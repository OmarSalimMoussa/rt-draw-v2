// Your pen: smooth strokes over the canvas, each point with its time, so a
// stroke can later be matched to the word you were saying.
import { getStroke } from "perfect-freehand";

/** x, y in canvas units; t in ms since the session started. */
export type Pt = [x: number, y: number, t: number];
/** t0: pen down; t1: pen up. */
export type Stroke = { id: number; points: Pt[]; t0: number; t1: number };

/** A click or a tiny wiggle: drawn as a filled dot, since it usually points at something. */
export const isDot = (points: Pt[]) => points.length > 0 && pathLength(points) < 3;

export function strokePath(points: Pt[], size = 5): string {
  if (!points.length) return "";
  if (isDot(points)) {
    const [x, y] = points[0];
    const r = size * 1.1;
    return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
  }
  const outline = getStroke(points.map(([x, y]) => [x, y]), { size, thinning: 0.5, smoothing: 0.5, streamline: 0.4 });
  if (!outline.length) return "";
  const d = outline.reduce((acc: (string | number)[], [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length];
    acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    return acc;
  }, ["M", ...outline[0], "Q"]);
  return `${d.join(" ")} Z`;
}

/**
 * Lets the user draw on `layer` (an <svg> sharing the canvas's viewBox).
 * Calls onStroke when each stroke ends. Returns a function that detaches it.
 */
export function attachInk(layer: SVGSVGElement, onStroke: (s: Stroke) => void, opts: { color?: string; epoch?: number } = {}) {
  const epoch = opts.epoch ?? performance.now();
  let next = 1;
  let live: { stroke: Stroke; path: SVGPathElement } | null = null;

  const toCanvas = (e: PointerEvent): Pt => {
    const p = layer.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(layer.getScreenCTM()!.inverse());
    return [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10, Math.round(performance.now() - epoch)];
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    layer.setPointerCapture(e.pointerId);
    const pt = toCanvas(e);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", opts.color ?? "#e03131");
    path.setAttribute("d", strokePath([pt]));
    layer.append(path);
    live = { stroke: { id: next++, points: [pt], t0: pt[2], t1: pt[2] }, path };
  };
  const move = (e: PointerEvent) => {
    if (!live) return;
    for (const ce of e.getCoalescedEvents?.() ?? [e]) live.stroke.points.push(toCanvas(ce));
    live.path.setAttribute("d", strokePath(live.stroke.points));
  };
  const up = () => {
    if (!live) return;
    const { stroke, path } = live;
    live = null;
    // When the pen lifted, not the last move: a click held still has one point but a real length.
    stroke.t1 = Math.round(performance.now() - epoch);
    path.setAttribute("d", strokePath(stroke.points));
    path.dataset.stroke = String(stroke.id);
    onStroke(stroke);
  };

  layer.addEventListener("pointerdown", down);
  layer.addEventListener("pointermove", move);
  layer.addEventListener("pointerup", up);
  layer.addEventListener("pointercancel", up);
  return () => {
    layer.removeEventListener("pointerdown", down);
    layer.removeEventListener("pointermove", move);
    layer.removeEventListener("pointerup", up);
    layer.removeEventListener("pointercancel", up);
  };
}

export const pathLength = (pts: Pt[]) => pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
