// Latency, and the two debts, measured only through same-run pairs (spec §1.3–1.4, §5.2).
// Two runs at different times don't pair (v1: r ≈ 0, ±15% shifts between runs), so a decision
// compares B with A inside its own run, and cumulative latency and quality chain same-run
// ratios through the anchor: never a number from one run against another run's.
import { LOOP } from "./config.ts";
import { type Factor, asRatio, chain, cr1, logRatio, medianSwapP, quantileRatio, quantileSwapP, seedOf, tQuantile } from "./stats.ts";
import type { Ratio, Row } from "./types.ts";

export type Metric = "ttfc" | "ttd" | "ttfd" | "render";
/** The latencies that decide (LOOP.latGated, LOOP-V2.md): time to first drawing and render. TTFC and TTD are reported. */
export type Gated = "ttfd" | "render";
export const GATED = LOOP.latGated as readonly Gated[];

/** One arm's value: render floored at LOOP.renderFloorMs; undefined in a row written before the metric. */
const value = (r: Row, m: Metric, arm: 0 | 1) => {
  const v = r[m]?.[arm];
  return m === "render" && typeof v === "number" ? Math.max(v, LOOP.renderFloorMs) : v;
};
/** Rows where both arms have the metric (a camera-only reply has no TTFC, a send with no frame no render). */
const paired = (rows: Row[], m: Metric) => rows.filter((r) => !r.void && (value(r, m, 0) ?? 0) > 0 && (value(r, m, 1) ?? 0) > 0);
const logs = (rows: Row[], m: Metric) => rows.map((r) => Math.log(value(r, m, 1)! / value(r, m, 0)!));

/** B/A on one metric: the median paired log-ratio with session-bootstrap bounds and the swap test's p. Undefined without pairs. */
export function pairedRatio(rows: Row[], m: Metric): Ratio | undefined {
  const ok = paired(rows, m);
  if (!ok.length) return undefined;
  const seed = seedOf(`${m} ${ok.map((r) => r.case).join(" ")}`), clusters = ok.map((r) => r.cluster);
  const p = medianSwapP(ok.map((r) => value(r, m, 0)!), ok.map((r) => value(r, m, 1)!), clusters, 1, seed);
  return { ...logRatio(logs(ok, m), clusters, seed), p };
}

/** B/A at a tail: both arms' p quantile (0.90: the p90 send) over the paired rows, session-bootstrap bounds. */
export function tailRatio(rows: Row[], m: Metric, p: number): Ratio | undefined {
  const ok = paired(rows, m);
  if (!ok.length) return undefined;
  const [a, b, clusters] = [ok.map((r) => value(r, m, 0)!), ok.map((r) => value(r, m, 1)!), ok.map((r) => r.cluster)];
  const seed = seedOf(`${m} p${p} ${ok.map((r) => r.case).join(" ")}`);
  const test = { slower: quantileSwapP(a, b, clusters, p, 1, seed).slower, faster: quantileSwapP(a, b, clusters, p, LOOP.latTailKeepHi95, seed).faster };
  return { ...quantileRatio(a, b, clusters, p, seed), p: test };
}

/** One metric's latency stats by name: "p50" (the median paired ratio) and each tail of LOOP.latTails ("p90", "p95"). */
export function latencyStats(rows: Row[], m: Metric): Record<string, Ratio> {
  const out: Record<string, Ratio> = {};
  const mid = pairedRatio(rows, m);
  if (mid) out.p50 = mid;
  for (const p of LOOP.latTails) {
    const r = tailRatio(rows, m, p);
    if (r) out[`p${Math.round(p * 100)}`] = r;
  }
  return out;
}

/** The metrics' tails by name ("ttfd p90" … "render p95"), for the decision record and the vetoes. */
export const tailsOf = (rows: Row[], ms: readonly Metric[] = GATED): Record<string, Ratio> =>
  Object.fromEntries(ms.flatMap((m) => Object.entries(latencyStats(rows, m)).filter(([k]) => k !== "p50").map(([k, r]) => [`${m} ${k}`, r])));

