// The page each arm serves for the eval (spec §7.1): the arm's own product (render,
// boardStage, src/core/send.ts) on a bare 1280×800 stage, driven over CDP through
// window.rtEval. Its clock (timing.ts) and ink overlay (ink.ts) are the harness's,
// overlaid into every tree, so both arms are measured alike. The runner reloads it
// before every case (the product keeps every call and span in memory), so it holds
// nothing between cases and is ready as soon as its modules are.
import { SCREEN } from "../../src/core/board.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { Scene } from "../../src/core/scene.ts";
import { send } from "../../src/core/send.ts";
import { type ReadableSpan, finished } from "../../src/core/trace.ts";
import { DEFAULTS, type Tuning, tune, tuningId } from "../../src/core/tuning.ts";
import { boardStage } from "../../src/boardStage.ts";
import { applyPictures } from "../fixtures/fixtures.ts";
import { LOOP, sha256 } from "../loop/config.ts";
import type { OpRecord, RtEval, SceneJSON, SpanJSON } from "../loop/types.ts";
import { drawInk } from "./ink.ts";
import { watch } from "./timing.ts";

const st = boardStage(document.querySelector<HTMLElement>("#stage")!, { x: 0, y: 0, ...SCREEN });
let scene = new Scene();
type ShapeJSON = SceneJSON["shapes"][number];
/** The board at the send's start, and screen px per board unit then (LOOP-V2.md A1). */
let start = new Map<string, ShapeJSON>();
let scale = 1;
/** Per shape, this send: when each content first showed (its words, each picture element by key, a visible change to a picture already shown). */
type Seen = { words: Map<string, number>; els: Map<string, number>; change?: number };
let seen = new Map<string, Seen>();
/**
 * Whether a shape as it is now counts as drawn, for time to first drawing (LOOP-V2.md A1): one already on the board only
 * once it visibly changed (moved or resized SHAPE_MIN_PX on screen, recoloured DELTA_E or more, faded MIN_OPACITY, its
 * words or kind changed); a removed shape's going is a drawing too. It also notes, at `at`, the content a shape that
 * ends with a drawing counts by (`firstContent`). Read off the page's scene, not the product's rendering, so no arm can
 * make a placeholder count by drawing it differently, and only visible ink counts: nothing see-through, near-white on
 * the white board, or too small to see.
 */
const drawn = (id: string, at: number): boolean => {
  const s = scene.get(id);
  if (!s) return true;
  const was = start.get(id);
  const rec = seen.get(id) ?? seen.set(id, { words: new Map(), els: new Map() }).get(id)!;
  const words = wordsShow(s) && alnum(s.text?.words) !== alnum(was?.text?.words) ? alnum(s.text?.words) : "";
  if (words && !rec.words.has(words)) rec.words.set(words, at);
  const els = pictureNew(s, was);
  for (const k of els) if (!rec.els.has(k)) rec.els.set(k, at);
  // A picture already on screen, moved, resized or faded: what it shows changed, though none of its elements did.
  const moved = !!was && showing(was) && showing(s) && was.drawing === s.drawing && changedVisibly(s, was);
  if (moved) rec.change ??= at;
  if (contentOnly(id)) return !!words || els.length > 0 || moved;
  return !!words || (was ? (inked(s) || inked(was)) && changedVisibly(s, was) : inked(s));
};
/**
 * When a shape that ends with a drawing first showed content its final state keeps: its final words, an element of its
 * final picture, or a visible change to a picture it already showed (one it ends with); never its box, so no placeholder or outline shown
 * before the picture stands in for it, and no caption or element shown only until the picture came.
 */
