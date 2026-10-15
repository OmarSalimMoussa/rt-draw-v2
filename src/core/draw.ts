// The drawing model: one send (your words with [ink n] markers, the screenshot
// with your numbered ink, the id map) → op lines, streamed back and applied the
// moment each line completes. buildPrompt hides nothing, so a playground can
// show exactly what was sent; run records when each op landed.
import type { Stroke } from "./ink.ts";
import { type Word, linkInk } from "./link.ts";
import { groupStrokes } from "./marks.ts";
import { type ModelStats, callModel, modelOf } from "./model.ts";
import { OpStream, type Parsed, applyOp } from "./ops.ts";
import type { Scene, Shape } from "./scene.ts";
import { type Shot, takeShot } from "./shot.ts";
import { DEFAULTS, type Tuning, tune } from "./tuning.ts";

/** The op manual, short on purpose: v1's long manual is not carried over. {W} {H} {CELL} are filled in. */
export const SYSTEM = `You edit a drawing canvas of {W}×{H} pixels (x right, y down, origin top-left). Shapes sit in layers like a slide; nothing is laid out for you: a shape is drawn exactly where its box says.

Reply ONLY with op lines, one per line: no prose, no code fences. Each line is applied the moment it is complete, so put the most visible change first.

shape(id, kind, box, "description", style...)   add a shape, or change only what you give
text(id, "words", size:s|m|l|xl, color:..., align:left|center|right, weight:bold)
drawing(id, "what the picture shows", fade:0-1)  a doodle picture inside a shape
layer(id, front | back | above:other | below:other)
move(id, box)      remove(id)      group(id, [a, b, ...])

kind: rect, round, circle, pill, line, arrow (line and arrow run from the box's top-left to its bottom-right).
box: x y w h in canvas pixels{CELL}, written bare, never in quotes. Quotes are only for descriptions and words.
Example: shape(sale-badge, pill, 1100 90 150 50, "small red pill badge in the top right corner announcing a toy sale", fill:#e03131, stroke:none)
style: fill:#hex  stroke:#hex|none  opacity:0-1  fade:0-1 (dims the picture, not the box).
Ids are short readable names (hero-title, toy-l2). The same id changes that shape: never re-create an existing shape under a new id.
A NEW shape needs a box and a description of at least 6 words saying what it is and what it's for. Later sends find shapes by these descriptions.

The user's words carry [ink n] markers: n is the red ink mark labeled [n] in the screenshot, drawn while they said that word. Their ink points at things or sketches a shape and place; it is never part of the page, so don't copy it unless they ask you to draw what they sketched. If the request is unclear, make the most likely change.`;

export type Prompt = {
  system: string;
  user: string;
  images: string[];
  /** The screenshot as sent, when it was. */
  shot?: Shot;
  /** The transcript with its [ink n] markers. */
  transcript: string;
  features: { chars: number; imageTokens: number; shapes: number; marks: number; idMap: number; ops: number; screenshot: number; grid: number };
};

/** The scene as op lines: its exact boxes and styles, for when the model should see numbers. */
export function sceneToOps(scene: Scene): string {
  const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
  const style = (s: Shape) => Object.entries(s.style).filter(([, v]) => v !== undefined).map(([k, v]) => `, ${k}:${v}`).join("");
  const lines: string[] = [];
  for (const s of scene.stacked()) {
    const { x, y, w, h } = s.box;
    lines.push(`shape(${s.id}, ${s.kind}, ${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}, ${q(s.description)}${style(s)})`);
    if (s.text?.words) {
      const t = s.text;
      const extra = [t.size && `size:${t.size}`, t.color && `color:${t.color}`, t.align && `align:${t.align}`, t.weight && `weight:${t.weight}`].filter(Boolean).map((x) => `, ${x}`).join("");
      lines.push(`text(${s.id}, ${q(t.words)}${extra})`);
    }
    if (s.drawing) lines.push(`drawing(${s.id}, ${q(s.drawing)})`);
  }
  for (const [g, members] of scene.groups) lines.push(`group(${g}, [${members.join(", ")}])`);
  return lines.join("\n");
}

/**
 * Typed words have no times, so the ink can't be matched by time: mark n goes
 * after the n-th pointing word (this, that, here...), and any left over go at the end.
 */
export function typedTranscript(text: string, marks: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const pointing = /^(this|that|here|there|these|those|it)\b/i;
  let n = 0;
  const out = words.map((w) => (n < marks && pointing.test(w) ? `${w} [ink ${++n}]` : w));
  while (n < marks) out.push(`[ink ${++n}]`);
  return out.join(" ");
}

