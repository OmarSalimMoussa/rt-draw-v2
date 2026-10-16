// The infinite board: pages (frame shapes) laid out anywhere, arrows between
// them as links, and a camera that shows any part at any zoom. A model can't
// look at all of it, so this is what it can be given instead: several views
// captured side by side (what you see, around each mark, pages you named), the
// whole board at the biggest zoom that holds every page, and the site map as
// structured text.
import type { Stroke } from "./ink.ts";
import { groupStrokes } from "./marks.ts";
import type { Box, Scene, Shape } from "./scene.ts";
import { type Shot, takeShot } from "./shot.ts";
import { type TraceContext, span, timed } from "./trace.ts";
import { DEFAULTS, type Tuning, tune } from "./tuning.ts";

/** A rectangle of the board the camera shows, in board pixels. */
export type View = Box;
/** The screen's shape: a view keeps it, so it fills the screen. */
export const ASPECT = 1280 / 800;

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

/**
 * The site map as text: every page in reading order (top to bottom, left to
 * right) with its links, then its content as a tree (a shape sits under the
 * smallest shape around it), board.mapDepth levels deep, descriptions cut to
 * board.mapWords words.
 */
export function siteMap(scene: Scene, t: Tuning = DEFAULTS): string {
  const pages = pagesOf(scene).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const links = linksOf(scene, t);
  const linkIds = new Set(links.map((l) => l.via.id));
  const depth = t["board.mapDepth"];
  const nWords = t["board.mapWords"];
  const r = (n: number) => Math.round(n);
  const line = (s: Shape) => {
    const bits = [s.id];
    if (nWords > 0) bits.push(`: ${words(s.description, nWords)}`);
    if (s.text?.words) bits.push(` text "${words(s.text.words.replace(/\s+/g, " "), 8)}"`);
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

export type NamedView = { name: string; why: string; view: View; width: number; tags: boolean };

/**
 * The views worth showing a model for this send, in the order it gets them:
 * what you see (the camera), around each mark that the camera shows too small,
 * each page you named that the camera doesn't show, and the whole board.
 */
export function autoViews(scene: Scene, camera: View, strokes: Stroke[], said: string, t: Tuning = DEFAULTS): NamedView[] {
  const views: NamedView[] = [];
  const detailW = t["board.viewWidthPx"];
  if (t["board.viewportShot"]) views.push({ name: "what you see", why: "the camera, as on screen", view: camera, width: detailW, tags: true });
  if (t["board.markViews"])
    for (const m of groupStrokes(strokes, t)) {
      const v = fitView(m.box, t["board.markPadFrac"], t["board.markMinViewPx"]);
      // Only when it's a real close-up: the camera already shows the mark at about this zoom.
      if (v.w > camera.w * t["board.markZoomFrac"] && insideShare(m.box, camera) > 0.9) continue;
      views.push({ name: `around [ink ${m.n}]`, why: `a close-up of mark ${m.n} and what it touches`, view: v, width: detailW, tags: true });
    }
  if (t["board.pageViews"]) {
    const text = ` ${said.toLowerCase()} `;
    for (const p of pagesOf(scene)) {
      const name = pageName(p).toLowerCase();
      if (!text.includes(` ${name} `) && !text.includes(` ${name}'`) && !text.includes(` ${name}.`) && !text.includes(` ${name},`)) continue;
      if (insideShare(p.box, camera) > 0.6) continue;
      // In the page's own shape (a tall page isn't squeezed into a wide picture), for about the same pixels.
      const aspect = Math.max(0.5, Math.min(2.5, p.box.w / p.box.h));
      views.push({ name: `page ${pageName(p)}`, why: `you named it and it's off screen`, view: fitView(p.box, 0.04, 0, aspect), width: Math.round(Math.sqrt(((detailW * detailW) / ASPECT) * aspect)), tags: true });
    }
  }
  // The camera and the whole board are kept; close-ups and pages fill what's left of board.maxViews.
  const whole: NamedView[] = [];
  if (t["board.overview"]) whole.push({ name: "the whole board", why: "the biggest zoom that holds every page", view: fitView(pagesOf(scene).length ? union(pagesOf(scene).map((p) => p.box)) : boardBounds(scene), 0.03), width: t["board.overviewWidthPx"], tags: !!t["board.overviewTags"] });
  const fixed = (t["board.viewportShot"] ? 1 : 0) + whole.length;
  const middle = views.slice(t["board.viewportShot"] ? 1 : 0, Math.max(0, t["board.maxViews"] - fixed) + (t["board.viewportShot"] ? 1 : 0));
  return [...(t["board.viewportShot"] ? views.slice(0, 1) : []), ...middle, ...whole].slice(0, Math.max(t["board.maxViews"], fixed));
}

export type BoardShot = NamedView & { shot: Shot };

/** Captures views side by side: drawing each one is quick, so their rasterizing and encoding overlap. */
export async function boardShots(scene: Scene, strokes: Stroke[], views: NamedView[], t: Tuning = DEFAULTS, parent?: TraceContext): Promise<{ shots: BoardShot[]; ms: number; sumMs: number }> {
  return span("board screenshots", parent, async (ctx) => {
    const t0 = performance.now();
    const shots = await Promise.all(
      views.map(async (v) => {
        const s0 = performance.now();
        const shot = await takeShot(scene, strokes, v.tags ? t : tune({ "shot.tagPx": 0 }, t), { view: v.view, width: v.width });
        timed(ctx, `shot: ${v.name}`, s0, performance.now(), { width: shot.width, height: shot.height, kb: Math.round(shot.bytes / 1024) });
        return { ...v, shot };
      }),
    );
    return { shots, ms: Math.round(performance.now() - t0), sumMs: Math.round(shots.reduce((a, s) => a + s.shot.ms.total, 0)) };
  }, { views: views.length });
}
