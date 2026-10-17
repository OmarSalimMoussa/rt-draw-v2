// The driver probe (spec §2.8, N14): 8 driver calls that show the driver prompt and the served driver model can
// tell a good result from a bad one and don't pick the same thing every time, before a bank's ratings and miss
// checks rely on them. `rte probe` runs it, and so does every bank build or refresh whose evals/core/driver.ts or
// served driver model differs from the last probe's. A failed probe stops the banking until driver.ts changes or
// the owner accepts it (`rte probe --accept`, after reading probe.json).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "../core/driver.ts";
import { userMessage } from "../core/driver.ts";
import { personaOf, styleOf } from "../core/personas.ts";
import { ASK_WORDS } from "../core/scenarios.ts";
import { type Step, synthesize } from "../core/synth.ts";
import { loadFixture } from "../fixtures/fixtures.ts";
import { type Page, paintedCapture } from "./chrome.ts";
import { DRIVE_VIEW, sha256 } from "./config.ts";
import { type DriveCtx, driverTurn, loadPage, readingsOf } from "./drive.ts";
import { type MeterCall, readMeter } from "./meter.ts";
import { paths } from "./paths.ts";
import { put } from "./record.ts";
import type { AskType, CaseInput, SceneJSON } from "./types.ts";

/** The good result must rate at least `goodMin`, the bad one at most `badMax`; the spread must reach `distinct` targets and asks. */
export const PROBE = { goodMin: 3, badMax: 2, distinct: 4 };
/** The spread calls' asks, one each, on the same screen. */
const SPREAD: AskType[] = ["remove", "move", "resize", "restyle", "retext", "reorder"];

export type Probe = {
  at: string; driverHash: string; servedModel?: string; pass: boolean; why: string[];
  good?: number; bad?: number; saw: string[]; targets: string[]; asks: AskType[]; accepted?: boolean;
};

const file = () => join(paths().home, "probe.json");
const last = (): Probe | undefined => {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return undefined;
  }
};
export const driverHash = () => sha256(readFileSync(new URL("../core/driver.ts", import.meta.url), "utf8"));
const liveDriver = (l: MeterCall) => l.role === "driver" && l.mode === "live" && !!l.servedModel;
const servedDriver = () => (readMeter(paths().calls).filter((l): l is MeterCall => !("agent" in l) && liveDriver(l)).at(-1))?.servedModel;

/** Why a probe is due before drivers bank anything; undefined while the last one holds. */
export function probeDue(): string | undefined {
  const p = last();
  if (!p) return "no driver probe yet";
  if (p.driverHash !== driverHash()) return "evals/core/driver.ts changed since the last probe";
  const served = servedDriver();
  if (served && p.servedModel && served !== p.servedModel) return `the served driver model is now ${served} (the probe's was ${p.servedModel})`;
}

/** Why drivers may not bank now: a probe due, or the last one failed and the owner hasn't accepted it. */
export function probeRefuses(): string | undefined {
  const due = probeDue(), p = last();
  if (due) return `the driver probe is due: ${due}`;
  if (p && !p.pass && !p.accepted) return `the driver probe failed (${p.why.join("; ")}): read probe.json, then change driver.ts or rte probe --accept`;
}

/** The owner's word that a failed probe may bank anyway (this driver.ts and served model only). */
export function acceptProbe(): Probe {
  const p = last();
  if (!p || probeDue()) throw new Error(`no current probe to accept${p ? `: ${probeDue()}` : ""}: run rte probe --cap 8`);
  put(file(), { ...p, accepted: true });
  return { ...p, accepted: true };
}

/** The 8 calls on `page` (the champion's): the toy shop's home page, its nav turned pink after a send that asked for it and after one that didn't, then six asks on the plain page. */
export async function probe(ctx: DriveCtx, page: Page): Promise<Probe> {
  const { scene, start } = loadFixture("toyshop-home");
  const plain = scene.toJSON() as unknown as SceneJSON;
  const pink = structuredClone(plain) as { shapes: { id: string; style?: Record<string, unknown> }[] };
  const nav = pink.shapes.find((s) => s.id === "home-nav")!;
  nav.style = { ...nav.style, fill: "#f783ac" };
  const why: string[] = [];
  const shot = async (j: unknown) => {
    await loadPage(page, ctx.run, "probe", j as SceneJSON, start);
    const s = await paintedCapture(page, { width: DRIVE_VIEW.screenW, quality: DRIVE_VIEW.jpegQuality });
    if (s.blank) why.push("a blank capture of the probe's screen");
    return `data:image/jpeg;base64,${s.jpeg.toString("base64")}`;
  };
  const [before, after] = [await shot(plain), await shot(pink)];
  const card: Card = { persona: personaOf("explorer"), style: { ...styleOf("typical"), pen: 1 } };
  const turn = async (id: string, user: string, images: string[]) => (await driverTurn(ctx, id, user, images, start, () => {}))?.turn;

  // One result (the nav turned pink) after a send it meets and after one it doesn't; both should see the pink.
  const after1 = (said: string, meant: string) => userMessage(card, [{ said, marks: [], meant }], undefined, "restyle", 3);
  const good = await turn("probe-good", after1("make the nav pink", "the navigation bar along the top is pink"), [before, after]);
  const bad = await turn("probe-bad", after1("take the big purple banner away", "the big purple banner is gone"), [before, after]);
  if (!((good?.satisfaction ?? 0) >= PROBE.goodMin)) why.push(`the met ask rated ${good?.satisfaction ?? "nothing"} (< ${PROBE.goodMin})`);
  if (!((bad?.satisfaction ?? 9) <= PROBE.badMax)) why.push(`the missed ask rated ${bad?.satisfaction ?? "nothing"} (> ${PROBE.badMax})`);
  const saw = [good?.saw ?? "", bad?.saw ?? ""];
  if (!saw.every((s) => /pink/i.test(s))) why.push("its saw missed the pink nav");

  // The spread: the same screen, another ask each time; the first shape its marks point at, and whether its words ask that.
  const targets = new Set<string>(), asks = new Set<AskType>();
  for (const [i, a] of SPREAD.entries()) {
    const t = await turn(`probe-spread-${i + 1}`, userMessage(card, [], undefined, a, 3), [before, before]);
    if (!t) continue;
    const tl = synthesize(t.steps as Step[], { mess: 0, disfluency: 0 }, i + 1, { view: start });
    const first = readingsOf(plain, { camera: start, words: tl.words, strokes: tl.strokes, enterAtMs: 0, inputHash: "" } satisfies CaseInput, []).marks.flatMap((m) => m.targets)[0];
    if (first) targets.add(first);
    if (ASK_WORDS[a].test(`${tl.spoken} ${t.meant}`)) asks.add(a);
  }
  if (targets.size < PROBE.distinct) why.push(`${targets.size} distinct targets in ${SPREAD.length} calls (< ${PROBE.distinct})`);
  if (asks.size < PROBE.distinct) why.push(`${asks.size} of ${SPREAD.length} asks in its words (< ${PROBE.distinct})`);

  const servedModel = readMeter(paths().calls).filter((l): l is MeterCall => !("agent" in l) && l.run === ctx.run && liveDriver(l)).at(-1)?.servedModel;
  const p: Probe = { at: new Date().toISOString(), driverHash: driverHash(), servedModel, pass: !why.length, why, good: good?.satisfaction, bad: bad?.satisfaction, saw, targets: [...targets], asks: [...asks] };
  put(file(), p);
  return p;
}
