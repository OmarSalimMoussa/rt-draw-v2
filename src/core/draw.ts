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
import { type Ref, type Resolution, guessRefs, resolve } from "./resolve.ts";
import { type ModelStats, callModel, jevOf, modelOf } from "./model.ts";
import { decide } from "./decide.ts";
import { OpStream, type Parsed, Waiting, applyOp, earlyShape } from "./ops.ts";
import type { Scene, Shape } from "./scene.ts";
import { type Shot, takeShot } from "./shot.ts";
import { type TraceContext, mark, span, spanSync, timed } from "./trace.ts";
import { DRAW_ADD, promptOf, thinkingOf } from "./prompts.ts";
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
  /** The strokes of the marks read as sketches (not pointing), on the board as it was: what a picture may follow (picture.context). */
  sketches?: Stroke[];
  /** "off" when Jev decided this send needs no thinking (draw.thinkRouter); unset: draw.noThink decides. */
  thinking?: "off";
  features: { /** resolve.speculate: "hit" (the guess's drawing landed), "miss" (dropped, drawn again), "no guess" */ spec?: string; thinkP?: number; marksSent: number; refs: string; resolveMs: number; chars: number; imageTokens: number; shapes: number; marks: number; idMap: number; ops: number; screenshot: number; grid: number; board: number; pictures: number; views: string; earlyShots: number; unusedShots: number; shotsMs: number; mapChars: number };
};

/** The scene as op lines: its exact boxes and styles, for when the model should see numbers. */
export function sceneToOps(scene: Scene): string {
  // On one line, read back as written: a backslash and a line break escaped as the parser reads them.
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "'")}"`;
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
export async function buildPrompt(scene: Scene, strokes: Stroke[], words: Word[] | string, t: Tuning = DEFAULTS, parent?: TraceContext, camera?: View, onGuess?: (guess: Promise<Prompt | undefined>) => void): Promise<Prompt> {
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
    // Whether the drawing model may think on this send: Jev's one question, alongside the resolver (a failed call leaves it to draw.noThink).
    const thinkCall = t["draw.thinkRouter"] ? span("decide thinking", ctx, (dctx) => needsThought(scene, transcript, readings, t, dctx)).catch(() => undefined) : undefined;
    // Whether the send asks for something new: Jev's one question beside the resolver (a failed or late call leaves the text unchanged).
    const addCall = t["draw.addHint"]
      ? span("decide add", ctx, (dctx) => Promise.race([asksForNew(scene, transcript, readings, t, dctx), new Promise<undefined>((res) => setTimeout(res, t["draw.addWaitMs"]))])).catch(() => undefined)
      : undefined;
    const shotCall = t["draw.sendScreenshot"] && !camera
      ? span("screenshot", ctx, async (sctx) => {
          const sh = await takeShot(scene, strokes, tune({ "shot.gridCellPx": cell }, t));
          // Its own phases, measured inside takeShot, laid end to end from the span's start.
          let at = performance.now() - sh.ms.total;
          for (const phase of ["serialize", "rasterize", "encode"] as const) timed(sctx, `screenshot: ${phase}`, at, (at += sh.ms[phase]));
          return sh;
        })
      : undefined;
    // On a board, the pictures the references add wait for them: the resolver's answer, or a guess's.
    const boardFor = (refs?: Promise<Ref[] | undefined>) => (t["draw.sendScreenshot"] && camera ? sendShots(scene, camera, strokes, said.map((w) => w.word).join(" "), t, refs, ctx) : undefined);
    // resolve.speculate: the same prompt on Jev's guess at the references, for a drawing call that starts before the resolver answers.
    const guessCall = t["resolve.speculate"] && refsCall ? span("guess references", ctx, (gctx) => guessRefs(said, marks, scene, hits, t, "draw-refs-guess", gctx)).catch(() => undefined) : undefined;
    onGuess?.(guessCall ? guessCall.then(async (g) => g && finish(...(await Promise.all([shotCall, boardFor(Promise.resolve(g.refs)), g, thinkCall, addCall])))) : Promise.resolve(undefined));
    // The pictures and the resolver: side by side.
    return finish(...(await Promise.all([shotCall, boardFor(resolved?.then((r) => r.refs)), resolved, thinkCall, addCall])));

    function finish(shot: Shot | undefined, board: Awaited<ReturnType<typeof sendShots>> | undefined, refs: Resolution | undefined, thinkP: number | undefined, addP: number | undefined): Prompt {
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
      if (t["resolve.speculate"]) {
        // Ids alone, sorted: a guess (no phrases) and the resolver's answer then give the same line when they name the same shapes.
        const ids = [...new Set(refs?.refs.flatMap((x) => x.ids) ?? [])].sort();
        if (ids.length) parts.push(`References (resolved before this call): ${ids.join(", ")}`);
      } else {
        const refLines = refs?.refs.map((x) => `"${x.phrase}" → ${x.ids.join(", ") || "nothing on the canvas"}`) ?? [];
        if (refs && refLines.length) parts.push(`References (resolved before this call, ${refs.via === "ink" ? "from the ink" : "by a model"}):\n${refLines.join("\n")}`);
      }
      if (refs?.hints?.length) parts.push(`Maybe also meant (the resolver was unsure; how likely each is):\n${refs.hints.map((h) => `${h.id} (${Math.round(h.p * 100)}%)`).join("\n")}`);
      parts.push(`Request: ${transcript || "(no words)"}`);
      if (addP !== undefined && addP >= t["draw.addYes"]) parts.push(DRAW_ADD.line);
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
        sketches: marks.filter((_, i) => readings[i].kind === "sketch").flatMap((m) => m.strokes),
        thinking: thinkP !== undefined && thinkP < t["draw.thinkYes"] ? "off" : undefined,
        features: {
          thinkP,
          marksSent: t["draw.sendMarks"] && marks.length ? marks.length : 0, refs: refs ? refs.via : "off", resolveMs, chars: system.length + user.length, imageTokens, shapes: scene.shapes.size, marks: marks.length, idMap: idMap.length, ops: ops ? ops.split("\n").length : 0, screenshot: pictures.length ? 1 : 0, grid: cell,
          board: camera ? 1 : 0, pictures: pictures.length, views: shots?.map((s) => s.name).join(" | ") ?? "", earlyShots: board?.early ?? 0, unusedShots: board?.unused ?? 0, shotsMs: board?.ms ?? 0, mapChars,
        },
      };
    }
  });
}