/**
 * Every deciding stat by name, medians as the bare metric ("ttfd", "render p90"): what the latency veto reads. A tail
 * counts once it holds LOOP.latTailMinSends sends, as for a keep: p95 on 48 sends is the second-slowest send alone.
 */
export const gatedStats = (rows: Row[]): Record<string, Ratio> =>
  Object.fromEntries(GATED.flatMap((m) => {
    const n = paired(rows, m).length;
    const holds = (k: string) => k === "p50" || n * (1 - Number(k.slice(1)) / 100) >= LOOP.latTailMinSends - 1e-9;
    return Object.entries(latencyStats(rows, m)).filter(([k]) => holds(k)).map(([k, r]) => [k === "p50" ? m : `${m} ${k}`, r]);
  }));

/** The same ratio split by which arms thought (latency-4): none, A, B, both. */
export function byThinking(rows: Row[], m: Metric): Record<string, Ratio> {
  const key = (r: Row) => (r.thought[0] ? (r.thought[1] ? "both" : "A") : r.thought[1] ? "B" : "none");
  const out: Record<string, Ratio> = {};
  for (const k of ["none", "A", "B", "both"]) {
    const ratio = pairedRatio(rows.filter((r) => key(r) === k), m);
    if (ratio) out[k] = ratio;
  }
  return out;
}

// ---- Checkpoints as chain links

/** Q's clip (§5.2): a share of 0 or 1 would make log-odds infinite. */
const SHARE_CLIP = [0.05, 0.95] as const;
const logit = (p: number) => Math.log(p / (1 - p));

/**
 * One checkpoint run (arm A the anchor, B the champion) as the links the debts chain: the mean
 * paired log-ratio per latency metric and the champion's share in log-odds, CR1 by origin
 * session. `moved`: the champion became the next anchor here, so this run's own ratio is the
 * new anchor against the old one. ttfd and render are absent at checkpoints before them.
 */
export type CheckpointLinks = { id: string; moved: boolean; ttfc: Factor; ttd: Factor; ttfd?: Factor; render?: Factor; q: Factor };
export type Chained = Metric | "q";

export function linksOf(id: string, rows: Row[], moved: boolean): CheckpointLinks {
  const lat = (m: Metric): Factor => {
    const ok = paired(rows, m);
    const { mean, se, G } = cr1(logs(ok, m), ok.map((r) => r.cluster));
    return { log: mean, se, df: G - 1 };
  };
  const gated = (m: Gated) => (paired(rows, m).length ? { [m]: lat(m) } : {});
  // A lost case is a void at a checkpoint: two copies of the champion have no candidate to charge it to.
  const live = rows.filter((r) => !r.void && !r.lost);
  const { mean, se, G } = cr1(live.map((r) => (r.s + 1) / 2), live.map((r) => r.cluster));
  const p = Math.min(SHARE_CLIP[1], Math.max(SHARE_CLIP[0], mean));
  // Delta method: d logit(p) = dp / (p (1 − p)).
  return { id, moved, ttfc: lat("ttfc"), ttd: lat("ttd"), ...gated("ttfd"), ...gated("render"), q: { log: logit(p), se: se / (p * (1 - p)), df: G - 1 } };
}

/**
 * Where a chain on `k` may start: after the newest checkpoint without that link (one recorded before the metric, or that
 * couldn't measure it), since nothing before it chains through. history.length when the newest has none.
 */
const chainStart = (history: CheckpointLinks[], k: Chained) => {
  for (let i = history.length - 1; i >= 0; i--) if (!history[i][k]) return i + 1;
  return 0;
};

/**
 * The newest checkpoint's champion against the champion at checkpoint `from` (against the
 * first anchor A0 when `from` is undefined): this run's link, minus `from`'s, plus every anchor
 * move in between. A move at `from` itself cancels: the anchor then is that champion. A metric
 * newer than `from` chains from the first checkpoint that measured it (`since`); undefined when
 * the newest checkpoint didn't.
 */
