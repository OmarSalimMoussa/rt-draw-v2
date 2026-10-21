// A pen stroke as v2 takes it (src/core/ink.ts): every point timed in ms on the
// send's ink clock, which starts at `epoch`, so a stroke can be matched to the
// word said while it was drawn. The canvas records page-clock times.
import type { Pt, Stroke } from "../../../src/core/ink.ts";

export function toStroke(id: number, raw: Pt[], downAt: number, upAt: number, epoch: number): Stroke {
  const at = (t: number) => Math.round(t - epoch);
  return { id, points: raw.map(([x, y, t]) => [x, y, at(t)]), t0: at(downAt), t1: at(upAt) };
}
