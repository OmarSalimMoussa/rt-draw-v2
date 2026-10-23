// The numbers by the pen's marks on screen (marks.ts numberSpots): numberAt's rule, at the view's zoom.
import { describe, expect, it } from "vitest";
import { readArrow } from "../../../src/core/arrow.ts";
import type { Pt, Stroke } from "../../../src/core/ink.ts";
import { markOf } from "../../../src/core/marks.ts";
import { numberSpots } from "./marks.ts";

const along = (from: [number, number], to: [number, number], t0: number): Pt[] => Array.from({ length: 21 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 20, from[1] + ((to[1] - from[1]) * i) / 20, t0 + i * 10]);
const stroke = (id: number, points: Pt[]): Stroke => ({ id, points, t0: points[0][2], t1: points.at(-1)![2] });

describe("the numbers on screen", () => {
  it("an arrow drawn up and to the right gets its number just beyond its tail, down and left of it, at any zoom", () => {
    // Shaft from 100,300 up to 300,100, the head two barbs swept back from the tip.
    const strokes = [stroke(1, along([100, 300], [300, 100], 0)), stroke(2, [...along([272, 113], [300, 100], 300), ...along([300, 100], [287, 128], 520)])];
    const tail = readArrow(strokes.map((s) => s.points)).tail!;
    for (const zoom of [0.5, 1, 2]) {
      const view = { scrollX: 40, scrollY: -20, zoom };
      const [spot] = numberSpots([markOf(strokes)], view);
      const at = { x: (tail[0] + 40) * zoom, y: (tail[1] - 20) * zoom };
      expect(spot.n).toBe(1);
      expect(spot.x).toBeLessThan(at.x);
      expect(spot.y).toBeGreaterThan(at.y);
      // On screen it keeps its size: within about 40 px of the tail whatever the zoom.
      expect(Math.hypot(spot.x - at.x, spot.y - at.y)).toBeLessThan(40);
    }
  });
});
