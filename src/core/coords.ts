// How the model names a place. One box (or a point: a box with no size) can be
// written several ways; each way reads back to a box, so the round trip shows
// what each one loses, and the text shows what it costs in tokens.
//   pixels    "320 140 200 80"                       (rounded to coords.roundPx)
//   cells     "C2-J7"                                (coords.cellPx, as ops.ts reads boxes)
//   relative  "below hero-photo, left-aligned, 20px gap, size 200x80"
//             "inside story, top-right, offset -10 10, size 200x80"
//   percent   "25% 18% 16% 10%"                      (of the canvas)
import { colName, parseBox } from "./ops.ts";
import type { Box, Scene } from "./scene.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export const SCHEMES = ["pixels", "cells", "relative", "percent"] as const;
export type Scheme = (typeof SCHEMES)[number];

export type Naming = {
  scheme: Scheme;
  text: string;
  /** A rough count: 4 characters a token. */
  tokens: number;
  /** What the naming was built from, for logs and replays. */
  features: Record<string, number | string>;
};

const tokensOf = (text: string) => Math.ceil(text.length / 4);
const isPoint = (b: Box) => b.w === 0 && b.h === 0;
const round = (v: number, step: number) => Math.round(v / step) * step;
const signed = (n: number) => (n < 0 ? `${n}` : `+${n}`);

/** Every scheme's name for a box, in SCHEMES order. */
export function name(box: Box, scene: Scene, t: Tuning = DEFAULTS): Naming[] {
  return SCHEMES.map((scheme) => {
    const { text, features } = NAMERS[scheme](box, scene, t);
    return { scheme, text, tokens: tokensOf(text), features };
  });
}

/** Reads a name back into a box (a point comes back with no size, a cell as that cell). */
export function read(scheme: Scheme, text: string, scene: Scene, t: Tuning = DEFAULTS): Box {
  return READERS[scheme](text.trim(), scene, t);
}

/**
 * How far the read-back box is from the original, in px: the worst edge for a
 * box, the distance between centers for a point.
 */
export function error(orig: Box, back: Box): number {
  if (isPoint(orig)) return Math.hypot(back.x + back.w / 2 - orig.x, back.y + back.h / 2 - orig.y);
  return Math.max(Math.abs(back.x - orig.x), Math.abs(back.y - orig.y), Math.abs(back.x + back.w - orig.x - orig.w), Math.abs(back.y + back.h - orig.y - orig.h));
}

type Built = { text: string; features: Record<string, number | string> };

