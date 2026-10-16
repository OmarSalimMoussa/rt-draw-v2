// The frozen ink overlay (spec §7.1): the person's strokes drawn over the stage for
// captures (the driver's before image, the judges' before-ink.jpg), never into the
// scene. Frozen like all of evals/: today's pen and [n] look, so a candidate's
// ink.*, marks.* or shot.* knobs can't change what the driver or the judges see.
import { getStroke } from "perfect-freehand";
import { SCREEN, type View } from "../../src/core/board.ts";
import type { Stroke } from "../../src/core/ink.ts";
import { DRIVE_VIEW } from "../loop/config.ts";

/** Today's defaults, frozen: the pen (ink.*), the numbers (shot.inkNumber*), and which strokes make one mark (marks.gapMs, marks.nearPx). */
export const INK = { color: "#e03131", thinning: 0.5, smoothing: 0.5, streamline: 0.4, dotMaxPx: 3, dotRadius: 1.1, numberPx: 22, numberGapPx: 6, groupGapMs: 700, groupNearPx: 60 } as const;

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (strokes: Stroke[]): Box => {
  const xs = strokes.flatMap((s) => s.points.map((p) => p[0]));
  const ys = strokes.flatMap((s) => s.points.map((p) => p[1]));
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

/** The strokes as marks in time order: mark n is the judge transcript's [ink n] (§4.2), so the packet and the picture agree. */
export function inkGroups(strokes: Stroke[]): Stroke[][] {
  const groups: { strokes: Stroke[]; box: Box; t1: number }[] = [];
  for (const s of [...strokes].filter((x) => x.points.length).sort((a, b) => a.t0 - b.t0)) {
    const last = groups.at(-1);
    if (last && s.t0 - last.t1 <= INK.groupGapMs && gap(last.box, boxOf([s])) <= INK.groupNearPx) {
      last.strokes.push(s);
      last.box = boxOf(last.strokes);
      last.t1 = s.t1;
    } else groups.push({ strokes: [s], box: boxOf([s]), t1: s.t1 });
  }
  return groups.map((g) => g.strokes);
}

const NS = "http://www.w3.org/2000/svg";
const el = (name: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** One stroke's outline, `k` board px per screen px: the pen is DRIVE_VIEW.inkSize screen px wide at any zoom. */
function strokePath(s: Stroke, k: number): string {
  const size = DRIVE_VIEW.inkSize * k;
  const len = s.points.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - s.points[i - 1][0], p[1] - s.points[i - 1][1]) : 0), 0);
  if (len < INK.dotMaxPx * k) {
    const [x, y] = s.points[0];
    const r = size * INK.dotRadius;
    return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
  }
  const o = getStroke(s.points.map(([x, y]) => [x, y]), { size, thinning: INK.thinning, smoothing: INK.smoothing, streamline: INK.streamline });
  if (!o.length) return "";
  const d = o.reduce<(string | number)[]>((acc, [x0, y0], i) => {
    const [x1, y1] = o[(i + 1) % o.length];
    acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    return acc;
  }, ["M", ...o[0], "Q"]);
  return `${d.join(" ")} Z`;
}

/** Draws the strokes on `layer` (the <svg> over the stage, sharing the camera's viewBox `v`), with [n] by each mark in view when asked. */
export function drawInk(layer: SVGSVGElement, strokes: Stroke[], v: View, numbers: boolean) {
  const k = v.w / SCREEN.w;
  layer.replaceChildren(...strokes.filter((s) => s.points.length).map((s) => el("path", { d: strokePath(s, k), fill: INK.color })));
  if (!numbers) return;
  const px = INK.numberPx * k;
  inkGroups(strokes).forEach((g, i) => {
    const b = boxOf(g);
    if (b.x > v.x + v.w || b.x + b.w < v.x || b.y > v.y + v.h || b.y + b.h < v.y) return;
    // Beside the mark's own ink: its point furthest up and right, nudged out, kept on screen, a white halo under it.
    const [ax, ay] = g.flatMap((s) => s.points).reduce((best, p) => (p[0] - p[1] > best[0] - best[1] ? p : best));
    const x = Math.max(v.x, Math.min(v.x + v.w - px * 2, ax + INK.numberGapPx * k));
    const y = Math.max(v.y + px, Math.min(v.y + v.h - 2, ay - INK.numberGapPx * k));
    const n = el("text", { x, y, "font-size": px, "font-family": "Excalifont, 'Comic Sans MS', cursive", fill: INK.color, stroke: "#fff", "stroke-width": px / 6, "paint-order": "stroke", "font-weight": 700 });
    n.textContent = `[${i + 1}]`;
    layer.append(n);
  });
}