const firstContent = (id: string): number | undefined => {
  const s = scene.get(id), rec = seen.get(id);
  if (!s || !rec) return undefined;
  const kept = new Set(showing(s) ? s.picture!.els.map(elKey) : []);
  const was = start.get(id);
  const ts = [rec.words.get(alnum(s.text?.words)), ...[...rec.els].filter(([k]) => kept.has(k)).map(([, t]) => t), was && changedVisibly(s, was) ? rec.change : undefined];
  const xs = ts.filter((t): t is number => t !== undefined);
  return xs.length ? Math.min(...xs) : undefined;
};
/** The shape ends with a drawing (a page's isn't shown): only its picture's elements or its words count, never its box. */
const contentOnly = (id: string) => {
  const s = scene.get(id);
  return !!s?.drawing && s.kind !== "frame";
};
/** DELTA_E: a colour change anyone sees at a glance (CIE76; cream #fff8e7 to pink #ffe3e3 is 12.6, a 1/255 nudge 0.7). */
const SHAPE_MIN_PX = 4, MIN_OPACITY = 0.2, NEAR_WHITE = 240, DELTA_E = 5;
const INK = "#1e1e1e";
const paint = document.createElement("canvas").getContext("2d")!;
/** A colour as [r, g, b], or null where nothing shows: none, see-through, near-white (every channel ≥ NEAR_WHITE), or not a colour. */
const ink = (c: string | undefined): number[] | null => {
  const v = c?.trim();
  if (!v || /^(none|transparent)$/i.test(v)) return null;
  if (/^url\(/i.test(v)) return [0, 0, 0];
  paint.fillStyle = "#000";
  paint.fillStyle = v;
  const a = String(paint.fillStyle);
  paint.fillStyle = "#fff";
  paint.fillStyle = v;
  if (String(paint.fillStyle) !== a) return null;
  const x = a.startsWith("#") ? [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)) : (a.match(/[\d.]+/g) ?? []).map(Number);
  return (x[3] ?? 1) < MIN_OPACITY || x.slice(0, 3).every((n) => n >= NEAR_WHITE) ? null : x.slice(0, 3);
};
/** sRGB to CIE L*a*b* (D65). */
const lab = ([r, g, b]: number[]) => {
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [X, Y, Z] = [f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), f(0.2126 * R + 0.7152 * G + 0.0722 * B), f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)];
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
const recoloured = (a: string | undefined, b: string | undefined) => {
  const x = ink(a), y = ink(b);
  if (!x || !y) return !x !== !y;
  const [p, q] = [lab(x), lab(y)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) >= DELTA_E;
};
const alnum = (w: string | undefined) => (w ?? "").replace(/[^\p{L}\p{N}]/gu, "");
const outlineOf = (s: ShapeJSON) => (s.style.stroke === "transparent" ? undefined : (s.style.stroke ?? INK));
const opaque = (s: ShapeJSON) => (s.style.opacity ?? 1) >= MIN_OPACITY;
const big = (b: ShapeJSON["box"]) => Math.max(Math.abs(b.w), Math.abs(b.h)) * scale >= SHAPE_MIN_PX;
const wordsShow = (s: ShapeJSON) => opaque(s) && !!alnum(s.text?.words) && (!!ink(s.text?.color ?? INK) || !!ink(s.style.fill));
/** A shape's ink: big enough on screen, not faded out, with words, an outline or a fill that shows. */
const inked = (s: ShapeJSON) =>
  opaque(s) && big(s.box) && (wordsShow(s) || (!!ink(outlineOf(s)) && (s.style.strokeWidth ?? 1) > 0) || !!ink(s.style.fill));
const changedVisibly = (s: ShapeJSON, was: ShapeJSON) =>
  s.kind !== was.kind || alnum(s.text?.words) !== alnum(was.text?.words) || Math.abs((s.style.fade ?? 0) - (was.style.fade ?? 0)) >= MIN_OPACITY ||
  Math.max(...(["x", "y", "w", "h"] as const).map((k) => Math.abs(s.box[k] - was.box[k]))) * scale >= SHAPE_MIN_PX ||
  recoloured(outlineOf(s), outlineOf(was)) || recoloured(s.style.fill, was.style.fill) || Math.abs((s.style.strokeWidth ?? 1) - (was.style.strokeWidth ?? 1)) >= 1 ||
  Math.abs((s.style.opacity ?? 1) - (was.style.opacity ?? 1)) >= MIN_OPACITY;
