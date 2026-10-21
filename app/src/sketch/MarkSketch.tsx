// One of the person's strokes in red pencil (rough.ts), worked out once per stroke
// (a stroke's points never change). A tap is a dot: v2 reads it as pointing.
// (v1's MarkSketch.tsx, on v2's strokes.)
import { memo } from "react";
import type { Stroke } from "../../../src/core/ink.ts";
import { type Point, isLoop, simplify, strokeLength } from "../canvas/marks.ts";
import { seedOf, sketchMark } from "./rough.ts";

const drawn = new WeakMap<Stroke, { outline: string[]; fill: string[] } | { dot: Point }>();

function sketchOf(stroke: Stroke, zoom: number) {
  let s = drawn.get(stroke);
  if (!s) {
    const points = simplify(stroke.points.map(([x, y]) => ({ x, y })));
    s = strokeLength(points) < 4 ? { dot: { x: stroke.points[0][0], y: stroke.points[0][1] } } : sketchMark(points, { closed: isLoop(points), zoom, seed: seedOf(`stroke:${stroke.id}`) });
    drawn.set(stroke, s);
  }
  return s;
}

export const MarkSketch = memo(function MarkSketch({ stroke, zoom }: { stroke: Stroke; zoom: number }) {
  const s = sketchOf(stroke, zoom);
  if ("dot" in s) return <circle className="mk-dot" cx={s.dot.x} cy={s.dot.y} r={5 / zoom} />;
  return (
    <g>
      {s.fill.map((d, i) => <path key={`f${i}`} className="mk-fill" d={d} />)}
      {s.outline.map((d, i) => <path key={i} d={d} />)}
    </g>
  );
});
