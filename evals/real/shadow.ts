// R1 beside a keep and every checkpoint (LOOP-V2.md A5): testers' real sends replayed on both arms of a decision
// or checkpoint, as the bank's cases are, and each arm's result scored by gold's free checks. The fidelity judge
// compares the arms against the owner-approved rubric. R1 decides nothing until the judge is calibrated on
// illustrations: it is reported, so the owner sees whether what the loop keeps helps what testers actually do.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sceneDiff } from "../core/diff.ts";
import { combined, fidelityCall, RUBRIC, swap, variants } from "../judge/judge.ts";
import { stepOf } from "../judge/packet.ts";
import { type Arms, type Judge, type Rig, runAB } from "../loop/ab.ts";
import { resized } from "../loop/chrome.ts";
import { LOOP } from "../loop/config.ts";
import { pairedRatio } from "../loop/latency.ts";
import { paths } from "../loop/paths.ts";
import { caseDir, put, putImage, runFile } from "../loop/record.ts";
import type { Arm, Expectation, Packet, Ratio, Row, SceneJSON } from "../loop/types.ts";
import { type Check, runChecks } from "./checks.ts";
import { fixedFile } from "./real.ts";

export type Shadow = {
  run: string; hash: string; cases: number; void: number;
  /** Cases one arm failed: that arm's loss in the share, and every one of its checks failed. */
  lost?: number;
  /**
   * Each arm's share of R1's free checks passed, and of cases passing every one of theirs: [A, B], each over the cases
   * that arm has a result for or failed itself.
   */
  checks: [number, number]; casesPassing: [number, number];
  /** The judge's share for B (wins + ½ ties) on the cases both arms ran, and by split: R-hold is people the loop never tuned on. */
  share?: number; shareHold?: number;
  ttfd?: Ratio; render?: Ratio;
};

const json = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8"));
const benchRoot = () => join(paths().home, "real", "bench", "R1");

/** R1's case ids, or none when it isn't frozen. */
export function r1Cases(): string[] {
  const root = benchRoot();
  if (!existsSync(join(root, "manifest.json"))) return [];
  return readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort();
}

/** R1's cases run on both arms, unshared (each arm's own calls), with the gold rubric as each case's expectation. */
async function runReal(rig: Rig, o: { run: string; arms: Arms; seed: string; judge?: Judge }) {
  const ids = r1Cases();
  const root = benchRoot();
  // The gold rubric is the expectation: the owner approved it, so no expectation judge re-makes it.
  for (const id of ids) {
    const rubric = json<{ should: string[]; mustNot: string[] }>(join(root, id, "rubric.json"));
    mkdirSync(caseDir(o.run, id), { recursive: true });
    put(join(caseDir(o.run, id), "expectation.json"), { judgeId: RUBRIC, should: rubric.should.slice(0, 4), mustNot: rubric.mustNot.slice(0, 2) } satisfies Expectation);
  }
  const { rows } = await runAB(rig, { run: o.run, kind: "ab", arms: o.arms, mode: "live", share: false, seed: o.seed, judge: o.judge, cases: ids, source: (id) => join(root, id) });
  // Per case, each arm's checks: passed or not, every one. An arm that failed the case (Row.lost) failed every one; the
  // other arm of a failed page has no result, so it isn't counted.
  const scored = rows.filter((r) => !r.void);
  const results = scored.map((r) => {
    const checks = json<Check[]>(join(root, r.case, "checks.json"));
    const before = json<SceneJSON>(join(root, r.case, "before.scene.json"));
    return (["A", "B"] as const).map((arm) => {
      if (r.lost?.arm === arm) return checks.map(() => false);
      const after = join(caseDir(o.run, r.case), arm, "after.scene.json");
      return existsSync(after) ? runChecks(checks, json<SceneJSON>(after), before).map((x) => x.pass) : r.lost ? undefined : checks.map(() => false);
    });
  });
  return { ids, rows, scored, live: rows.filter((r) => !r.void && !r.lost), results };
}

/**
 * Whether one champion run is as good as gold: the fidelity judge, blind and with the gold's rubric, compares the run's
 * result with gold/after.jpg in both orders, and gold may not win (orders that disagree are a tie, §4.4). Free checks
 * alone can't see a diagram with no labels or a subject that falls apart. Stores judge/gold-<arm>-1.json and -2.json.
 */
