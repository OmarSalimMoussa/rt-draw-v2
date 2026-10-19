// Calibration (spec §4.5, N9, F27): the pairs the owner labels at /evals/label/, and whether the
// judge agrees with him well enough to decide. Most pairs are checkpoint 0's A/A (two real samples
// of the product on one input: the small differences real decisions see), then a contrast set so
// enough are clearly decidable, and bias probes: "did more" (one change list ≥ 2× the other) and
// synthetic "did nothing" (one side is the before-scene). Clear and slight labels are kept apart, and
// the bar follows the owner's own repeat agreement. A prompt whose variant 1 fails is re-judged on
// the labels with its frozen variant 2; only fidelity failing both stops the loop.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { View } from "../../src/core/board.ts";
import { LOOP } from "../loop/config.ts";
import { beforeOf } from "../loop/metrics.ts";
import { paths } from "../loop/paths.ts";
import { caseDir, put, putImage, runFile } from "../loop/record.ts";
import type { Arm, CaseInput, HealthRow, Judged, SceneJSON } from "../loop/types.ts";
import { type Label, type PairRef, standingLabels } from "../pages/plugin.ts";
import { calibrationFile, combined, craftCall, draw, fidelityCall, judging, pick, positionsFor, save, swap, variants } from "./judge.ts";
import { caseFile, readPacket } from "./packet.ts";
import type { Variant } from "./prompts.ts";

/** The label set's frozen shape; the pass numbers are LOOP.calib's. */
export const CALIB = {
  /** "did more" probes: change lists at least `ratio`× apart in length; "more detail" craft probes: shape counts `ratio`× apart. */
  more: 12, nothing: 8, ratio: 2,
  /** Repeats come from the first this many fidelity pairs (with room after them) and are shown again this many pairs later, so they come up before labelling stops. */
  repeatGap: 40,
  /** Where the synthetic "did nothing" cases live. */
  probeRun: "calib-probes",
};

type Pair = { run: string; case: string; subset: string };
type Side = Arm | "tie";
const json = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8"));
const maybe = <T>(f: string): T | undefined => (existsSync(f) ? json<T>(f) : undefined);
const pairsFile = () => join(dirname(paths().labels), "pairs.json");
const key = (p: Pair) => `${p.run}/${p.case}`;
const shuffle = <T>(xs: T[], seed: string | number, k: (x: T) => string) => [...xs].sort((a, b) => draw(seed, "calib", k(a)) - draw(seed, "calib", k(b)));
const judgedCases = (run: string) => {
  const d = runFile(run, "cases");
  return existsSync(d) ? readdirSync(d).filter((c) => existsSync(join(d, c, "judge", "fidelity-1.json"))).sort() : [];
};
const apart = (a: number, b: number, min = 1) => Math.min(a, b) >= min && Math.max(a, b) >= CALIB.ratio * Math.max(1, Math.min(a, b));
const shapes = (p: Pair, arm: Arm) => json<SceneJSON>(join(caseDir(p.run, p.case), arm, "after.scene.json")).shapes.length;
const changes = (p: Pair, arm: Arm) => json<string[]>(join(caseDir(p.run, p.case), arm, "changes.json")).length;

/**
 * A top-up ("more": fewer than 40 clear): fidelity pairs for contrast cases judged since pairs.json was written, put
 * after the fidelity pairs already there, so every labelled pair, probe and repeat keeps its id and place.
 */
export function topUpContrast(contrast: string): PairRef[] {
  const have = maybe<PairRef[]>(pairsFile()) ?? [];
  const known = new Set(have.map((p) => p.id));
  const add: PairRef[] = judgedCases(contrast).map((c) => ({ id: `f:${contrast}:${c}`, run: contrast, case: c, question: "fidelity" as const, subset: "contrast" })).filter((p) => !known.has(p.id));
  const at = have.findIndex((p) => p.question === "craft");
  put(pairsFile(), at < 0 ? [...have, ...add] : [...have.slice(0, at), ...add, ...have.slice(at)]);
  return add;
}