const NAMERS: Record<Scheme, (b: Box, scene: Scene, t: Tuning) => Built> = {
  pixels(b, _scene, t) {
    const r = (v: number) => round(v, t["coords.roundPx"]);
    return { text: isPoint(b) ? `${r(b.x)} ${r(b.y)}` : `${r(b.x)} ${r(b.y)} ${r(b.w)} ${r(b.h)}`, features: { roundPx: t["coords.roundPx"] } };
  },

  cells(b, _scene, t) {
    const cell = t["coords.cellPx"];
    const c1 = Math.floor(b.x / cell);
    const r1 = Math.floor(b.y / cell);
    if (isPoint(b)) return { text: `${colName(c1)}${r1 + 1}`, features: { cellPx: cell, cols: 1, rows: 1 } };
    // A box covers every cell it reaches into, so the read-back box always holds it.
    const c2 = Math.max(c1, Math.ceil((b.x + b.w) / cell) - 1);
    const r2 = Math.max(r1, Math.ceil((b.y + b.h) / cell) - 1);
    return { text: `${colName(c1)}${r1 + 1}-${colName(c2)}${r2 + 1}`, features: { cellPx: cell, cols: c2 - c1 + 1, rows: r2 - r1 + 1 } };
  },

  relative(b, scene, t): Built {
    const r = (v: number) => round(v, t["coords.roundPx"]);
    const size = isPoint(b) ? "" : `, size ${r(b.w)}x${r(b.h)}`;
    const near = nearest(b, scene, t);
    if (near) {
      const { id, dir, gap, align, res } = near;
      return { text: `${dir} ${id}, ${align}${r(res) ? ` ${signed(r(res))}` : ""}, ${r(gap)}px gap${size}`, features: { ref: id, form: dir, gap: Math.round(gap), align, residual: Math.round(res) } };
    }
    const parent = container(b, scene);
    const p = parent ? parent.box : { x: 0, y: 0, w: scene.width, h: scene.height };
    const a = bestAnchor(b, p);
    const dx = r(a.dx);
    const dy = r(a.dy);
    const offset = dx || dy ? `, offset ${dx} ${dy}` : "";
    return { text: `inside ${parent?.id ?? "canvas"}, ${a.name}${offset}${size}`, features: { ref: parent?.id ?? "canvas", form: "inside", anchor: a.name, dx: Math.round(a.dx), dy: Math.round(a.dy) } };
  },

  percent(b, scene) {
    const px = (v: number) => Math.round((v / scene.width) * 100);
    const py = (v: number) => Math.round((v / scene.height) * 100);
    return { text: isPoint(b) ? `${px(b.x)}% ${py(b.y)}%` : `${px(b.x)}% ${py(b.y)}% ${px(b.w)}% ${py(b.h)}%`, features: { step: 1 } };
  },
};

const READERS: Record<Scheme, (text: string, scene: Scene, t: Tuning) => Box> = {
  pixels(text) {
    const n = text.split(/\s+/).map(Number);
    if (n.length === 2 && n.every(Number.isFinite)) return { x: n[0], y: n[1], w: 0, h: 0 };
    return parseBox(text);
  },

  cells(text, _scene, t) {
    const one = /^([A-Za-z]+\d+)$/.exec(text);
    return parseBox(one ? `${one[1]}-${one[1]}` : text, t["coords.cellPx"]);
  },

  relative(text, scene) {
    const boxOf = (id: string) => (id === "canvas" ? { x: 0, y: 0, w: scene.width, h: scene.height } : scene.get(id)?.box);
    const inside = /^inside (\S+), ([a-z-]+)(?:, offset (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?))?(?:, size (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?))?$/.exec(text);
    if (inside) {
      const p = boxOf(inside[1]);
      const a = ANCHORS.find((x) => x.name === inside[2]);
      if (!p || !a) throw new Error(`can't read "${text}"`);
      const [dx, dy, w, h] = [inside[3], inside[4], inside[5], inside[6]].map((v) => Number(v ?? 0));
      return { x: p.x + a.fx * p.w + dx - a.fx * w, y: p.y + a.fy * p.h + dy - a.fy * h, w, h };
    }
    const next = /^(below|above|right of|left of) (\S+), ([a-z-]+)(?: ([+-]\d+(?:\.\d+)?))?, (\d+(?:\.\d+)?)px gap(?:, size (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?))?$/.exec(text);
    if (!next) throw new Error(`can't read "${text}"`);
    const s = boxOf(next[2]);
    if (!s) throw new Error(`no shape "${next[2]}"`);
    const dir = next[1] as Dir;
    const [res, gap, w, h] = [next[4], next[5], next[6], next[7]].map((v) => Number(v ?? 0));
    const along = alongOf(dir, s, next[3] as Align, res, w, h);
    if (dir === "below") return { x: along, y: s.y + s.h + gap, w, h };
    if (dir === "above") return { x: along, y: s.y - gap - h, w, h };
    if (dir === "right of") return { x: s.x + s.w + gap, y: along, w, h };
    return { x: s.x - gap - w, y: along, w, h };
  },

  percent(text, scene) {
    const n = text.split(/\s+/).map((v) => Number(v.replace("%", "")) / 100);
    if (n.length === 2) return { x: n[0] * scene.width, y: n[1] * scene.height, w: 0, h: 0 };
    if (n.length !== 4 || !n.every(Number.isFinite)) throw new Error(`can't read "${text}"`);
    return { x: n[0] * scene.width, y: n[1] * scene.height, w: n[2] * scene.width, h: n[3] * scene.height };
  },
};

