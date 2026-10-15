// Is this mark an arrow, and which end is the tip? Pure geometry on the ink's
// points, in the browser, well under a millisecond: no picture, no network.
//
// An arrow is a shaft (straight or gently curved) with a head at one end: ink
// near that end that sweeps back along the shaft on one or both sides. That
// covers a head drawn as separate strokes, as one V stroke, or in the same
// stroke as the shaft (out to the tip and back along the barbs).
import { type Pt, pathLength } from "./ink.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export type ArrowReading = {
  arrow: boolean;
  /** 0-1. Both barbs: about 0.95; one barb: about 0.65. */
  confidence: number;
  tip?: [number, number];
  tail?: [number, number];
  why: string;
  /** The measurements the decision came from, for logs and replays. */
  features: Record<string, number>;
};

type P = [number, number];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const len = (v: P) => Math.hypot(v[0], v[1]);
const dist = (a: P, b: P) => len(sub(a, b));
const angle = (a: P, b: P) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (len(a) * len(b) || 1)))) * (180 / Math.PI);
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];

/** Evenly spaced points along a stroke, so corners don't depend on drawing speed. */
export function resample(points: Pt[], step = 5): P[] {
  const out: P[] = [[points[0][0], points[0][1]]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    let a: P = [points[i - 1][0], points[i - 1][1]];
    const b: P = [points[i][0], points[i][1]];
    let d = dist(a, b);
    while (carry + d >= step) {
      const t = (step - carry) / d;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(a);
      d = dist(a, b);
      carry = 0;
    }
    carry += d;
  }
  const last: P = [points.at(-1)![0], points.at(-1)![1]];
  if (dist(out.at(-1)!, last) > 1) out.push(last);
  return out;
}

/** Splits a resampled stroke at sharp turns (more than `deg` degrees). */
function splitAtCorners(pts: P[], deg: number, k = 2): P[][] {
  const cuts: number[] = [];
  for (let i = k; i < pts.length - k; i++) {
    const turn = 180 - angle(sub(pts[i - k], pts[i]), sub(pts[i + k], pts[i]));
    if (turn > deg && (!cuts.length || i - cuts.at(-1)! > k * 2)) cuts.push(i);
  }
  const parts: P[][] = [];
  let from = 0;
  for (const c of cuts) {
    parts.push(pts.slice(from, c + 1));
    from = c;
  }
  parts.push(pts.slice(from));
  return parts.filter((p) => p.length > 1);
}

const polyLen = (p: P[]) => p.reduce((s, q, i) => (i ? s + dist(q, p[i - 1]) : 0), 0);

export function readArrow(strokes: Pt[][], t: Tuning = DEFAULTS): ArrowReading {
  const f: Record<string, number> = {};
  const no = (why: string): ArrowReading => ({ arrow: false, confidence: 0, why, features: f });
  const real = strokes.filter((s) => s.length > 1 && pathLength(s) >= t["ink.dotMaxPx"]);
  if (!real.length) return no("a dot");

  // The shaft: the longest straight-ish piece, whether it's its own stroke or part of one.
  const step = t["arrow.resamplePx"];
  const pieces = real.flatMap((s, si) => splitAtCorners(resample(s, step), t["arrow.cornerDeg"]).map((p) => ({ p, si })));
  pieces.sort((a, b) => polyLen(b.p) - polyLen(a.p));
  const shaft = pieces[0].p;
  const shaftLen = polyLen(shaft);
  const span = dist(shaft[0], shaft.at(-1)!);
  f.span = Math.round(span);
  f.curve = Math.round((shaftLen / (span || 1)) * 100) / 100;
  f.pieces = pieces.length;
  if (span < t["arrow.minShaftPx"]) return no("too short for a shaft");
  if (shaftLen / span > t["arrow.maxCurve"]) return no("no straight or gently curved shaft");

  // Everything that isn't the shaft could be a head.
  const rest = pieces.slice(1).flatMap((x) => x.p);
  if (!rest.length) return no("a plain line: no head at either end");

  const radius = Math.max(t["arrow.headRadiusMinPx"], Math.min(t["arrow.headRadiusMaxPx"], span * t["arrow.headRadiusFrac"]));
  const endScore = (end: P, inward: P) => {
    const back = sub(inward, end);
    const near = rest.filter((q) => {
      const d = dist(q, end);
      return d > step && d < radius;
    });
    const nearFrac = near.length / rest.length;
    // Most of the non-shaft ink must be the head: a star or a zigzag has plenty of ink far from either end.
    if (near.length < 2 || nearFrac < t["arrow.headInkFrac"]) return { score: 0, sides: 0, frac: 0, nearFrac };
    let left = 0;
    let right = 0;
    let inCone = 0;
    for (const q of near) {
      const v = sub(q, end);
      const a = angle(v, back);
      if (a > t["arrow.coneMinDeg"] && a < t["arrow.coneMaxDeg"]) {
        inCone++;
        if (cross(back, v) > 0) left++;
        else right++;
      }
    }
    const frac = inCone / near.length;
    const sides = (left >= 2 ? 1 : 0) + (right >= 2 ? 1 : 0);
    // Head ink that mostly sweeps backwards; more is better, both sides is best.
    const base = sides === 2 ? t["arrow.twoSided"] : sides === 1 ? t["arrow.oneSided"] : 0;
    const score = frac < t["arrow.coneFrac"] ? 0 : base * Math.min(1, frac + 0.2);
    return { score, sides, frac, nearFrac };
  };

  const a = shaft[0];
  const b = shaft.at(-1)!;
  // A point a little in from each end gives the shaft's direction right there, even on a curve.
  const inStep = Math.max(1, Math.min(shaft.length - 1, Math.round(t["arrow.tangentPx"] / step)));
  const inA = shaft[inStep];
  const inB = shaft[shaft.length - 1 - inStep];
  // Heads on curved arrows follow either the curve's last stretch or the line back to the other
  // end (people draw both), so try both directions and keep the better fit.
  const mid = shaft[Math.floor(shaft.length / 2)];
  const better = (x: ReturnType<typeof endScore>, y: ReturnType<typeof endScore>) => (y.score > x.score ? y : x);
  const atA = better(endScore(a, inA), endScore(a, mid));
  const atB = better(endScore(b, inB), endScore(b, mid));
  const [best, tip, tail] = atB.score >= atA.score ? [atB, b, a] : [atA, a, b];
  f.headInk = Math.round(best.nearFrac * 100) / 100;
  f.cone = Math.round(best.frac * 100) / 100;
  f.sides = best.sides;
  f.score = Math.round(best.score * 100) / 100;
  if (best.score < t["arrow.threshold"]) return no(`ink near the ends doesn't sweep back like a head (${Math.round(Math.max(atA.frac, atB.frac) * 100)}% of it does)`);
  return { arrow: true, confidence: f.score, tip, tail, why: best.sides === 2 ? "shaft with a two-sided head" : "shaft with a one-sided head", features: f };
}
