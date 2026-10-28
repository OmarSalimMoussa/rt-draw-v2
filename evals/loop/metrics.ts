// Per-case metrics (spec §5.1), computed by frozen harness code from a run's raw files: each
// arm's result.json and timing.json (the harness clock), the before and after scenes, the judge
// files and the gateway's call lines. The product's own numbers are never used. rows.jsonl is
// built here, so remetric.ts can rebuild it after a metric fix with the code that wrote it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sceneDiff } from "../core/diff.ts";
import { readReply } from "./cache.ts";
import { listUsd } from "./meter.ts";
import { isRealCase, paths } from "./paths.ts";
import { appendLine, caseDir, runFile } from "./record.ts";
import type { Arm, ArmResult, ArmTiming, CallLog, Engine, EngineRun, Judged, Row, Same, SceneJSON } from "./types.ts";

/** The eval roles of meter lines from before the gateway marked each line's page: every other role was the product's. */
const OLD_EVAL_ROLES = new Set(["driver", "judge", "craft", "expectation", "miss", "failure", "probe", "analyst", "canary", "real-triage", "real-gold"]);
/** A product call (an arm page's), not the harness's own roles (§7.3): only these count toward an arm's cost. */
export const isProduct = (c: Pick<CallLog, "page" | "role">) => c.page ?? !OLD_EVAL_ROLES.has(c.role);
/** The resolver and drawing calls, whose thinking splits the latency verdicts (latency-4). */
const THINKS = /^(draw|resolve)/;

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? json<T>(file) : undefined);
/**
 * A send's render (LOOP-V2.md A2): one paint plus one op's apply, the mean over both arms' boards when the engine was
 * timed on both, so the two arms' engines are compared on the same content: of each board, only what both engines'
 * timings share (Engine.same: paint and apply, paint alone, or nothing); none when they share nothing. On B's own board
 * with paint alone (a new op A's engine can't apply), B's apply still counts, against A's paint alone: a slow new op
 * shows, and what A's apply would have added falls on B.
 */
