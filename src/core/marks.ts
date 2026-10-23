// Strokes drawn close together in time and space form one mark. A mark either
// points at what's on the canvas (a loop, an arrow, a tap, an underline) or is
// a sketch: "make something shaped like this, here".
import { type ArrowReading, readArrow } from "./arrow.ts";
import type { HitIndex } from "./hittest.ts";
import { type Pt, type Stroke, pathLength } from "./ink.ts";
import type { Box } from "./scene.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export type How = "loop" | "arrow" | "tap" | "line" | "scribble" | "sketch";
export type Mark = {
  n: number;
  strokes: Stroke[];
  box: Box;
  t0: number;
  t1: number;
};
export type Reading = {
  kind: "pointing" | "sketch";
  how: How;
  /** What it points at, front first. */
  targets: string[];
  /** Arrows: the shape at the start and at the end (or the empty spot). */
  from?: string;
  to?: string | { x: number; y: number };
  /** Sketches: the shape it was drawn inside, if any. */
  inside?: string;
  /** Every mark is checked for being an arrow, whatever else it is; the tip says where it points. */
  arrow: ArrowReading;
  why: string;
  /** The measurements the decision came from, for logs and replays. */
  features: Record<string, number>;
};

export function boxOf(points: Pt[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

/** One mark from its strokes, as grouping would make it: what a logged example replays. */
export function markOf(strokes: Stroke[], n = 1): Mark {
  return { n, strokes, box: boxOf(strokes.flatMap((s) => s.points)), t0: Math.min(...strokes.map((s) => s.t0)), t1: Math.max(...strokes.map((s) => s.t1)) };
}

/** A mark's identity across regroupings and saves: its stroke ids. */
export const markKey = (m: { strokes: Stroke[] }) => m.strokes.map((s) => s.id).join(",");

/** What a reading says, as the label people correct: "sketch" or "pointing:<how>". */
export const kindLabel = (r: Reading) => (r.kind === "sketch" ? "sketch" : `pointing:${r.how}`);

/** Groups strokes, in time order, into marks. */
export function groupStrokes(strokes: Stroke[], t: Tuning = DEFAULTS): Mark[] {
  const marks: Mark[] = [];
  for (const s of [...strokes].sort((a, b) => a.t0 - b.t0)) {
    const box = boxOf(s.points);
    const last = marks.at(-1);
    if (last && s.t0 - last.t1 <= t["marks.gapMs"] && gap(last.box, box) <= t["marks.nearPx"]) {
      last.strokes.push(s);
      last.box = boxOf(last.strokes.flatMap((x) => x.points));
      last.t1 = s.t1;
    } else marks.push({ n: marks.length + 1, strokes: [s], box, t0: s.t0, t1: s.t1 });
  }
  return marks;
}

/**
 * Where a mark's number goes, on the screen and in the model's pictures alike: just beyond
 * an arrow's tail, on the side away from its tip; beside any other mark's ink, up and right
 * of its top-right-most point. `gap` (from the ink) and the number's glyphs, `w` × `h`, are
 * in the ink's units; returns the number's middle.
 */
export function numberAt(m: Mark, gap: number, w: number, h: number, t: Tuning = DEFAULTS): [number, number] {
  const { tip, tail } = readArrow(m.strokes.map((s) => s.points), t);
  const d = tip && tail ? Math.hypot(tail[0] - tip[0], tail[1] - tip[1]) : 0;
  if (tip && tail && d) {
    const [ux, uy] = [(tail[0] - tip[0]) / d, (tail[1] - tip[1]) / d];
    // Far enough along the shaft's line that the number's box clears the tail by `gap`.
    const out = gap + Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
    return [tail[0] + ux * out, tail[1] + uy * out];
  }
  const [ax, ay] = m.strokes.flatMap((s) => s.points).reduce((best, p) => (p[0] - p[1] > best[0] - best[1] ? p : best));
  return [ax + gap + w / 2, ay - gap - h / 2];
}

export function readMark(mark: Mark, hits: HitIndex, t: Tuning = DEFAULTS): Reading {
  const arrow = readArrow(mark.strokes.map((s) => s.points), t);
  const main = [...mark.strokes].sort((a, b) => pathLength(b.points) - pathLength(a.points))[0].points;
  const len = pathLength(main);
  const span = Math.hypot(main.at(-1)![0] - main[0][0], main.at(-1)![1] - main[0][1]);
  const features = { strokes: mark.strokes.length, len: Math.round(len), endGap: Math.round((span / (len || 1)) * 100) / 100, ms: mark.t1 - mark.t0 };
  return { ...readKind(mark, hits, arrow, t), arrow, features };
}

function readKind(mark: Mark, hits: HitIndex, arrow: ArrowReading, t: Tuning): Omit<Reading, "arrow" | "features"> {
  // The longest stroke carries the gesture; short extra strokes are arrowheads or ticks.
  const main = [...mark.strokes].sort((a, b) => pathLength(b.points) - pathLength(a.points))[0];
  const pts = main.points;
  const len = pathLength(pts);
  const start = pts[0];
  const end = pts.at(-1)!;
  const span = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const all = mark.strokes.flatMap((s) => s.points);
  const touched = hits.touched(all, t);

  if (len < t["marks.tapPx"] && mark.strokes.length === 1) {
    const top = hits.top(start[0], start[1], t);
    return top ? { kind: "pointing", how: "tap", targets: [top], why: "short tap on a shape" } : { kind: "sketch", how: "sketch", targets: [], why: "a dot in empty space" };
  }

  // A drawn arrow, whatever it starts and ends on: the tip says where it points.
  if (arrow.arrow && arrow.tip && arrow.tail) {
    const from = hits.top(arrow.tail[0], arrow.tail[1], t);
    const toId = hits.top(arrow.tip[0], arrow.tip[1], t);
    return { kind: "pointing", how: "arrow", targets: [from, toId].filter((x): x is string => !!x), from, to: toId ?? { x: arrow.tip[0], y: arrow.tip[1] }, why: `arrow (${arrow.confidence}) from ${from ?? "empty space"} to ${toId ?? "empty space"}` };
  }

  const closed = len > t["marks.minLoopPx"] && span < len * t["marks.closeRatio"];
  if (closed) {
    const enclosed = hits.enclosed(pts, t);
    if (enclosed.length) return { kind: "pointing", how: "loop", targets: enclosed, why: `loop around ${enclosed.length} shape(s)` };
    const inside = hits.container(mark.box);
    return { kind: "sketch", how: "sketch", targets: [], inside, why: inside ? `closed shape drawn inside ${inside}, around nothing` : "closed shape in empty space" };
  }

  // Arrows come only from the arrow check above (a drawn head); a straight stroke without one is a line.
  const straight = span / len >= t["marks.straightRatio"];
  if (straight) {
    if (touched.length) return { kind: "pointing", how: "line", targets: touched.slice(0, 1), why: `straight line over ${touched[0]}` };
    return { kind: "sketch", how: "sketch", targets: [], inside: hits.container(mark.box), why: "straight line in empty space" };
  }

  // Squiggles: over shapes it's emphasis ("this one"); in empty space it's a drawing.
  const inside = hits.container(mark.box);
  const overOwnShapes = touched.filter((id) => id !== inside);
  if (overOwnShapes.length) return { kind: "pointing", how: "scribble", targets: overOwnShapes, why: `scribble over ${overOwnShapes.join(", ")}` };
  return { kind: "sketch", how: "sketch", targets: [], inside, why: inside ? `free drawing inside ${inside}` : "free drawing in empty space" };
}
