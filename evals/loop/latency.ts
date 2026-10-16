// Latency, and the two debts, measured only through same-run pairs (spec §1.3–1.4, §5.2).
// Two runs at different times don't pair (v1: r ≈ 0, ±15% shifts between runs), so a decision
// compares B with A inside its own run, and cumulative latency and quality chain same-run
// ratios through the anchor: never a number from one run against another run's.
import { LOOP } from "./config.ts";
import { type Factor, asRatio, chain, cr1, logRatio, seedOf, tQuantile } from "./stats.ts";
import type { Ratio, Row } from "./types.ts";

export type Metric = "ttfc" | "ttd";

/** Rows where both arms have the metric (a camera-only reply has no TTFC). */
const paired = (rows: Row[], m: Metric) => rows.filter((r) => !r.void && r[m][0]! > 0 && r[m][1]! > 0);
const logs = (rows: Row[], m: Metric) => rows.map((r) => Math.log(r[m][1]! / r[m][0]!));

/** B/A on one metric: the median paired log-ratio with session-bootstrap bounds. Undefined without pairs. */
export function pairedRatio(rows: Row[], m: Metric): Ratio | undefined {
  const ok = paired(rows, m);
  if (!ok.length) return undefined;
  return logRatio(logs(ok, m), ok.map((r) => r.cluster), seedOf(`${m} ${ok.map((r) => r.case).join(" ")}`));
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

// ---- Checkpoints as chain links

/** Q's clip (§5.2): a share of 0 or 1 would make log-odds infinite. */
const SHARE_CLIP = [0.05, 0.95] as const;
const logit = (p: number) => Math.log(p / (1 - p));

/**
 * One checkpoint run (arm A the anchor, B the champion) as the links the debts chain: the mean
 * paired log-ratio per latency metric and the champion's share in log-odds, CR1 by origin
 * session. `moved`: the champion became the next anchor here, so this run's own ratio is the
 * new anchor against the old one.
 */
export type CheckpointLinks = { id: string; moved: boolean; ttfc: Factor; ttd: Factor; q: Factor };

export function linksOf(id: string, rows: Row[], moved: boolean): CheckpointLinks {
  const lat = (m: Metric): Factor => {
    const ok = paired(rows, m);
    const { mean, se, G } = cr1(logs(ok, m), ok.map((r) => r.cluster));
    return { log: mean, se, df: G - 1 };
  };
  const live = rows.filter((r) => !r.void);
  const { mean, se, G } = cr1(live.map((r) => (r.s + 1) / 2), live.map((r) => r.cluster));
  const p = Math.min(SHARE_CLIP[1], Math.max(SHARE_CLIP[0], mean));
  // Delta method: d logit(p) = dp / (p (1 − p)).
  return { id, moved, ttfc: lat("ttfc"), ttd: lat("ttd"), q: { log: logit(p), se: se / (p * (1 - p)), df: G - 1 } };
}

/**
 * The newest checkpoint's champion against the champion at checkpoint `from` (against the
 * first anchor A0 when `from` is undefined): this run's link, minus `from`'s, plus every anchor
 * move in between. A move at `from` itself cancels: the anchor then is that champion.
 */
export function chainSince(history: CheckpointLinks[], from: string | undefined, k: "ttfc" | "ttd" | "q"): Factor {
  const now = history.length - 1;
  const start = from === undefined ? -1 : history.findIndex((c) => c.id === from);
  if (from !== undefined && start < 0) throw new Error(`no checkpoint ${from} in the history`);
  const coef = new Map<number, number>([[now, 1]]);
  if (start >= 0) coef.set(start, (coef.get(start) ?? 0) - 1);
  for (let m = Math.max(0, start); m < now; m++) if (history[m].moved) coef.set(m, (coef.get(m) ?? 0) + 1);
  const terms = [...coef].filter(([, c]) => c).map(([i, c]): [number, Factor] => [c, history[i][k]]);
  return terms.length ? chain(terms) : { log: 0, se: 0, df: Infinity };
}

const ratioOf = (f: Factor): Ratio => (f.se ? asRatio(f) : { est: Math.exp(f.log), lo90: Math.exp(f.log), hi90: Math.exp(f.log), lo95: Math.exp(f.log) });

/** The loop's debts: whether it's in each, and the checkpoint it's measured against (L, P). */
export type Debts = { latency: { debt: boolean; L: string }; quality: { debt: boolean; P: string } };

/**
 * The debts after the newest checkpoint (the last of `history`). Latency debt: TTFC or TTD
 * against L has a 90% lower bound above LOOP.latDebtLo90. Quality debt: ΔQ against P has a 90%
 * upper bound below the share LOOP.qualDebtHi90 (in log-odds). A debt clears at a later
 * checkpoint back within its bound, which becomes the new L or P. Checkpoint 0 starts both.
 */
export function debtsAfter(prev: Debts | undefined, history: CheckpointLinks[]) {
  const now = history.at(-1)!.id;
  const was: Debts = prev ?? { latency: { debt: false, L: now }, quality: { debt: false, P: now } };
  const ttfc = ratioOf(chainSince(history, was.latency.L, "ttfc"));
  const ttd = ratioOf(chainSince(history, was.latency.L, "ttd"));
  const latDebt = ttfc.lo90 > LOOP.latDebtLo90 || ttd.lo90 > LOOP.latDebtLo90;
  const q = chainSince(history, was.quality.P, "q");
  const half = q.se ? tQuantile(0.9, q.df) * q.se : 0;
  const dQ = { dQ: q.log, lo90: q.log - half, hi90: q.log + half, P: was.quality.P };
  const qualDebt = dQ.hi90 < logit(LOOP.qualDebtHi90);
  return {
    debts: {
      latency: { debt: latDebt, L: was.latency.debt && !latDebt ? now : was.latency.L },
      quality: { debt: qualDebt, P: was.quality.debt && !qualDebt ? now : was.quality.P },
    } satisfies Debts,
    vsLatencyCheckpoint: { ttfc, ttd, L: was.latency.L },
    vsQualityCheckpoint: dQ,
  };
}
