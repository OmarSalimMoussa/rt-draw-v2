// The hand-drawn look, as in Excalidraw (which draws with the same library,
// rough.js): pencil-like strokes for arrows, frames and boxes. Every shape is
// drawn from a seed (made from its id), so it looks the same on every render
// instead of wobbling each time.
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";

export type Stroke = { d: string; stroke: string; strokeWidth: number; fill?: string };
type Pt = { x: number; y: number };

const gen = rough.generator();

/** Excalidraw's default ("artist") sketchiness. */
const HAND: Options = { roughness: 1, bowing: 1, strokeWidth: 2 };

const strokes = (d: Drawable): Stroke[] => gen.toPaths(d);

/** A stable seed for a shape, from its id (FNV-1a). */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2147483646) + 1;
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} ` +
    `L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`
  );
}

export type BoxStyle = {
  seed: number;
  stroke: string;
  strokeWidth?: number;
  /** Filled solid (with a slightly off-line edge, as by hand). */
  fill?: string;
  /** Corner radius; ignored for an ellipse. */
  radius?: number;
  shape?: "box" | "ellipse" | "bottom";
  /** The classic wireframe X for a picture with nothing in it. */
  cross?: boolean;
};

/** A w×h box (or the ellipse in it, or just a line along its bottom), drawn inside its edges so the wobble doesn't get cut off. */
export function sketchBox(w: number, h: number, s: BoxStyle): Stroke[] {
  const sw = s.strokeWidth ?? 2;
  const i = sw / 2 + 1.5;
  // Small shapes wobble less, as in Excalidraw.
  const opts: Options = { ...HAND, seed: s.seed, stroke: s.stroke, strokeWidth: sw, roughness: Math.min(1, Math.min(w, h) / 60 + 0.4) };
  if (s.fill) Object.assign(opts, { fill: s.fill, fillStyle: "solid" });
  if (s.shape === "bottom") return strokes(gen.line(i, h - sw / 2, w - i, h - sw / 2, { ...opts, roughness: 0.8 }));
  const out = strokes(s.shape === "ellipse" ? gen.ellipse(w / 2, h / 2, w - 2 * i, h - 2 * i, opts) : gen.path(roundedRect(i, i, w - 2 * i, h - 2 * i, s.radius ?? 10), opts));
  if (s.cross) {
    const x = { ...opts, fill: undefined, strokeWidth: 1.5, seed: s.seed + 1 };
    out.push(...strokes(gen.line(i * 4, i * 4, w - i * 4, h - i * 4, x)), ...strokes(gen.line(w - i * 4, i * 4, i * 4, h - i * 4, { ...x, seed: s.seed + 2 })));
  }
  return out;
}

/**
 * One of the user's drawings, redrawn in pencil: a loop gets a sketchy outline and light hatching inside, a
 * line just the sketchy line. Drawn in scene units; `zoom` is the zoom it was drawn at, so its wobble and
 * hatching are sized for how it looked on screen.
 */
export function sketchMark(points: Pt[], s: { seed: number; closed: boolean; zoom: number }): { outline: string[]; fill: string[] } {
  const k = 1 / s.zoom;
  const pts: [number, number][] = points.map((p) => [p.x, p.y]);
  if (s.closed && pts.length) pts.push(pts[0]);
  const drawn = gen.curve(pts, {
    ...HAND,
    seed: s.seed,
    roughness: 1.1,
    maxRandomnessOffset: 2 * k,
    // One pass: rough's second pass beside the first reads as a doubled stroke (the model's pictures draw one line).
    disableMultiStroke: true,
    ...(s.closed && { fill: "#e03131", fillStyle: "hachure", hachureGap: 13 * k, hachureAngle: -41, fillWeight: k }),
  });
  const of = (type: string) => drawn.sets.filter((set) => set.type === type).map((set) => gen.opsToPath(set, 1));
  return { outline: of("path"), fill: of("fillSketch") };
}

/**
 * An arrow along the path `d` through `points`, with a two-stroke head at its end (`head` px long).
 * `scale`: drawing units per screen pixel, so a zoomed-out arrow still wobbles by a couple of screen pixels.
 */
export function sketchArrow(d: string, points: Pt[], s: { seed: number; stroke: string; strokeWidth?: number; head?: number; scale?: number }): Stroke[] {
  const opts: Options = { ...HAND, seed: s.seed, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 2, preserveVertices: true, maxRandomnessOffset: 2 * (s.scale ?? 1) };
  const [from, tip] = [points.at(-2), points.at(-1)];
  if (!from || !tip) return [];
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const len = s.head ?? 16;
  const wing = (side: number): [number, number] => [tip.x - len * Math.cos(angle + side * 0.45), tip.y - len * Math.sin(angle + side * 0.45)];
  return [...strokes(gen.path(d, opts)), ...strokes(gen.linearPath([wing(1), [tip.x, tip.y], wing(-1)], { ...opts, seed: s.seed + 1 }))];
}
