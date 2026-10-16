// The picture model: a few words ("a red toy car") → a doodle that fills a
// shape's box, drawn as a small SVG by a model and redrawn with rough.js so it
// wobbles like the rest of the canvas. Elements are shown as soon as each one
// is complete in the stream, so a picture fills in while it's being drawn.
//
// Lessons from v1's doodles: the biggest shape goes first and every part must
// touch what it belongs to (Haiku once drew heads floating off bodies, so
// Sonnet is the default); no text, no background; a fixed small palette.
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import { type ModelStats, callModel, modelOf, warmModel } from "./model.ts";
import type { Scene, Shape } from "./scene.ts";
import { type TraceContext, span } from "./trace.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export const PICTURE_SYSTEM = "You draw small, charming doodles as SVG elements. Output only the elements, one per line: no prose, no code fences, no <svg> wrapper.";

export const picturePrompt = (subject: string, w: number, h: number, t: Tuning) => `Doodle: ${subject}

Like a quick, cute marker sketch in a notebook: a recognizable silhouette, simple shapes, flat colors, no text, no background, no shading.
It must hold together: draw the biggest shape first (the body), then attach every other part so it overlaps or touches what it belongs to. Nothing floats.
The box is ${w} wide and ${h} tall (x right, y down, 0 0 at the top left). Fill most of it, centered, and keep everything inside it.
Use only these elements, each on its own line and self-closing: <path d="..."/>, <circle/>, <ellipse/>, <rect/>, <line/>, <polyline/>, <polygon/>.
Attributes: geometry, fill, stroke, stroke-width. Absolute coordinates, no transforms, no groups, no style attribute.
At most ${t["picture.maxPaths"]} elements and ${t["picture.colors"]} colors (hex, like #e8590c; fill="none" for outlines). Outlines in near-black #1e1e1e, stroke-width 2 to 4.
Example (a smiling sun in a 100 x 100 box):
<circle cx="50" cy="50" r="28" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>
<path d="M38 56 Q50 66 62 56" fill="none" stroke="#1e1e1e" stroke-width="3"/>`;

/** The tags a doodle may use. Anything else (script, image, use, foreignObject, text...) is dropped. */
const TAGS = ["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"] as const;
type Tag = (typeof TAGS)[number];
/** Geometry attributes per tag; with fill, stroke and stroke-width, the only attributes kept. */
const GEOMETRY: Record<Tag, string[]> = {
  path: ["d"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
};

/** What a tag can't be drawn without (a rect's x and y default to 0, its corner radii are optional). */
const REQUIRED: Record<Tag, string[]> = { ...GEOMETRY, rect: ["width", "height"] };

export type El = { tag: Tag; attrs: Record<string, string> };

export type PictureFeatures = {
  subject: string;
  w: number;
  h: number;
  /** Elements kept (all count as paths against picture.maxPaths). */
  paths: number;
  /** Distinct colors used after the palette limit. */
  colors: number;
  /** Elements past picture.maxPaths, and elements or attributes refused by the sanitizer. */
  dropped: number;
  refused: number;
  /** Colors over picture.colors, mapped to the nearest kept color. */
  remapped: number;
  bytes: number;
  /** Some ink lies outside the box (cut off by the clip). */
  clipped: boolean;
  ms: number;
  firstMs: number;
};

export type Picture = { els: El[]; features: PictureFeatures; reply: string };

const NUM = /^-?\d*\.?\d+(?:e-?\d+)?$/i;
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|none)$/i;
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;
const POINTS = /^[0-9.,\s-]+$/;

