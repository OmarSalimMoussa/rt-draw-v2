// Draws a scene into an <svg> in the doodle style: rough outlines, Excalifont,
// shapes painted back to front. A shape's picture is its doodle once the
// picture model has drawn it (src/core/picture.ts), a hatched placeholder until then.
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import { colName } from "./ops.ts";
import { renderPicture } from "./picture.ts";
import type { Scene, Shape } from "./scene.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export const FONT = "Excalifont, 'Comic Sans MS', cursive";
const NS = "http://www.w3.org/2000/svg";
const INK = "#1e1e1e";

export type RenderOptions = {
  /** Draw a labeled grid with cells this big (what the model would see). */
  grid?: number;
  /** Show each shape's id in a small tag. */
  tags?: boolean;
  /** Ids to outline, e.g. what a mark hit. */
  highlight?: Map<string, string>;
  /** The look's knobs (render.*); defaults unless a playground is tuning them. */
  tuning?: Tuning;
  /** The part of the board to show (the camera), in board pixels; the whole scene when unset. */
  view?: { x: number; y: number; w: number; h: number };
};

/** The board behind pages, so a page's white edge shows. */
export const BOARD = "#f1f0ec";

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** A stable seed per id, so a shape keeps its wobble across redraws. */
const seedOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 ** 31 || 1;