/**
 * Writes labels/pairs.json from checkpoint 0 (`aa`) and the contrast run, after building the "did
 * nothing" probes (their before-scene side captured by `capture`: 0 model calls) and judging what has
 * no verdict yet: the probes' fidelity and the contrast cases' craft (~30 calls; checkpoint cases have both).
 */
export async function assemble(o: { aa: string; contrast: string; seed: string | number; capture: (scene: SceneJSON, camera: View) => Promise<Uint8Array> }): Promise<PairRef[]> {
  const real: Pair[] = [...judgedCases(o.aa).map((c) => ({ run: o.aa, case: c, subset: "aa" })), ...judgedCases(o.contrast).map((c) => ({ run: o.contrast, case: c, subset: "contrast" }))];
  const more = new Set(shuffle(real.filter((p) => apart(changes(p, "A"), changes(p, "B"))), o.seed, key).slice(0, CALIB.more));

  // "Did nothing": an A/A case's arm A (it changed something) against its own before-scene, as arm B.
  const nothing = shuffle(real.filter((p) => p.subset === "aa" && !more.has(p) && changes(p, "A") > 0), o.seed, key).slice(0, CALIB.nothing);
  const pos = positionsFor(nothing.map((p) => p.case), o.seed);
  const probes = judging(CALIB.probeRun, { seed: o.seed, craft: "none" });
  await Promise.all(nothing.map(async (p) => {
    const [from, to] = [caseDir(p.run, p.case), caseDir(CALIB.probeRun, p.case)];
    putImage(join(to, "A", "after.jpg"), readFileSync(join(from, "A", "after.jpg")));
    for (const f of ["after.scene.json", "changes.json"]) put(join(to, "A", f), readFileSync(join(from, "A", f), "utf8"));
    const before = beforeOf(p.run, p.case);
    put(join(to, "B", "after.scene.json"), before);
    put(join(to, "B", "changes.json"), []);
    putImage(join(to, "B", "after.jpg"), await o.capture(before, json<CaseInput>(caseFile(p.case, "input.json", p.run)).camera));
    await probes.judgeCase(p.case, pos.get(p.case)!);
  }));
  const craftOf = (p: Pair) => join(caseDir(p.run, p.case), "judge", "craft.json");
  await Promise.all(real.filter((p) => !existsSync(craftOf(p))).map(async (p) => put(craftOf(p), await craftCall(p.run, readPacket(p.run, p.case), variants().craft))));

  const ref = (p: Pair, q: "fidelity" | "craft", subset: string): PairRef => ({ id: `${q[0]}:${p.run}:${p.case}`, run: p.run, case: p.case, question: q, subset });
  const probePairs = nothing.map((p) => ({ run: CALIB.probeRun, case: p.case, subset: "nothing" }));
  const fid = shuffle([...real, ...probePairs], o.seed, key).map((p) => ref(p, "fidelity", more.has(p) ? "more" : p.subset));
  // Only pairs with room for the gap after them can be repeated.
  const repeats = shuffle(fid.slice(0, Math.min(CALIB.repeatGap, fid.length - CALIB.repeatGap - 1)), `${o.seed}:repeats`, (r) => r.id).slice(0, LOOP.calib.repeats);
  // From the back, so each insert leaves the earlier originals where they were.
  for (const r of repeats.sort((a, b) => fid.indexOf(b) - fid.indexOf(a))) fid.splice(fid.indexOf(r) + CALIB.repeatGap + 1, 0, { ...r, id: `${r.id}:r`, swap: true });
  const detail = (p: Pair) => apart(shapes(p, "A"), shapes(p, "B"), 0);
  const craft = [...shuffle(real.filter(detail), o.seed, key).map((p) => ref(p, "craft", "detail")), ...shuffle(real.filter((p) => !detail(p)), o.seed, key).map((p) => ref(p, "craft", p.subset))];
  put(pairsFile(), [...fid, ...craft]);
  return [...fid, ...craft];
}

/** One label against the judge. bigger: on a probe, the side with the longer change list ("more") or more shapes ("detail"). */
export type CalibRow = { pair: string; question: "fidelity" | "craft"; subset?: string; label: Side; strength: "clear" | "slight" | null; judge: Side; bigger?: Arm };

