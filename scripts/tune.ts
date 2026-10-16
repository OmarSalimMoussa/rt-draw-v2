// Replays labeled sets (playground saves, people's corrections, evals) under
// other knob values and reports the values that score best. Pure geometry: no
// browser, no network, no model calls; a few seconds for hundreds of marks.
//
//   node scripts/tune.ts sets/*.json [--parts marks,arrow,hit] [--out best.json]
//   node scripts/tune.ts router-set.json --parts router
//
// Synthetic ink (the eval's synthesizer marks its strokes source "synth") is refused
// for the ink readers' knobs (marks, arrow, hit, link) unless --allow-synth: tuned on
// it, they would learn the synthesizer's habits, not people's.
//
// Every 4th example is held out, so a "better" tuning that only memorized the
// set shows up as a drop on the held-out score.
import { readFileSync, writeFileSync } from "node:fs";
import { readArrow } from "../src/core/arrow.ts";
import { HitIndex } from "../src/core/hittest.ts";
import type { Example, LabeledSet } from "../src/core/labels.ts";
import { kindLabel, markOf, readMark } from "../src/core/marks.ts";
import { runScript } from "../src/core/ops.ts";
import { route } from "../src/core/router.ts";
import { DEFAULTS, KNOBS, type Tuning, diff, tune, tuningId } from "../src/core/tuning.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
// Grouping knobs (marks.gapMs, marks.nearPx) need whole sessions, not single marks; they're left out.
const parts = (flag("--parts") ?? "marks,arrow,hit").split(",");
const out = flag("--out");
const allowSynth = args.includes("--allow-synth");
if (allowSynth) args.splice(args.indexOf("--allow-synth"), 1);
const sets = args.map((f) => JSON.parse(readFileSync(f, "utf8")) as LabeledSet);
if (!sets.length) throw new Error("usage: node scripts/tune.ts set.json ... [--parts marks,arrow,hit] [--out best.json] [--allow-synth]");

const scenes = new Map<string, HitIndex>();
const hitsFor = (name = "clowns") => {
  if (!scenes.has(name)) scenes.set(name, new HitIndex(runScript(readFileSync(new URL(`../src/fixtures/${name}.ops.txt`, import.meta.url), "utf8")).scene));
  return scenes.get(name)!;
};

type Case = { ex: Example; scene?: string };
const cases: Case[] = sets.flatMap((s) => s.examples.map((ex) => ({ ex, scene: s.scene })));
const train = cases.filter((_, i) => i % 4 !== 3);
const held = cases.filter((_, i) => i % 4 === 3);
const INK_PARTS = ["marks", "arrow", "hit", "link"];
const synthetic = cases.filter((c) => c.ex.strokes?.some((s) => (s as { source?: string }).source === "synth")).length;
if (synthetic && !allowSynth && parts.some((p) => INK_PARTS.includes(p))) {
  console.error(`refused: ${synthetic} of ${cases.length} examples hold synthetic strokes (source "synth"); tuning ${parts.filter((p) => INK_PARTS.includes(p)).join(", ")} on them fits the synthesizer, not people. Pass --allow-synth to do it anyway.`);
  process.exit(2);
}

function decide({ ex, scene }: Case, t: Tuning): string {
  if (ex.decision === "marks.arrow") return readArrow(ex.strokes.map((s) => s.points), t).arrow ? "arrow" : "not";
  if (ex.decision === "marks.kind") return kindLabel(readMark(markOf(ex.strokes), hitsFor(scene), t));
  if (ex.decision === "router.lane") {
    // The send is kept as features: its words, its mark kinds and the scene's shape count.
    const f = ex.features ?? {};
    const kinds = String(f.markKinds ?? "").split(",").filter(Boolean);
    const marks = kinds.map((k) => (k === "sketch" ? { kind: "sketch" as const, how: "sketch" as const } : { kind: "pointing" as const, how: k as "loop" }));
    return route({ words: String(f.text ?? ""), marks, sceneShapes: Number(f.sceneShapes ?? 0) }, t).lane;
  }
  throw new Error(`no replay for decision "${ex.decision}"`);
}
const accuracy = (cs: Case[], t: Tuning) => (cs.length ? cs.filter((c) => decide(c, t) === c.ex.label).length / cs.length : 1);
const byDecision = (t: Tuning) => {
  const m = new Map<string, [number, number]>();
  for (const c of cases) {
    const [r, n] = m.get(c.ex.decision) ?? [0, 0];
    m.set(c.ex.decision, [r + (decide(c, t) === c.ex.label ? 1 : 0), n + 1]);
  }
  return [...m].map(([d, [r, n]]) => `${d} ${r}/${n}`).join(" · ");
};

// Coordinate search: each knob in turn over its range, keeping the best train score
// (ties go to the value nearest the default, so knobs only move when it helps).
const knobs = KNOBS.filter((k) => parts.some((p) => k.key.startsWith(`${p}.`)) && k.key !== "marks.gapMs" && k.key !== "marks.nearPx");
let best: Tuning = DEFAULTS;
let bestScore = accuracy(train, best);
const t0 = performance.now();
for (let round = 0; round < 2; round++) {
  for (const k of knobs) {
    const n = Math.min(40, Math.round((k.max - k.min) / k.step));
    for (let i = 0; i <= n; i++) {
      const v = Math.round((k.min + ((k.max - k.min) * i) / n) / k.step) * k.step;
      const cand = tune({ [k.key]: Number(v.toFixed(6)) }, best);
      const sc = accuracy(train, cand);
      const nearer = Math.abs(v - DEFAULTS[k.key]) < Math.abs(best[k.key] - DEFAULTS[k.key]);
      if (sc > bestScore || (sc === bestScore && nearer)) [best, bestScore] = [cand, sc];
    }
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
console.log(`${cases.length} examples from ${sets.length} set(s) (${cases.filter((c) => c.ex.corrected).length} corrected) · searched ${knobs.length} knobs in ${Math.round(performance.now() - t0)} ms`);
console.log(`defaults   train ${pct(accuracy(train, DEFAULTS))}  held out ${pct(accuracy(held, DEFAULTS))}  · ${byDecision(DEFAULTS)}`);
console.log(`${tuningId(best).padEnd(10)} train ${pct(bestScore)}  held out ${pct(accuracy(held, best))}  · ${byDecision(best)}`);
console.log("changes:", JSON.stringify(diff(best)));
if (out) writeFileSync(out, JSON.stringify({ tuningId: tuningId(best), tuning: diff(best) }, null, 1));
