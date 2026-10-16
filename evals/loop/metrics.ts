// Per-case metrics (spec §5.1), computed by frozen harness code from a run's raw files: each
// arm's result.json and timing.json (the harness clock), the before and after scenes, the judge
// files and the gateway's call lines. The product's own numbers are never used. rows.jsonl is
// built here, so remetric.ts can rebuild it after a metric fix with the code that wrote it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sceneDiff } from "../core/diff.ts";
import { paths } from "./paths.ts";
import { appendLine, caseDir, runFile } from "./record.ts";
import type { Arm, ArmResult, ArmTiming, CallLog, Judged, Row, SceneJSON } from "./types.ts";

/** Roles that aren't the product's (§7.3): their calls never count toward an arm's cost. */
const EVAL_ROLES = new Set(["driver", "judge", "craft", "expectation", "miss", "failure", "probe"]);
/** The resolver and drawing calls, whose thinking splits the latency verdicts (latency-4). */
const THINKS = /^(draw|resolve)/;

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? json<T>(file) : undefined);

export type ArmMetrics = {
  ttfc: number | null; ttd: number; ttlo?: number;
  firstTextMs?: number; resolverMs?: number; picturesMs?: number; waitMs?: number;
  thought: boolean; work: number; empty: boolean; usd: number;
  opsFailed: number; picsDrawn: number; picsFailed: number; maxTokens: number;
  renders: number; longTasksMs: number; heapMb: number; gatewayLoopP99Ms: number;
  /** Pictures drawn (or tried) for shapes the send didn't change: must be 0 (V12's guard). */
  strayPictures: number;
};

/** This run's call lines from the meter. Read it once per run, not per case: it holds every run's calls. */
export function meterOf(runId: string): CallLog[] {
  if (!existsSync(paths().calls)) return [];
  return readFileSync(paths().calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallLog).filter((c) => c.run === runId);
}

/** The scene the case started from: the run's own copy (a continuation send), else the banked case's. */
export const beforeOf = (runId: string, caseId: string): SceneJSON =>
  maybe<SceneJSON>(join(caseDir(runId, caseId), "before.scene.json")) ?? json<SceneJSON>(join(paths().bankCase(caseId), "before.scene.json"));

/** One arm's metrics for one case. */
export function armMetrics(runId: string, caseId: string, arm: Arm, before: SceneJSON, calls: CallLog[]): ArmMetrics {
  const dir = join(caseDir(runId, caseId), arm);
  const result = json<ArmResult>(join(dir, "result.json"));
  const timing = json<ArmTiming>(join(dir, "timing.json"));
  const diff = sceneDiff(before, json<SceneJSON>(join(dir, "after.scene.json")));
  const changed = new Set(diff.changed);
  const stray = new Set([...diff.pictured, ...(result.pics?.failed ?? [])].filter((id) => !changed.has(id)));
  const product = result.calls.filter((c) => !EVAL_ROLES.has(c.role));
  // A follower got the leader's reply for free; both arms are charged the call, so sharing never reads as a saving.
  const mine = calls.filter((c) => c.case === caseId && !EVAL_ROLES.has(c.role));
  const usd = mine
    .filter((c) => c.arm === arm)
    .reduce((a, c) => a + (c.shared === "follower" && !c.listUsd ? (mine.find((l) => l.reqHash === c.reqHash && l.shared === "leader")?.listUsd ?? 0) : c.listUsd), 0);
  const waits = product.map((c) => c.waitMs).filter((w): w is number => w !== undefined);
  return {
    ttfc: timing.ttfcMs ?? null, ttd: timing.ttdMs, ttlo: timing.ttloMs,
    firstTextMs: product.find((c) => c.role === "draw")?.firstMs,
    resolverMs: product.find((c) => /resolve|refs/.test(c.role))?.ms,
    picturesMs: result.pics?.ms,
    waitMs: waits.length ? Math.max(...waits) : undefined,
    thought: product.some((c) => THINKS.test(c.role) && (c.thinkingTokens ?? 0) > 0),
    work: diff.work, empty: diff.empty, usd,
    opsFailed: result.ops.filter((o) => !o.ok).length,
    picsDrawn: result.pics?.drawn ?? 0, picsFailed: result.pics?.failed.length ?? 0,
    maxTokens: result.stopReasons.filter((s) => s === "max_tokens").length,
    renders: timing.renders, longTasksMs: timing.longTasksMs, heapMb: timing.heapMb, gatewayLoopP99Ms: timing.gatewayLoopP99Ms,
    strayPictures: stray.size,
  };
}

