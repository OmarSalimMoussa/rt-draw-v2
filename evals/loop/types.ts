// The shapes of what the loop writes and reads: banked cases (spec §3.2), runs (§3.3),
// call records (§3.4), history rows (§5.3), the bridge (§7.1), cards (§8.2) and the
// yardstick's manifest. Types only, so pages and node share them. Product types come
// only from the bridge contract (§7.1), so a candidate that breaks one fails G0's typecheck.
import type { View } from "../../src/core/board.ts";
import type { Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";
import type { Scene } from "../../src/core/scene.ts";
import type { Dropped, Turn } from "../core/driver.ts";

// ---- Ids shared by scenarios, cases and cards (§2.1–2.2)

/** real: people's own sends on the hosted app, measured like tuning cases and never digested (evals/real/README.md). */
export type SetId = "tuning" | "heldout-gate" | "heldout-chart" | "fresh" | "real";
export type PersonaId = "first-timer" | "explorer" | "breaker";
export type StyleId = "typical" | "pointer" | "talker" | "precise" | "rambler";
/** Today's 8 targets plus notion and uber. */
export type TargetId = "bakery" | "airbnb" | "pricing" | "music" | "lesson" | "dentist" | "dashboard" | "repo" | "notion" | "uber";
export type StartId =
  | "blank" | "toyshop-home" | "toyshop-products" | "toyshop-cart" | "toyshop-zoomed-out" | "clowns" | "messy" | "messy-zoomed-out" | "grid"
  | `resume:${TargetId}` | `site:${TargetId}`;
/** The seed picks one per send; "reorder" is the table's reorder/layout. */
export type AskType = "add" | "remove" | "move" | "resize" | "restyle" | "retext" | "reorder" | "new-page";
export type BeatId =
  | "amb-arrow" | "amb-shape" | "two-cand" | "contra" | "mind" | "pause-fix" | "big-small" | "strange"
  | "undo" | "offscreen" | "camera-ask" | "by-hand" | "sketch" | "no-names" | "add-new";

export type Arm = "A" | "B";
export type Pair<T> = [a: T, b: T];
export type Goal = "fidelity" | "craft" | "latency";
export type DecisionClass = "N" | "S" | "R" | "Q" | "D";
/** `Scene.toJSON()` as the arm's scene.ts writes it. */
export type SceneJSON = ReturnType<Scene["toJSON"]>;

// ---- A banked case: bank/cases/c-<bank>-s<session>-<n>/ (§3.2)

/** case.json */
export type CaseInfo = {
  id: string; set: SetId; scenario: string; persona: PersonaId; style: StyleId; target?: TargetId; start: StartId;
  beat?: BeatId; ask: AskType; seed: number; originSession: string; send: number;
  championSha: string; tuningId: string; harnessTag: string; configId: string; recordedAt: string;
  hedged: boolean; beatDone: boolean;
  /** Whether the driver's words (said or meant) match the planned ask type (scenarios.ts' ASK_WORDS). */
  askDone?: boolean;
  /** e.g. "filled" (V12). */
  flags: string[];
};
/** input.json, on the person's clock; words is a string only for U1's typed sends. */
export type CaseInput = { camera: View; words: Word[] | string; strokes: Stroke[]; enterAtMs: number; inputHash: string };
/** driver.json: the acting turn's raw reply and parse (positions in board px of `view`, the screen it drew on), and the look turns before it. */
export type DriverRecord = { raw: string; turn: Turn; retries: number; dropped: Dropped[]; clamped: number; reqHash: string; view: View; looks: { raw: string; turn: Turn; reqHash: string }[] };
/** meant.json, written before Enter. */
export type Meant = { meant: string; testing?: string; hedged: boolean };
/** rating.json: the driver's view of this case's champion result, from its next turn (absent on a session's last send). */
export type Rating = { satisfaction: number; saw: string; feeling: string };
/** expectation.json, made once per case and judgeId. */
export type Expectation = { judgeId: string; should: string[]; mustNot: string[] };
/** miss.json: the miss check on the champion's result, once per case and judgeId. */
export type Miss = { judgeId: string; met: "yes" | "partly" | "no"; why: string };
/** champion.json: the champion's outcome at record time. */
export type ChampionOutcome = { opsFailed: number; picsFailed: number; empty: boolean };
/** replies.json: the champion's calls at record time, also the stand-in index (N2). */
export type RecordedReply = {
  role: string; ordinal: number; subject?: string; reqHash: string; cacheFile: string; /** ms from the request to each chunk */ offsets: number[];
  /** copy n (2 or more) of one answer (draw.copies, picture.copies): never a stand-in */ copy?: number;
};
/** readings.json: the product's ink readings and the resolver's answer at record time. */
export type Readings = { marks: { n: number; kind: string; how: string; targets: string[] }[]; refs?: { phrase: string; ids: string[] }[] };

// ---- A run: runs/<run-id>/ (§3.3)

export type RunKind = "ab" | "aa" | "checkpoint" | "bank" | "smoke" | "calib" | "live" | "scan";
export type CallMode = "live" | "replay" | "scan" | "resume";
export type Shared = "leader" | "follower" | "-";
/** run.json */
export type RunInfo = {
  id: string; kind: RunKind; arms: Partial<Record<Arm, { sha: string; tuningId: string; tree: string }>>;
  configId: string; harnessTag: string; judgeId: string; machine: string; slots: number;
  load: Record<string, number>; meter: Record<string, number>;
};
export type OpRecord = { line: string; ok: boolean; error?: string; ms: number };
/** cases/<case>/<arm>/result.json */
export type ArmResult = {
  ops: OpRecord[]; reply: string; error?: string; pics?: { drawn: number; failed: string[]; ms: number }; stopReasons: string[];
  calls: { role: string; reqHash: string; shared: Shared; mode: CallMode; ms: number; firstMs?: number; waitMs?: number; readyAtTake?: boolean; thinkingTokens?: number }[];
};
/** cases/<case>/<arm>/timing.json: the harness clock. */
export type ArmTiming = {
  enterAt: number; ttfcMs?: number; ttdMs: number; /** the product's own hook, informational */ ttloMs?: number;
  /**
   * The owner's latency (LOOP-V2.md): time to first drawing; the engine measured idle after the send (engine), whose
   * apply per op plus one paint is the render metric; and the per-frame paint during the send (informational). Absent before them.
   */
  ttfdMs?: number; engine?: Engine; renderP50Ms?: number; renderP90Ms?: number; renderMaxMs?: number;
  firstTextMs?: number; resolverMs?: number; picturesMs?: number; renders: number; longTasksMs: number;
  quiescedAt: number; heapMb: number; gatewayLoopP99Ms: number;
};
/** cases/<case>/fork.json */
export type Fork = { order: Arm[]; offsetsMs: number[]; sharedReqs: string[]; identicalAfter: boolean;
  /** Each arm's camera after the send: where a G4 continuation of this case starts. */
  cameras?: Record<Arm, View> };
/** cases/<case>/judge/packet.json (§4.2); positions is stored, never sent. */
export type Packet = {
  case: string; said: string; meant: string; hedged: boolean; targetParts?: string;
  expectation: { should: string[]; mustNot: string[] };
  /** leftChanged/rightChanged: the results framed on what changed, when a result's screen left it (packet version 2). */
  images: { before: string; left: string; right: string; leftChanged?: string; rightChanged?: string };
  changes: { left: string[]; right: string[] };
  positions: { left: Arm; right: Arm };
};
/** judge/fidelity-1.json, fidelity-2.json, craft.json: the reply (§4.3) with the positions it was asked in. */
export type Judged = {
  winner: "left" | "right" | "tie"; confidence: 1 | 2 | 3; why: string;
  /** prompt variant 2's per-side answers */ left?: string; right?: string;
  positions: { left: Arm; right: Arm }; judgeId: string;
  /** The prompt variant it was asked with (§4.3; absent = 1), so calibration knows what a re-judge must replace. */
  variant?: 1 | 2;
};
/** load.ndjson, every 5 s. */
export type LoadSample = { at: number; load1: number; psiCpu: number; psiMemory: number };
/** rows.jsonl: one per case; pairs are [A, B]. */
export type Row = {
  case: string; cluster: string; affected: boolean; class: DecisionClass; s: -1 | 0 | 1; sCraft?: -1 | 0 | 1;
  /** null: no lasting change on screen (a camera-only reply). */
  ttfc: Pair<number | null>; ttd: Pair<number>; work: Pair<number>; usd: Pair<number>; thought: Pair<boolean>; overuse: Pair<boolean>;
  /**
   * The two latencies that decide (LOOP-V2.md): time to first drawing, and render, the engine's time from an op landing
   * to it on screen (one op's apply plus one frame's paint, measured idle on both arms' boards; null: no render this
   * case). Absent in rows written before them, which no latency decision can then use.
   */
  ttfd?: Pair<number | null>; render?: Pair<number | null>;
  /** An arm's render() left work for after it returned (Engine.deferred): B's alone vetoes a keep. */
  deferred?: Pair<boolean>;
  /** What of each arm's own board both engines' timings shared (Engine.same), when not all of it: paint alone (a new op), or nothing (a new shape kind). */
  renderSame?: Pair<Same>;
  /** Pictures drawn and failed, for the failed-picture veto (§1.4 item 5). */
  pics: Pair<[drawn: number, failed: number]>;
  /** The case's ask and beat, so the over-use rule can tell target cases from the rest (§1.4 item 8). */
  ask: AskType; beat?: BeatId;
  firstArm: Arm; void?: string;
  /**
   * Only this arm failed (its page, its engine on its own board, or its product calls twice): the case is its loss in
   * Rule F, never a void that would drop its worst cases, and left out of the work and empty-send rates (a hiccup isn't
   * an empty send); such cases still count toward the void rate, so a harness that breaks one arm voids.
   */
  lost?: { arm: Arm; why: string };
};
/** verdict.json: the decision (§1.3) with every look's Z and the vetoes. */
export type Verdict = {
  verdict: "keep" | "revert" | "void" | "owner"; reasons: string[]; goal: Goal; class: DecisionClass;
  looks: { n: number; decisive: number; z: number }[]; vetoes: string[]; configId: string;
};

// ---- Call records: meter/calls.jsonl, written by the gateway (§3.4)

export type CallLog = {
  at: string; run: string; case?: string; arm?: Arm; slot?: number; role: string;
  /** An arm page's call (the product's), not an eval role's; absent in lines before 2026-10-26 (metrics.ts isProduct). */ page?: boolean;
  model: string; servedModel?: string; sdk: string;
  reqHash: string; shared: Shared; mode: CallMode;
  inTokens: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; outTokens: number; thinkingTokens: number;
  stopReason?: string; ms: number; firstMs?: number; waitMs?: number; readyAtTake?: boolean; retries: number; apiError?: string;
  /** Its page dropped it (a losing copy, a missed speculation): the product's choice, not a failure. */ dropped?: boolean;
  listUsd: number; costUsd?: number; token: 1 | 2 | 3;
  /** utilization 0–1 and the reset (unix seconds), when the server sent them */ fiveHour?: number; sevenDay?: number; resetsAt?: number;
};
/** An agent session's one line, from the SDK's result message. */
export type AgentLog = {
  at: string; run: string; role: string; agent: true; model: string; totalCostUsd: number;
  usage: { inTokens: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; outTokens: number };
  turns: number; minutes: number; token: 1 | 2 | 3;
};

// ---- History: branch eval/history (§5.3)

export type Ratio = {
  est: number;
  /**
   * What latency decides on (LOOP-V2.md A3): the session-swap test's one-sided p-values, `slower` that B is above A by
   * chance, `faster` that it's below the keep line by chance (A for the median, LOOP.latTailKeepHi95·A for a tail).
   * Absent in rows written before it; rows before 2026-10-26 also carry session-bootstrap bounds (lo90, hi90, lo95).
   */
  p?: { slower: number; faster: number };
};
export type Lat = { ttfcP50: number; ttfcP75: number; ttdP50: number; ttdP75: number; ttfdP50?: number; ttfdP75?: number; renderP50?: number; renderP75?: number };
type Share = { n: number; share: number; lo90: number; hi90: number };
export type EpochRow = { epoch: number; at: string; era: number; machine: "pgx" | "laptop"; championSha: string; configId: string;
  decisions: string[]; checkpoint?: string;
  cost: { listUsd: number; calls: number; agentUsd: number; byRole: Record<string, { calls: number; usd: number }>;
          tokens: { in: number; cacheRead: number; write5m: number; write1h: number; out: number; thinking: number } };
  minutes: { total: number; agents: number; measure: number; idle: number };
  slots: { slot: 1 | 2 | 3; fiveHour?: number; sevenDay?: number; sevenDayAt?: number; usdThisWindow: number; status: string }[] };
/**
 * Why a decision went the way it did, as data (search.ts reads these, never the reasons' words): a veto ("latency",
 * "empty", "pictures", "deferred", "heldout", "direction": G3 didn't lean the card's way, "continuation", "schedule": a
 * schedule change drew differently on the held-out cases), a fidelity floor or futility that reverted it ("floor"),
 * "no-change", or an owner hold ("owner").
 */
export type Code = "latency" | "empty" | "pictures" | "deferred" | "heldout" | "direction" | "continuation" | "schedule" | "floor" | "no-change" | "owner";

export type DecisionRow = { id: string; kind: "card" | "owner-step"; epoch: number; card?: HypothesisCard; candSha: string; baseSha: string;
  class: DecisionClass | "owner"; goal: Goal | "owner";
  verdict: "keep" | "revert" | "void" | "owner"; reasons: string[];
  /** The reasons as data (absent before 2026-10-26: search.ts reads those rows' words). */ codes?: Code[];
  trust: "green" | "amber" | "void";
  looks: { n: number; decisive: number; z: number }[]; counts: { wins: number; losses: number; ties: number; exactTies: number };
  /** tuning counts every measured case, the real sends among them as real (absent before 2026-10-28). */
  affected: { tuning: number; of: number; topUp: number; real?: number }; heldOutZ?: number; craftZ?: number; continuationZ?: number;
  overuse?: { detector: string; a: number; b: number }; checkpoint?: string /* owner steps */;
  /** ttfd and render decide (absent before LOOP-V2); ttfc and ttd are reported. tails: "ttfd p90" … "render p95". */
  latency: { ttfc: Ratio; ttd: Ratio; ttfd?: Ratio; render?: Ratio; byThinking?: Record<string, Ratio>; tails?: Record<string, Ratio> }; work: number; emptyRise: number; failedPicRise: number;
  cost: { usdPerCaseRatio: number; listUsd: number; calls: number }; minutes: number; run: string; judgeId: string; configId: string;
  /** Bench R1 at a keep (evals/real/shadow.ts' Shadow): reported, decides nothing yet. */
  real?: { run: string; hash: string; cases: number; void: number; lost?: number; checks: [number, number]; casesPassing: [number, number]; share?: number; shareHold?: number; ttfd?: Ratio; render?: Ratio } };
export type CheckpointRow = { id: string; epoch: number;
  /** The yardstick's era: a new judgeId or bench starts the next, charted apart (nothing bridges two eras). */
  era: number; at: string; machine: string; trust: "green" | "amber" | "void";
  /** The champion, and A0: checkpoint 0's champion, which never moves (rows before 2026-10-26 may name a later anchor). */
  champion: string; anchor: string;
  share: Record<"all" | "heldout" | "tuning" | "human", Share | undefined>;
  craft: Share;
  latency: { champion: Lat; anchor: Lat; ratioTtfc: Ratio; ratioTtd: Ratio;
             /** The deciding latencies (LOOP-V2.md), champion over A0 in this run. */
             ratioTtfd?: Ratio; ratioRender?: Ratio;
             /** The latency veto's test on this run: what the champion is surely slower than A0 on, if it is (a notice to the owner). */
             slower?: string };
  /** Checkpoint 0's: ttfd, render, order and share since LOOP-V2 (ttfc and ttd before). */
  aa?: { pass: boolean; ci: number; tests: Record<string, { est: number; lo: number; hi: number; halfWidth: number }> } /* checkpoint 0 */;
  productUsdPerSend: { champion: number; anchor: number }; overfitGap: number;
  health: { voidPct: number; flipPct: number; hedgePct: number; beatCompliance: number; thinking: Record<string, number>; coldShare: number; psiMedian: number };
  realism?: Record<string, { driver: number; human: number }>;
  /** Bench R1, A0 against the champion (evals/real/shadow.ts' Shadow): reported, decides nothing yet. */
  real?: DecisionRow["real"] };
/** markers.jsonl: what moved under the chart without being a decision ("anchor" in rows before 2026-10-26). */
export type Marker = { at: string; era: number; kind: "harness" | "served-model" | "owner-step" | "era"; label: string; ref?: string };
/** budget.jsonl: one meter snapshot per epoch per slot. */
export type BudgetRow = { at: string; epoch: number; slot: 1 | 2 | 3; usdThisWindow: number; fiveHour?: number; sevenDay?: number;
  /** when the server sent sevenDay (ms) */ sevenDayAt?: number;
  status: string; resetsAt?: number; usd7d: number };
/** health.jsonl: A/A, canary, readiness and calibration outcomes. */
export type HealthRow = { at: string; kind: "aa" | "canary" | "ready" | "calib"; pass: boolean; detail: Record<string, unknown> };
/** smoke.jsonl: §11 step 1, the page's first point before any epoch: its A/B's share and median latency, and its cost. */
export type SmokeRow = { at: string; run: string; pass: boolean; calls: number; listUsd: number; minutes: number; cases: number; share?: number; ttfcP50?: number; ttdP50?: number; ttfdP50?: number; renderP50?: number };
/** bench/B1/manifest.json, bench/U1/manifest.json: file → sha256, and the hash over them (N7). */
export type BenchManifest = { version: string; files: Record<string, string>; hash: string };

// ---- The bridge each arm serves: window.rtEval (§7.1)

export type SpanJSON = { name: string; traceId: string; spanId: string; parentId?: string; startMs: number; endMs: number;
  attributes: Record<string, string | number | boolean>; events: { name: string; atMs: number }[] };
/**
 * rtEval.engine() on one board: one apply of its op lines (the fastest of warm runs), one frame's paint, how many lines
 * and how many applied, and what the board held as this engine loaded it (absent in runs recorded before them).
 */
export type EngineRun = { applyMs: number; paintMs: number; ops: number; applied?: number; board?: string };
/**
 * How much of one board's timing two engines share (ab.ts' sameContent): "all" (both loaded the board alike and applied
 * as many of its lines), "paint" (loaded alike, applied differently: its paint compares, its apply doesn't), "none".
 */
export type Same = "all" | "paint" | "none";
/**
 * The engine's cost on the arm's own board, and on the other arm's (`other`): each arm's engine timed on both boards,
 * so render compares engines on the same content and never reads more drawing as a slower engine (LOOP-V2.md A2).
 * `same`: what of each board both engines' timings share (absent in runs recorded before it); `skew`: why not all of
 * it. `deferred`: the stage changed after render() returned.
 */
export type Engine = EngineRun & { other?: EngineRun; same?: { own: Same; other: Same }; skew?: string; deferred?: boolean };
/** ttfdMs and render*Ms: the owner's latency (LOOP-V2.md); absent in runs recorded before them. */
export type Timing = { enterAt: number; ttfcMs?: number; ttdMs: number; ttfdMs?: number; renderP50Ms?: number; renderP90Ms?: number; renderMaxMs?: number;
  ttloMs?: number; renders: number; longTasksMs: number; heapMb: number };
export type SendOutcome = { ops: OpRecord[]; reply: string; error?: string; pics?: { drawn: number; failed: string[]; ms: number };
  camera: View; after: SceneJSON; timing: Timing; spans: SpanJSON[] };
export interface RtEval {
  health(): { ok: boolean; sha: string; tuningId: string; fonts: boolean; visible: boolean; rafPerSec: number };
  load(c: { scene: SceneJSON; camera: View; tuning?: Record<string, number>; pictures?: "fixture" }): Promise<{ sceneHash: string }>;
  /** words as a string: a typed U1 send. */
  send(i: { words: Word[] | string; strokes: Stroke[]; timeline?: "instant" | "realtime" }): Promise<SendOutcome>;
  setView(v: View): Promise<void>;
  /** The engine's cost on the arm's own board and the other arm's, measured idle in one view (rtEval in bridge/main.ts). */
  engine(i: { before: SceneJSON; view: View; own: { ops: string[]; after: SceneJSON }; other?: { ops: string[]; after: SceneJSON } }): Promise<Engine>;
  /** The frozen ink overlay, for captures only. */
  showInk(strokes: Stroke[], o: { numbers: boolean }): void;
  hideInk(): void;
  scene(): SceneJSON;
  /** Undo steps. */
  restore(scene: SceneJSON): void;
}

// ---- Cards (§8.2)

export type HypothesisCard = { id: string; component: string /* "resolve" | "draw" | "picture" | "marks" | "render" | … */;
  kind: "knob" | "variant" | "code" | "op" | "newknob" | "sweep" | "combo"; change: string /* one line */; knobs?: Record<string, number>;
  /** kind "sweep": one knob's values, nearest the champion's first on each side; run as knob cards until one keeps (LOOP-V2.md D3). */
  sweep?: { knob: string; values: number[] };
  /** kind "combo": tried cards (their ids) applied together on the champion (LOOP-V2.md D4). */
  combines?: string[];
  /** A latency card's metric: the deciding ones only (LOOP-V2.md). */
  goal: Goal; metric?: "ttfd" | "render"; classGuess: "S" | "R" | "Q" | "D"; dialogue: boolean;
  overuseDetector?: string /* a detector name from patterns.ts' OVERUSE: its rate on the cards' other cases is reported */;
  targets?: { asks?: AskType[]; beats?: BeatId[] } /* the cases the card is for; the over-use rate is read off the rest */;
  generality?: string /* new ops */;
  isPatch: boolean; touchesFrozen: boolean; risk: string; files: string[];
  /** rte decide --owner-ok: the owner's say-so on findings that are the owner's call (G0 waives them; a reject stands) */ ownerOk?: boolean };
