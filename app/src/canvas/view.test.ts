import { describe, expect, it } from "vitest";
import { fitView } from "../../../src/core/board.ts";
import type { Box } from "../../../src/core/scene.ts";
import { type Rect, type View, boardRect, glideAt, seenRect, sendView, viewShowing } from "./view.ts";

const size = { width: 1440, height: 900 };
/** Beside a 250 px sidebar, under a 64 px toolbar, above a prompt bar. */
const r: Rect = { left: 262, top: 64, right: 1428, bottom: 760 };
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const holds = (outer: Box, inner: Box) => {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1e-6);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 1e-6);
  expect(inner.x + inner.w).toBeLessThanOrEqual(outer.x + outer.w + 1e-6);
  expect(inner.y + inner.h).toBeLessThanOrEqual(outer.y + outer.h + 1e-6);
};

describe("view math", () => {
  it("boardRect is what the whole canvas shows", () => {
    expect(boardRect({ scrollX: -100, scrollY: -50, zoom: 2 }, { width: 800, height: 600 })).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });

  it("seenRect is what the uncovered area shows", () => {
    expect(seenRect({ scrollX: 0, scrollY: 0, zoom: 1 }, { left: 262, top: 64, right: 788, bottom: 488 })).toEqual({ x: 262, y: 64, w: 526, h: 424 });
  });

  it("sendView has the screen's shape and holds what is seen", () => {
    const v: View = { scrollX: -300, scrollY: 120, zoom: 0.7 };
    const sent = sendView(v, r, size);
    near(sent.w / sent.h, 1.6, 1e-9);
    holds(sent, seenRect(v, r));
  });

  it("sendView falls back to the whole canvas when the visible area is under 50 px", () => {
    const v: View = { scrollX: 0, scrollY: 0, zoom: 1 };
    const thin: Rect = { left: 262, top: 64, right: 1428, bottom: 84 };
    expect(sendView(v, thin, size)).toEqual(fitView(boardRect(v, size), 0));
  });

  it("viewShowing fits the box in the visible area", () => {
    const box = { x: 0, y: 0, w: 1280, h: 800 };
    const seen = seenRect(viewShowing(box, r), r);
    holds(seen, box);
    // The tighter axis is filled exactly.
    const tight = (r.right - r.left) / box.w < (r.bottom - r.top) / box.h ? "w" : "h";
    near(seen[tight], box[tight]);
  });

  it("viewShowing clamps a huge box to MIN_ZOOM", () => {
    expect(viewShowing({ x: 0, y: 0, w: 100000, h: 62500 }, r).zoom).toBe(0.02);
  });

  it("glideAt starts and ends where it should, with zoom halfway in log scale", () => {
    const from: View = { scrollX: 0, scrollY: 0, zoom: 0.5 };
    const to: View = { scrollX: -2000, scrollY: -400, zoom: 2 };
    const a = glideAt(from, to, 0, r);
    const b = glideAt(from, to, 1, r);
    for (const k of ["scrollX", "scrollY", "zoom"] as const) {
      near(a[k], from[k], 1e-9);
      near(b[k], to[k], 1e-9);
    }
    near(glideAt(from, to, 0.5, r).zoom, Math.sqrt(from.zoom * to.zoom), 1e-9);
  });
});
