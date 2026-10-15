// The tidy pass: after the model writes a scene, nudge near-misses into place.
// Make almost-equal sizes equal, align siblings whose edges or centers almost
// line up, even out almost-equal gaps in rows and columns, then snap to a fine
// grid (last, so things made equal stay equal). Plain geometry
// in rule order; if the rules start to fight each other, a constraint solver
// (kiwi.js, Cassowary) is the upgrade path.
//
// Siblings are shapes with the same smallest container. Containers are tidied
// before their children, and children move with their container.
import { type Box, Scene, type Shape } from "./scene.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export type Rule = "size" | "align" | "gap" | "snap" | "follow";
export type Move = {
  id: string;
  from: Box;
  to: Box;
  rule: Rule;
  why: string;
  /** The measurements behind the move, for logs and replays. */
  features: { dx: number; dy: number; dw: number; dh: number; cluster: number };
};

const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
const holds = (a: Box, b: Box) => a.x <= b.x && a.y <= b.y && right(a) >= right(b) && bottom(a) >= bottom(b) && a.w * a.h > b.w * b.h;

export function copyScene(scene: Scene): Scene {
  const out = new Scene(scene.width, scene.height);
  for (const s of scene.stacked()) out.add({ ...s, box: { ...s.box }, style: { ...s.style }, text: s.text && { ...s.text } });
  for (const [g, m] of scene.groups) out.groups.set(g, [...m]);
  return out;
}

/** Each shape's smallest container (undefined for the page), from the boxes as written. */
function parents(shapes: Shape[]) {
  const parent = new Map<string, string | undefined>();
  for (const s of shapes) {
    const holders = shapes.filter((o) => o !== s && holds(o.box, s.box)).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
    parent.set(s.id, holders[0]?.id);
  }
  return parent;
}

