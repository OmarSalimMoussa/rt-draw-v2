// Which shapes your ink touches, encloses, starts on or ends on. Runs in the
// app before any model call, in well under a millisecond for a normal page.
import RBush from "rbush";
import type { Pt } from "./ink.ts";
import type { Scene, Shape } from "./scene.ts";

type Item = { minX: number; minY: number; maxX: number; maxY: number; id: string };

export class HitIndex {
  private tree = new RBush<Item>();
  private z = new Map<string, number>();
  constructor(readonly scene: Scene) {
    scene.order.forEach((id, i) => this.z.set(id, i));
    this.tree.load(scene.stacked().map((s) => ({ minX: s.box.x, minY: s.box.y, maxX: s.box.x + s.box.w, maxY: s.box.y + s.box.h, id: s.id })));
  }

  private byFront = (ids: Iterable<string>) => [...ids].sort((a, b) => this.z.get(b)! - this.z.get(a)!);

  /** Shapes under a point, front first. */
  at(x: number, y: number): string[] {
    return this.byFront(this.tree.search({ minX: x, minY: y, maxX: x, maxY: y }).filter((it) => inside(this.scene.get(it.id)!, x, y)).map((it) => it.id));
  }

  /** The front shape under a point. */
  top(x: number, y: number): string | undefined {
    return this.at(x, y)[0];
  }

  /** Every shape a stroke passes over, front first. */
  touched(points: Pt[]): string[] {
    const hit = new Set<string>();
    for (const [x, y] of points) for (const id of this.at(x, y)) hit.add(id);
    return this.byFront(hit);
  }

  /**
   * Shapes a closed stroke goes around: at least 4 of a shape's 5 sample points
   * inside the loop. Sorted front first.
   */
  enclosed(loop: Pt[]): string[] {
    if (loop.length < 3) return [];
    const xs = loop.map((p) => p[0]);
    const ys = loop.map((p) => p[1]);
    const cands = this.tree.search({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) });
    const out = cands.filter(({ id }) => {
      return samples(this.scene.get(id)!).filter(([px, py]) => pointInPolygon(px, py, loop)).length >= 4;
    });
    return this.byFront(out.map((o) => o.id));
  }

  /** The smallest shape that holds a whole box: where a sketch was drawn. */
  container(b: { x: number; y: number; w: number; h: number }): string | undefined {
    const hits = this.tree.search({ minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h })
      .map((it) => this.scene.get(it.id)!)
      .filter((s) => s.box.x <= b.x && s.box.y <= b.y && s.box.x + s.box.w >= b.x + b.w && s.box.y + s.box.h >= b.y + b.h);
    hits.sort((a, b2) => a.box.w * a.box.h - b2.box.w * b2.box.h);
    return hits[0]?.id;
  }
}

/** Five points that stand for a shape: its center and four points on its own outline (a circle's box corners lie outside it). */
function samples(s: Shape): [number, number][] {
  const { x, y, w, h } = s.box;
  const c: [number, number] = [x + w / 2, y + h / 2];
  if (s.kind === "circle") return [c, [x + w / 2, y + 2], [x + w - 2, y + h / 2], [x + w / 2, y + h - 2], [x + 2, y + h / 2]];
  if (s.kind === "line" || s.kind === "arrow") return [c, [x, y], [x + w, y + h], [x + w / 4, y + h / 4], [x + (3 * w) / 4, y + (3 * h) / 4]];
  return [c, [x, y], [x + w, y], [x, y + h], [x + w, y + h]];
}

/** Whether box a holds box b entirely. */
export const holds = (a: Shape, b: Shape) => a.box.x <= b.box.x && a.box.y <= b.box.y && a.box.x + a.box.w >= b.box.x + b.box.w && a.box.y + a.box.h >= b.box.y + b.box.h;

/** Inside the shape's own outline (an ellipse for circles), not just its box. */
function inside(s: Shape, x: number, y: number) {
  const { x: bx, y: by, w, h } = s.box;
  if (s.kind === "circle") return ((x - bx - w / 2) / (w / 2)) ** 2 + ((y - by - h / 2) / (h / 2)) ** 2 <= 1;
  if (s.kind === "line" || s.kind === "arrow") return distToSegment(x, y, bx, by, bx + w, by + h) <= 8;
  return x >= bx && x <= bx + w && y >= by && y <= by + h;
}

export function pointInPolygon(x: number, y: number, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}