/** Jev's probability that this send asks for something new to be added or built (draw.addHint); undefined when it gave none. */
async function asksForNew(scene: Scene, transcript: string, readings: Reading[], t: Tuning, parent?: TraceContext): Promise<number | undefined> {
  const state = { canvas: scene.shapes.size ? `${scene.shapes.size} shapes` : "empty", said: transcript || "(no words)", ink: readings.map((r) => (r.kind === "sketch" ? "a sketch" : `a ${r.how}`)) };
  const d = await decide(jevOf(t["draw.thinkJevModel"]), state, { add: { type: "noul", instructions: DRAW_ADD.question, criteria: { yes: DRAW_ADD.yes, no: DRAW_ADD.no } } }, "draw-add", parent);
  return d.yes.add;
}

/** Jev's probability that this send needs the drawing model to think first (draw.thinkRouter); undefined when it gave none. */
async function needsThought(scene: Scene, transcript: string, readings: Reading[], t: Tuning, parent?: TraceContext): Promise<number | undefined> {
  const v = promptOf("drawThink", t);
  const state = { canvas: scene.shapes.size ? `${scene.shapes.size} shapes` : "empty", said: transcript || "(no words)", ink: readings.map((r) => (r.kind === "sketch" ? "a sketch" : `a ${r.how}`)) };
  const d = await decide(jevOf(t["draw.thinkJevModel"]), state, { think: { type: "noul", instructions: v.question, criteria: { yes: v.yes, no: v.no } } }, "draw-think", parent);
  return d.yes.think;
}

/** One op line as it landed; a camera(...) line carries the view to move the screen to (the caller moves it). */
export type OpResult = { line: string; ok: boolean; error?: string; ms: number; camera?: View };
export type SendResult = { ops: OpResult[]; firstOpMs?: number; ms: number; stats?: ModelStats; reply: string; error?: string };

/**
 * Sends the prompt and applies each op line to `scene` as it completes. onOp
 * fires after each line (so the caller re-renders); times are ms since the send.
 * With a `gate` (resolve.speculate), op lines are held until it opens: true applies
 * them and the rest as they come; false drops them all, and the caller aborts the call.
 */
export async function run(scene: Scene, prompt: Prompt, t: Tuning, onOp: (r: OpResult) => void, onText?: (soFar: string) => void, signal?: AbortSignal, parent?: TraceContext, gate?: Promise<boolean>): Promise<SendResult> {
  return span("drawing model and ops", parent, (ctx) => runIn(ctx, scene, prompt, t, onOp, onText, signal, gate));
}

