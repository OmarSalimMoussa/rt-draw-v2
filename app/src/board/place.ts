// Where the board's pages go and how the arrows between them run, worked out by
// the app and never drawn by the model: v1's layout (layout.ts) fed from the
// site's link tree (siteTree, src/core/board.ts). Each page other than home gets
// one arrow, from the element whose link first reaches it to that page's left
// edge; nav copied onto every page draws none. Pages no link reaches sit in a
// row to the right, top-aligned with home, as an old board's row of pages did.
import { norm, pageOf, pagesOf, siteTree } from "../../../src/core/board.ts";
import type { Box, Scene, Shape } from "../../../src/core/scene.ts";
import { type PageLink, layoutPages } from "./layout.ts";

export type Pt = { x: number; y: number };
/** An arrow to page `to`, from element `id` on page `from`: its route as corner points and as v1's rounded path. */
export type Arrow = { id: string; from: string; to: string; d: string; points: Pt[]; key: string };
/** Where each page goes (its top-left), and the arrows once they're there. */
export type Placement = { at: Map<string, Pt>; arrows: Arrow[] };

/** Between pages no link reaches (v1's space between pages, elk.spacing.nodeNode). */
const ROW_GAP = 140;

const rel = (b: Box, page: Shape): Box => {
  const n = norm(b);
  return { x: n.x - page.box.x, y: n.y - page.box.y, w: n.w, h: n.h };
};
const holds = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export async function placeBoard(scene: Scene): Promise<Placement> {
  const tree = siteTree(scene);
  if (!tree.length) return { at: new Map(), arrows: [] };
  const home = tree[0].page;
  const reached = tree.filter((p) => p.page === home || p.via);
  const links: PageLink[] = reached.flatMap(({ via }) => {
    if (!via) return [];
    const el = norm(via.via.box);
    // What else is on its page, for picking the side it leaves by: not what holds it (its card, the header) nor what's in it (its words).
    const around = scene
      .stacked()
      .filter((s) => s !== via.via && s.kind !== "frame" && pageOf(scene, s) === via.from && !holds(norm(s.box), el) && !holds(el, norm(s.box)))
      .map((s) => rel(s.box, via.from));
    return [{ id: via.via.id, from: via.from.id, to: via.to.id, button: rel(el, via.from), around }];
  });
  const laid = await layoutPages(home.id, reached.map(({ page }) => ({ id: page.id, w: norm(page.box).w, h: norm(page.box).h })), links);
  const at = new Map(reached.map(({ page }) => [page.id, laid.at.get(page.id) ?? { x: 0, y: 0 }]));
  let x = Math.max(...reached.map(({ page }) => at.get(page.id)!.x + norm(page.box).w)) + ROW_GAP;
  for (const { page } of tree.filter((p) => !reached.includes(p))) {
    at.set(page.id, { x, y: 0 });
    x += norm(page.box).w + ROW_GAP;
  }
  const arrows: Arrow[] = laid.arrows.flatMap((a) => {
    const l = links.find((k) => k.id === a.id);
    return l ? [{ id: a.id, from: l.from, to: l.to, d: a.d, points: a.points, key: "" }] : [];
  });
  for (const a of arrows) a.key = arrowKey(scene, a, at);
  return { at, arrows };
}

/**
 * What an arrow was routed for: its element (box and link) and its two pages' boxes, as they are, or as
 * they'll be once the pages are moved to `at`. While these hold, the arrow is right.
 */
export function arrowKey(scene: Scene, a: Pick<Arrow, "id" | "from" | "to">, at?: Placement["at"]): string {
  const [el, from, to] = [scene.get(a.id), scene.get(a.from), scene.get(a.to)];
  if (!el || !from || !to) return "";
  const moved = (b: Box, page: Shape) => {
    const p = at?.get(page.id);
    return p ? { ...b, x: b.x + p.x - page.box.x, y: b.y + p.y - page.box.y } : b;
  };
  const r = (b: Box) => [b.x, b.y, b.w, b.h].map((n) => Math.round(n * 10) / 10).join(" ");
  return [r(moved(from.box, from)), r(moved(to.box, to)), r(moved(el.box, from)), el.link ?? ""].join("|");
}

/** The arrows that are still right on this board (none while their pages are elsewhere, as on an old version). */
export const shownArrows = (scene: Scene, p: Placement | undefined): Arrow[] => (p ? p.arrows.filter((a) => a.key && arrowKey(scene, a) === a.key) : []);

/** How far each shape moves for its page to land at `at`: everything on a page (pageOf, as things are now) moves with it. */
export function shiftsOf(scene: Scene, at: Placement["at"]): Map<string, { dx: number; dy: number }> {
  const byPage = new Map<Shape, { dx: number; dy: number }>();
  for (const p of pagesOf(scene)) {
    const to = at.get(p.id);
    if (to && (to.x !== p.box.x || to.y !== p.box.y)) byPage.set(p, { dx: to.x - p.box.x, dy: to.y - p.box.y });
  }
  const out = new Map<string, { dx: number; dy: number }>();
  if (!byPage.size) return out;
  for (const s of scene.stacked()) {
    const page = s.kind === "frame" ? s : pageOf(scene, s);
    const d = page && byPage.get(page);
    if (d) out.set(s.id, d);
  }
  return out;
}

/** Moves the pages to `at`, their content with them. */
export function moveBy(scene: Scene, at: Placement["at"]): Map<string, { dx: number; dy: number }> {
  const shifts = shiftsOf(scene, at);
  for (const [id, d] of shifts) {
    const s = scene.get(id)!;
    s.box = { ...s.box, x: s.box.x + d.dx, y: s.box.y + d.dy };
  }
  return shifts;
}
