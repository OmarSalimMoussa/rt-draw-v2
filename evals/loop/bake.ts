// Fixture doodles (spec F2, §11 step 2): every start's drawings drawn once by the product's own
// picture filler in a bridge page, through the gateway under run.ts's hard cap (bake --cap 36),
// into $RT_EVAL_HOME/out/pictures.json for the owner to review and commit as
// evals/fixtures/pictures.json. After that no session start pays for the fixtures' 31 pictures.
import { join } from "node:path";
import { runScript } from "../../src/core/ops.ts";
import { FIXTURES, type Pictures, pictureKey } from "../fixtures/fixtures.ts";
import type { Page } from "./chrome.ts";
import { endCase, gatewayStatus } from "./client.ts";
import { loadPage } from "./drive.ts";
import { paths } from "./paths.ts";
import { put } from "./record.ts";
import type { SceneJSON, StartId } from "./types.ts";

/** In the bridge page: the arm's own pictureFiller over the loaded scene at its defaults, as a send would run it. */
const FILL = `(async () => {
  const [{ Scene }, { pictureFiller }, { DEFAULTS }] = await Promise.all(["/src/core/scene.ts", "/src/core/picture.ts", "/src/core/tuning.ts"].map((m) => import(m)));
  const scene = Scene.fromJSON(rtEval.scene());
  const filler = pictureFiller(scene, DEFAULTS, () => {});
  filler.kick();
  const pics = await filler.finish();
  return { failed: pics.failed, scene: scene.toJSON() };
})()`;

/** Bakes the starts' doodles (default every start; one per distinct scene). Stops at the gateway's call cap; `missing` lists what's still undrawn. */
export async function bake(page: Page, ids?: StartId[]): Promise<{ file: string; pictures: Pictures; missing: string[]; stopped?: string }> {
  // The toy shop's four starts share one board, messy's two one page.
  const fixtures = FIXTURES.filter((f) => !ids || ids.includes(f.id)).filter((f, i, all) => all.findIndex((g) => g.ops === f.ops) === i);
  const pictures: Pictures = {};
  let stopped: string | undefined;
  for (const f of fixtures) {
    const scene = runScript(f.ops).scene;
    if (stopped || !scene.stacked().some((s) => s.drawing)) continue;
    const id = `bake-${f.id}`;
    await loadPage(page, page.labels.run, id, scene.toJSON(), f.start);
    const r = await page.eval<{ failed: string[]; scene: SceneJSON }>(FILL);
    await endCase(page.labels.run, id);
    for (const s of r.scene.shapes) if (s.drawing && s.picture?.done && s.picture.subject === s.drawing) pictures[pictureKey(s)] = { w: s.picture.w, h: s.picture.h, els: s.picture.els };
    if (r.failed.length && (await gatewayStatus()).capReached) stopped = `the call cap was reached at ${f.id}`;
  }
  const missing = fixtures.flatMap((f) => runScript(f.ops).scene.stacked().filter((s) => s.drawing).map(pictureKey)).filter((k) => !pictures[k]);
  const file = join(paths().out, "pictures.json");
  put(file, pictures);
  return { file, pictures, missing: [...new Set(missing)], stopped };
}
