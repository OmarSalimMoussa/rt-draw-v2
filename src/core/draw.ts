// The drawing model: one send (your words with [ink n] markers, the screenshot
// with your numbered ink, the id map) → op lines, streamed back and applied the
// moment each line completes. On a board (a camera given), the screenshot is the
// pictures picked for the send (what you see, what you referred to, the whole
// board) and the id map is the site map; camera(...) lines move the screen.
// buildPrompt hides nothing, so a playground can show exactly what was sent;
// run records when each op landed.
import { type BoardShot, SCREEN, type View, pagesOf, sendShots, siteMap } from "./board.ts";
import { parseCamera } from "./camera.ts";
import type { Stroke } from "./ink.ts";
import { type Word, linkInk } from "./link.ts";
import { HitIndex } from "./hittest.ts";
import { type Mark, type Reading, groupStrokes, readMark } from "./marks.ts";
import { type Resolution, resolve } from "./resolve.ts";
import { type ModelStats, callModel, modelOf } from "./model.ts";
import { OpStream, type Parsed, applyOp } from "./ops.ts";
import type { Scene, Shape } from "./scene.ts";
import { type Shot, takeShot } from "./shot.ts";
import { type TraceContext, mark, span, spanSync, timed } from "./trace.ts";
import { promptOf, thinkingOf } from "./prompts.ts";
import { DEFAULTS, type Tuning, tune } from "./tuning.ts";