/** Agreement with one label: the same side 1; a judge tie on a decisive label, or a decisive verdict on a tie label, 0.5; else 0. */
export const agreement = (label: Side, judge: Side) => (label === judge ? 1 : label === "tie" || judge === "tie" ? 0.5 : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const share = (rows: CalibRow[]) => (rows.length ? sum(rows.map((r) => agreement(r.label, r.judge))) / rows.length : NaN);
/** How much more often the judge picks the bigger side than the owner does. */
const preferMore = (probes: CalibRow[]) => (probes.length ? (probes.filter((r) => r.judge === r.bigger).length - probes.filter((r) => r.label === r.bigger).length) / probes.length : 0);
const EPS = 1e-9;

/** §4.5's fidelity rule on the first label of each pair; `repeats` holds the owner's two labels of each repeated pair. */
export function scoreFidelity(rows: CalibRow[], repeats: [Side, Side][]) {
  const { clear: N, pass: K, minClear, selfGap, preferMoreMax } = LOOP.calib;
  const clear = rows.filter((r) => r.strength === "clear").slice(0, N);
  const score = sum(clear.map((r) => agreement(r.label, r.judge)));
  const decisive = rows.filter((r) => r.strength);
  const self = repeats.length ? repeats.filter(([a, b]) => a === b).length / repeats.length : NaN;
  const probes = rows.filter((r) => r.bigger);
  const rules = {
    // ≥ 47 of 60 clear, or the same 78% on at least 40.
    clear: clear.length >= N ? score >= K : score / clear.length >= K / N - EPS,
    // The bar follows how decidable the pairs really are: the owner's own repeat agreement − 0.10.
    self: share(decisive) >= self - selfGap - EPS,
    probes: preferMore(probes) <= preferMoreMax + EPS,
  };
  const bySubset = Object.fromEntries([...new Set(decisive.map((r) => r.subset ?? "-"))].map((s) => {
    const of = decisive.filter((r) => (r.subset ?? "-") === s);
    return [s, { n: of.length, share: share(of) }];
  }));
  const slight = rows.filter((r) => r.strength === "slight");
  return {
    pass: clear.length >= minClear && Object.values(rules).every(Boolean), more: clear.length < minClear, rules,
    clear: { n: clear.length, score }, decisive: { n: decisive.length, share: share(decisive) }, slight: { n: slight.length, share: share(slight) },
    self: { n: repeats.length, share: self }, probes: { n: probes.length, preferMore: preferMore(probes) }, bySubset,
  };
}

/** The craft rule: ≥ 22 of 30 craft labels (the same share on at least 20, as fidelity's 40 of 60), and the more-detail probe rule. */
export function scoreCraft(rows: CalibRow[]) {
  const { craftPairs: N, craftPass: K, clear, minClear, preferMoreMax } = LOOP.calib;
  const first = rows.slice(0, N);
  const score = sum(first.map((r) => agreement(r.label, r.judge)));
  const probes = first.filter((r) => r.bigger);
  const rules = { agree: first.length >= N ? score >= K : score / first.length >= K / N - EPS, probes: preferMore(probes) <= preferMoreMax + EPS };
  const more = first.length < Math.ceil((N * minClear) / clear);
  return { pass: !more && rules.agree && rules.probes, more, rules, n: first.length, score, probes: { n: probes.length, preferMore: preferMore(probes) } };
}

export type Outcome = "pass" | "pass-no-craft" | "variant-2" | "stop" | "more";
/** more: label more pairs (or run 16 more contrast pairs, fewer than 40 clear). Only a variant-2 fidelity failure stops the loop. */
export function outcomeOf(variant: Variant, fid: { pass: boolean; more: boolean }, craft: { pass: boolean; more: boolean }): Outcome {
  if (fid.more || craft.more) return "more";
  if (fid.pass && craft.pass) return "pass";
  if (variant === 1) return "variant-2";
  return fid.pass ? "pass-no-craft" : "stop";
}

/** The judge's verdict on a pair at variant v: the run's own files if asked with v, else judge/v<v>/, else judged now into judge/v<v>/. */
async function verdictFor(p: PairRef, v: Variant): Promise<Side> {
  const dir = join(caseDir(p.run, p.case), "judge");
  const names = p.question === "craft" ? ["craft.json"] : ["fidelity-1.json", "fidelity-2.json"];
  for (const sub of ["", `v${v}`]) {
    const [a, b] = names.map((n) => maybe<Judged>(join(dir, sub, n)));
    if (a && (a.variant ?? 1) === v) return combined(a, b);
  }
  const packet = readPacket(p.run, p.case);
  const out = (n: string) => join(dir, `v${v}`, n);
  const callRun = `calib-v${v}`;
  if (p.question === "craft") {
    const c = await craftCall(p.run, packet, v, callRun);
    put(out("craft.json"), c);
    return pick(c);
  }
  const first = await fidelityCall(p.run, packet, packet.positions, v, callRun);
  put(out("fidelity-1.json"), first);
  if (first.winner === "tie" || first.confidence > LOOP.lowConfidence) return pick(first);
  const second = await fidelityCall(p.run, packet, swap(packet.positions), v, callRun);
  put(out("fidelity-2.json"), second);
  return combined(first, second);
}

type Calibration = { use: { fidelity: Variant | null; craft: Variant | null }; outcome: Outcome; checks: unknown[] };

/**
 * `rte calib --check [--variant 2]`: the owner's labels against the judge (0 calls with variant 1, the
 * verdicts exist; ~120 with variant 2, which re-judges only the prompt that failed). Writes
 * history/judge/calibration.json, whose `use` judge.ts reads.
 */
export async function checkCalibration(variant: Variant = 1) {
  const pairs = new Map(json<PairRef[]>(pairsFile()).map((p) => [p.id, p]));
  const prior = maybe<Calibration>(calibrationFile());
  // A prompt that passed with variant 1 stays on it.
  const vOf = (q: "fidelity" | "craft"): Variant => (variant === 2 && prior?.use?.[q] === 1 ? 1 : variant);
  const first = new Map<string, Label>();
  const again: Label[] = [];
  for (const l of standingLabels(paths().labels)) {
    const p = pairs.get(l.pair);
    if (!p || l.label === "skip") continue;
    if (p.swap) again.push(l);
    else if (!first.has(p.id)) first.set(p.id, l);
  }
  const rows = await Promise.all([...first.values()].map(async (l): Promise<CalibRow> => {
    const p = pairs.get(l.pair)!;
    const pair = { run: p.run, case: p.case, subset: p.subset ?? "" };
    const [a, b] = p.question === "fidelity" && p.subset === "more" ? [changes(pair, "A"), changes(pair, "B")] : p.question === "craft" && p.subset === "detail" ? [shapes(pair, "A"), shapes(pair, "B")] : [0, 0];
    const bigger: Arm | undefined = a === b ? undefined : a > b ? "A" : "B";
    return { pair: p.id, question: p.question, subset: p.subset, label: l.label as Side, strength: l.strength, judge: await verdictFor(p, vOf(p.question)), ...(bigger ? { bigger } : {}) };
  }));
  const repeats = again.flatMap((l): [Side, Side][] => {
    const orig = first.get(l.pair.replace(/:r$/, ""));
    return orig ? [[orig.label as Side, l.label as Side]] : [];
  });
  const fidelity = scoreFidelity(rows.filter((r) => r.question === "fidelity"), repeats);
  const craft = scoreCraft(rows.filter((r) => r.question === "craft"));
  const outcome = outcomeOf(variant, fidelity, craft);
  const use = { fidelity: fidelity.pass ? vOf("fidelity") : null, craft: craft.pass ? vOf("craft") : null };
  const at = new Date().toISOString();
  save(calibrationFile(), { use, outcome, checks: [...(prior?.checks ?? []), { at, variant, outcome, fidelity, craft }] });
  const health: HealthRow = { at, kind: "calib", pass: outcome === "pass" || outcome === "pass-no-craft", detail: { variant, outcome, use } };
  return { outcome, use, fidelity, craft, health };
}