/** One complete tag from the reply → a safe element, or why it was refused. */
export function sanitize(raw: string): { el?: El; refusedAttrs: number; why?: string } {
  const m = /^<\s*([a-zA-Z]+)\b([^<>]*?)\/?>$/s.exec(raw.trim());
  if (!m) return { refusedAttrs: 0, why: "not a tag" };
  const tag = m[1].toLowerCase() as Tag;
  if (!TAGS.includes(tag)) return { refusedAttrs: 0, why: `<${tag}> isn't allowed` };
  const attrs: Record<string, string> = {};
  let refusedAttrs = 0;
  for (const a of m[2].matchAll(/([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g)) {
    const [name, value] = [a[1].toLowerCase(), a[2].trim()];
    const ok =
      (GEOMETRY[tag].includes(name) && (name === "d" ? PATH.test(value) : name === "points" ? POINTS.test(value) : NUM.test(value))) ||
      ((name === "fill" || name === "stroke") && COLOR.test(value)) ||
      (name === "stroke-width" && NUM.test(value));
    if (ok) attrs[name] = value;
    else refusedAttrs++;
  }
  if (!REQUIRED[tag].every((g) => g in attrs)) return { refusedAttrs, why: `<${tag}> is missing its geometry` };
  return { el: { tag, attrs }, refusedAttrs };
}

/** Complete tags in the text so far: everything from "<" up to a ">" (groups and wrappers come through and are refused). */
const completeTags = (text: string) => [...text.matchAll(/<[^<>]*>/g)].map((m) => m[0]).filter((s) => !s.startsWith("</"));

const hexRgb = (c: string) => {
  const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join("") : c.slice(1);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};

/** Every number in an element's geometry as x, y pairs, roughly: enough to tell if ink leaves the box. */
function extent(el: El): { x0: number; y0: number; x1: number; y1: number } {
  const a = el.attrs;
  const n = (k: string) => Number(a[k] ?? 0);
  if (el.tag === "circle") return { x0: n("cx") - n("r"), y0: n("cy") - n("r"), x1: n("cx") + n("r"), y1: n("cy") + n("r") };
  if (el.tag === "ellipse") return { x0: n("cx") - n("rx"), y0: n("cy") - n("ry"), x1: n("cx") + n("rx"), y1: n("cy") + n("ry") };
  if (el.tag === "rect") return { x0: n("x"), y0: n("y"), x1: n("x") + n("width"), y1: n("y") + n("height") };
  if (el.tag === "line") return { x0: Math.min(n("x1"), n("x2")), y0: Math.min(n("y1"), n("y2")), x1: Math.max(n("x1"), n("x2")), y1: Math.max(n("y1"), n("y2")) };
  // Paths: absolute commands are what the prompt asks for; relative ones make this a rough guess.
  const nums = (a.d ?? a.points ?? "").match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return xs.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/**
 * Reads a reply (whole or partial) into a doodle under the knobs: sanitized
 * elements, cut at picture.maxPaths, colors beyond picture.colors mapped to the
 * nearest kept one.
 */
export function readPicture(reply: string, subject: string, w: number, h: number, t: Tuning = DEFAULTS): Omit<Picture, "features"> & { features: Omit<PictureFeatures, "ms" | "firstMs"> } {
  const els: El[] = [];
  let refused = 0;
  let dropped = 0;
  for (const raw of completeTags(reply)) {
    const s = sanitize(raw);
    refused += s.refusedAttrs;
    if (!s.el) {
      // Wrappers the prompt forbids (<svg>, <g>) are skipped quietly; anything else counts as refused.
      if (!/^<\s*(svg|g)\b/i.test(raw)) refused++;
      continue;
    }
    if (els.length >= t["picture.maxPaths"]) dropped++;
    else els.push(s.el);
  }
  // Palette: the first picture.colors distinct colors stay; later ones take the nearest of those.
  const kept: string[] = [];
  let remapped = 0;
  for (const el of els)
    for (const k of ["fill", "stroke"]) {
      const c = el.attrs[k]?.toLowerCase();
      if (!c || c === "none") continue;
      if (kept.includes(c)) continue;
      if (kept.length < t["picture.colors"]) kept.push(c);
      else {
        const rgb = hexRgb(c);
        const near = kept.reduce((best, x) => (dist3(hexRgb(x), rgb) < dist3(hexRgb(best), rgb) ? x : best));
        el.attrs[k] = near;
        remapped++;
      }
    }
  const clipped = els.some((el) => {
    const e = extent(el);
    return e.x0 < 0 || e.y0 < 0 || e.x1 > w || e.y1 > h;
  });
  return { els, reply, features: { subject, w, h, paths: els.length, colors: kept.length, dropped, refused, remapped, bytes: reply.length, clipped } };
}

const dist3 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Asks the model for a doodle of `subject` filling a w × h box. `onEls` gets the
 * elements so far each time one more completes, so the picture can fill in live.
 */
export async function drawPicture(subject: string, w: number, h: number, t: Tuning = DEFAULTS, onEls?: (els: El[]) => void, signal?: AbortSignal, parent?: TraceContext): Promise<{ picture: Picture; stats: ModelStats }> {
  let shown = 0;
  const { text, stats } = await callModel(
    { model: modelOf(t["picture.model"]), system: PICTURE_SYSTEM, user: picturePrompt(subject, w, h, t), from: "picture", warm: t["picture.parallel"] },
    (_chunk, soFar) => {
      const { els } = readPicture(soFar, subject, w, h, t);
      if (els.length > shown) {
        shown = els.length;
        onEls?.(els);
      }
    },
    signal,
    parent,
  );
  const read = readPicture(text, subject, w, h, t);
  onEls?.(read.els);
  return { picture: { ...read, features: { ...read.features, ms: stats.ms, firstMs: stats.firstMs ?? stats.ms } }, stats };
}

const NS = "http://www.w3.org/2000/svg";
let clipN = 0;

/**
 * Draws a doodle into `parent` (an <svg> or a group in one) at box x, y, w, h,
 * through rough.js with picture.roughness, clipped to the box. Seeds are fixed
 * per element, so redrawing doesn't change the wobble.
 */
export function renderPicture(parent: SVGElement, els: El[], box: { x: number; y: number; w: number; h: number }, t: Tuning = DEFAULTS, root?: SVGSVGElement): SVGGElement {
  // `root`: the <svg> it will end up in, when `parent` isn't in it yet.
  const svg = root ?? (parent instanceof SVGSVGElement ? parent : parent.ownerSVGElement!);
  const rc = rough.svg(svg);
  const id = `pic-clip-${++clipN}`;
  const g = document.createElementNS(NS, "g");
  const clip = document.createElementNS(NS, "clipPath");
  clip.id = id;
  const r = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: box.w, height: box.h })) r.setAttribute(k, String(v));
  clip.append(r);
  g.append(clip);
  g.setAttribute("transform", `translate(${box.x} ${box.y})`);
  const inner = document.createElementNS(NS, "g");
  inner.setAttribute("clip-path", `url(#${id})`);
  g.append(inner);
  els.forEach((el, i) => {
    const a = el.attrs;
    const n = (k: string) => Number(a[k] ?? 0);
    const fill = a.fill && a.fill !== "none" ? a.fill : undefined;
    const opts: Options = { seed: i + 1, roughness: t["picture.roughness"], stroke: a.stroke ?? (fill ? "none" : "#1e1e1e"), strokeWidth: a["stroke-width"] ? Number(a["stroke-width"]) : 2, fill, fillStyle: "solid" };
    if (opts.stroke === "none") opts.strokeWidth = 0;
    const pts = () => (a.points.match(/-?\d*\.?\d+/g) ?? []).map(Number).reduce<[number, number][]>((acc, v, j, arr) => (j % 2 ? acc : [...acc, [v, arr[j + 1] ?? 0]]), []);
    let node: SVGGElement;
    if (el.tag === "path") node = rc.path(a.d, opts);
    else if (el.tag === "circle") node = rc.circle(n("cx"), n("cy"), n("r") * 2, opts);
    else if (el.tag === "ellipse") node = rc.ellipse(n("cx"), n("cy"), n("rx") * 2, n("ry") * 2, opts);
    else if (el.tag === "rect") node = rc.rectangle(n("x"), n("y"), n("width"), n("height"), opts);
    else if (el.tag === "line") node = rc.line(n("x1"), n("y1"), n("x2"), n("y2"), opts);
    else if (el.tag === "polygon") node = rc.polygon(pts(), opts);
    else node = rc.linearPath(pts(), opts);
    inner.append(node);
  });
  parent.append(g);
  return g;
}