export type Prompt = {
  system: string;
  user: string;
  images: string[];
  /** The screenshot as sent, when it was (on a board, the first picture: what you see). */
  shot?: Shot;
  /** On a board: every picture sent, in order, and where the camera was. */
  shots?: BoardShot[];
  camera?: View;
  /** The transcript with its [ink n] markers. */
  transcript: string;
  /** The resolver's answers, when they were sent. */
  refs?: Resolution;
  features: { marksSent: number; refs: string; resolveMs: number; chars: number; imageTokens: number; shapes: number; marks: number; idMap: number; ops: number; screenshot: number; grid: number; board: number; pictures: number; views: string; earlyShots: number; unusedShots: number; shotsMs: number; mapChars: number };
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

/** One line per mark: what its geometry says it is and what it touches. */
export function describeMark(n: number, r: Reading): string {
  const at = (p?: [number, number]) => (p ? ` (${Math.round(p[0])} ${Math.round(p[1])})` : "");
  if (r.how === "arrow") {
    const to = typeof r.to === "string" ? r.to : r.to ? `empty space${at([r.to.x, r.to.y])}` : "?";
    return `[ink ${n}] arrow from ${r.from ?? "empty space"}${at(r.arrow.tail)} to ${to}, tip at${at(r.arrow.tip)}`;
  }
  if (r.kind === "sketch") return `[ink ${n}] a sketch: draw something shaped like this here${r.inside ? `, inside ${r.inside}` : ""}`;
  const what = { loop: "loop around", tap: "tap on", line: "line under", scribble: "scribble over" }[r.how as "loop"] ?? r.how;
  return `[ink ${n}] ${what} ${r.targets.join(", ") || "nothing"}`;
}

/** Typed words get times so the resolver can match them to marks: the n-th pointing word lands on mark n. */
export function typedWords(text: string, marks: Mark[]): Word[] {
  const pointing = /^(this|that|here|there|these|those|it)\b/i;
  let n = 0;
  let at = marks[0]?.t0 ?? 0;
  return text.trim().split(/\s+/).filter(Boolean).map((word) => {
    if (n < marks.length && pointing.test(word)) at = marks[n++].t0;
    const w = { word, t0: at, t1: at + 1 };
    at += 1;
    return w;
  });
}

const r0 = (n: number) => Math.round(n);
const fmtBox = (v: View) => `${r0(v.x)} ${r0(v.y)} ${r0(v.w)} ${r0(v.h)}`;

/** A map's first `max` shape lines (0: all of them), the rest only counted, so a big board can't crowd the prompt. */
function capShapes(lines: string[], max: number, isShape: (line: string) => boolean = () => true): string[] {
  if (!max) return lines;
  let n = 0;
  const kept = lines.filter((l) => !isShape(l) || ++n <= max);
  return n > max ? [...kept, `(${n - max} more shapes not listed)`] : kept;
}

/**
 * What the model gets for this send. Words are spoken (with times) or typed (a
 * string). With a camera, the scene is a board seen through it.
 */
export async function buildPrompt(scene: Scene, strokes: Stroke[], words: Word[] | string, t: Tuning = DEFAULTS, parent?: TraceContext, camera?: View): Promise<Prompt> {
  return span("build the prompt", parent, async (ctx) => {
    const marks = spanSync("group strokes into marks", ctx, () => groupStrokes(strokes, t), { strokes: strokes.length });
    const transcript = spanSync("link words to ink", ctx, () => (typeof words === "string" ? typedTranscript(words, marks.length) : linkInk(words, marks, t).text));
    // A board has no grid: cells name places on one fixed canvas.
    const cell = camera ? 0 : t["draw.gridCellPx"];
    const system = promptOf("draw", t).system(!!camera, scene.width, scene.height, cell, SCREEN.w);

    // What the ink is, read from its geometry: free, and the screenshot only shows it as pixels.
    const { hits, readings } = spanSync("read marks (hit-test, arrows)", ctx, () => {
      const hits = new HitIndex(scene);
      return { hits, readings: marks.map((m) => readMark(m, hits, t)) };
    }, { marks: marks.length });

    const said = typeof words === "string" ? (words.trim() ? typedWords(words, marks) : []) : words;
    const r0t = performance.now();
    // Which shapes the words and ink mean: one more model call unless the ink settles it.
    const refsCall = t["draw.sendRefs"] && (marks.length || said.length) ? span("resolve references", ctx, (rctx) => resolve(said, strokes, marks, scene, hits, t, "draw-refs", rctx)) : undefined;
    let resolveMs = 0;
    const resolved = refsCall?.then((r) => ((resolveMs = Math.round(performance.now() - r0t)), r));
    // The pictures and the resolver: side by side; on a board, the pictures the resolver's answers add wait for it.
    const [shot, board, refs] = await Promise.all([
      t["draw.sendScreenshot"] && !camera
        ? span("screenshot", ctx, async (sctx) => {
            const sh = await takeShot(scene, strokes, tune({ "shot.gridCellPx": cell }, t));
            // Its own phases, measured inside takeShot, laid end to end from the span's start.
            let at = performance.now() - sh.ms.total;
            for (const phase of ["serialize", "rasterize", "encode"] as const) timed(sctx, `screenshot: ${phase}`, at, (at += sh.ms[phase]));
            return sh;
          })
        : undefined,
      t["draw.sendScreenshot"] && camera ? sendShots(scene, camera, strokes, said.map((w) => w.word).join(" "), t, resolved?.then((r) => r.refs), ctx) : undefined,
      resolved,
    ]);
    const shots = board?.shots;

    const parts: string[] = [];
    let mapChars = 0;
    let idMap: string[] = [];
    if (camera) {
      parts.push(`Board: ${pagesOf(scene).length} pages, ${scene.shapes.size} shapes. The screen shows ${fmtBox(camera)} of it (x y w h, board pixels).`);
      if (shots?.length) parts.push(`Pictures (boxes are always in board pixels):\n${shots.map((s, i) => `${i + 1}. ${s.name}: board ${fmtBox(s.view)} at ${s.shot.width}×${s.shot.height} (${s.why})`).join("\n")}`);
      if (t["draw.sendIdMap"]) {
        const tree = siteMap(scene, t, { depth: t["draw.mapDepth"], words: t["draw.mapWords"], boxes: !!t["draw.mapBoxes"] });
        const map = capShapes(tree.split("\n"), t["draw.mapMaxShapes"], (l) => /^\s*- /.test(l)).join("\n");
        mapChars = map.length;
        parts.push(`Site map (each page's content as a tree, id${t["draw.mapBoxes"] ? " (box)" : ""}: description):\n${map}`);
      }
    } else {
      parts.push(`Canvas: ${scene.width}×${scene.height} px, ${scene.shapes.size} shapes.`);
      idMap = t["draw.sendIdMap"] ? scene.stacked().map((s) => `${s.id}: ${s.description}`) : [];
      if (idMap.length) parts.push(`Shapes, back to front (id: description):\n${capShapes(idMap, t["draw.mapMaxShapes"]).join("\n")}`);
    }
    const ops = t["draw.sendOps"] ? sceneToOps(scene) : "";
    if (ops) parts.push(`The scene as ops:\n${ops}`);
    if (shot) parts.push(`The screenshot is the canvas at ${Math.round(shot.width)}×${Math.round(shot.height)} (scaled ${t["shot.scale"]}); boxes are always in canvas pixels.`);
    if (t["draw.sendMarks"] && marks.length) parts.push(`Marks (what each [ink n] is, read from its geometry):\n${readings.map((r, i) => describeMark(i + 1, r)).join("\n")}`);
    const refLines = refs?.refs.map((x) => `"${x.phrase}" → ${x.ids.join(", ") || "nothing on the canvas"}`) ?? [];
    if (refs && refLines.length) parts.push(`References (resolved before this call, ${refs.via === "ink" ? "from the ink" : "by a model"}):\n${refLines.join("\n")}`);
    parts.push(`Request: ${transcript || "(no words)"}`);
    const user = parts.join("\n\n");
    const pictures = shots ? shots.map((s) => s.shot) : shot ? [shot] : [];
    const imageTokens = pictures.reduce((a, p) => a + Math.round((p.width * p.height) / 750), 0);
    return {
      system,
      user,
      images: pictures.map((p) => p.dataUrl),
      shot: pictures[0],
      shots,
      camera,
      transcript,
      refs,
      features: {
        marksSent: t["draw.sendMarks"] && marks.length ? marks.length : 0, refs: refs ? refs.via : "off", resolveMs, chars: system.length + user.length, imageTokens, shapes: scene.shapes.size, marks: marks.length, idMap: idMap.length, ops: ops ? ops.split("\n").length : 0, screenshot: pictures.length ? 1 : 0, grid: cell,
        board: camera ? 1 : 0, pictures: pictures.length, views: shots?.map((s) => s.name).join(" | ") ?? "", earlyShots: board?.early ?? 0, unusedShots: board?.unused ?? 0, shotsMs: board?.ms ?? 0, mapChars,
      },
    };
  });
}

/** One op line as it landed; a camera(...) line carries the view to move the screen to (the caller moves it). */
export type OpResult = { line: string; ok: boolean; error?: string; ms: number; camera?: View };
export type SendResult = { ops: OpResult[]; firstOpMs?: number; ms: number; stats?: ModelStats; reply: string; error?: string };

/**
 * Sends the prompt and applies each op line to `scene` as it completes. onOp
 * fires after each line (so the caller re-renders); times are ms since the send.
 */
export async function run(scene: Scene, prompt: Prompt, t: Tuning, onOp: (r: OpResult) => void, onText?: (soFar: string) => void, signal?: AbortSignal, parent?: TraceContext): Promise<SendResult> {
  return span("drawing model and ops", parent, (ctx) => runIn(ctx, scene, prompt, t, onOp, onText, signal));
}

async function runIn(ctx: TraceContext, scene: Scene, prompt: Prompt, t: Tuning, onOp: (r: OpResult) => void, onText?: (soFar: string) => void, signal?: AbortSignal): Promise<SendResult> {
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
          // camera(...) moves the screen, not the scene: on a board, the caller glides there.
          const camera = p.op.name === "camera" && prompt.camera ? parseCamera(p.op.line, scene, t).view : undefined;
          if (!camera) applyOp(scene, p.op, opT);
          // A camera move changes the screen, not the scene, so it's never the first op (F1).
          if (!camera) firstOpMs ??= ms;
          r = { line: p.op.line, ok: true, ms, camera };
        } catch (e) {
          r = { line: p.op.line, ok: false, error: e instanceof Error ? e.message : String(e), ms };
        }
      }
      ops.push(r);
      if (r.ok && !r.camera && ops.filter((o) => o.ok && !o.camera).length === 1) mark(ctx, "first op applied");
      // The page's redraw after each op is part of the op's time on screen.
      spanSync(`op ${ops.length}: ${r.line.slice(0, 48)}`, ctx, () => onOp(r), { ok: r.ok, line: r.line });
    }
  };
  try {
    const { text, stats } = await callModel({ model: modelOf(t["draw.model"]), system: prompt.system, user: prompt.user, images: prompt.images, from: "draw", ...thinkingOf("draw", t) }, (chunk, soFar) => {
      handle(stream.push(chunk));
      onText?.(soFar);
    }, signal, ctx);
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