/** Both arms' metrics and the per-case invariant inputs (§7.5): stray pictures, heap, gateway event-loop p99. */
export function caseMetrics(runId: string, caseId: string, calls = meterOf(runId)) {
  const before = beforeOf(runId, caseId);
  const A = armMetrics(runId, caseId, "A", before, calls);
  const B = armMetrics(runId, caseId, "B", before, calls);
  return {
    A, B,
    strayPictures: A.strayPictures + B.strayPictures,
    heapMb: Math.max(A.heapMb, B.heapMb),
    gatewayLoopP99Ms: Math.max(A.gatewayLoopP99Ms, B.gatewayLoopP99Ms),
  };
}

/** A verdict's score for B: +1 B won, −1 A won, 0 a tie. */
const scoreOf = (j?: Judged): -1 | 0 | 1 => (!j || j.winner === "tie" ? 0 : j.positions[j.winner] === "B" ? 1 : -1);

/** The case's fidelity and craft scores from its judge files: two orders that disagree score 0 (§1.3). */
function scores(runId: string, caseId: string) {
  const at = (f: string) => maybe<Judged>(join(caseDir(runId, caseId), "judge", f));
  const [f1, f2, craft] = [at("fidelity-1.json"), at("fidelity-2.json"), at("craft.json")];
  const s = f2 && scoreOf(f1) !== scoreOf(f2) ? 0 : scoreOf(f1);
  return { s, sCraft: craft ? scoreOf(craft) : undefined };
}

/** What a row records but no metric computes: the runner's facts about the case. */
export type RowFacts = Pick<Row, "case" | "cluster" | "affected" | "class" | "overuse" | "ask" | "beat" | "firstArm" | "void">;

/** A case's rows.jsonl line: the runner's facts plus every metric, from the raw files (a void row has no metrics). */
export function rowOf(runId: string, f: RowFacts, calls: CallLog[]): Row {
  const head = { case: f.case, cluster: f.cluster, affected: f.affected, class: f.class };
  const tail = { overuse: f.overuse, ask: f.ask, ...(f.beat ? { beat: f.beat } : {}), firstArm: f.firstArm };
  if (f.void)
    return { ...head, s: 0, ttfc: [null, null], ttd: [0, 0], work: [0, 0], usd: [0, 0], thought: [false, false], pics: [[0, 0], [0, 0]], ...tail, void: f.void };
  const m = caseMetrics(runId, f.case, calls);
  const { s, sCraft } = scores(runId, f.case);
  const pair = <T>(k: (x: ArmMetrics) => T): [T, T] => [k(m.A), k(m.B)];
  return {
    ...head, s, ...(sCraft !== undefined ? { sCraft } : {}),
    ttfc: pair((x) => x.ttfc), ttd: pair((x) => x.ttd), work: pair((x) => x.work), usd: pair((x) => x.usd), thought: pair((x) => x.thought),
    pics: pair((x): [number, number] => [x.picsDrawn, x.picsFailed]),
    ...tail,
  };
}

export const appendRow = (runId: string, row: Row) => appendLine(runFile(runId, "rows.jsonl"), row);

/** rows.jsonl, one row per case in the order cases were first written (a resumed case's later row wins). */
export function readRows(runId: string): Row[] {
  const file = runFile(runId, "rows.jsonl");
  if (!existsSync(file)) return [];
  const by = new Map<string, Row>();
  for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Row;
    by.set(r.case, r);
  }
  return [...by.values()];
}
