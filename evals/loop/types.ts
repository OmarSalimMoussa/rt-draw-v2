// The shapes of what the loop writes and reads: banked cases (spec §3.2), runs (§3.3),
// call records (§3.4), history rows (§5.3), the bridge (§7.1), cards (§8.2) and the
// yardstick's manifest. Types only, so pages and node share them. Product types come
// only from the bridge contract (§7.1), so a candidate that breaks one fails G0's typecheck.
import type { View } from "../../src/core/board.ts";
import type { Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";
import type { Scene } from "../../src/core/scene.ts";
import type { Turn } from "../core/driver.ts";
import type { Step } from "../core/synth.ts";

// ---- Ids shared by scenarios, cases and cards (§2.1–2.2)

export type SetId = "tuning" | "heldout-gate" | "heldout-chart" | "fresh";
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
  /** e.g. "filled" (V12). */
  flags: string[];
};
/** input.json, on the person's clock; words is a string only for U1's typed sends. */
export type CaseInput = { camera: View; words: Word[] | string; strokes: Stroke[]; enterAtMs: number; inputHash: string };
/** driver.json */
export type DriverRecord = { raw: string; turn: Turn; retries: number; dropped: Step[]; reqHash: string };
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
export type RecordedReply = { role: string; ordinal: number; subject?: string; reqHash: string; cacheFile: string; /** ms from the request to each chunk */ offsets: number[] };
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
  firstTextMs?: number; resolverMs?: number; picturesMs?: number; renders: number; longTasksMs: number;
  quiescedAt: number; heapMb: number; gatewayLoopP99Ms: number;
};
/** cases/<case>/fork.json */
export type Fork = { order: Arm[]; offsetsMs: number[]; sharedReqs: string[]; identicalAfter: boolean };
/** cases/<case>/judge/packet.json (§4.2); positions is stored, never sent. */
export type Packet = {
  case: string; said: string; meant: string; hedged: boolean; targetParts?: string;
  expectation: { should: string[]; mustNot: string[] };
  images: { before: string; left: string; right: string };
  changes: { left: string[]; right: string[] };
  positions: { left: Arm; right: Arm };
};
/** judge/fidelity-1.json, fidelity-2.json, craft.json: the reply (§4.3) with the positions it was asked in. */
export type Judged = {
  winner: "left" | "right" | "tie"; confidence: 1 | 2 | 3; why: string;
  /** prompt variant 2's per-side answers */ left?: string; right?: string;
  positions: { left: Arm; right: Arm }; judgeId: string;
};
/** load.ndjson, every 5 s. */
export type LoadSample = { at: number; load1: number; psiCpu: number; psiMemory: number };
/** rows.jsonl: one per case; pairs are [A, B]. */
export type Row = {
  case: string; cluster: string; affected: boolean; class: DecisionClass; s: -1 | 0 | 1; sCraft?: -1 | 0 | 1;
  /** null: no lasting change on screen (a camera-only reply). */
  ttfc: Pair<number | null>; ttd: Pair<number>; work: Pair<number>; usd: Pair<number>; thought: Pair<boolean>; overuse: Pair<boolean>;
  /** Pictures drawn and failed, for the failed-picture veto (§1.4 item 5). */
  pics: Pair<[drawn: number, failed: number]>;
  /** The case's ask and beat, so the over-use rule can tell target cases from the rest (§1.4 item 8). */
  ask: AskType; beat?: BeatId;
  firstArm: Arm; void?: string;
};
/** verdict.json: the decision (§1.3) with every look's Z and the vetoes. */
export type Verdict = {
  verdict: "keep" | "revert" | "void" | "owner"; reasons: string[]; goal: Goal; class: DecisionClass;
  looks: { n: number; decisive: number; z: number }[]; vetoes: string[]; configId: string;
};

// ---- Call records: meter/calls.jsonl, written by the gateway (§3.4)