/** A shape whose picture is missing, unfinished, or drawn for another subject. */
export const needsPicture = (s: Shape) => !!s.drawing && !(s.picture?.subject === s.drawing && s.picture.done);

export type PictureFiller = {
  /** Queues every picture the scene needs that isn't drawn or drawing yet, and starts as many as picture.parallel allows. Call it after each op lands. */
  kick: () => void;
  /** No more ops are coming: draws what's left and resolves once every picture is done. */
  finish: () => Promise<{ drawn: number; failed: string[]; ms: number }>;
};

/**
 * Pictures for one send, drawn as soon as their drawing() ops land, side by
 * side with the rest of the drawing model's reply (not after it). Make it when
 * the send starts: it starts picture.parallel picture processes right away, so
 * the first pictures don't wait for one. Each picture goes straight into its
 * shape and fills in live (onUpdate after each element). A failed one stays a
 * placeholder.
 */
export function pictureFiller(scene: Scene, t: Tuning, onUpdate: () => void, signal?: AbortSignal, parent?: TraceContext): PictureFiller {
  const model = modelOf(t["picture.model"]);
  warmModel(model, PICTURE_SYSTEM, t["picture.parallel"]);
  const t0 = performance.now();
  /** Shape id and subject of every picture started this send. */
  const started = new Set<string>();
  const queue: Shape[] = [];
  const failed: string[] = [];
  let drawn = 0;
  let active = 0;
  let closed = false;
  let ctx: TraceContext | undefined;
  let finished!: () => void;
  const allDone = new Promise<void>((ok) => (finished = ok));

  const drawOne = async (shape: Shape) => {
    const subject = shape.drawing!;
    const w = Math.round(shape.box.w * t["picture.fill"]);
    const h = Math.round(shape.box.h * t["picture.fill"]);
    try {
      await span(`picture: ${shape.id}`, ctx, (pctx) =>
        drawPicture(subject, w, h, t, (els) => {
          // Still this shape's subject (a later op may have changed it): show what's drawn so far.
          if (shape.drawing !== subject) return;
          shape.picture = { subject, w, h, els, done: false };
          onUpdate();
        }, signal, pctx),
      );
      if (shape.picture?.subject === subject) shape.picture.done = true;
      drawn++;
    } catch {
      if (shape.picture?.subject === subject && !shape.picture.els.length) shape.picture = undefined;
      failed.push(shape.id);
    }
  };
  const pump = () => {
    while (active < t["picture.parallel"] && queue.length) {
      const shape = queue.shift()!;
      active++;
      void drawOne(shape).finally(() => {
        active--;
        pump();
        if (closed && !active && !queue.length) finished();
      });
    }
  };
  const kick = () => {
    for (const s of scene.stacked().filter(needsPicture)) {
      const key = `${s.id}\n${s.drawing}`;
      if (started.has(key)) continue;
      started.add(key);
      queue.push(s);
    }
    // One span for all of this send's pictures, from the first one queued.
    if (queue.length && !ctx) void span("draw pictures", parent, (c) => ((ctx = c), allDone));
    pump();
  };
  return {
    kick,
    finish: async () => {
      closed = true;
      kick();
      if (!active && !queue.length) finished();
      await allDone;
      onUpdate();
      return { drawn, failed, ms: drawn || failed.length ? Math.round(performance.now() - t0) : 0 };
    },
  };
}