const renderOf = (e: Engine, arm: Arm) => {
  const cost = (x: EngineRun | undefined, s: Same = "all", apply = s === "all") => (!x || s === "none" ? undefined : x.paintMs + (apply ? x.applyMs / Math.max(1, x.ops) : 0));
  if (!e.same && e.skew) return null;
  const xs = [cost(e, e.same?.own, e.same?.own !== "paint" || arm === "B"), cost(e.other, e.same?.other)].filter((x): x is number => x !== undefined);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

export type ArmMetrics = {
  ttfc: number | null; ttd: number; ttlo?: number;
  /**
   * The deciding latencies (LOOP-V2.md): time to first drawing, and render: the engine's time from an op landing to it
   * on screen on this send's board (one op's apply, the send's average, plus one paint), measured idle; null before them.
   */
  ttfd: number | null; render: number | null; deferred: boolean; renderSame: Same;
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

/**
 * What a replayed call cost when it was recorded. A live A/B replays the calls the bank already holds (the champion's,
 * byte for byte) and makes the candidate's changed ones fresh: charged $0, the champion's arm read as free and any card
 * that changes a prompt as several times dearer (×6.00 on e4-h2, whose own calls cost $0.0001).
 */
function recordedUsd(c: CallLog): number {
  const r = readReply(paths(), c.reqHash, c.run, false, c.case);
  const s = r?.stats as Record<string, number | undefined> | undefined;
  return r && s ? listUsd(r.request.model, { inTokens: s.inTokens ?? 0, cacheRead: s.cacheRead ?? 0, cacheWrite5m: s.write5m ?? 0, cacheWrite1h: s.write1h ?? 0, outTokens: s.outTokens ?? 0 }) : 0;
}

/** One arm's metrics for one case. */
export function armMetrics(runId: string, caseId: string, arm: Arm, before: SceneJSON, calls: CallLog[]): ArmMetrics {
  const dir = join(caseDir(runId, caseId), arm);
  const result = json<ArmResult>(join(dir, "result.json"));
  const timing = json<ArmTiming>(join(dir, "timing.json"));
  const diff = sceneDiff(before, json<SceneJSON>(join(dir, "after.scene.json")));
  const changed = new Set(diff.changed);
  const stray = new Set([...diff.pictured, ...(result.pics?.failed ?? [])].filter((id) => !changed.has(id)));
  const product = result.calls.filter(isProduct);
  // A follower got the leader's reply for free; both arms are charged the call, so sharing never reads as a saving.
  // A replayed call is charged what it cost when recorded, so the arm the bank holds isn't free.
  const mine = calls.filter((c) => c.case === caseId && isProduct(c));
  const usd = mine
    .filter((c) => c.arm === arm)
    .reduce((a, c) => a + (c.mode === "replay" ? recordedUsd(c) : c.shared === "follower" && !c.listUsd ? (mine.find((l) => l.reqHash === c.reqHash && l.shared === "leader")?.listUsd ?? 0) : c.listUsd), 0);
  const waits = product.map((c) => c.waitMs).filter((w): w is number => w !== undefined);
  return {
    ttfc: timing.ttfcMs ?? null, ttd: timing.ttdMs, ttlo: timing.ttloMs, ttfd: timing.ttfdMs ?? null, render: timing.engine ? renderOf(timing.engine, arm) : null, deferred: !!timing.engine?.deferred, renderSame: timing.engine?.same?.own ?? "all",
    // With copies, the one that streamed (a dropped copy has no first text).
    firstTextMs: product.find((c) => c.role === "draw" && c.firstMs !== undefined)?.firstMs,
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
export type RowFacts = Pick<Row, "case" | "cluster" | "affected" | "class" | "overuse" | "ask" | "beat" | "firstArm" | "void" | "lost">;

/** A case's rows.jsonl line: the runner's facts plus every metric, from the raw files (a void row has no metrics). */
export function rowOf(runId: string, f: RowFacts, calls: CallLog[]): Row {
  const head = { case: f.case, cluster: f.cluster, affected: f.affected, class: f.class };
  const tail = { overuse: f.overuse, ask: f.ask, ...(f.beat ? { beat: f.beat } : {}), firstArm: f.firstArm };
  if (f.void)
    return { ...head, s: 0, ttfc: [null, null], ttd: [0, 0], ttfd: [null, null], render: [null, null], work: [0, 0], usd: [0, 0], thought: [false, false], pics: [[0, 0], [0, 0]], ...tail, void: f.void };
  if (f.lost) {
    const s = f.lost.arm === "B" ? -1 : 1;
    return { ...head, s, sCraft: s, ttfc: [null, null], ttd: [0, 0], ttfd: [null, null], render: [null, null], work: f.lost.arm === "B" ? [1, 0] : [0, 1], usd: [0, 0], thought: [false, false], pics: [[0, 0], [0, 0]], ...tail, lost: f.lost };
  }
  const m = caseMetrics(runId, f.case, calls);
  const { s, sCraft } = scores(runId, f.case);
  const pair = <T>(k: (x: ArmMetrics) => T): [T, T] => [k(m.A), k(m.B)];
  return {
    ...head, s, ...(sCraft !== undefined ? { sCraft } : {}),
    ttfc: pair((x) => x.ttfc), ttd: pair((x) => x.ttd), ttfd: pair((x) => x.ttfd), render: pair((x) => x.render), work: pair((x) => x.work), usd: pair((x) => x.usd), thought: pair((x) => x.thought),
    pics: pair((x): [number, number] => [x.picsDrawn, x.picsFailed]),
    ...(m.A.deferred || m.B.deferred ? { deferred: pair((x) => x.deferred) } : {}),
    ...(m.A.renderSame !== "all" || m.B.renderSame !== "all" ? { renderSame: pair((x) => x.renderSame) } : {}),
    ...tail,
  };
}

/** A real send's void or loss reason, as rows keep it: its code (V7, V9, …), since a page's or a call's error can quote the person. */
const codeOnly = (why: string) => /^V\d+/.exec(why)?.[0] ?? "failed";
export const appendRow = (runId: string, row: Row) =>
  appendLine(runFile(runId, "rows.jsonl"), !isRealCase(row.case) ? row : { ...row, ...(row.void ? { void: codeOnly(row.void) } : {}), ...(row.lost ? { lost: { arm: row.lost.arm, why: codeOnly(row.lost.why) } } : {}) });

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