async function runIn(ctx: TraceContext, scene: Scene, prompt: Prompt, t: Tuning, onOp: (r: OpResult) => void, onText?: (soFar: string) => void, signal?: AbortSignal, gate?: Promise<boolean>): Promise<SendResult> {
  const t0 = performance.now();
  const stream = new OpStream();
  const ops: OpResult[] = [];
  let firstOpMs: number | undefined;
  // Cells in the reply mean the grid the model saw.
  const opT = t["draw.gridCellPx"] > 0 ? tune({ "ops.cellPx": t["draw.gridCellPx"] }, t) : t;
  // Held op lines while the gate is shut; dropped for good once it shuts them out.
  let held: Parsed[] | undefined = gate ? [] : undefined;
  let dropped = false;
  gate?.then((open) => {
    const h = held ?? [];
    held = undefined;
    if (open) handle(h);
    else dropped = true;
  });
  const shut = async () => !!gate && !(await gate);
  // Op lines naming a shape a later line makes wait for it (ops.waitForShape).
  const waiting = new Waiting(!!t["ops.waitForShape"]);
  let marked = false;
  const emit = (r: OpResult) => {
    ops.push(r);
    // A camera move changes the screen, not the scene, so it's never the first op (F1).
    if (r.ok && !r.camera) firstOpMs ??= r.ms;
    if (r.ok && !r.camera && !marked) {
      marked = true;
      mark(ctx, "first op applied");
    }
    // The page's redraw after each op is part of the op's time on screen.
    spanSync(`op ${ops.length}: ${r.line.slice(0, 48)}`, ctx, () => onOp(r), { ok: r.ok, line: r.line });
  };
  // ops.earlyShape: the id of the shape painted from a shape() line still being written. The line's own end (its
  // result, or a failure, or the reply cut off) takes it away first, so a line that fails leaves nothing behind.
  let early: string | undefined;
  const unearly = () => {
    if (early) scene.remove(early);
    early = undefined;
  };
  const showEarly = () => {
    if (!t["ops.earlyShape"] || early || dropped || held) return;
    const op = earlyShape(scene, stream.pending());
    if (!op) return;
    try {
      applyOp(scene, op, opT);
    } catch {
      return;
    }
    early = op.args.find((a) => !a.key)!.value;
    const ms = Math.round(performance.now() - t0);
    firstOpMs ??= ms;
    if (!marked) {
      marked = true;
      mark(ctx, "first op applied");
    }
    spanSync(`early shape: ${early}`, ctx, () => onOp({ line: op.line, ok: true, ms }), { ok: true, line: op.line });
  };
  const handle = (parsed: Parsed[]) => {
    if (dropped) return;
    if (held) return void held.push(...parsed);
    if (parsed.length) unearly();
    for (const p of parsed) {
      if (p.ok === "skip") continue;
      const ms = Math.round(performance.now() - t0);
      if (!p.ok) {
        emit({ line: p.line, ok: false, error: p.error, ms });
        continue;
      }
      try {
        // camera(...) moves the screen, not the scene: on a board, the caller glides there.
        const camera = p.op.name === "camera" && prompt.camera ? parseCamera(p.op.line, scene, t).view : undefined;
        if (camera) {
          emit({ line: p.op.line, ok: true, ms, camera });
          continue;
        }
      } catch (e) {
        emit({ line: p.op.line, ok: false, error: e instanceof Error ? e.message : String(e), ms });
        continue;
      }
      for (const a of waiting.apply(scene, p.op, opT)) emit({ line: a.op.line, ok: !a.error, error: a.error, ms });
    }
  };
  /** The reply's last line, then what still waits for a shape that never came. */
  const finish = () => {
    handle(stream.end());
    unearly();
    if (dropped) return;
    const ms = Math.round(performance.now() - t0);
    for (const a of waiting.end()) emit({ line: a.op.line, ok: false, error: a.error, ms });
  };
  try {
    const thinking = prompt.thinking ? { thinking: prompt.thinking } : thinkingOf("draw", t);
    // A guess that misses drops its process; a second one waiting keeps the redraw warm. Each copy takes its own.
    const copies = t["draw.copies"];
    const { text, stats } = await callModel({ model: modelOf(t["draw.model"]), system: prompt.system, user: prompt.user, images: prompt.images, from: "draw", ...thinking, warm: t["resolve.speculate"] || copies > 1 ? (t["resolve.speculate"] ? 2 : 1) * copies : undefined, copies, copyAfterMs: t["draw.copyAfterMs"] }, (chunk, soFar) => {
      handle(stream.push(chunk));
      showEarly();
      onText?.(soFar);
    }, signal, ctx);
    if (await shut()) return { ops, firstOpMs, ms: Math.round(performance.now() - t0), stats, reply: text, error: "dropped: the resolver's answer gave another prompt" };
    finish();
    return { ops, firstOpMs, ms: Math.round(performance.now() - t0), stats, reply: text };
  } catch (e) {
    if (await shut()) return { ops, firstOpMs, ms: Math.round(performance.now() - t0), reply: "", error: "dropped: the resolver's answer gave another prompt" };
    finish();
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
