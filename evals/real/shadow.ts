// R1 beside a keep and every checkpoint (LOOP-V2.md A5): admitted real sends with gold (evals/real/cases.ts) replayed
// on both arms of a decision or checkpoint, as the bank's cases are, and each arm's result scored by gold's free checks.
// The fidelity judge compares the arms against the card's rubric (gold's, or the owner's edit of it). R1 is a report and
// decides nothing, so the owner sees whether what the loop keeps helps what testers actually do, R-hold's people (whom
// the loop never tunes on) apart. A case both arms already get right is a tie, not noise to remove.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUBRIC } from "../judge/judge.ts";
import { type Arms, type Judge, type Rig, runAB } from "../loop/ab.ts";
import { pairedRatio } from "../loop/latency.ts";
import { paths } from "../loop/paths.ts";
import { caseDir, put, runFile } from "../loop/record.ts";
import type { Expectation, Ratio, Row, SceneJSON } from "../loop/types.ts";
import { type Check, runChecks } from "./checks.ts";

export type Shadow = {
  run: string; hash: string; cases: number; void: number;
  /** Cases one arm failed: that arm's loss in the share, and every one of its checks failed. */
  lost?: number;
  /**
   * Each arm's share of R1's free checks passed, and of cases passing every one of theirs: [A, B], each over the cases
   * that have checks and that arm has a result for or failed itself.
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

/** R1 on both arms, unshared (each arm's own calls): rows like any run's, plus each arm's checks. Undefined when R1 isn't frozen. */
export async function realShadow(rig: Rig, o: { run: string; arms: Arms; seed: string; judge?: Judge }): Promise<Shadow | undefined> {
  const ids = r1Cases();
  if (!ids.length) return undefined;
  const root = benchRoot();
  // The card's rubric is the expectation, all of it: admitted by the owner, so no expectation judge re-makes or trims it.
  for (const id of ids) {
    const rubric = json<{ should: string[]; mustNot: string[] }>(join(root, id, "rubric.json"));
    mkdirSync(caseDir(o.run, id), { recursive: true });
    put(join(caseDir(o.run, id), "expectation.json"), { judgeId: RUBRIC, should: rubric.should, mustNot: rubric.mustNot } satisfies Expectation);
  }
  const { rows } = await runAB(rig, { run: o.run, kind: "ab", arms: o.arms, mode: "live", share: false, seed: o.seed, judge: o.judge, cases: ids, source: (id) => join(root, id) });
  const scored = rows.filter((r) => !r.void), live = scored.filter((r) => !r.lost);
  // Per case with checks, each arm's: passed or not, every one. An arm that failed the case (Row.lost) failed every one;
  // the other arm of a failed page has no result, so it isn't counted. A case with no checks has nothing to pass.
  const passed: [number[], number[]] = [[], []];
  const whole: [number, number] = [0, 0], n: [number, number] = [0, 0];
  for (const r of scored) {
    const checks = json<Check[]>(join(root, r.case, "checks.json"));
    if (!checks.length) continue;
    const before = json<SceneJSON>(join(root, r.case, "before.scene.json"));
    (["A", "B"] as const).forEach((arm, k) => {
      const after = join(caseDir(o.run, r.case), arm, "after.scene.json");
      const res = r.lost?.arm === arm ? checks.map(() => false) : existsSync(after) ? runChecks(checks, json<SceneJSON>(after), before).map((x) => x.pass) : r.lost ? undefined : checks.map(() => false);
      if (!res) return;
      n[k]++;
      passed[k].push(...res.map(Number));
      if (res.every(Boolean)) whole[k]++;
    });
  }
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
