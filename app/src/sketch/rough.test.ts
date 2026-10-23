// The pen's strokes in red pencil (rough.ts sketchMark): wobbly, but one line, as the model's pictures draw them.
import { describe, expect, it } from "vitest";
import { sketchMark } from "./rough.ts";

const line = Array.from({ length: 20 }, (_, i) => ({ x: 100 + i * 10, y: 300 - i * 10 }));
const ring = Array.from({ length: 24 }, (_, i) => ({ x: 500 + 60 * Math.cos((i / 24) * 2 * Math.PI), y: 500 + 45 * Math.sin((i / 24) * 2 * Math.PI) }));
const moves = (d: string) => (d.match(/M/g) ?? []).length;

describe("a stroke in red pencil", () => {
  it("is drawn once, not as two passes side by side", () => {
    const open = sketchMark(line, { seed: 1, closed: false, zoom: 1 });
    expect(open.outline.map(moves)).toEqual([1]);
    const loop = sketchMark(ring, { seed: 2, closed: true, zoom: 1 });
    expect(loop.outline.map(moves)).toEqual([1]);
    // A loop keeps its hatching.
    expect(loop.fill.length).toBeGreaterThan(0);
  });
});