/** It shows its own subject's picture (not a stale one), not faded out: render dims a faded picture to 1 − fade·render.fadeOpacity. */
const showing = (s: ShapeJSON) =>
  !!s.drawing && s.picture?.subject === s.drawing && s.picture.els.length > 0 && (s.style.opacity ?? 1) * (1 - (s.style.fade ?? 0) * (tuning["render.fadeOpacity"] ?? 0.7)) >= MIN_OPACITY;
/** A picture element by its tag and geometry: a palette remapped when the picture ends doesn't make it another element. */
const elKey = (e: { tag: string; attrs: Record<string, string> }) => JSON.stringify([e.tag, Object.entries(e.attrs).filter(([k]) => !/^(fill|stroke|stroke-width|opacity|fill-opacity|stroke-opacity)$/.test(k)).sort()]);
/** The keys of its picture's visible elements it didn't show at the send's start (its own subject's, not washed out by fade). */
const pictureNew = (s: ShapeJSON, was: ShapeJSON | undefined): string[] => {
  if (!showing(s)) return [];
  const p = s.picture!;
  const old = new Set(was?.picture?.subject === p.subject ? was.picture.els.map(elKey) : []);
  return p.els.filter((e) => !old.has(elKey(e)) && elInked(e, p)).map(elKey);
};
/** A picture element's ink: it shows (stroke or fill, not see-through) and spans PIC_MIN of its picture's size. */
const PIC_MIN = 0.04;
const measured = new WeakMap<object, number>();
const measurer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
measurer.setAttribute("style", "position:absolute;left:-10000px;top:0;width:10px;height:10px;visibility:hidden");
document.body.append(measurer);
const elInked = (e: { tag: string; attrs: Record<string, string> }, p: { w: number; h: number }) => {
  const a = e.attrs;
  const num = (k: string) => (a[k] === undefined ? 1 : Number(a[k]));
  if (num("opacity") < MIN_OPACITY) return false;
  // An outline only where it's named, or (renderPicture's default) on an element with no fill.
  const stroke = (a.stroke !== undefined ? !!ink(a.stroke) : !a.fill || a.fill === "none") && num("stroke-width") > 0 && num("stroke-opacity") >= MIN_OPACITY;
  const fill = !!ink(a.fill) && num("fill-opacity") >= MIN_OPACITY;
  if (!stroke && !fill) return false;
  let span = measured.get(e);
  if (span === undefined) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", e.tag) as SVGGraphicsElement;
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
    measurer.append(el);
    try {
      const b = el.getBBox();
      span = Math.max(b.width, b.height);
    } catch {
      span = 0;
    }
    el.remove();
    measured.set(e, span);
  }
  return span >= PIC_MIN * Math.max(p.w, p.h);
};
const clock = watch(st.canvas, drawn);
let tuning: Tuning = DEFAULTS;
// Text wraps by Excalifont's widths: a render before it loads would be redrawn differently later.
let fonts = false;
const fontsLoaded = document.fonts.load("20px Excalifont").then(() => void (fonts = true));

// Redraws coalesce to one per animation frame (F12): a picture fill asks for one per element.
let renders = 0;
let frame = 0;
/** Each render's start and how long the engine took (the owner's rendering time between shapes). */
const renderTimes: [at: number, ms: number][] = [];
const renderNow = () => {
  cancelAnimationFrame(frame);
  frame = 0;
  renders++;
  const t0 = performance.now();
  render(st.canvas, scene, { tuning, view: st.view() });
  renderTimes.push([t0, performance.now() - t0]);
  if (renderTimes.length > 5000) renderTimes.splice(0, 1000);
};
const rank = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.max(0, Math.ceil(p * s.length) - 1)] * 10) / 10 : undefined;
};
const draw = () => void (frame ||= requestAnimationFrame(renderNow));
/**
 * engine()'s timing: ENGINE_WARM untimed runs (a page reloaded per case is cold, and its JIT optimizes at a run of its own:
 * one warm-up and a median of 7 read two identical arms 7.8 and 4.1 ms), then the fastest of ENGINE_REPEATS timed runs,
 * stopping early past ENGINE_BUDGET_MS, each after an untimed setup. Noise (GC, a busy neighbour, the JIT) only adds
 * time, so the fastest is the cost.
 */