async function asGoodAsGold(run: string, id: string, arm: Arm): Promise<boolean> {
  const dir = caseDir(run, id), bench = join(benchRoot(), id);
  const e = json<Expectation>(join(dir, "expectation.json"));
  const gold = sceneDiff(json<SceneJSON>(join(bench, "before.scene.json")), json<SceneJSON>(join(bench, "gold.scene.json"))).changes;
  // Gold stands in as the other arm: positions only say which side is which.
  const other: Arm = arm === "A" ? "B" : "A";
  const p: Packet = {
    case: id, ...stepOf(id, run), expectation: { should: e.should, mustNot: e.mustNot },
    images: { before: "before-ink.jpg", left: `${arm}/after.jpg`, right: "gold/after.jpg" },
    changes: { left: json<string[]>(join(dir, arm, "changes.json")), right: gold },
    positions: { left: arm, right: other },
  };
  const v = variants().fidelity;
  const verdicts = await Promise.all([p.positions, swap(p.positions)].map((at) => fidelityCall(run, p, at, v)));
  verdicts.forEach((j, i) => put(join(dir, "judge", `gold-${arm}-${i + 1}.json`), j));
  return combined(verdicts[0], verdicts[1]) !== other;
}

/**
 * R1 on today's champion twice (an unshared A/A): the cases where both runs pass every one of their checks and the judge
 * finds both as good as gold are ones a later commit already fixed (LOOP-V2.md A5; the owner rejects failures of fixed
 * bugs), listed in real/fixed.json for the next freeze to leave out. Its rows are also R1's own noise: TTFD and render
 * between two identical arms.
 */
export async function realBaseline(rig: Rig, o: { run: string; arms: Arms; seed: string; champion: string }) {
  if (!r1Cases().length) throw new Error("R1 isn't frozen: rte real freeze first");
  const { ids, rows, scored, live, results } = await runReal(rig, o);
  const passing = scored.filter((r, i) => !r.lost && results[i].every((arm) => !!arm?.length && arm.every(Boolean))).map((r) => r.case);
  // Gold at the judge's size, as every arm's result is shot: at gold.jpg's twice the pixels, detail too small for the
  // arm's shot to show would count for gold.
  const page = (await rig.tab(0, "A", o.arms.A.tree)).page;
  for (const id of passing) putImage(join(caseDir(o.run, id), "gold", "after.jpg"), await resized(page, readFileSync(join(benchRoot(), id, "gold.jpg")), LOOP.judgePx, LOOP.judgeQuality));
  const judged = await Promise.all(passing.map(async (id) => ({ id, arms: await Promise.all((["A", "B"] as const).map((arm) => asGoodAsGold(o.run, id, arm))) })));
  const fixed = judged.filter((j) => j.arms.every(Boolean)).map((j) => j.id);
  // Added to the cases earlier baselines found: today's R1 already leaves those out, so they can't be found again.
  const before = existsSync(fixedFile()) ? json<{ ids: string[] }>(fixedFile()).ids : [];
  const out = { at: new Date().toISOString(), run: o.run, champion: o.champion, cases: ids.length, void: rows.length - live.length, passing, found: fixed, ids: [...new Set([...before, ...fixed])].sort(), ttfd: pairedRatio(live, "ttfd"), render: pairedRatio(live, "render") };
  writeFileSync(fixedFile(), `${JSON.stringify(out, null, 2)}\n`);
  put(runFile(o.run, "real-baseline.json"), out);
  return out;
}

/** R1 on both arms: rows like any run's, plus each arm's checks. Undefined when R1 isn't frozen. */
export async function realShadow(rig: Rig, o: { run: string; arms: Arms; seed: string; judge?: Judge }): Promise<Shadow | undefined> {
  if (!r1Cases().length) return undefined;
  const root = benchRoot();
  const { ids, rows, scored, live, results } = await runReal(rig, o);
  const passed: [number[], number[]] = [[], []];
  const whole: [number, number] = [0, 0], n: [number, number] = [0, 0];
  for (const res of results)
    res.forEach((arm, k) => {
      if (!arm) return;
      n[k]++;
      passed[k].push(...arm.map(Number));
      if (arm.every(Boolean)) whole[k]++;
    });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const split = (r: Row) => json<{ split: string }>(join(root, r.case, "case.json")).split;
  const shareOf = (rs: Row[]) => (rs.length ? mean(rs.map((r) => (r.s + 1) / 2)) : undefined);
  const hash = json<{ hash: string }>(join(root, "manifest.json")).hash;
  const out: Shadow = {
    run: o.run, hash, cases: ids.length, void: rows.length - scored.length, lost: scored.length - live.length,
    checks: [mean(passed[0]), mean(passed[1])], casesPassing: [n[0] ? whole[0] / n[0] : 0, n[1] ? whole[1] / n[1] : 0],
    share: shareOf(scored), shareHold: shareOf(scored.filter((r) => split(r) === "hold")),
    ttfd: pairedRatio(live, "ttfd"), render: pairedRatio(live, "render"),
  };
  put(runFile(o.run, "real.json"), out);
  return out;
}