/** Splits values into clusters whose neighbours are within tol of each other. */
function clusters<T>(items: T[], value: (t: T) => number, tol: number): T[][] {
  const sorted = [...items].sort((a, b) => value(a) - value(b));
  const out: T[][] = [];
  for (const it of sorted) {
    const last = out.at(-1);
    if (last && value(it) - value(last.at(-1)!) <= tol) last.push(it);
    else out.push([it]);
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

export function tidy(input: Scene, t: Tuning = DEFAULTS): { scene: Scene; moves: Move[] } {
  const scene = copyScene(input);
  const moves: Move[] = [];
  // Lines and arrows connect things; they're left where they are.
  const shapes = scene.stacked().filter((s) => s.kind !== "line" && s.kind !== "arrow");
  const parent = parents(shapes);
  const children = (id: string) => shapes.filter((s) => parent.get(s.id) === id);
  const descendants = (id: string): Shape[] => children(id).flatMap((c) => [c, ...descendants(c.id)]);
  /** Where each shape was before this level's rules (after following its container), for the max-move limit. */
  const start = new Map<string, Box>();
  const snap = t["tidy.snapPx"];
  const tol = t["tidy.alignTolPx"];

  const apply = (s: Shape, to: Box, rule: Rule, why: string, cluster: number) => {
    const from = s.box;
    const f = { dx: to.x - from.x, dy: to.y - from.y, dw: to.w - from.w, dh: to.h - from.h, cluster };
    if (!f.dx && !f.dy && !f.dw && !f.dh) return;
    const s0 = start.get(s.id)!;
    const far = Math.max(Math.abs(to.x - s0.x), Math.abs(to.y - s0.y), Math.abs(right(to) - right(s0)), Math.abs(bottom(to) - bottom(s0)));
    if (far > t["tidy.maxMovePx"]) return;
    s.box = to;
    moves.push({ id: s.id, from, to, rule, why, features: f });
  };

  const tidyLevel = (sibs: Shape[]) => {
    for (const s of sibs) start.set(s.id, { ...s.box });
    const n = sibs.length;

    // 1. Same size: widths (and heights) of siblings that almost match become equal.
    if (tol > 0 && n > 1) {
      for (const dim of ["w", "h"] as const) {
        for (const c of clusters(sibs, (s) => s.box[dim], tol)) {
          if (c.length < 2) continue;
          const v = median(c.map((s) => s.box[dim]));
          for (const s of c) apply(s, { ...s.box, [dim]: v }, "size", `${dim === "w" ? "width" : "height"} of ${c.length} siblings → ${v} px`, c.length);
        }
      }
    }

    // 2. Align edges and centers that almost line up. A shape takes one alignment per axis.
    if (tol > 0 && n > 1) {
      for (const axis of ["x", "y"] as const) {
        const done = new Set<string>();
        const lo = (b: Box) => (axis === "x" ? b.x : b.y);
        const size = (b: Box) => (axis === "x" ? b.w : b.h);
        const ways: [string, (b: Box) => number, (b: Box, v: number) => Box][] = [
          [axis === "x" ? "left" : "top", lo, (b, v) => (axis === "x" ? { ...b, x: v } : { ...b, y: v })],
          [axis === "x" ? "right" : "bottom", (b) => lo(b) + size(b), (b, v) => (axis === "x" ? { ...b, x: v - b.w } : { ...b, y: v - b.h })],
          [axis === "x" ? "center x" : "center y", (b) => lo(b) + size(b) / 2, (b, v) => (axis === "x" ? { ...b, x: Math.round(v - b.w / 2) } : { ...b, y: Math.round(v - b.h / 2) })],
        ];
        for (const [name, get, put] of ways) {
          for (const c of clusters(sibs.filter((s) => !done.has(s.id)), (s) => get(s.box), tol)) {
            if (c.length < 2) continue;
            const v = median(c.map((s) => get(s.box)));
            if (c.every((s) => get(s.box) === v)) {
              c.forEach((s) => done.add(s.id));
              continue;
            }
            for (const s of c) {
              apply(s, put(s.box, v), "align", `${name} edges of ${c.length} siblings (${c.map((o) => o.id).join(", ")})`, c.length);
              done.add(s.id);
            }
          }
        }
      }
    }

    // 3. Even out almost-equal gaps in rows (side by side) and columns (stacked) of 3 or more.
    const gapTol = t["tidy.gapTolPx"];
    if (gapTol > 0 && n > 2) {
      for (const axis of ["x", "y"] as const) {
        const lo = (b: Box) => (axis === "x" ? b.x : b.y);
        const hi = (b: Box) => (axis === "x" ? right(b) : bottom(b));
        const across = (b: Box) => (axis === "x" ? b.y + b.h / 2 : b.x + b.w / 2);
        const thick = (b: Box) => (axis === "x" ? b.h : b.w);
        // A row: centers across the row's direction within half the smallest shape's thickness.
        const lanes = clusters(sibs, (s) => across(s.box), Math.max(tol, Math.min(...sibs.map((s) => thick(s.box))) / 2));
        for (const lane of lanes) {
          if (lane.length < 3) continue;
          const run = [...lane].sort((a, b) => lo(a.box) - lo(b.box));
          const gaps = run.slice(1).map((s, i) => lo(s.box) - hi(run[i].box));
          if (gaps.some((g) => g < 0)) continue;
          const spread = Math.max(...gaps) - Math.min(...gaps);
          if (spread === 0 || spread >= gapTol) continue;
          const even = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
          let at = hi(run[0].box);
          for (const s of run.slice(1)) {
            const v = at + even;
            apply(s, axis === "x" ? { ...s.box, x: v } : { ...s.box, y: v }, "gap", `${run.length} in a ${axis === "x" ? "row" : "column"}: gaps ${gaps.join("/")} → ${even} px`, run.length);
            at = hi(s.box);
          }
        }
      }
    }

    // 4. Snap to the fine grid last: positions and sizes, so equal sizes stay equal.
    if (snap > 0) {
      const r = (v: number) => Math.round(v / snap) * snap;
      for (const s of sibs) apply(s, { x: r(s.box.x), y: r(s.box.y), w: Math.max(snap, r(s.box.w)), h: Math.max(snap, r(s.box.h)) }, "snap", `position and size onto the ${snap} px grid`, 1);
    }

    // 5. Children follow their container, then get tidied among themselves.
    for (const s of sibs) {
      const was = start.get(s.id)!;
      const dx = s.box.x - was.x;
      const dy = s.box.y - was.y;
      if (dx || dy) {
        for (const d of descendants(s.id)) {
          const from = d.box;
          d.box = { ...from, x: from.x + dx, y: from.y + dy };
          moves.push({ id: d.id, from, to: d.box, rule: "follow", why: `moves with ${s.id}`, features: { dx, dy, dw: 0, dh: 0, cluster: 1 } });
        }
      }
    }
    for (const s of sibs) {
      const kids = children(s.id);
      if (kids.length) tidyLevel(kids);
    }
  };

  tidyLevel(shapes.filter((s) => parent.get(s.id) === undefined));
  return { scene, moves };
}