const ENGINE_WARM = 5, ENGINE_REPEATS = 15, ENGINE_BUDGET_MS = 1500;
const fastest = <T>(setup: () => T, run: (x: T) => void) => {
  for (let k = 0; k < ENGINE_WARM; k++) run(setup());
  let best = Infinity;
  const end = performance.now() + ENGINE_BUDGET_MS;
  for (let k = 0; k < ENGINE_REPEATS && (k < 3 || performance.now() < end); k++) {
    const x = setup();
    const t0 = performance.now();
    run(x);
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best * 100) / 100;
};

type Pictured = SceneJSON["shapes"][number] & { picture?: { els?: { attrs: Record<string, string> }[] } };
/** The board's last change: its last picture element (a picture streaming in is most of a send's frames), else its top shape. */
const lastChange = (shapes: Pictured[]) => {
  const i = shapes.findLastIndex((s) => (s.picture?.els?.length ?? 0) > 0);
  return i >= 0 ? { i, el: shapes[i].picture!.els!.length - 1 } : { i: shapes.length - 1 };
};
/** The board one change short, as the frame before the last. Plain JSON, so it reads every tree's scene format alike. */
function lessOne(j: SceneJSON): SceneJSON {
  const shapes = structuredClone(j.shapes) as Pictured[];
  const c = lastChange(shapes);
  if (c.el !== undefined) shapes[c.i].picture!.els!.pop();
  else shapes.pop();
  return { ...j, shapes };
}
/**
 * The board with its last change moved k/2 units: each timed frame paints content no run before it painted, as the app's
 * new element is, so a cache of an element's own content (renderPicture's rough cache, or a candidate's) can't hit.
 */
function nudged(j: SceneJSON, k: number): SceneJSON {
  const shapes = structuredClone(j.shapes) as Pictured[];
  const c = lastChange(shapes);
  const d = k / 2;
  if (c.el === undefined) {
    if (shapes[c.i]) shapes[c.i].box.x += d;
    return { ...j, shapes };
  }
  const a = shapes[c.i].picture!.els![c.el].attrs;
  for (const n of ["x", "y", "cx", "cy", "x1", "y1", "x2", "y2"]) if (a[n] !== undefined) a[n] = String(Number(a[n]) + d);
  if (a.width !== undefined && a.x === undefined) a.x = String(d);
  if (a.d) a.d = a.d.replace(/^\s*[Mm]\s*(-?[\d.]+)/, (_, x) => `M${Number(x) + d}`);
  if (a.points) a.points = a.points.replace(/^\s*(-?[\d.]+)/, (_, x) => String(Number(x) + d));
  return { ...j, shapes };
}
/** What a board holds, in any tree's scene format: its shapes' ids, kinds, boxes (to a unit), words and picture elements. */
const boardKey = (j: SceneJSON) =>
  sha256(JSON.stringify(j.shapes.map((s) => [s.id, s.kind, ...["x", "y", "w", "h"].map((k) => Math.round(s.box[k as "x"])), s.text?.words ?? "", (s as Pictured).picture?.els?.length ?? 0])));
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));
const nextFrame = () => new Promise<void>((r) => {
  const t = setTimeout(r, 100);
  requestAnimationFrame(() => (clearTimeout(t), r()));
});

// Frames in the last second, for health(): a background tab without focus emulation runs at 0.
const ticks: number[] = [];
const tick = (t: number) => {
  ticks.push(t);
  while (t - ticks[0] > 1000) ticks.shift();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// Model requests in flight until their reply has fully arrived, read or not (a warm-up's never is).
let inflight = 0;
let idleSince = 0;
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const p = realFetch(input, init);
  if (!String(input instanceof Request ? input.url : input).includes("/api/model")) return p;
  inflight++;
  const done = () => {
    if (!--inflight) idleSince = performance.now();
  };
  p.then((r) => r.clone().arrayBuffer()).then(done, done);
  return p;
};

