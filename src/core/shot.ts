// The picture the model gets at Enter: the scene as drawn, your red ink with a
// [n] by each mark (the same n the prompt's [ink n] markers use), id tags on
// shapes and an optional labeled grid, rasterized at shot.scale. Excalifont is
// embedded in the SVG, since an SVG drawn as an image can't load page fonts.
import fontUrl from "../fonts/Excalifont-Regular.woff2?url";
import { type Stroke, strokePath } from "./ink.ts";
import { type Mark, groupStrokes, numberAt } from "./marks.ts";
import { colName } from "./ops.ts";
import { FONT, render } from "./render.ts";
import type { Box, Scene } from "./scene.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export type Shot = {
  blob: Blob;
  dataUrl: string;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  bytes: number;
  ms: { serialize: number; rasterize: number; encode: number; total: number };
  /** What went into the picture, for logs. */
  features: { marks: number; shapes: number; tags: boolean; grid: number; scale: number };
};

export type ShotOptions = {
  inkNumbers?: boolean;
  inkColor?: string;
  /** Part of the board to capture, in board pixels; the whole scene when unset. */
  view?: { x: number; y: number; w: number; h: number };
  /** Picture width in pixels (height follows the view); the view at shot.scale when unset. */
  width?: number;
};

const NS = "http://www.w3.org/2000/svg";
const el = (name: string, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

let fontData: Promise<string> | undefined;
/** The font as a data URL, fetched once. */
const embeddedFont = () =>
  (fontData ??= fetch(fontUrl)
    .then((r) => r.blob())
    .then((b) => new Promise<string>((ok) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.readAsDataURL(b);
    })));

function grid(svg: SVGSVGElement, scene: Scene, cell: number) {
  const g = el("g");
  const size = Math.max(9, Math.min(14, cell / 3));
  for (let c = 0, x = 0; x <= scene.width; c++, x += cell) {
    g.append(el("line", { x1: x, y1: 0, x2: x, y2: scene.height, stroke: "#4dabf7", "stroke-opacity": 0.3 }));
    const t = el("text", { x: x + cell / 2, y: size + 2, "text-anchor": "middle", "font-size": size, "font-family": "monospace", fill: "#1971c2" });
    t.textContent = colName(c);
    if (x < scene.width) g.append(t);
  }
  for (let r = 1, y = 0; y <= scene.height; r++, y += cell) {
    g.append(el("line", { x1: 0, y1: y, x2: scene.width, y2: y, stroke: "#4dabf7", "stroke-opacity": 0.3 }));
    const t = el("text", { x: 3, y: y + cell / 2 + size / 3, "font-size": size, "font-family": "monospace", fill: "#1971c2" });
    t.textContent = String(r);
    if (y < scene.height) g.append(t);
  }
  svg.append(g);
}

function tags(svg: SVGSVGElement, scene: Scene, px: number) {
  for (const s of scene.stacked()) {
    const w = s.id.length * px * 0.62 + px;
    const g = el("g");
    g.append(el("rect", { x: s.box.x + 2, y: s.box.y + 2, width: w, height: px * 1.45, rx: 3, fill: "#e8590c" }));
    const t = el("text", { x: s.box.x + 2 + px / 2, y: s.box.y + 2 + px * 1.1, "font-size": px, "font-family": "monospace", fill: "#fff" });
    t.textContent = s.id;
    g.append(t);
    svg.append(g);
  }
}

/**
 * Where a mark's [n] goes in a picture of `view` at `k` picture pixels per board pixel: numberAt's
 * spot (beyond an arrow's tail, beside other ink), kept in the picture. x is the number's middle,
 * y its baseline, in board pixels.
 */
export function inkNumberSpot(m: Mark, view: Box, k: number, t: Tuning = DEFAULTS): { x: number; y: number } {
  const px = t["shot.inkNumberPx"] / k;
  // The glyphs of [n]: about 0.6 em a character, digits 0.7 em tall.
  const [w, h] = [`[${m.n}]`.length * 0.6 * px, 0.7 * px];
  const [cx, cy] = numberAt(m, t["shot.inkNumberGapPx"] / k, w, h, t);
  return { x: Math.max(view.x + w / 2, Math.min(view.x + view.w - w / 2, cx)), y: Math.max(view.y + h, Math.min(view.y + view.h - 2 / k, cy + h / 2)) };
}

export async function takeShot(scene: Scene, strokes: Stroke[], t: Tuning = DEFAULTS, opts: ShotOptions = {}): Promise<Shot> {
  const t0 = performance.now();
  const view = opts.view ?? { x: 0, y: 0, w: scene.width, h: scene.height };
  const width = Math.round(opts.width ?? view.w * t["shot.scale"]);
  const height = Math.round((width * view.h) / view.w);
  /** Picture pixels per board pixel: tags and numbers are sized for the picture, not the board. */
  const k = width / view.w;
  const scale = Math.round(k * 1000) / 1000;
  const color = opts.inkColor ?? "#e03131";

  const svg = el("svg", { xmlns: NS, width, height }) as SVGSVGElement;
  render(svg, scene, { tuning: t, view: opts.view });
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const style = el("style");
  style.textContent = `@font-face { font-family: Excalifont; src: url(${await embeddedFont()}) format("woff2"); }`;
  svg.querySelector("defs")!.append(style);

  const cell = t["shot.gridCellPx"];
  if (cell > 0) grid(svg, scene, cell);
  if (t["shot.tagPx"] > 0) tags(svg, scene, t["shot.tagPx"] / k);
  for (const s of strokes) svg.append(el("path", { d: strokePath(s.points, t["ink.size"], t), fill: color }));
  const marks = groupStrokes(strokes, t);
  if (opts.inkNumbers !== false) {
    const px = t["shot.inkNumberPx"] / k;
    for (const m of marks) {
      // A mark outside this picture gets no number (it would be pinned to the edge, pointing at nothing).
      const b = m.box;
      if (b.x > view.x + view.w || b.x + b.w < view.x || b.y > view.y + view.h || b.y + b.h < view.y) continue;
      // Where the screen puts it too (numberAt); a white halo keeps it readable over anything.
      const { x, y } = inkNumberSpot(m, view, k, t);
      const n = el("text", { x, y, "text-anchor": "middle", "font-size": px, "font-family": FONT, fill: color, stroke: "#fff", "stroke-width": px / 6, "paint-order": "stroke", "font-weight": 700 });
      n.textContent = `[${m.n}]`;
      svg.append(n);
    }
  }
  const text = new XMLSerializer().serializeToString(svg);
  const t1 = performance.now();

  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(url);
  const t2 = performance.now();

  const q = t["shot.jpegQuality"];
  const mime = q >= 1 ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), mime, q));
  const dataUrl = await new Promise<string>((ok) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result));
    fr.readAsDataURL(blob);
  });
  const t3 = performance.now();
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    blob, dataUrl, mime, width, height, bytes: blob.size,
    ms: { serialize: r(t1 - t0), rasterize: r(t2 - t1), encode: r(t3 - t2), total: r(t3 - t0) },
    features: { marks: marks.length, shapes: scene.shapes.size, tags: t["shot.tagPx"] > 0, grid: cell, scale },
  };
}

/** Anthropic's rule of thumb for image input: about one token per 750 pixels. */
export const imageTokens = (w: number, h: number) => Math.round((w * h) / 750);
