// Where cases start (spec §2.2) and the doodles their pictures show: the frozen
// measuring side (N5), so a candidate, which may edit src/, can't move its own start
// scenes. The ops are copies of src/fixtures/; pictures.json is baked once
// (`run.ts bake`, ≤ 36 calls, F2) and committed, so no session start pays for the
// fixtures' 31 pictures. One module for node (bank, drive, bake; with node-hooks.mjs)
// and the browser (bridge, driver demo).
import { SCREEN, type View, asPage, boardBounds, fitView, pageTop, pagesOf, union } from "../../src/core/board.ts";
import { runScript } from "../../src/core/ops.ts";
import type { El } from "../../src/core/picture.ts";
import { Scene, type SceneJSON, type Shape } from "../../src/core/scene.ts";
import type { StartId, TargetId } from "../loop/types.ts";
import board from "./board.ops.txt?raw";
import clowns from "./clowns.ops.txt?raw";
import grid from "./grid.ops.txt?raw";
import messy from "./messy.ops.txt?raw";
import baked from "./pictures.json" with { type: "json" };

/** A start: the ops that build it, where the camera starts, its page count, and whether only held-out sets use it (§2.1). */
export type Fixture = { id: StartId; ops: string; start: View; pages: number; heldoutOnly: boolean };

/** A zoomed-out start shows its page from this many times as far: small in the middle of the screen. */
const ZOOMED_OUT = 2;
const top = (id: string) => (s: Scene) => pageTop(s.get(id)!);
const everything = (s: Scene) => fitView(union(pagesOf(s).map((p) => p.box)), 0.03);
const far = (s: Scene) => fitView(pagesOf(s)[0].box, 0, ZOOMED_OUT * SCREEN.w);
const page = (ops: string, name = "Home") => asPage(ops, "page", name);

const STARTS: [StartId, string, (s: Scene) => View, boolean][] = [
  ["blank", page(""), top("page"), false],
  ["toyshop-home", board, top("home"), false],
  ["toyshop-products", board, top("shop"), false],
  ["toyshop-cart", board, top("cart"), true],
  ["toyshop-zoomed-out", board, everything, false],
  ["clowns", page(clowns), top("page"), false],
  ["messy", page(messy), top("page"), false],
  ["messy-zoomed-out", page(messy), far, true],
  ["grid", page(grid, "Settings"), top("page"), true],
];

/** Every start built from ops; resume:<target> and site:<target> are pages saved at bank build (see loadFixture). */
export const FIXTURES: Fixture[] = STARTS.map(([id, ops, view, heldoutOnly]) => {
  const { scene } = runScript(ops);
  return { id, ops, start: view(scene), pages: pagesOf(scene).length, heldoutOnly };
});

/** A baked doodle in the picture model's own w × h space (render scales it to the shape). */
export type Baked = { w: number; h: number; els: El[] };
export type Pictures = Record<string, Baked>;
export const PICTURES = baked as Pictures;

/** A doodle's key: a changed subject or box size is a different picture, left for the product to draw. */
export const pictureKey = (s: Shape) => `${s.id}|${s.drawing}|${Math.round(s.box.w)}|${Math.round(s.box.h)}`;

/** Fills every drawing whose key is baked, done, so needsPicture() is false and no call is made for it. Returns how many. */
export function applyPictures(scene: Scene, pics: Pictures = PICTURES): number {
  let n = 0;
  for (const s of scene.stacked()) {
    const p = s.drawing ? pics[pictureKey(s)] : undefined;
    if (!p) continue;
    s.picture = { subject: s.drawing!, w: p.w, h: p.h, els: structuredClone(p.els), done: true };
    n++;
  }
  return n;
}

/** The saved pages: resume:<target> (a first-timer's own half-built page) and site:<target> (a held-out first-timer's page). */
export type Saved = (target: TargetId) => SceneJSON | undefined;
const savedTarget = (id: StartId) => /^(?:resume|site):(.+)$/.exec(id)?.[1] as TargetId | undefined;

/** Node only: saved pages as bank build writes them, $RT_EVAL_HOME/bank/resume/<target>.json (pass paths().resume). */
export function savedIn(file: (target: string) => string): Saved {
  // Not an import, so the browser never loads node:fs.
  const fs = process.getBuiltinModule("node:fs");
  return (target) => (fs.existsSync(file(target)) ? (JSON.parse(fs.readFileSync(file(target), "utf8")) as SceneJSON) : undefined);
}

/** The saved starts among `ids` that aren't there yet. */
export const missingStarts = (ids: StartId[], saved?: Saved) => ids.filter((id) => savedTarget(id) && !saved?.(savedTarget(id)!));

/** A start's scene, with the baked doodles (pass {} to leave every picture undrawn), and the camera it starts with. */
export function loadFixture(id: StartId, o: { saved?: Saved; pictures?: Pictures } = {}): { scene: Scene; start: View } {
  const target = savedTarget(id);
  if (target) {
    const j = o.saved?.(target);
    if (!j) throw new Error(`no saved page for ${id}: bank build writes bank/resume/${target}.json`);
    const scene = Scene.fromJSON(j);
    const first = pagesOf(scene)[0];
    return { scene, start: first ? pageTop(first) : fitView(boardBounds(scene)) };
  }
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`no start ${id}`);
  const { scene } = runScript(f.ops);
  applyPictures(scene, o.pictures ?? PICTURES);
  return { scene, start: { ...f.start } };
}
