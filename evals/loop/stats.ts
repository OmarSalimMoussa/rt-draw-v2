// The statistics every decision and checkpoint uses (spec §1.3–1.4, §5.2). Cases from one
// driver session are alike (same person, same page, same run of luck), so every interval
// treats the origin session as the unit: CR1 standard errors clustered by session, and a
// bootstrap that draws whole sessions. Seeded, so a verdict recomputed from rows.jsonl is
// the same verdict.
import { LOOP } from "./config.ts";
import type { Ratio } from "./types.ts";

/** A seeded uniform [0, 1) generator (mulberry32, as the spec's simulations use). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from text (FNV-1a), so the same cases always give the same draws. */
export function seedOf(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Mean and CR1 standard error clustered by `clusters` (G / (G − 1) small-sample factor). */
export function cr1(xs: number[], clusters: string[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const by = new Map<string, number>();
  xs.forEach((x, i) => by.set(clusters[i], (by.get(clusters[i]) ?? 0) + (x - mean)));
  const G = by.size;
  let ss = 0;
  for (const v of by.values()) ss += v * v;
  return { mean, se: G > 1 ? Math.sqrt((G / (G - 1)) * ss) / n : Infinity, G, n };
}

/**
 * Rule F's statistic: mean score over its CR1 SE, floored at the null SE √(decisive/n)/√n so a
 * handful of agreeing sessions can't make the SE vanish. Scores are +1 B won, −1 A won, 0 tie.
 */
export function clusteredZ(rows: { s: number; cluster: string }[]) {
  const n = rows.length;
  const decisive = rows.filter((r) => r.s !== 0).length;
  if (!n) return { z: 0, n, decisive, mean: 0, se: Infinity };
  const { mean, se: cl } = cr1(rows.map((r) => r.s), rows.map((r) => r.cluster));
  const se = Math.max(cl, Math.sqrt(decisive / n) / Math.sqrt(n));
  return { z: se > 0 && Number.isFinite(se) ? mean / se : 0, n, decisive, mean, se };
}

// ---- Student's t, for CR1 intervals with G − 1 degrees of freedom

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, s = 1.000000000190015;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

/** The regularized incomplete beta I_x(a, b), by its continued fraction (Numerical Recipes' betacf). */
function betaInc(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(1 - x, b, a);
  const tiny = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < tiny ? tiny : d);
  let f = d;
  for (let m = 1; m <= 300; m++) {
    for (const num of [(m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)), (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + num * d;
      d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      f *= c * d;
    }
    if (Math.abs(c * d - 1) < 1e-12) break;
  }
  return (front * f) / a;
}

const tCdf = (t: number, df: number) => {
  const tail = 0.5 * betaInc(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
};

const tMemo = new Map<string, number>();
/** The p quantile of Student's t with df degrees of freedom (bisection on the CDF). */
export function tQuantile(p: number, df: number): number {
  const key = `${p} ${df}`;
  if (tMemo.has(key)) return tMemo.get(key)!;
  let lo = -1e3, hi = 1e3;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  tMemo.set(key, (lo + hi) / 2);
  return (lo + hi) / 2;
}

/** A two-sided `level` interval: mean ± t(G − 1)·CR1 SE (the checkpoint-0 A/A rule, LOOP.aa). */
export function tInterval(xs: number[], clusters: string[], level: number) {
  const { mean, se, G } = cr1(xs, clusters);
  const half = tQuantile(1 - (1 - level) / 2, Math.max(1, G - 1)) * se;
  return { est: mean, lo: mean - half, hi: mean + half, se, G };
}

// ---- The session bootstrap, for paired latency ratios

/** The p quantile of sorted values, as the spec's simulations read it. */
const quantile = (sorted: ArrayLike<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

/** The k-th smallest (from 0) of a[0..n), by quickselect. */
function select(a: Float64Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i > j) break;
      const t = a[i];
      a[i++] = a[j];
      a[j--] = t;
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

// The 0.5 quantile by the same convention as `quantile` (the upper median for an even count): the
// convention the latency veto's 4 / 23 / 61% was simulated with. In place, without sorting: the
// bootstrap takes 2,000 medians per ratio.
const median = (a: Float64Array, n: number) => select(a, n, n >> 1);

/**
 * Paired per-case log-ratios (log B/A) → the ratio's estimate (the median, robust to thinking's
 * two-humped latency) with one-sided bounds from LOOP.bootstrap draws of whole sessions.
 */
export function logRatio(logs: number[], clusters: string[], seed: number): Ratio {
  const by = new Map<string, number[]>();
  logs.forEach((x, i) => (by.get(clusters[i]) ?? by.set(clusters[i], []).get(clusters[i])!).push(x));
  const groups = [...by.values()];
  const buf = new Float64Array(groups.length * Math.max(...groups.map((g) => g.length)));
  const r = rng(seed);
  const meds = new Float64Array(LOOP.bootstrap);
  for (let k = 0; k < LOOP.bootstrap; k++) {
    let n = 0;
    for (let g = 0; g < groups.length; g++) {
      for (const x of groups[Math.floor(r() * groups.length)]) buf[n++] = x;
    }
    meds[k] = median(buf, n);
  }
  meds.sort();
  const est = median(Float64Array.from(logs), logs.length);
  return { est: Math.exp(est), lo90: Math.exp(quantile(meds, 0.1)), hi90: Math.exp(quantile(meds, 0.9)), lo95: Math.exp(quantile(meds, 0.05)) };
}

// ---- Chains of same-run ratios (latency and quality debt, §1.4)

/** One run's paired estimate on the log scale: a log-ratio, or a share in log-odds. */
export type Factor = { log: number; se: number; df: number };

/** A product of same-run factors (coefficient ±1 each): logs add, and so do their variances. */
export function chain(terms: [coef: number, f: Factor][]): Factor {
  return {
    log: terms.reduce((a, [c, f]) => a + c * f.log, 0),
    se: Math.sqrt(terms.reduce((a, [c, f]) => a + c * c * f.se * f.se, 0)),
    df: Math.min(...terms.map(([, f]) => f.df)),
  };
}

/** A factor as a ratio with one-sided t bounds. */
export function asRatio(f: Factor): Ratio {
  const t90 = tQuantile(0.9, f.df), t95 = tQuantile(0.95, f.df);
  return { est: Math.exp(f.log), lo90: Math.exp(f.log - t90 * f.se), hi90: Math.exp(f.log + t90 * f.se), lo95: Math.exp(f.log - t95 * f.se) };
}

/**
 * Rule F's entry order: sessions in a seeded order, each session's cases together, so every
 * look sees whole sessions (a look that split sessions would understate the clustering).
 */
export function entryOrder<T>(items: T[], clusterOf: (x: T) => string, seed: number): T[] {
  const by = new Map<string, T[]>();
  for (const x of items) (by.get(clusterOf(x)) ?? by.set(clusterOf(x), []).get(clusterOf(x))!).push(x);
  const keys = [...by.keys()].sort();
  const r = rng(seed);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys.flatMap((k) => by.get(k)!);
}
