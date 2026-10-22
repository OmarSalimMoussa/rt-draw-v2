// Boards from before links were data: the model drew a link as an arrow whose two
// ends sat on two pages. Each such arrow becomes a link on the element under its
// tail, and the arrow goes (the board draws its own arrows now, place.ts). An
// arrow with nothing under its tail stays a drawing. Run when a project opens,
// and after every send in case the model draws one anyway. So is the other guess a
// model makes: a link naming a page by its name (link:home for the page "Home",
// whose id is page) is a link to that page.
import { centerOf, norm, pageName, pageOf, pagesOf } from "../../../src/core/board.ts";
import type { Box, Scene, Shape } from "../../../src/core/scene.ts";
import { DEFAULTS, type Tuning } from "../../../src/core/tuning.ts";

const near = (b: Box, p: [number, number], pad: number) => p[0] >= b.x - pad && p[0] <= b.x + b.w + pad && p[1] >= b.y - pad && p[1] <= b.y + b.h + pad;
const area = (s: Shape) => norm(s.box).w * norm(s.box).h;

/** The smallest page holding the point, or within `pad` of its edge (as linksOf read arrows before). */
const pageAt = (scene: Scene, p: [number, number], pad: number) => pagesOf(scene).filter((f) => near(f.box, p, pad)).sort((a, b) => area(a) - area(b))[0];

/** Turns the board's page arrows into links; returns how many. */
export function adoptArrows(scene: Scene, t: Tuning = DEFAULTS): number {
  const snap = t["board.linkSnapPx"];
  let n = 0;
  for (const a of scene.stacked().filter((s) => s.kind === "arrow")) {
    const { x, y, w, h } = a.box;
    const [from, to] = [pageAt(scene, [x, y], snap), pageAt(scene, [x + w, y + h], snap)];
    if (!from || !to || from === to) continue;
    const tail = scene
      .stacked()
      .filter((s) => s.kind !== "frame" && s.kind !== "arrow" && s.kind !== "line" && pageOf(scene, s) === from && near(norm(s.box), [x, y], snap))
      .sort((p, q) => area(p) - area(q) || distance(p, [x, y]) - distance(q, [x, y]))[0];
    if (!tail) continue;
    tail.link = to.id;
    scene.remove(a.id);
    n++;
  }
  return n;
}

const distance = (s: Shape, p: [number, number]) => Math.hypot(centerOf(norm(s.box))[0] - p[0], centerOf(norm(s.box))[1] - p[1]);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Links to no shape that name a page by its name instead of its id, pointed at its id; returns how many. */
export function adoptLinks(scene: Scene): number {
  const byName = new Map<string, Shape>();
  for (const p of pagesOf(scene)) if (!byName.has(slug(pageName(p)))) byName.set(slug(pageName(p)), p);
  let n = 0;
  for (const s of scene.stacked()) {
    if (!s.link || scene.get(s.link)) continue;
    const page = byName.get(slug(s.link));
    if (!page) continue;
    s.link = page.id;
    n++;
  }
  return n;
}