export function chainFrom(history: CheckpointLinks[], from: string | undefined, k: Chained): { f: Factor; since: string | undefined } | undefined {
  const now = history.length - 1;
  let start = from === undefined ? -1 : history.findIndex((c) => c.id === from);
  if (from !== undefined && start < 0) throw new Error(`no checkpoint ${from} in the history`);
  const first = chainStart(history, k);
  if (first > now) return undefined;
  if (first > 0 && start < first) start = first;
  const coef = new Map<number, number>([[now, 1]]);
  if (start >= 0) coef.set(start, (coef.get(start) ?? 0) - 1);
  for (let m = Math.max(0, start); m < now; m++) if (history[m].moved) coef.set(m, (coef.get(m) ?? 0) + 1);
  const terms = [...coef].filter(([, c]) => c).map(([i, c]): [number, Factor] => [c, history[i][k]!]);
  return { f: terms.length ? chain(terms) : { log: 0, se: 0, df: Infinity }, since: start >= 0 ? history[start].id : undefined };
}

/** chainFrom's factor, the identity when the newest checkpoint has no such link. */
export const chainSince = (history: CheckpointLinks[], from: string | undefined, k: Chained): Factor =>
  chainFrom(history, from, k)?.f ?? { log: 0, se: 0, df: Infinity };

const ratioOf = (f: Factor): Ratio => (f.se ? asRatio(f) : { est: Math.exp(f.log), lo90: Math.exp(f.log), hi90: Math.exp(f.log), lo95: Math.exp(f.log) });

/** The loop's debts: whether it's in each, and the checkpoint it's measured against (L, P). */
/** latency.signal: this checkpoint alone said surely slower; the debt starts only on a second in a row (LOOP-V2.md D2). */
export type Debts = { latency: { debt: boolean; L: string; signal?: boolean }; quality: { debt: boolean; P: string } };

/**
 * The debts after the newest checkpoint (the last of `history`). Latency debt: a deciding latency
 * (GATED) against L has a 90% lower bound above LOOP.latDebtLo90. Quality debt: ΔQ against P has a
 * 90% upper bound below the share LOOP.qualDebtHi90 (in log-odds). A debt clears at a later
 * checkpoint back within its bound, which becomes the new L or P. Checkpoint 0 starts both. A
 * latency first measured after L is held against the first checkpoint that measured it. Latency debt starts only on a
 * second checkpoint in a row surely slower (`signal`): one alone happens by chance about one time in five.
 */
export function debtsAfter(prev: Debts | undefined, history: CheckpointLinks[]) {
  const now = history.at(-1)!.id;
  const was: Debts = prev ?? { latency: { debt: false, L: now }, quality: { debt: false, P: now } };
  const lat = Object.fromEntries(GATED.flatMap((m) => {
    const c = chainFrom(history, was.latency.L, m);
    return c ? [[m, { ...ratioOf(c.f), since: c.since ?? "A0" }]] : [];
  })) as Partial<Record<Gated, Ratio & { since: string }>>;
  // One checkpoint surely slower happens by chance on about one in five with no drift at all (two metrics at lo90):
  // the debt starts on the second in a row, and holds while each says so.
  const signal = Object.values(lat).some((r) => r.lo90 > LOOP.latDebtLo90);
  const latDebt = signal && (was.latency.debt || !!was.latency.signal);
  const q = chainSince(history, was.quality.P, "q");
  const half = q.se ? tQuantile(0.9, q.df) * q.se : 0;
  const dQ = { dQ: q.log, lo90: q.log - half, hi90: q.log + half, P: was.quality.P };
  const qualDebt = dQ.hi90 < logit(LOOP.qualDebtHi90);
  return {
    debts: {
      latency: { debt: latDebt, signal, L: was.latency.debt && !latDebt ? now : was.latency.L },
      quality: { debt: qualDebt, P: was.quality.debt && !qualDebt ? now : was.quality.P },
    } satisfies Debts,
    vsLatencyCheckpoint: { ...lat, L: was.latency.L },
    vsQualityCheckpoint: dQ,
  };
}
