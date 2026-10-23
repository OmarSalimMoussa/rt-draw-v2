// Where a mark's number goes (src/core/marks.ts numberAt), one rule for the screen and
// for the pictures the model gets: just beyond an arrow's tail, beside any other mark's ink.
import { describe, expect, it } from "vitest";
import { readArrow } from "../../src/core/arrow.ts";
import type { Pt, Stroke } from "../../src/core/ink.ts";
import { markOf, numberAt } from "../../src/core/marks.ts";

type P = [number, number];
const along = (from: P, to: P, t0: number): Pt[] => Array.from({ length: 21 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 20, from[1] + ((to[1] - from[1]) * i) / 20, t0 + i * 10]);
const stroke = (id: number, points: Pt[]): Stroke => ({ id, points, t0: points[0][2], t1: points.at(-1)![2] });
/** A shaft from `tail` to `tip`, and a head of two 40 px barbs swept back 25° from the tip. */
function arrow(tail: P, tip: P): Stroke[] {
  const back = Math.atan2(tail[1] - tip[1], tail[0] - tip[0]);
  const barb = (a: number): P => [tip[0] + 40 * Math.cos(back + a), tip[1] + 40 * Math.sin(back + a)];
  const r = (25 * Math.PI) / 180;
  return [stroke(1, along(tail, tip, 0)), stroke(2, [...along(barb(r), tip, 300), ...along(tip, barb(-r), 520)])];
}
const near = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The number's glyphs take up 20 × 14; it sits 6 from the ink.
const [gap, w, h] = [6, 20, 14];

describe("where a mark's number goes", () => {
  it("an arrow up and to the right: just beyond its tail, down and left of it, far from the head", () => {
    const strokes = arrow([100, 300], [300, 100]);
    const read = readArrow(strokes.map((s) => s.points));
    expect(read).toMatchObject({ arrow: true });
    const [x, y] = numberAt(markOf(strokes), gap, w, h);
    expect(x).toBeLessThan(100);
    expect(y).toBeGreaterThan(300);
    // Its box clears the tail by the gap: the middle is gap + half the box along the shaft away.
    expect(near([x, y], read.tail!)).toBeCloseTo(gap + Math.SQRT1_2 * (w / 2) + Math.SQRT1_2 * (h / 2), 0);
    expect(near([x, y], [300, 100])).toBeGreaterThan(250);
  });

  it("an arrow pointing right: left of its tail, level with it", () => {
    const strokes = arrow([100, 200], [400, 200]);
    const tail = readArrow(strokes.map((s) => s.points)).tail!;
    const [x, y] = numberAt(markOf(strokes), gap, w, h);
    expect(x).toBeCloseTo(tail[0] - gap - w / 2, 0);
    expect(y).toBeCloseTo(tail[1], 0);
  });

  it("an arrow pointing down: above its tail", () => {
    const strokes = arrow([300, 100], [300, 400]);
    const tail = readArrow(strokes.map((s) => s.points)).tail!;
    const [x, y] = numberAt(markOf(strokes), gap, w, h);
    expect(x).toBeCloseTo(tail[0], 0);
    expect(y).toBeCloseTo(tail[1] - gap - h / 2, 0);
  });

  it("any other mark: up and right of its top-right-most ink, as the pictures had it", () => {
    const loop: Pt[] = Array.from({ length: 41 }, (_, i) => [500 + 50 * Math.cos((i / 40) * 2 * Math.PI), 500 + 50 * Math.sin((i / 40) * 2 * Math.PI), i * 10]);
    const m = markOf([stroke(1, loop)]);
    expect(readArrow([loop]).arrow).toBe(false);
    const [ax, ay] = loop.reduce((best, p) => (p[0] - p[1] > best[0] - best[1] ? p : best));
    const [x, y] = numberAt(m, gap, w, h);
    // The box's bottom-left corner is gap up and right of that point.
    expect([x - w / 2, y + h / 2]).toEqual([ax + gap, ay - gap]);
  });
});

describe("the number in the model's pictures", () => {
  it("an up-right arrow's [n] sits beyond its tail, and stays in the picture when the tail is at its edge", async () => {
    const { inkNumberSpot } = await import("../../src/core/shot.ts");
    const strokes = arrow([100, 300], [300, 100]);
    const tail = readArrow(strokes.map((s) => s.points)).tail!;
    // A picture at half size: its numbers are 22 / 0.5 = 44 board px tall.
    const s = inkNumberSpot(markOf(strokes), { x: 0, y: 0, w: 1280, h: 800 }, 0.5);
    expect(s.x).toBeLessThan(tail[0]);
    expect(s.y).toBeGreaterThan(tail[1]);
    const edge = inkNumberSpot(markOf(strokes), { x: 95, y: 0, w: 1280, h: 800 }, 0.5);
    // Text middle-anchored: half its width in from the left edge.
    expect(edge.x).toBeGreaterThanOrEqual(95 + (3 * 0.6 * 44) / 2);
  });
});