let measureCtx: CanvasRenderingContext2D | null = null;
/** The words in lines no wider than `width` where it can (a word wider than that gets a line of its own), and the widest line. */
function wrap(words: string, size: number, weight: string, width: number): { lines: string[]; widest: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  const lines: string[] = [];
  for (const para of words.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measureCtx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return { lines, widest: Math.max(...lines.map((l) => measureCtx!.measureText(l).width)) };
}

/**
 * The text's size and lines in a width × height box: its own size if it fits, else a pixel smaller
 * at a time until it does, since the shape cuts off whatever sticks out. Never below the floor.
 */
function fitText(words: string, size: number, weight: string, width: number, height: number, knobs: Tuning) {
  const floor = Math.min(size, Math.max(8, size * knobs["render.minTextScale"]));
  for (let s = size; ; s = Math.max(floor, s - 1)) {
    const { lines, widest } = wrap(words, s, weight, width);
    if (s <= floor || (lines.length * s * knobs["render.lineHeight"] <= height && widest <= width)) return { size: s, lines };
  }
}

function roundedPath(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** The shape's outline as a plain path, for clipping its insides. */
function outline(s: Shape) {
  const { x, y, w, h } = s.box;
  if (s.kind === "circle") return `M${x + w / 2} ${y}A${w / 2} ${h / 2} 0 1 1 ${x + w / 2} ${y + h}A${w / 2} ${h / 2} 0 1 1 ${x + w / 2} ${y}Z`;
  if (s.kind === "round") return roundedPath(x, y, w, h, 18);
  if (s.kind === "pill") return roundedPath(x, y, w, h, h / 2);
  return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}

/**
 * Whether a shape's box is invisible (render.pictureBox, and always for an illustration()): it holds a picture and has
 * no stroke or fill of its own, so the picture is the shape and fills it. An outline the model never asked for framed
 * every subject. The bridge's clock has its own copy (evals/bridge/main.ts pictureOnly): such a shape's first drawing is
 * its picture's first element.
 */
export function bareBox(s: Shape, knobs: Tuning = DEFAULTS): boolean {
  const st = s.style;
  const noStroke = st.stroke === "transparent" || (st.stroke === undefined && knobs["render.pictureBox"] === 1);
  return !!s.drawing && s.kind !== "frame" && noStroke && (st.fill === undefined || st.fill === "transparent");
}

function drawShape(rc: ReturnType<typeof rough.svg>, svg: SVGSVGElement, s: Shape, knobs: Tuning): SVGGElement {
  const g = el("g", { "data-id": s.id });
  const { x, y, w, h } = s.box;
  const st = s.style;
  if (st.opacity !== undefined) g.setAttribute("opacity", String(st.opacity));
  const bare = bareBox(s, knobs);
  const opts: Options = {
    seed: seedOf(s.id),
    roughness: st.roughness ?? knobs["render.roughness"],
    stroke: st.stroke === "transparent" ? "none" : (st.stroke ?? INK),
    strokeWidth: st.strokeWidth ?? knobs["render.strokeWidth"],
    fill: st.fill && st.fill !== "transparent" ? st.fill : undefined,
    fillStyle: st.fillStyle ?? "solid",
  };
  let body: SVGGElement;
  if (s.kind === "frame") {
    // A page: white, with its name above its top-left corner, sized for a board seen from afar.
    g.append(rc.rectangle(x, y, w, h, { ...opts, fill: st.fill ?? "#ffffff", roughness: Math.min(opts.roughness ?? 1, 0.6) }));
    const name = el("text", { x, y: y - 14, "font-family": FONT, "font-size": Math.max(24, Math.min(64, w / 28)), fill: "#495057" });
    name.textContent = s.text?.words ?? s.id;
    g.append(name);
    return g;
  }
  if (s.kind === "circle") body = rc.ellipse(x + w / 2, y + h / 2, w, h, opts);
  else if (s.kind === "round" || s.kind === "pill") body = rc.path(outline(s), opts);
  else if (s.kind === "line" || s.kind === "arrow") {
    body = rc.line(x, y, x + w, y + h, opts);
    if (s.kind === "arrow") {
      const a = Math.atan2(h, w);
      const head = (t: number) => rc.line(x + w, y + h, x + w - 16 * Math.cos(a + t), y + h - 16 * Math.sin(a + t), opts);
      body.append(head(0.45), head(-0.45));
    }
  } else body = rc.rectangle(x, y, w, h, opts);
  if (!bare) g.append(body);

  const clipId = `clip-${s.id}`;
  const clip = el("clipPath", { id: clipId });
  clip.append(el("path", { d: outline(s) }));
  svg.querySelector("defs")!.append(clip);

  // Words on a shape with a picture are its caption, in a band along the bottom, with the picture
  // fitted above: one drawn over the other, neither could be read.
  const t = s.text?.words ? s.text : undefined;
  const weight = t?.weight === "bold" ? "700" : "400";
  const pad = Math.min(knobs["render.textPadPx"], w * 0.06);
  const fitted = t && fitText(t.words, t.size ?? 20, weight, w - pad * 2, s.drawing ? h * knobs["render.captionMaxShare"] : h, knobs);
  const band = fitted && s.drawing ? fitted.lines.length * fitted.size * knobs["render.lineHeight"] + pad : 0;
  const ph = h - band;

  const drawn = s.drawing && s.picture?.subject === s.drawing && s.picture.els.length ? s.picture : undefined;
  if (drawn) {
    // The doodle, scaled to fit the shape as it is now (it may have moved or been resized since). Fade dims it, not the box.
    const pic = el("g", { "clip-path": `url(#${clipId})` });
    if (st.fade) pic.setAttribute("style", `opacity:${1 - st.fade * knobs["render.fadeOpacity"]};filter:saturate(${1 - st.fade})`);
    const share = bare ? 1 : knobs["picture.fill"];
    const k = Math.min((w * share) / drawn.w, (ph * share) / drawn.h);
    const fit = el("g", { transform: `translate(${x + (w - drawn.w * k) / 2} ${y + (ph - drawn.h * k) / 2}) scale(${k})` });
    renderPicture(fit, drawn.els, { x: 0, y: 0, w: drawn.w, h: drawn.h }, knobs, svg);
    pic.append(fit);
    g.append(pic);
  } else if (s.drawing) {
    // Placeholder picture: hatched, with what it will show. Fade dims it, not the box.
    const pic = el("g", { "clip-path": `url(#${clipId})` });
    if (st.fade) pic.setAttribute("style", `opacity:${1 - st.fade * knobs["render.fadeOpacity"]};filter:saturate(${1 - st.fade})`);
    const hatch = rc.rectangle(x + w * 0.1, y + ph * 0.1, w * 0.8, ph * 0.8, { seed: seedOf(s.id) + 1, roughness: 2, stroke: "#868e96", strokeWidth: 1, fill: "#adb5bd", fillStyle: "cross-hatch", hachureGap: 10 });
    const label = el("text", { x: x + w / 2, y: y + ph - Math.max(14, ph * 0.12), "text-anchor": "middle", "font-family": FONT, "font-size": Math.max(11, Math.min(16, w / 14)), fill: "#495057" });
    label.textContent = `🖼 ${s.drawing}`;
    pic.append(hatch);
    // Small shapes get the hatch only; the subject is in the shape's tag and data.
    if (w >= 90 && ph >= 60) pic.append(label);
    g.append(pic);
  }

  if (t && fitted) {
    const { size, lines } = fitted;
    const lh = size * knobs["render.lineHeight"];
    // In the middle of the shape, or of the caption band.
    const top = (band ? y + ph + band / 2 : y + h / 2) - (lines.length * lh) / 2 + size * 0.9;
    const anchor = t.align === "left" ? "start" : t.align === "right" ? "end" : "middle";
    const tx = t.align === "left" ? x + pad : t.align === "right" ? x + w - pad : x + w / 2;
    const text = el("text", { "font-family": FONT, "font-size": size, "font-weight": weight, fill: t.color ?? INK, "text-anchor": anchor, "clip-path": `url(#${clipId})`, style: "white-space:pre" });
    lines.forEach((ln, i) => {
      const span = el("tspan", { x: tx, y: top + i * lh });
      span.textContent = ln;
      text.append(span);
    });
    g.append(text);
  }
  return g;
}

function drawGrid(svg: SVGSVGElement, scene: Scene, cell: number) {
  const g = el("g", { "pointer-events": "none" });
  for (let c = 0, x = 0; x <= scene.width; c++, x += cell) {
    g.append(el("line", { x1: x, y1: 0, x2: x, y2: scene.height, stroke: "#4dabf7", "stroke-opacity": 0.25 }));
    if (x < scene.width) {
      const t = el("text", { x: x + cell / 2, y: 11, "text-anchor": "middle", "font-size": 10, "font-family": "monospace", fill: "#1971c2" });
      t.textContent = colName(c);
      g.append(t);
    }
  }
  for (let r = 1, y = 0; y <= scene.height; r++, y += cell) {
    g.append(el("line", { x1: 0, y1: y, x2: scene.width, y2: y, stroke: "#4dabf7", "stroke-opacity": 0.25 }));
    if (y < scene.height) {
      const t = el("text", { x: 3, y: y + cell / 2 + 4, "font-size": 10, "font-family": "monospace", fill: "#1971c2" });
      t.textContent = String(r);
      g.append(t);
    }
  }
  svg.append(g);
}

function drawTag(svg: SVGSVGElement, s: Shape, color = "#e8590c") {
  const label = s.id;
  const w = label.length * 7 + 10;
  const g = el("g", { "pointer-events": "none" });
  g.append(el("rect", { x: s.box.x + 2, y: s.box.y + 2, width: w, height: 16, rx: 3, fill: color }));
  const t = el("text", { x: s.box.x + 7, y: s.box.y + 14, "font-size": 11, "font-family": "monospace", fill: "#fff" });
  t.textContent = label;
  g.append(t);
  svg.append(g);
}

/** Redraws the whole scene. Returns how long it took, in ms. */
export function render(svg: SVGSVGElement, scene: Scene, opts: RenderOptions = {}): number {
  const t0 = performance.now();
  svg.replaceChildren(el("defs"));
  const v = opts.view;
  if (v) {
    // A camera on the board: pages are white on the board's color.
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    svg.append(el("rect", { x: v.x, y: v.y, width: v.w, height: v.h, fill: BOARD }));
  } else {
    svg.setAttribute("viewBox", `0 0 ${scene.width} ${scene.height}`);
    svg.append(el("rect", { x: 0, y: 0, width: scene.width, height: scene.height, fill: "#ffffff" }));
  }
  const rc = rough.svg(svg);
  for (const s of scene.stacked()) svg.append(drawShape(rc, svg, s, opts.tuning ?? DEFAULTS));
  if (opts.grid) drawGrid(svg, scene, opts.grid);
  for (const [id, color] of opts.highlight ?? []) {
    const s = scene.get(id);
    if (!s) continue;
    svg.append(el("path", { d: outline(s), fill: color, "fill-opacity": 0.12, stroke: color, "stroke-width": 3, "stroke-dasharray": "6 4", "pointer-events": "none" }));
  }
  if (opts.tags) for (const s of scene.stacked()) drawTag(svg, s, opts.highlight?.get(s.id));
  return performance.now() - t0;
}
