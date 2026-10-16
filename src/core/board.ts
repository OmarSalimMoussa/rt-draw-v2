// The infinite board: pages (frame shapes) laid out anywhere, arrows between
// them as links, and a camera that shows any part at any zoom. A model can't
// look at all of it, so this is what it can be given instead: several views
// captured side by side (what you see, around each mark, pages you named), the
// whole board at the biggest zoom that holds every page, and the site map as
// structured text.
import type { Stroke } from "./ink.ts";
import type { InkSpec, Ref } from "./resolve.ts";
import { groupStrokes } from "./marks.ts";
import type { Box, Scene, Shape } from "./scene.ts";
import { type Shot, takeShot } from "./shot.ts";
import { type TraceContext, span, timed } from "./trace.ts";
import { DEFAULTS, type Tuning, tune } from "./tuning.ts";

/** A rectangle of the board the camera shows, in board pixels. */
export type View = Box;
/** The screen a view fills, in pixels. */
export const SCREEN = { w: 1280, h: 800 };
/** The screen's shape: a view keeps it, so it fills the screen. */
export const ASPECT = SCREEN.w / SCREEN.h;

/** A box with its width and height made positive (arrows can point left or up). */
export const norm = (b: Box): Box => ({ x: Math.min(b.x, b.x + b.w), y: Math.min(b.y, b.y + b.h), w: Math.abs(b.w), h: Math.abs(b.h) });
export const centerOf = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
export function union(boxes: Box[]): Box {
  const bs = boxes.map(norm);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}
/** Share of `inner`'s area that lies inside `outer` (a line counts by its length). */
export function insideShare(inner: Box, outer: Box): number {
  const a = norm(inner);
  const w = Math.max(0, Math.min(a.x + a.w, outer.x + outer.w) - Math.max(a.x, outer.x));
  const h = Math.max(0, Math.min(a.y + a.h, outer.y + outer.h) - Math.max(a.y, outer.y));
  if (!a.w || !a.h) return (a.w ? w / a.w : 1) * (a.h ? h / a.h : 1) * (a.x >= outer.x - 1 && a.x <= outer.x + outer.w + 1 && a.y >= outer.y - 1 && a.y <= outer.y + outer.h + 1 ? 1 : 0);
  return (w * h) / (a.w * a.h);
}
const contains = (outer: Box, p: [number, number], pad = 0) => p[0] >= outer.x - pad && p[0] <= outer.x + outer.w + pad && p[1] >= outer.y - pad && p[1] <= outer.y + outer.h + pad;