export type CallLog = {
  at: string; run: string; case?: string; arm?: Arm; slot?: number; role: string; model: string; servedModel?: string; sdk: string;
  reqHash: string; shared: Shared; mode: CallMode;
  inTokens: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; outTokens: number; thinkingTokens: number;
  stopReason?: string; ms: number; firstMs?: number; waitMs?: number; readyAtTake?: boolean; retries: number; apiError?: string;
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

export type Ratio = { est: number; lo90: number; hi90: number; lo95: number };
export type Lat = { ttfcP50: number; ttfcP75: number; ttdP50: number; ttdP75: number };
type Share = { n: number; share: number; lo90: number; hi90: number };
export type EpochRow = { epoch: number; at: string; era: number; machine: "pgx" | "laptop"; championSha: string; configId: string;
  decisions: string[]; checkpoint?: string;
  cost: { listUsd: number; windowShare: number; calls: number; agentUsd: number; byRole: Record<string, { calls: number; usd: number }>;
          tokens: { in: number; cacheRead: number; write5m: number; write1h: number; out: number; thinking: number } };
  minutes: { total: number; agents: number; measure: number; idle: number };
  slots: { slot: 1 | 2 | 3; fiveHour?: number; sevenDay?: number; usdThisWindow: number; status: string }[] };
export type DecisionRow = { id: string; kind: "card" | "owner-step"; epoch: number; card?: HypothesisCard; candSha: string; baseSha: string;
  class: DecisionClass | "owner"; goal: Goal | "owner";
  verdict: "keep" | "revert" | "void" | "owner"; reasons: string[]; trust: "green" | "amber" | "void";
  looks: { n: number; decisive: number; z: number }[]; counts: { wins: number; losses: number; ties: number; exactTies: number };
  affected: { tuning: number; of: number; topUp: number }; heldOutZ?: number; craftZ?: number; continuationZ?: number;
  overuse?: { detector: string; a: number; b: number }; checkpoint?: string /* owner steps */;
  latency: { ttfc: Ratio; ttd: Ratio; byThinking?: Record<string, Ratio> }; work: number; emptyRise: number; failedPicRise: number;
  cost: { usdPerCaseRatio: number; listUsd: number; calls: number }; minutes: number; run: string; judgeId: string; configId: string };
export type CheckpointRow = { id: string; epoch: number; era: number; at: string; machine: string; trust: "green" | "amber" | "void";
  champion: string; anchor: string; anchorMoved: boolean;
  share: Record<"all" | "heldout" | "tuning" | "human", Share | undefined>;
  craft: Share; Q: { value: number; lo90: number; hi90: number };
  latency: { champion: Lat; anchor: Lat; ratioTtfc: Ratio; ratioTtd: Ratio; chainedTtfc: number; chainedTtd: number;
             debt: boolean; vsLatencyCheckpoint: { ttfc: Ratio; ttd: Ratio; L: string } };
  quality: { debt: boolean; vsQualityCheckpoint: { dQ: number; lo90: number; hi90: number; P: string } };
  aa?: { pass: boolean; ci: number; tests: Record<"ttfc" | "ttd" | "order" | "share", { est: number; lo: number; hi: number; halfWidth: number }> } /* checkpoint 0 */;
  productUsdPerSend: { champion: number; anchor: number }; overfitGap: number;
  health: { voidPct: number; flipPct: number; hedgePct: number; beatCompliance: number; thinking: Record<string, number>; coldShare: number; psiMedian: number };
  realism?: Record<string, { driver: number; human: number }> };
export type Era = { era: number; from: string; why: "judge" | "bench" | "measure"; judgeId: string; bench: string; measureHash: string;
  bridge?: { run: string; step: { Q: number; ttfc: number; ttd: number } } };
export type Marker = { at: string; era: number; kind: "harness" | "served-model" | "owner-step" | "anchor"; label: string; ref?: string };
/** budget.jsonl: one meter snapshot per epoch per slot. */
export type BudgetRow = { at: string; epoch: number; slot: 1 | 2 | 3; usdThisWindow: number; fiveHour?: number; sevenDay?: number;
  /** W_k, the window's $ estimate */ windowUsd: number; status: string; resetsAt?: number; usd7d: number };
/** health.jsonl: A/A, canary, readiness and calibration outcomes. */
export type HealthRow = { at: string; kind: "aa" | "canary" | "ready" | "calib"; pass: boolean; detail: Record<string, unknown> };
/** bench/B1/manifest.json, bench/U1/manifest.json: file → sha256, and the hash over them (N7). */
export type BenchManifest = { version: string; files: Record<string, string>; hash: string };

// ---- The bridge each arm serves: window.rtEval (§7.1)

export type SpanJSON = { name: string; traceId: string; spanId: string; parentId?: string; startMs: number; endMs: number;
  attributes: Record<string, string | number | boolean>; events: { name: string; atMs: number }[] };
export type Timing = { enterAt: number; ttfcMs?: number; ttdMs: number; ttloMs?: number; renders: number; longTasksMs: number; heapMb: number };
export type SendOutcome = { ops: OpRecord[]; reply: string; error?: string; pics?: { drawn: number; failed: string[]; ms: number };
  camera: View; after: SceneJSON; timing: Timing; spans: SpanJSON[] };
export interface RtEval {
  health(): { ok: boolean; sha: string; tuningId: string; fonts: boolean; visible: boolean; rafPerSec: number };
  load(c: { scene: SceneJSON; camera: View; tuning?: Record<string, number>; pictures?: "fixture" }): Promise<{ sceneHash: string }>;
  /** words as a string: a typed U1 send. */
  send(i: { words: Word[] | string; strokes: Stroke[]; timeline?: "instant" | "realtime" }): Promise<SendOutcome>;
  setView(v: View): Promise<void>;
  /** The frozen ink overlay, for captures only. */
  showInk(strokes: Stroke[], o: { numbers: boolean }): void;
  hideInk(): void;
  scene(): SceneJSON;
  /** Undo steps. */
  restore(scene: SceneJSON): void;
}

// ---- Cards (§8.2)

export type HypothesisCard = { id: string; component: string /* "resolve" | "draw" | "picture" | "marks" | "render" | … */;
  kind: "knob" | "variant" | "code" | "op" | "newknob"; change: string /* one line */; knobs?: Record<string, number>;
  goal: Goal; metric?: "ttfc" | "ttd"; classGuess: "S" | "R" | "Q" | "D"; dialogue: boolean;
  predicts: string; overuseDetector?: string /* a detector name from patterns.ts' OVERUSE, §1.4 item 8 */;
  targets?: { asks?: AskType[]; beats?: BeatId[] } /* the cases the card is for; the over-use rate is read off the rest */;
  generality?: string /* new ops */;
  isPatch: boolean; raisesCost: boolean; touchesFrozen: boolean; risk: string; files: string[] };
