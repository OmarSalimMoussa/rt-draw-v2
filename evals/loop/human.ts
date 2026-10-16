// The human set U1 (spec §2.8): the owner's real sends from /playgrounds/draw/?record=1 (human/<id>.json,
// written by the pages plugin) that he wrote a `meant` for, frozen by `human freeze` into bench/U1 beside
// B1, so every checkpoint also measures the product on a real person's words and marks. A typed send keeps
// its text (input.json's words is then a string). The before image is shot on a bridge page with the
// frozen ink overlay, numbered, as the bank's are; the expectation is made at the first checkpoint and
// written back. A send frozen before keeps its image, so a re-freeze that adds sends moves only their hash.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { View } from "../../src/core/board.ts";
import type { Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";
import { writeManifest } from "./checkpoint.ts";
import { type Page, capture } from "./chrome.ts";
import { LOOP, sha256 } from "./config.ts";
import { commitHistory, historyWrite, openHistory } from "./history.ts";
import { paths } from "./paths.ts";
import type { BenchManifest, CaseInfo, CaseInput, Meant, SceneJSON } from "./types.ts";

/** human/<id>.json as the pages plugin stores it. */
type HumanSend = { id: string; input: Word[] | string; strokes: Stroke[]; scene: SceneJSON; view: View; at?: string; recordedAt?: string; meant?: string };
/** The before image with the person's ink: a JPEG at the judges' size. */
export type Shot = (scene: SceneJSON, camera: View, strokes: Stroke[]) => Promise<Uint8Array>;

const js = JSON.stringify;

/** A Shot on a bridge page (a rig tab, at /evals/bridge/). */
export const pageShot = (page: Page): Shot => async (scene, camera, strokes) => {
  await page.reload();
  await page.eval("new Promise((r) => { const t = () => (window.rtEval ? r() : setTimeout(t, 20)); t(); })");
  await page.eval(`rtEval.load(${js({ scene, camera })})`);
  await page.eval(`rtEval.showInk(${js(strokes)}, { numbers: true })`);
  return capture(page, { width: LOOP.judgePx, quality: LOOP.judgeQuality });
};

/** `human freeze`: every recorded send with a meant, as bench/U1/<id>/, its manifest and one commit. */
export async function freezeHuman(shot: Shot): Promise<BenchManifest> {
  const dir = paths().human;
  const sends = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => /^h-[\w-]+\.json$/.test(n)).sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as HumanSend).filter((s) => s.meant?.trim());
  if (!sends.length) throw new Error("no recorded send has a meant yet: write them on the labeling page's “your sends” tab");
  const root = join(openHistory(), "bench", "U1");
  for (const [i, s] of sends.entries()) {
    const f = (name: string) => `bench/U1/${s.id}/${name}`;
    // A person's send has no scenario, persona, beat or ask: only what it is. One sitting (a day) is one cluster.
    const info = { id: s.id, set: "human", originSession: `h-${s.id.slice(2, 10)}`, send: i + 1, recordedAt: s.recordedAt ?? s.at ?? "", hedged: false, beatDone: false, flags: ["human"] } as unknown as CaseInfo;
    historyWrite(f("case.json"), info);
    historyWrite(f("input.json"), { camera: s.view, words: s.input, strokes: s.strokes, enterAtMs: 0, inputHash: sha256(js([s.view, s.input, s.strokes])) } satisfies CaseInput);
    historyWrite(f("before.scene.json"), s.scene);
    historyWrite(f("meant.json"), { meant: s.meant!.trim(), hedged: false } satisfies Meant);
    if (!existsSync(join(root, s.id, "before-ink.jpg"))) writeFileSync(join(root, s.id, "before-ink.jpg"), await shot(s.scene, s.view, s.strokes));
  }
  const m = writeManifest("U1");
  commitHistory(`human freeze: U1 = ${sends.length} of the owner's sends (${m.hash.slice(0, 12)})`);
  return m;
}
