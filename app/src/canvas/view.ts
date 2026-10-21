// Where the canvas is looking. Scene coordinates are v2's board pixels; the
// screen shows them as
//   screen = (scene + scroll) * zoom
// so scroll is the scene offset and zoom the scale (v1's view, src/canvas/view.ts).
// v2's camera is a box of the board with the screen's shape (1280×800, board.ts),
// which is what the model sees as "what you see" and what camera(...) ops name:
// sendView turns the part of the canvas the panels leave uncovered into one, and
// viewShowing turns one back into a view of the canvas.
import { fitView } from "../../../src/core/board.ts";
import type { Box } from "../../../src/core/scene.ts";

export type View = { scrollX: number; scrollY: number; zoom: number };
export type Point = { x: number; y: number };
/** Screen px from the canvas's top-left: the area the sidebar, toolbar and prompt bar leave uncovered. */
export type Rect = { left: number; top: number; right: number; bottom: number };

/** Low enough that a camera op showing a whole board of pages fits. */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 4;
/** A visible area thinner than this is hidden, not a view to send. */
const MIN_SEEN_PX = 50;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The scene point under a screen point (relative to the canvas's top-left). */
export const toScene = (v: View, sx: number, sy: number): Point => ({ x: sx / v.zoom - v.scrollX, y: sy / v.zoom - v.scrollY });

export const toScreen = (v: View, p: Point): Point => ({ x: (p.x + v.scrollX) * v.zoom, y: (p.y + v.scrollY) * v.zoom });

/** Zooms to `zoom` keeping the scene point under (sx, sy) where it is on screen. */
export function zoomAt(v: View, sx: number, sy: number, zoom: number): View {
  const z = clampZoom(zoom);
  const p = toScene(v, sx, sy);
  return { zoom: z, scrollX: sx / z - p.x, scrollY: sy / z - p.y };
}

/** Moves the view by a screen distance. */
export const panBy = (v: View, dx: number, dy: number): View => ({ ...v, scrollX: v.scrollX + dx / v.zoom, scrollY: v.scrollY + dy / v.zoom });

/** What the board steers the view through. */
export type CanvasApi = {
  getView(): View;
  setView(v: View): void;
  /** The canvas's size on screen. */
  size(): { width: number; height: number };
};

/** The board area the whole canvas shows. */
export const boardRect = (v: View, size: { width: number; height: number }): Box => ({ x: -v.scrollX, y: -v.scrollY, w: size.width / v.zoom, h: size.height / v.zoom });

/** The board area inside `r`. */
export const seenRect = (v: View, r: Rect): Box => ({ x: r.left / v.zoom - v.scrollX, y: r.top / v.zoom - v.scrollY, w: (r.right - r.left) / v.zoom, h: (r.bottom - r.top) / v.zoom });

/** The camera a send is given: the smallest box of the screen's shape holding what the person sees. */
export function sendView(v: View, r: Rect, size: { width: number; height: number }): Box {
  const hidden = r.right - r.left < MIN_SEEN_PX || r.bottom - r.top < MIN_SEEN_PX;
  return fitView(hidden ? boardRect(v, size) : seenRect(v, r), 0);
}

/** The view in which `box` (a camera, or a page) just fits inside `r`, centred. */
export function viewShowing(box: Box, r: Rect): View {
  const zoom = clampZoom(Math.min((r.right - r.left) / box.w, (r.bottom - r.top) / box.h));
  return { zoom, scrollX: (r.left + r.right) / 2 / zoom - (box.x + box.w / 2), scrollY: (r.top + r.bottom) / 2 / zoom - (box.y + box.h / 2) };
}

/** Partway (u, 0–1) through a glide: eased, the zoom even in scale, the board point at r's centre moving with it. */
export function glideAt(from: View, to: View, u: number, r: Rect): View {
  const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
  const [cx, cy] = [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
  const a = toScene(from, cx, cy);
  const b = toScene(to, cx, cy);
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e);
  const [px, py] = [a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e];
  return { zoom, scrollX: cx / zoom - px, scrollY: cy / zoom - py };
}
