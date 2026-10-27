// Latency, measured only through same-run pairs (spec §1.3–1.4, §5.2). Two runs at different times
// don't pair (v1: r ≈ 0, ±15% shifts between runs), so a decision compares B with A inside its own
// run, and a checkpoint the champion with A0 inside its own: never a number from one run against
// another run's.
import { LOOP } from "./config.ts";
import { type SwapStat, median, medianStat, quantileAt, quantileStat, seedOf, swapMax, swapP } from "./stats.ts";
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
const arms = (rows: Row[], m: Metric): [number[], number[], string[]] => {
  const ok = paired(rows, m);
  return [ok.map((r) => value(r, m, 0)!), ok.map((r) => value(r, m, 1)!), ok.map((r) => r.cluster)];
};
const seedFor = (rows: Row[], m: Metric, k: string) => seedOf(`${m} ${k} ${paired(rows, m).map((r) => r.case).join(" ")}`);

/** B/A on one metric: the median paired ratio and its swap test's p. Undefined without pairs. */
export function pairedRatio(rows: Row[], m: Metric): Ratio | undefined {
  const [a, b, clusters] = arms(rows, m);
  if (!a.length) return undefined;
  const logs = Float64Array.from(a, (x, i) => Math.log(b[i] / x));
  return { est: Math.exp(median(logs, logs.length)), p: swapP(medianStat(a, b, clusters), 1, seedFor(rows, m, "p50")) };
}

/** B/A at a tail: both arms' p quantile (0.90: the p90 send) over the paired rows; `faster` against LOOP.latTailKeepHi95·A, a tail's keep line. */
export function tailRatio(rows: Row[], m: Metric, p: number): Ratio | undefined {
  const [a, b, clusters] = arms(rows, m);
  if (!a.length) return undefined;
  const s = quantileStat(a, b, clusters, p), seed = seedFor(rows, m, `p${p}`);
  const at = (xs: number[]) => [...xs].sort((x, y) => x - y)[quantileAt(xs.length, p)];
  return { est: at(b) / at(a), p: { slower: swapP(s, 1, seed).slower, faster: swapP(s, LOOP.latTailKeepHi95, seed).faster } };
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

/**
 * The latency veto's one test: every deciding stat (gatedStats' names) at once, by swapMax. `slower` is the family's p
 * that B is slower on any of them by chance, `faster` that it's faster; `worst` names the stat slowest as observed.
 * Undefined without pairs.
 */
export function shiftTest(rows: Row[]): { slower: number; faster: number; worst: string; best: string } | undefined {
  const named: [string, SwapStat][] = GATED.flatMap((m) => {
    const [a, b, clusters] = arms(rows, m);
    if (!a.length) return [];
    const tails = LOOP.latTails.filter((p) => a.length * (1 - p) >= LOOP.latTailMinSends - 1e-9);
    return [[m, medianStat(a, b, clusters)] as [string, SwapStat], ...tails.map((p): [string, SwapStat] => [`${m} p${Math.round(p * 100)}`, quantileStat(a, b, clusters, p)])];
  });
  if (!named.length) return undefined;
  const t = swapMax(named.map(([, s]) => s), seedOf(`shift ${rows.map((r) => r.case).join(" ")}`));
  return { slower: t.slower, faster: t.faster, worst: named[t.worst][0], best: named[t.best][0] };
}

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