/** The smallest view of the screen's shape that holds `box` with a margin of padFrac on every side, and is at least minW wide. */
export function fitView(box: Box, padFrac = 0.06, minW = 0, aspect = ASPECT): View {
  const b = norm(box);
  const pad = Math.max(b.w, b.h) * padFrac;
  let w = Math.max(b.w + pad * 2, (b.h + pad * 2) * aspect, minW);
  w = Math.max(w, 1);
  const h = w / aspect;
  const [cx, cy] = centerOf(b);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export const pagesOf = (scene: Scene) => scene.stacked().filter((s) => s.kind === "frame");
export const pageName = (p: Shape) => p.text?.words ?? p.id;
/** A single-canvas script as one page of a board: a screen-sized frame behind it. */
export const asPage = (script: string, id: string, name: string) => `shape(${id}, frame, 0 0 ${SCREEN.w} ${SCREEN.h}, "the ${name} page, the one page of this site so far")\ntext(${id}, "${name}")\n${script}`;
/** The camera on a page: its top, the page's full width, its name showing above it. */
export const pageTop = (p: Shape): View => ({ x: p.box.x, y: p.box.y - 60, w: p.box.w, h: p.box.w / ASPECT });

/** The smallest page holding this point, or within `pad` of its edge. */
function pageAt(scene: Scene, p: [number, number], pad = 0): Shape | undefined {
  return pagesOf(scene)
    .filter((f) => contains(f.box, p, pad))
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
}
/** The page a shape is on: the smallest page holding its middle. */
export const pageOf = (scene: Scene, s: Shape) => (s.kind === "frame" ? undefined : pageAt(scene, centerOf(norm(s.box))));

export type Link = { from: Shape; to: Shape; via: Shape };
/** Arrows from one page to another: each end on a page, or within board.linkSnapPx of its edge. */
export function linksOf(scene: Scene, t: Tuning = DEFAULTS): Link[] {
  const out: Link[] = [];
  for (const s of scene.stacked()) {
    if (s.kind !== "arrow") continue;
    const { x, y, w, h } = s.box;
    const from = pageAt(scene, [x, y], t["board.linkSnapPx"]);
    const to = pageAt(scene, [x + w, y + h], t["board.linkSnapPx"]);
    if (from && to && from !== to) out.push({ from, to, via: s });
  }
  return out;
}

/** Everything on the board. */
export const boardBounds = (scene: Scene): Box => (scene.shapes.size ? union(scene.stacked().map((s) => s.box)) : { x: 0, y: 0, w: scene.width, h: scene.height });

const words = (s: string, n: number) => {
  const w = s.split(/\s+/).filter(Boolean);
  return w.length > n ? `${w.slice(0, n).join(" ")}…` : w.join(" ");
};

/** How much of each page the site map lists: levels of content, words of each description, and each shape's box. */
export type MapDetail = { depth: number; words: number; boxes: boolean };

/**
 * The site map as text: every page in reading order (top to bottom, left to
 * right) with its links, then its content as a tree (a shape sits under the
 * smallest shape around it), board.mapDepth levels deep, descriptions cut to
 * board.mapWords words (or as `detail` says).
 */
export function siteMap(scene: Scene, t: Tuning = DEFAULTS, detail: MapDetail = { depth: t["board.mapDepth"], words: t["board.mapWords"], boxes: false }): string {
  const pages = pagesOf(scene).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const links = linksOf(scene, t);
  const linkIds = new Set(links.map((l) => l.via.id));
  const { depth, words: nWords } = detail;
  const r = (n: number) => Math.round(n);
  const line = (s: Shape) => {
    const bits = [detail.boxes ? `${s.id} (${r(s.box.x)} ${r(s.box.y)} ${r(s.box.w)} ${r(s.box.h)})` : s.id];
    if (nWords > 0) bits.push(`: ${words(s.description, nWords)}`);
    if (s.text?.words) bits.push(` text "${words(s.text.words.replace(/\s+/g, " "), Math.max(8, nWords))}"`);
    if (s.drawing) bits.push(` picture "${s.drawing}"`);
    return bits.join("");
  };
  // Content by page; a shape's parent is the smallest other shape on its page around it.
  const content = scene.stacked().filter((s) => s.kind !== "frame" && !linkIds.has(s.id));
  const parentOf = new Map<Shape, Shape | undefined>();
  for (const s of content) {
    const page = pageOf(scene, s);
    const around = content
      .filter((o) => o !== s && pageOf(scene, o) === page && insideShare(s.box, o.box) >= 0.98 && o.box.w * o.box.h > norm(s.box).w * norm(s.box).h)
      .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
    parentOf.set(s, around);
  }
  const kids = (page: Shape | undefined, parent: Shape | undefined) =>
    content.filter((s) => pageOf(scene, s) === page && parentOf.get(s) === parent).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const tree = (page: Shape | undefined, parent: Shape | undefined, level: number, indent: string): string[] =>
    level > depth ? [] : kids(page, parent).flatMap((s) => [`${indent}- ${line(s)}`, ...tree(page, s, level + 1, `${indent}  `)]);

  const out = [`Board: ${pages.length} pages, ${links.length} links between them, ${scene.shapes.size} shapes. Positions are board pixels; pages are frames.`];
  pages.forEach((p, i) => {
    const to = links.filter((l) => l.from === p).map((l) => `${pageName(l.to)} (${l.via.id})`);
    out.push(`${i + 1}. ${pageName(p)} [${p.id}] at ${r(p.box.x)},${r(p.box.y)}, ${r(p.box.w)}×${r(p.box.h)}${to.length ? `. Links to: ${to.join(", ")}` : ""}`);
    if (depth > 0) out.push(...tree(p, undefined, 1, "   "));
  });
  const loose = kids(undefined, undefined);
  if (loose.length) out.push("Not on any page:", ...loose.map((s) => `- ${line(s)}`));
  return out.join("\n");
}

export type NamedView = { name: string; why: string; view: View; width: number; tags: boolean; /** Ids it's there to show. */ for?: string[] };

/** A picture's height for a view drawn `width` pixels wide. */
const heightOf = (v: NamedView) => Math.round((v.width * v.view.h) / v.view.w);
/** Image tokens a view costs (about one per 750 pixels). */
export const viewTokens = (v: NamedView) => Math.round((v.width * heightOf(v)) / 750);
/** How big a box comes out in a view's picture: its larger side, in picture pixels. */
export const pictureSize = (b: Box, v: NamedView) => (Math.max(norm(b).w, norm(b).h) * v.width) / v.view.w;
/** When a picture shows a shape well enough to work with: big enough, its text tall enough to read, a page wide enough to make out its layout. */
export type Legibility = { readablePx: number; textPx: number; pagePx: number };
export const legibilityOf = (t: Tuning): Legibility => ({ readablePx: t["board.readablePx"], textPx: t["board.textPx"], pagePx: t["board.pageReadablePx"] });
/** Whether a view's picture shows this shape (at least 80% of it) legibly. */
export function legible(s: Shape, v: NamedView, l: Legibility): boolean {
  if (insideShare(s.box, v.view) < 0.8) return false;
  if (s.kind === "frame") return (s.box.w * v.width) / v.view.w >= l.pagePx;
  if (pictureSize(s.box, v) < l.readablePx) return false;
  return !s.text?.words || ((s.text.size ?? 20) * v.width) / v.view.w >= l.textPx;
}

/** A view of a whole page, in the page's own shape (a tall page isn't squeezed into a wide picture), for about the pixels of a camera picture. */
function pageView(p: Shape, why: string, t: Tuning): NamedView {
  const detailW = t["board.viewWidthPx"];
  const aspect = Math.max(0.5, Math.min(2.5, p.box.w / p.box.h));
  return { name: `page ${pageName(p)}`, why, view: fitView(p.box, 0.04, 0, aspect), width: Math.round(Math.sqrt(((detailW * detailW) / ASPECT) * aspect)), tags: true, for: [p.id] };
}

/**
 * The pictures worth sending a model for this send, within board.imageBudget
 * tokens and board.maxViews pictures: what you see first and the whole board
 * last (both kept), and between them, in this order:
 * - what you referred to (the resolver's answers, when given and
 *   board.fromRefs is on) that what you see doesn't show readably: a page you
 *   meant gets a page view; shapes get a close-up, one per page they're on
 *   (the whole page when the close-up would be nearly as big both ways);
 * - a close-up of each mark the camera shows too small;
 * - without the resolver's answers: each page named in the words that's off screen.
 */
export function pickViews(scene: Scene, camera: View, strokes: Stroke[], said: string, t: Tuning = DEFAULTS, refs?: { phrase: string; ids: string[] }[]): NamedView[] {
  const detailW = t["board.viewWidthPx"];
  const l = legibilityOf(t);
  const first: NamedView[] = t["board.viewportShot"] ? [{ name: "what you see", why: "the camera, as on screen", view: camera, width: detailW, tags: true }] : [];
  const middle: NamedView[] = [];
  const shown = (s: Shape) => [...first, ...middle].some((v) => legible(s, v, l));

  if (refs && t["board.fromRefs"]) {
    // Each phrase's ids, by the page they're on, in the order they were said.
    for (const ref of refs) {
      const byPage = new Map<Shape | undefined, Shape[]>();
      for (const id of ref.ids) {
        const s = scene.get(id);
        if (!s) continue;
        const page = s.kind === "frame" ? s : pageOf(scene, s);
        byPage.set(page, [...(byPage.get(page) ?? []), s]);
      }
      for (const [page, shapes] of byPage) {
        if (page && shapes.includes(page)) {
          // The page itself was meant: worth a picture unless one already shows its layout.
          if (!shown(page)) middle.push(pageView(page, `you meant it ("${ref.phrase}") and ${insideShare(page.box, camera) < 0.8 ? "it's off screen" : "it's too small on screen"}`, t));
          continue;
        }
        const missing = shapes.filter((s) => !shown(s));
        if (!missing.length) continue;
        const v = fitView(union(missing.map((s) => s.box)), t["board.markPadFrac"], t["board.markMinViewPx"]);
        const ids = missing.map((s) => s.id);
        if (page && v.w >= 0.7 * page.box.w && v.h >= 0.7 * page.box.h) middle.push({ ...pageView(page, `you meant ${ids.join(", ")} ("${ref.phrase}") on this page`, t), for: ids });
        else middle.push({ name: `around ${ids.join(", ")}`, why: `you meant ${ids.length > 1 ? "them" : "it"} ("${ref.phrase}") and ${ids.length > 1 ? "they're" : "it's"} ${insideShare(union(missing.map((s) => s.box)), camera) < 0.8 ? "off screen" : "too small on screen"}`, view: v, width: detailW, tags: true, for: ids });
      }
    }
  }
  if (t["board.markViews"])
    for (const m of groupStrokes(strokes, t)) {
      const v = fitView(m.box, t["board.markPadFrac"], t["board.markMinViewPx"]);
      // Only when it's a real close-up: the camera already shows the mark at about this zoom.
      if (v.w > camera.w * t["board.markZoomFrac"] && insideShare(m.box, camera) > 0.9) continue;
      if (middle.some((x) => insideShare(m.box, x.view) > 0.9 && x.view.w <= v.w * 1.2)) continue;
      middle.push({ name: `around [ink ${m.n}]`, why: `a close-up of mark ${m.n} and what it touches`, view: v, width: detailW, tags: true });
    }
  if (!(refs && t["board.fromRefs"]) && t["board.pageViews"]) {
    const text = ` ${said.toLowerCase().replace(/[^a-z0-9' ]/g, " ")} `;
    for (const p of pagesOf(scene)) {
      const named = [pageName(p), p.id].map((n) => n.toLowerCase()).some((n) => text.includes(` ${n} `) || text.includes(` ${n}'`));
      if (!named || shown(p)) continue;
      middle.push(pageView(p, "you named it and it's off screen", t));
    }
  }
  const last: NamedView[] = t["board.overview"]
    ? [{ name: "the whole board", why: "the biggest zoom that holds every page", view: fitView(pagesOf(scene).length ? union(pagesOf(scene).map((p) => p.box)) : boardBounds(scene), 0.03), width: t["board.overviewWidthPx"], tags: !!t["board.overviewTags"] }]
    : [];
  // What you see and the whole board are kept; the rest fill the budget in order.
  let tokens = [...first, ...last].reduce((a, v) => a + viewTokens(v), 0);
  const kept: NamedView[] = [];
  for (const v of middle) {
    if (first.length + kept.length + last.length >= t["board.maxViews"] || tokens + viewTokens(v) > t["board.imageBudget"]) continue;
    kept.push(v);
    tokens += viewTokens(v);
  }
  return [...first, ...kept, ...last];
}

/** The rules alone: no resolver. */
export const autoViews = (scene: Scene, camera: View, strokes: Stroke[], said: string, t: Tuning = DEFAULTS) => pickViews(scene, camera, strokes, said, t);

export type BoardShot = NamedView & { shot: Shot };

/** Takes a view's picture once: the same view asked for again gets the same capture. */
function capturer(scene: Scene, strokes: Stroke[], t: Tuning, ctx: TraceContext) {
  const taken = new Map<string, Promise<Shot>>();
  const shoot = (v: NamedView) => {
    const key = [v.view.x, v.view.y, v.view.w, v.view.h].map(Math.round).concat(v.width, Number(v.tags)).join(" ");
    let p = taken.get(key);
    if (!p) {
      const s0 = performance.now();
      p = takeShot(scene, strokes, v.tags ? t : tune({ "shot.tagPx": 0 }, t), { view: v.view, width: v.width }).then((shot) => {
        timed(ctx, `shot: ${v.name}`, s0, performance.now(), { width: shot.width, height: shot.height, kb: Math.round(shot.bytes / 1024) });
        return shot;
      });
      taken.set(key, p);
    }
    return p;
  };
  return { shoot, taken };
}

/** Captures views side by side: drawing each one is quick, so their rasterizing and encoding overlap. */
export async function boardShots(scene: Scene, strokes: Stroke[], views: NamedView[], t: Tuning = DEFAULTS, parent?: TraceContext): Promise<{ shots: BoardShot[]; ms: number; sumMs: number }> {
  return span("board screenshots", parent, async (ctx) => {
    const t0 = performance.now();
    const { shoot } = capturer(scene, strokes, t, ctx);
    const shots = await Promise.all(views.map(async (v) => ({ ...v, shot: await shoot(v) })));
    return { shots, ms: Math.round(performance.now() - t0), sumMs: Math.round(shots.reduce((a, s) => a + s.shot.ms.total, 0)) };
  }, { views: views.length });
}

/**
 * A send's pictures on a board. The resolver's answers (`refs`, still coming)
 * pick them when board.fromRefs is on, but most don't depend on them: with
 * board.earlyShots on, the rules' pick (what you see, close-ups of marks, the
 * whole board) is captured while the resolver thinks, so only the pictures its
 * answers add wait for it. Early captures the answers don't keep are dropped.
 */
export async function sendShots(scene: Scene, camera: View, strokes: Stroke[], said: string, t: Tuning, refs?: Promise<Ref[] | undefined>, parent?: TraceContext): Promise<{ shots: BoardShot[]; early: number; unused: number; ms: number }> {
  return span("board screenshots", parent, async (ctx) => {
    const t0 = performance.now();
    const { shoot, taken } = capturer(scene, strokes, t, ctx);
    const byRefs = !!refs && !!t["board.fromRefs"];
    if (byRefs && t["board.earlyShots"]) pickViews(scene, camera, strokes, said, t).forEach(shoot);
    const early = taken.size;
    const answers = byRefs ? await refs : undefined;
    const views = pickViews(scene, camera, strokes, said, t, answers);
    const shots = await Promise.all(views.map(async (v) => ({ ...v, shot: await shoot(v) })));
    return { shots, early, unused: taken.size - views.length, ms: Math.round(performance.now() - t0) };
  });
}

// ---- Cases: which pictures a send needs, scored by what they show legibly and what they cost.

/** A hand-written case: where the camera is, what's said and drawn there, and what must come out legible in some picture. */
export type ViewCase = { said: string; from: string | number[]; ink: InkSpec[]; need: string[]; note?: string };

/** Scoring's own legibility, fixed (the knobs' defaults at the time), so tuning the picker can't move the goal. */
export const SCORE_LEGIBILITY: Legibility = { readablePx: 40, textPx: 9, pagePx: 400 };

export function scoreViews(c: ViewCase, views: NamedView[], scene: Scene): { ok: boolean; covered: string[]; missed: string[]; tokens: number } {
  const covered = c.need.filter((id) => {
    const s = scene.get(id);
    return !!s && views.some((v) => legible(s, v, SCORE_LEGIBILITY));
  });
  return { ok: covered.length === c.need.length, covered, missed: c.need.filter((id) => !covered.includes(id)), tokens: views.reduce((a, v) => a + viewTokens(v), 0) };
}