// Relative: the nearest neighbor in a clear direction, else the smallest shape holding the box.

type Dir = "below" | "above" | "right of" | "left of";
type Align = "left-aligned" | "centered" | "right-aligned" | "top-aligned" | "bottom-aligned";

const ANCHORS = [
  ["top-left", 0, 0], ["top", 0.5, 0], ["top-right", 1, 0],
  ["left", 0, 0.5], ["center", 0.5, 0.5], ["right", 1, 0.5],
  ["bottom-left", 0, 1], ["bottom", 0.5, 1], ["bottom-right", 1, 1],
].map(([name, fx, fy]) => ({ name: name as string, fx: fx as number, fy: fy as number }));

/** The parent anchor whose matching point on the box is closest: "inside story, top-right". */
function bestAnchor(b: Box, p: Box) {
  return ANCHORS.map((a) => ({ name: a.name, dx: b.x + a.fx * b.w - (p.x + a.fx * p.w), dy: b.y + a.fy * b.h - (p.y + a.fy * p.h) })).sort((m, n) => Math.abs(m.dx) + Math.abs(m.dy) - (Math.abs(n.dx) + Math.abs(n.dy)))[0];
}

const holds = (a: Box, b: Box) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function container(b: Box, scene: Scene) {
  return scene.stacked().filter((s) => holds(s.box, b)).sort((m, n) => m.box.w * m.box.h - n.box.w * n.box.h)[0];
}

/** Where along the reference's side the box starts, from its alignment. */
function alongOf(dir: Dir, s: Box, align: Align, res: number, w: number, h: number) {
  const vertical = dir === "below" || dir === "above";
  const [start, len, size] = vertical ? [s.x, s.w, w] : [s.y, s.h, h];
  if (align === "left-aligned" || align === "top-aligned") return start + res;
  if (align === "centered") return start + len / 2 - size / 2 + res;
  return start + len - size + res;
}

function nearest(b: Box, scene: Scene, t: Tuning) {
  let best: { id: string; dir: Dir; gap: number; dist: number; align: Align; res: number } | undefined;
  for (const s of scene.stacked()) {
    const o = s.box;
    // Only shapes the box is clear of: neither holds the other, and no overlap.
    if (overlaps(o, b) || holds(o, b) || holds(b, o)) continue;
    const gx = Math.max(o.x - (b.x + b.w), b.x - (o.x + o.w));
    const gy = Math.max(o.y - (b.y + b.h), b.y - (o.y + o.h));
    const dist = Math.hypot(Math.max(0, gx), Math.max(0, gy));
    if (dist > t["coords.nearPx"] || (best && dist >= best.dist)) continue;
    // The direction is the axis it's clear on; clear on both, the wider gap wins.
    const vertical = gy >= gx;
    const dir: Dir = vertical ? (b.y >= o.y + o.h ? "below" : "above") : b.x >= o.x + o.w ? "right of" : "left of";
    const gap = vertical ? gy : gx;
    const [bs, bl, os, ol] = vertical ? [b.x, b.w, o.x, o.w] : [b.y, b.h, o.y, o.h];
    const options: [Align, number][] = [
      [vertical ? "left-aligned" : "top-aligned", bs - os],
      ["centered", bs + bl / 2 - (os + ol / 2)],
      [vertical ? "right-aligned" : "bottom-aligned", bs + bl - (os + ol)],
    ];
    const [align, res] = options.sort((m, n) => Math.abs(m[1]) - Math.abs(n[1]))[0];
    best = { id: s.id, dir, gap, dist, align, res };
  }
  return best;
}