/** What the model gets for this send. Words are spoken (with times) or typed (a string). */
export async function buildPrompt(scene: Scene, strokes: Stroke[], words: Word[] | string, t: Tuning = DEFAULTS): Promise<Prompt> {
  const marks = groupStrokes(strokes, t);
  const transcript = typeof words === "string" ? typedTranscript(words, marks.length) : linkInk(words, marks, t).text;
  const cell = t["draw.gridCellPx"];
  const system = SYSTEM.replace("{W}", String(scene.width))
    .replace("{H}", String(scene.height))
    .replace("{CELL}", cell > 0 ? `, or grid cells like C2-J7 (bare) as labeled on the screenshot (${cell} px cells, columns A, B, ... rows 1, 2, ...)` : "");

  const parts = [`Canvas: ${scene.width}×${scene.height} px, ${scene.shapes.size} shapes.`];
  const idMap = t["draw.sendIdMap"] ? scene.stacked().map((s) => `${s.id}: ${s.description}`) : [];
  if (idMap.length) parts.push(`Shapes, back to front (id: description):\n${idMap.join("\n")}`);
  const ops = t["draw.sendOps"] ? sceneToOps(scene) : "";
  if (ops) parts.push(`The scene as ops:\n${ops}`);
  let shot: Shot | undefined;
  if (t["draw.sendScreenshot"]) {
    shot = await takeShot(scene, strokes, tune({ "shot.gridCellPx": cell }, t));
    parts.push(`The screenshot is the canvas at ${Math.round(shot.width)}×${Math.round(shot.height)} (scaled ${t["shot.scale"]}); boxes are always in canvas pixels.`);
  }
  parts.push(`Request: ${transcript || "(no words)"}`);
  const user = parts.join("\n\n");
  const imageTokens = shot ? Math.round((shot.width * shot.height) / 750) : 0;
  return {
    system,
    user,
    images: shot ? [shot.dataUrl] : [],
    shot,
    transcript,
    features: { chars: system.length + user.length, imageTokens, shapes: scene.shapes.size, marks: marks.length, idMap: idMap.length, ops: ops ? ops.split("\n").length : 0, screenshot: shot ? 1 : 0, grid: cell },
  };
}

export type OpResult = { line: string; ok: boolean; error?: string; ms: number };
export type SendResult = { ops: OpResult[]; firstOpMs?: number; ms: number; stats?: ModelStats; reply: string; error?: string };

/**
 * Sends the prompt and applies each op line to `scene` as it completes. onOp
 * fires after each line (so the caller re-renders); times are ms since the send.
 */
export async function run(scene: Scene, prompt: Prompt, t: Tuning, onOp: (r: OpResult) => void, onText?: (soFar: string) => void, signal?: AbortSignal): Promise<SendResult> {
  const t0 = performance.now();
  const stream = new OpStream();
  const ops: OpResult[] = [];
  let firstOpMs: number | undefined;
  // Cells in the reply mean the grid the model saw.
  const opT = t["draw.gridCellPx"] > 0 ? tune({ "ops.cellPx": t["draw.gridCellPx"] }, t) : t;
  const handle = (parsed: Parsed[]) => {
    for (const p of parsed) {
      if (p.ok === "skip") continue;
      const ms = Math.round(performance.now() - t0);
      let r: OpResult;
      if (!p.ok) r = { line: p.line, ok: false, error: p.error, ms };
      else {
        try {
          applyOp(scene, p.op, opT);
          firstOpMs ??= ms;
          r = { line: p.op.line, ok: true, ms };
        } catch (e) {
          r = { line: p.op.line, ok: false, error: e instanceof Error ? e.message : String(e), ms };
        }
      }
      ops.push(r);
      onOp(r);
    }
  };
  try {
    const { text, stats } = await callModel({ model: modelOf(t["draw.model"]), system: prompt.system, user: prompt.user, images: prompt.images, from: "draw" }, (chunk, soFar) => {
      handle(stream.push(chunk));
      onText?.(soFar);
    }, signal);
    handle(stream.end());
    return { ops, firstOpMs, ms: Math.round(performance.now() - t0), stats, reply: text };
  } catch (e) {
    handle(stream.end());
    return { ops, firstOpMs, ms: Math.round(performance.now() - t0), reply: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/** A deep copy, for undo. */
export function cloneScene(scene: Scene): Scene {
  const copy = Object.create(Object.getPrototypeOf(scene)) as Scene;
  Object.assign(copy, { width: scene.width, height: scene.height });
  copy.shapes = new Map([...scene.shapes].map(([id, s]) => [id, structuredClone(s)]));
  copy.order = [...scene.order];
  copy.groups = new Map([...scene.groups].map(([g, m]) => [g, [...m]]));
  return copy;
}
