// The statistics every decision and checkpoint uses (spec §1.3–1.4, §5.2). Cases from one
// driver session are alike (same person, same page, same run of luck), so every test treats
// the origin session as the unit: CR1 standard errors clustered by session, and swap tests
// that swap the arms of whole sessions. Seeded, so a verdict recomputed from rows.jsonl is
// the same verdict.
import { LOOP } from "./config.ts";

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

// ---- Paired latency stats, and the session-swap test that decides on them

/** Where the p quantile of n sorted values is read, as the spec's simulations read it. */
export const quantileAt = (n: number, p: number) => Math.min(n - 1, Math.max(0, Math.floor(p * n)));

/** The k-th smallest (from 0) of a[0..n), by quickselect. */
export function select(a: Float64Array, n: number, k: number): number {
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

// The 0.5 quantile by the same convention as quantileAt (the upper median for an even count): the convention the
// latency rules were simulated with. In place, without sorting: the swap test takes up to 2,048 medians per stat.
export const median = (a: Float64Array, n: number) => select(a, n, n >> 1);

/** Up to this many sessions every pattern of swapped arms is taken (2^11 = 2,048), past it LOOP.bootstrap random ones. */
const SWAP_EXACT_G = 11;

/** One B/A stat on paired values: `stat` reads the two arms' buffers (it may reorder them), larger meaning B slower. */
export type SwapStat = { a: number[]; b: number[]; clusters: string[]; stat: (a: Float64Array, b: Float64Array, n: number) => number };

/**
 * Stats tested together by swapping the arms of whole sessions, the same sessions in every stat: exact under "the arms
 * are alike" at any number of sessions (LOOP-V2.md A3: at 32 cases from 8 sessions a session bootstrap's no-effect median
 * read surely slower 13% of the time for a nominal 5%). Each stat is standardized by its spread over the swaps, so a
 * noisy tail doesn't drown the median; `slower` is P that the largest standardized stat is as large by chance, `faster`
 * that the smallest is as small: one p for the family however many stats it holds, where a test per stat would take a
 * no-effect change by chance once per stat. `worst` and `best` index the stats that were largest and smallest. With few
 * sessions p can't be small: 4 sessions give 1/16 at best.
 */
export function swapMax(stats: SwapStat[], seed: number): { slower: number; faster: number; worst: number; best: number } {
  const sessions = [...new Set(stats.flatMap((x) => x.clusters))].sort();
  const at = new Map(sessions.map((c, i) => [c, i]));
  const prep = stats.map((x) => {
    const by = new Map<number, number[]>();
    x.clusters.forEach((c, i) => (by.get(at.get(c)!) ?? by.set(at.get(c)!, []).get(at.get(c)!)!).push(i));
    return { ...x, groups: [...by], A: new Float64Array(x.a.length), B: new Float64Array(x.a.length) };
  });
  const run = (swapped: (g: number) => boolean) =>
    prep.map((x) => {
      let k = 0;
      for (const [g, idx] of x.groups) {
        const s = swapped(g);
        for (const i of idx) (x.A[k] = s ? x.b[i] : x.a[i]), (x.B[k++] = s ? x.a[i] : x.b[i]);
      }
      return x.stat(x.A, x.B, k);
    });
  const exact = sessions.length <= SWAP_EXACT_G;
  const draws = exact ? 2 ** sessions.length : LOOP.bootstrap;
  const r = rng(seed);
  const obs = run(() => false);
  const T = Array.from({ length: draws }, (_, d) => (exact ? run((g) => ((d >> g) & 1) === 1) : run(() => r() < 0.5)));
  // A stat that every swap leaves where it was (one session, or no spread) can't say anything.
  const scale = stats.map((_, k) => {
    const xs = T.map((t) => t[k]);
    const mean = xs.reduce((a, b) => a + b, 0) / draws;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / draws);
    return sd > 1e-12 ? { mean, sd } : undefined;
  });
  const z = (t: number[]) => scale.flatMap((s, k) => (s ? [(t[k] - s.mean) / s.sd] : []));
  const o = z(obs);
  if (!o.length) return { slower: 1, faster: 1, worst: 0, best: 0 };
  const hi = Math.max(...o), lo = Math.min(...o);
  const live = scale.flatMap((s, k) => (s ? [k] : []));
  let above = 0, below = 0;
  for (const t of T) {
    const zt = z(t);
    if (Math.max(...zt) >= hi - 1e-9) above++;
    if (Math.min(...zt) <= lo + 1e-9) below++;
  }
  // Exact: the observed pattern is among the 2^G. Random: counted once more, as a randomization test's p must be.
  const p = (n: number) => (exact ? n / draws : (n + 1) / (draws + 1));
  return { slower: p(above), faster: p(below), worst: live[o.indexOf(hi)], best: live[o.indexOf(lo)] };
}

/** The median paired log-ratio log(B/A) as a SwapStat. */
export function medianStat(a: number[], b: number[], clusters: string[]): SwapStat {
  const logs = new Float64Array(a.length);
  return { a, b, clusters, stat: (A, B, n) => {
    for (let i = 0; i < n; i++) logs[i] = Math.log(B[i] / A[i]);
    return median(logs, n);
  } };
}

/** A tail's log-ratio as a SwapStat: both arms' p quantile, log(B/A). */
export function quantileStat(a: number[], b: number[], clusters: string[], p: number): SwapStat {
  const at = quantileAt(a.length, p);
  return { a, b, clusters, stat: (A, B, n) => Math.log(select(B, n, at) / select(A, n, at)) };
}

/** One stat's swap test against B = c·A: `slower` P that it's above c by chance, `faster` below. */
export function swapP(s: SwapStat, c: number, seed: number) {
  const t = swapMax([{ ...s, b: s.b.map((x) => x / c) }], seed);
  return { slower: t.slower, faster: t.faster };
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
