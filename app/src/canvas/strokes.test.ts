import { describe, expect, it } from "vitest";
import { toStroke } from "./strokes.ts";

describe("strokes", () => {
  it("toStroke puts a stroke on the ink clock", () => {
    expect(toStroke(3, [[10, 20, 1100.4], [12, 22, 1150.6]], 1100.2, 1180.7, 1000)).toEqual({ id: 3, points: [[10, 20, 100], [12, 22, 151]], t0: 100, t1: 181 });
  });
});
