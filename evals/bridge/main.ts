// The page each arm serves for the eval (spec §7.1): the arm's own product (render,
// boardStage, src/core/send.ts) on a bare 1280×800 stage, driven over CDP through
// window.rtEval. Its clock (timing.ts) and ink overlay (ink.ts) are the harness's,
// overlaid into every tree, so both arms are measured alike. The runner reloads it
// before every case (the product keeps every call and span in memory), so it holds
// nothing between cases and is ready as soon as its modules are.
import { SCREEN } from "../../src/core/board.ts";
import { render } from "../../src/core/render.ts";
import { Scene } from "../../src/core/scene.ts";
import { send } from "../../src/core/send.ts";
import { type ReadableSpan, finished } from "../../src/core/trace.ts";
import { DEFAULTS, type Tuning, tune, tuningId } from "../../src/core/tuning.ts";
import { boardStage } from "../../src/boardStage.ts";
import { applyPictures } from "../fixtures/fixtures.ts";
import { LOOP, sha256 } from "../loop/config.ts";
import type { RtEval, SpanJSON } from "../loop/types.ts";
import { drawInk } from "./ink.ts";
import { watch } from "./timing.ts";

const st = boardStage(document.querySelector<HTMLElement>("#stage")!, { x: 0, y: 0, ...SCREEN });
const clock = watch(st.canvas);
let scene = new Scene();
let tuning: Tuning = DEFAULTS;
// Text wraps by Excalifont's widths: a render before it loads would be redrawn differently later.
let fonts = false;
const fontsLoaded = document.fonts.load("20px Excalifont").then(() => void (fonts = true));

// Redraws coalesce to one per animation frame (F12): a picture fill asks for one per element.
let renders = 0;
let frame = 0;
const renderNow = () => {
  cancelAnimationFrame(frame);
  frame = 0;
  renders++;
  render(st.canvas, scene, { tuning, view: st.view() });
};
const draw = () => void (frame ||= requestAnimationFrame(renderNow));

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
    const before = clock.enter();
    const enterAt = performance.now();
    const r0 = renders;
    let ttloAt: number | undefined;
    const { result, pics } = await send(scene, { words: i.words, strokes: i.strokes }, tuning, {
      draw,
      setView: st.setView,
      // TTLO: the frame after the last applied op, the product's own hook (informational, never gated).
      onOp: (r) => r.ok && !r.camera && requestAnimationFrame(() => (ttloAt = performance.now())),
    }, st.view());
    const sentAt = performance.now();
    await quiesce(enterAt);
    const t = clock.measure(before, enterAt);
    return {
      ops: result.ops.map(({ line, ok, error, ms }) => ({ line, ok, error, ms })),
      reply: result.reply,
      error: result.error,
      pics,
      camera: st.view(),
      after: structuredClone(scene.toJSON()),
      // A send that changes nothing has its end as TTD, so doing nothing never reads as fast.
      timing: { enterAt, ttfcMs: t.ttfcMs, ttdMs: t.ttdMs ?? Math.round(sentAt - enterAt), ttloMs: ttloAt && Math.round(ttloAt - enterAt), renders: renders - r0, longTasksMs: Math.round(longTasks.filter(([at]) => at >= enterAt).reduce((a, [, d]) => a + d, 0)), heapMb: heapMb() },
      spans: finished().filter((s) => ms(s.startTime) >= enterAt - 1).map(spanJSON),
    };
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
