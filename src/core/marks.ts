// Strokes drawn close together in time and space form one mark. A mark either
// points at what's on the canvas (a loop, an arrow, a tap, an underline) or is
// a sketch: "make something shaped like this, here".
import { type ArrowReading, readArrow } from "./arrow.ts";
import type { HitIndex } from "./hittest.ts";
import { type Pt, type Stroke, pathLength } from "./ink.ts";
import type { Box } from "./scene.ts";

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
};

export type Tuning = { gapMs: number; nearPx: number; tapPx: number; closeRatio: number; straightRatio: number };
export const TUNING: Tuning = { gapMs: 700, nearPx: 60, tapPx: 14, closeRatio: 0.2, straightRatio: 0.88 };

export function boxOf(points: Pt[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

/** Groups strokes, in time order, into marks. */
export function groupStrokes(strokes: Stroke[], t: Tuning = TUNING): Mark[] {
  const marks: Mark[] = [];
  for (const s of [...strokes].sort((a, b) => a.t0 - b.t0)) {
    const box = boxOf(s.points);
    const last = marks.at(-1);
    if (last && s.t0 - last.t1 <= t.gapMs && gap(last.box, box) <= t.nearPx) {
      last.strokes.push(s);
      last.box = boxOf(last.strokes.flatMap((x) => x.points));
      last.t1 = s.t1;
    } else marks.push({ n: marks.length + 1, strokes: [s], box, t0: s.t0, t1: s.t1 });
  }
  return marks;
}

export function readMark(mark: Mark, hits: HitIndex, t: Tuning = TUNING): Reading {
  const arrow = readArrow(mark.strokes.map((s) => s.points));
  return { ...readKind(mark, hits, arrow, t), arrow };
}

function readKind(mark: Mark, hits: HitIndex, arrow: ArrowReading, t: Tuning): Omit<Reading, "arrow"> {
  // The longest stroke carries the gesture; short extra strokes are arrowheads or ticks.
  const main = [...mark.strokes].sort((a, b) => pathLength(b.points) - pathLength(a.points))[0];
  const pts = main.points;
  const len = pathLength(pts);
  const start = pts[0];
  const end = pts.at(-1)!;
  const span = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const all = mark.strokes.flatMap((s) => s.points);
  const touched = hits.touched(all);

  if (len < t.tapPx && mark.strokes.length === 1) {
    const top = hits.top(start[0], start[1]);
    return top ? { kind: "pointing", how: "tap", targets: [top], why: "short tap on a shape" } : { kind: "sketch", how: "sketch", targets: [], why: "a dot in empty space" };
  }

  // A drawn arrow, whatever it starts and ends on: the tip says where it points.
  if (arrow.arrow && arrow.tip && arrow.tail) {
    const from = hits.top(arrow.tail[0], arrow.tail[1]);
    const toId = hits.top(arrow.tip[0], arrow.tip[1]);
    return { kind: "pointing", how: "arrow", targets: [from, toId].filter((x): x is string => !!x), from, to: toId ?? { x: arrow.tip[0], y: arrow.tip[1] }, why: `arrow (${arrow.confidence}) from ${from ?? "empty space"} to ${toId ?? "empty space"}` };
  }

  const closed = len > 60 && span < len * t.closeRatio;
  if (closed) {
    const enclosed = hits.enclosed(pts);
    if (enclosed.length) return { kind: "pointing", how: "loop", targets: enclosed, why: `loop around ${enclosed.length} shape(s)` };
    const inside = hits.container(mark.box);
    return { kind: "sketch", how: "sketch", targets: [], inside, why: inside ? `closed shape drawn inside ${inside}, around nothing` : "closed shape in empty space" };
  }

  // Arrows come only from the arrow check above (a drawn head); a straight stroke without one is a line.
  const straight = span / len >= t.straightRatio;
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