const longTasks: [at: number, ms: number][] = [];
new PerformanceObserver((l) => void longTasks.push(...l.getEntries().map((e): [number, number] => [e.startTime, e.duration]))).observe({ type: "longtask" });
const heapMb = () => Math.round(((performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20 * 10) / 10;

/** Once the stage has been still and no model request in flight for LOOP.quiesceMs (or the send has run out of time). */
async function quiesce(enterAt: number) {
  for (;;) {
    const t = performance.now();
    if (t - enterAt > LOOP.sendTimeoutMs || (!inflight && !frame && t - Math.max(clock.lastMutation(), idleSince) >= LOOP.quiesceMs)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6 - performance.timeOrigin;
const spanJSON = (s: ReadableSpan): SpanJSON => ({
  name: s.name, traceId: s.spanContext().traceId, spanId: s.spanContext().spanId, parentId: s.parentSpanContext?.spanId, startMs: ms(s.startTime), endMs: ms(s.endTime),
  attributes: Object.fromEntries(Object.entries(s.attributes).filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]))),
  events: s.events.map((e) => ({ name: e.name, atMs: ms(e.time) })),
});

const rtEval: RtEval = {
  health: () => ({ ok: fonts, sha: new URLSearchParams(location.search).get("sha") ?? "", tuningId: tuningId(tuning), fonts, visible: document.visibilityState === "visible", rafPerSec: ticks.length }),
  async load(c) {
    await fontsLoaded;
    tuning = c.tuning ? tune(c.tuning) : DEFAULTS;
    scene = Scene.fromJSON(c.scene);
    if (c.pictures === "fixture") applyPictures(scene);
    drawInk(st.ink, [], c.camera, false);
    await st.setView(c.camera);
    renderNow();
    return { sceneHash: sha256(JSON.stringify(scene.toJSON())) };
  },
  async send(i) {
    if (i.timeline === "realtime") throw new Error("timeline realtime isn't built: switching it on is an owner decision (spec §7.1)");
    if (frame) renderNow();
    start = new Map(scene.toJSON().shapes.map((x) => [x.id, structuredClone(x)]));
    seen = new Map();
    scale = SCREEN.w / st.view().w;
    const before = clock.enter();
    const enterAt = performance.now();
    const r0 = renders;
    let ttloAt: number | undefined;
    const applied: OpRecord[] = [];
    // A send that throws (a candidate's runtime error, a failed resolver call) is the arm's own failure, shown
    // as its result: the runner must never lose the case, or its process, to it.
    let sent: Awaited<ReturnType<typeof send>> | undefined, thrown: string | undefined;
    try {
      sent = await send(scene, { words: i.words, strokes: i.strokes }, tuning, {
        draw,
        setView: st.setView,
        // TTLO: the frame after the last applied op, the product's own hook (informational, never gated).
        onOp: (r) => (applied.push(r), r.ok && !r.camera && requestAnimationFrame(() => (ttloAt = performance.now()))),
      }, st.view());
    } catch (err) {
      thrown = `the send threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    const sentAt = performance.now();
    await quiesce(enterAt);
    const t = clock.measure(before, enterAt, (id, first) => (contentOnly(id) ? firstContent(id) : first));
    const frames = renderTimes.filter(([at]) => at >= enterAt).map(([, d]) => d);
    return {
      ops: (sent?.result.ops ?? applied).map(({ line, ok, error, ms }) => ({ line, ok, error, ms })),
      reply: sent?.result.reply ?? "",
      error: sent?.result.error ?? thrown,
      pics: sent?.pics,
      camera: st.view(),
      after: structuredClone(scene.toJSON()),
      // A send that changes nothing has its end as TTD, and one that draws nothing (a picture that never came) its end as
      // TTFD, so doing nothing never reads as fast.
      timing: { enterAt, ttfcMs: t.ttfcMs, ttdMs: t.ttdMs ?? Math.round(sentAt - enterAt), ttfdMs: t.ttfdMs ?? Math.round(sentAt - enterAt),
        renderP50Ms: rank(frames, 0.5), renderP90Ms: rank(frames, 0.9), renderMaxMs: rank(frames, 1), ttloMs: ttloAt && Math.round(ttloAt - enterAt), renders: renders - r0, longTasksMs: Math.round(longTasks.filter(([at]) => at >= enterAt).reduce((a, [, d]) => a + d, 0)), heapMb: heapMb() },
      spans: finished().filter((s) => ms(s.startTime) >= enterAt - 1).map(spanJSON),
    };
  },
  /**
   * The engine's cost (the owner's rendering time between shapes, LOOP-V2.md A2), measured with the page idle once both
   * arms' sends are done, on both arms' boards, in one view: each board's op lines applied again to a copy of the before
   * board (and read back), and the frame that brings the board's last change (the board one change short painted, then
   * the board with that change nudged, from a fresh copy, laid out), each timed warm (fastest). Both arms' engines on
   * the same content, so drawing more never reads as a slower engine; how many lines applied and what each board held
   * as loaded say whether it was the same content (ab.ts). `deferred`: the stage still changed after render() returned
   * (two frames, 50 ms and an idle callback later), so the timing missed work. A failure on its own board throws; on the other's it's
   * noted. Per-frame times during the send are reported too, but they carry cold-JIT first paints, GC and the other
   * arm's frames: two identical arms read ×0.94 at the median.
   */
  async engine({ before, view, own, other }) {
    cancelAnimationFrame(frame);
    frame = 0;
    const opts = { tuning, view };
    let k = 0;
    const time = (lines: string[], board: SceneJSON) => {
      const script = lines.join("\n");
      let applied = 0;
      const applyMs = fastest(() => Scene.fromJSON(structuredClone(before)), (copy) => {
        applied = lines.length - runScript(script, copy, tuning).errors.length;
        copy.toJSON();
      });
      const prev = lessOne(board);
      const paintMs = fastest(() => (render(st.canvas, Scene.fromJSON(prev), opts), Scene.fromJSON(nudged(board, ++k))), (next) => {
        render(st.canvas, next, opts);
        st.canvas.getBoundingClientRect();
      });
      return { applyMs, paintMs, ops: lines.length, applied, board: boardKey(Scene.fromJSON(board).toJSON()) };
    };
    const mine = time(own.ops, own.after);
    render(st.canvas, Scene.fromJSON(nudged(own.after, ++k)), opts);
    const painted = st.canvas.innerHTML;
    await nextTask();
    await nextFrame();
    await nextFrame();
    await new Promise<void>((r) => setTimeout(r, 50));
    await new Promise<void>((r) => requestIdleCallback(() => r(), { timeout: 200 }));
    const deferred = st.canvas.innerHTML !== painted;
    let theirs: ReturnType<typeof time> | undefined, skew: string | undefined;
    try {
      theirs = other && time(other.ops, other.after);
    } catch (err) {
      skew = `the engine failed on the other arm's board: ${err instanceof Error ? err.message : String(err)}`;
    }
    render(st.canvas, scene, { tuning, view: st.view() });
    return { ...mine, ...(deferred ? { deferred } : {}), ...(theirs ? { other: theirs } : {}), ...(skew ? { skew } : {}) };
  },
  setView: (v) => st.setView(v),
  showInk: (strokes, o) => drawInk(st.ink, strokes, st.view(), o.numbers),
  hideInk: () => drawInk(st.ink, [], st.view(), false),
  scene: () => structuredClone(scene.toJSON()),
  restore(j) {
    scene = Scene.fromJSON(j);
    renderNow();
  },
};
Object.assign(window, { rtEval });
