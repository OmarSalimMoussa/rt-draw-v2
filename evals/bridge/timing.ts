// The harness clock (spec §5.1, F1, F26): when a send's change reaches the stage,
// read off the stage itself, never off the product's own numbers. A shape's
// signature is a hash of its g[data-id] subtree, attributes included, so a recolour,
// restyle, text or picture change all count. Rendering is deterministic (render.ts
// seeds rough.js per id) and the camera only sets the root viewBox, so a glide or a
// redraw of an unchanged shape changes no signature. Frozen: the same in both arms.

/** cyrb53, a fast 53-bit string hash: signatures are only ever compared per shape. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A shape's signature. Picture clip ids count up on every render (picture.ts), so they're all named alike. */
export const signature = (g: Element) => hash(g.outerHTML.replace(/pic-clip-\d+/g, "pic-clip"));

/** The stage's shapes by id: the g[data-id] children of its <svg>. */
function shapesOf(svg: SVGSVGElement): Map<string, Element> {
  const out = new Map<string, Element>();
  for (const el of svg.children) if (el.tagName === "g" && el.getAttribute("data-id")) out.set(el.getAttribute("data-id")!, el);
  return out;
}

/** Every shape's signature on the stage now. */
export const signatures = (svg: SVGSVGElement) => new Map([...shapesOf(svg)].map(([id, g]) => [id, signature(g)]));

export type Clock = {
  /** Enter: forgets the last send's changes and returns the signatures this send is measured against. */
  enter: () => Map<string, string>;
  /**
   * TTFC: the first frame in which some shape differs from before and already has its final signature for good (its
   * last change); TTD: the frame from which every shape whose final signature differs from before (added, removed or
   * changed) holds it. A placeholder or a nudge later undone never counts. Both undefined when nothing changed.
   * TTFD, time to first drawing (the owner's latency, LOOP-V2.md): the first frame in which some shape the send keeps
   * (its final signature differs from before) showed anything new that counts as drawn, its final form or not. A
   * picture still a placeholder doesn't count (`drawn`); one whose first stroke has streamed in does. `firstOf(id,
   * first)` may put another time on a shape (the bridge: a shape that ends with a drawing counts only from content its
   * final state keeps, not from an outline it showed, before its drawing() landed or after).
   */
  measure: (before: Map<string, string>, enterAt: number, firstOf?: (id: string, first: number | undefined) => number | undefined) => { ttfcMs?: number; ttdMs?: number; ttfdMs?: number; changed: string[] };
  /** When the stage last changed at all (a glide's viewBox included): the send quiesces on it. */
  lastMutation: () => number;
};

/**
 * Watches the stage's <svg>: after each frame that touched shapes, recomputes their signatures and notes which changed.
 * `drawn(id, at)`: whether the shape as it is now, at frame `at`, counts as drawn (the page's own scene says; a removed
 * shape does).
 */
export function watch(svg: SVGSVGElement, drawn: (id: string, at: number) => boolean = () => true): Clock {
  const now = signatures(svg);
  /** Each shape's last signature change: the frame (ms, performance.now) from which it holds what it has now. */
  const changedAt = new Map<string, number>();
  /** The signatures at Enter, and each shape's first frame since that differed from them and counted as drawn. */
  let base = new Map(now);
  const firstAt = new Map<string, number>();
  let lastMutation = performance.now();
  const seen = (records: MutationRecord[]) => {
    if (!records.length) return;
    const at = (lastMutation = performance.now());
    const touched = new Set<string>();
    for (const r of records) {
      // A render replaces the shapes (the root's children); anything else touched lies inside one.
      if (r.target === svg)
        for (const n of [...r.addedNodes, ...r.removedNodes]) {
          const id = n instanceof Element && n.getAttribute("data-id");
          if (id) touched.add(id);
        }
      const g = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest("g[data-id]");
      if (g && g.parentNode === svg) touched.add(g.getAttribute("data-id")!);
    }
    if (!touched.size) return;
    const shapes = shapesOf(svg);
    for (const id of touched) {
      const g = shapes.get(id);
      const sig = g && signature(g);
      if (sig === now.get(id)) continue;
      if (sig) now.set(id, sig);
      else now.delete(id);
      changedAt.set(id, at);
      if (sig !== base.get(id) && drawn(id, at) && !firstAt.has(id)) firstAt.set(id, at);
    }
  };
  const observer = new MutationObserver(seen);
  observer.observe(svg, { subtree: true, childList: true, attributes: true, characterData: true });

  return {
    // Records not delivered yet (a render in this same task) belong before Enter.
    enter: () => (seen(observer.takeRecords()), changedAt.clear(), firstAt.clear(), (base = new Map(now)), new Map(now)),
    measure(before, enterAt, firstOf = (_, first) => first) {
      seen(observer.takeRecords());
      const changed = [...new Set([...before.keys(), ...now.keys()])].filter((id) => before.get(id) !== now.get(id));
      const settled = changed.map((id) => (changedAt.get(id) ?? enterAt) - enterAt);
      // Only shapes the send keeps, and only once drawn: a picture that never left its placeholder never counts.
      const firsts = changed.flatMap((id) => {
        const at = firstOf(id, firstAt.get(id));
        return at === undefined ? [] : [at - enterAt];
      });
      if (!changed.length) return { changed };
      return { ttfcMs: Math.round(Math.min(...settled)), ttdMs: Math.round(Math.max(...settled)), ...(firsts.length ? { ttfdMs: Math.round(Math.min(...firsts)) } : {}), changed };
    },
    lastMutation: () => lastMutation,
  };
}
