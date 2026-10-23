// The pen's strokes, as v1 drew them: pure geometry for their sketchy redrawing
// (sketch/MarkSketch.tsx) and where a mark's number goes on screen. What a stroke
// means (a loop, an arrow, a tap) is v2's to read (src/core/marks.ts) at Enter, and
// the number goes where v2 puts it in the model's pictures (numberAt).
import { type Mark, numberAt } from "../../../src/core/marks.ts";
import type { Box } from "../../../src/core/scene.ts";
import { DEFAULTS, type Tuning } from "../../../src/core/tuning.ts";
import { type View, toScreen } from "./view.ts";

export type Point = { x: number; y: number };

export function strokeLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** Drops points closer than `minDist` to the last kept one, then thins to at most `max`. */
export function simplify(points: Point[], minDist = 8, max = 32): Point[] {
  const kept: Point[] = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDist) kept.push(p);
  }
  if (kept.length <= max) return kept;
  const step = (kept.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => kept[Math.round(i * step)]);
}

export function polygonBox(points: Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** A stroke that comes back near where it started: it circles something. */
export function isLoop(points: Point[]): boolean {
  if (points.length < 4) return false;
  const b = polygonBox(points);
  return strokeLength(points) > 2.5 * Math.max(b.w, b.h) * 0.8 && dist(points[0], points.at(-1)!) < 0.3 * Math.max(b.w, b.h);
}

/** The numbers' size and distance from the ink on screen (.pg-marks text), in screen px. */
const NUMBER_PX = 18;
const NUMBER_GAP_PX = 6;

/** Each mark's number on screen: x its middle, y its baseline, in screen px. */
export function numberSpots(marks: Mark[], view: View, t: Tuning = DEFAULTS): { n: number; x: number; y: number }[] {
  return marks.map((m) => {
    // The digits' glyphs, as shot.ts sizes [n]'s: about 0.6 em each, 0.7 em tall.
    const [w, h] = [String(m.n).length * 0.6 * NUMBER_PX, 0.7 * NUMBER_PX];
    const [x, y] = numberAt(m, NUMBER_GAP_PX / view.zoom, w / view.zoom, h / view.zoom, t);
    const at = toScreen(view, { x, y });
    return { n: m.n, x: at.x, y: at.y + h / 2 };
  });
}
