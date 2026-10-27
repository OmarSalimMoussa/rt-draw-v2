// T6's acceptance check: the bridge page (window.rtEval) and the harness clock.
// Model replies stream from a local endpoint over time (resolver, drawing ops line by
// line, doodles element by element), so TTFC, TTD, time to first drawing (TTFD) and
// render time are measured on real frames.
// 0 model calls: one Chrome, every /api/* stubbed and counted (seen == stubbed), a
// Vite with no plugins but the stream endpoint, so nothing could reach a model.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t6-bridge.mjs
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "vite";
import { openChrome } from "./cdp.mjs";
import { ROOT, assertLocalOnly, check, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const f = await import("../fixtures/fixtures.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Streamed replies: /api/model is handed on (cdp.mjs redirect) to /__stream/<n>, which writes [delay ms, text] steps.
const plans = new Map();
const streamer = {
  name: "t6-stream",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const steps = plans.get(/^\/__stream\/(\d+)$/.exec(req.url ?? "")?.[1]);
      if (!steps) return next();
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const [delay, text] of steps) {
        await sleep(delay);
        res.write(`${JSON.stringify({ text })}\n`);
      }
      res.end(`${JSON.stringify({ done: true, model: "sonnet", ms: 1 })}\n`);
    });
  },
};
const vite = await createServer({
  root: ROOT, configFile: false, envDir: mkdtempSync(join(home, "env-")), cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null }, plugins: [streamer],
});
await vite.listen();
const BRIDGE = `http://127.0.0.1:${vite.httpServer.address().port}/evals/bridge/?sha=c0ffee`;

const RESOLVER_MS = 300;
const DRAW_MS = 100;
const GAP = 200;
const PIC_GAP = 60;
const RECOLOUR = "shape(home-nav, fill:#ffe3e3)\n";
const TMP = 'shape(tmp-box, rect, 300 300 200 100, "a temporary grey box that is about to be removed", fill:#dee2e6)\n';
const DOODLE = ['<circle cx="50" cy="50" r="30" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>\n', '<rect x="20" y="20" width="20" height="20" fill="#e03131"/>\n', '<line x1="10" y1="90" x2="90" y2="90" stroke="#1e1e1e"/>\n', '<ellipse cx="70" cy="30" rx="12" ry="8" fill="#74c0fc"/>\n'];
let drawPlan = [];
/** The picture's streamed elements, DOODLE unless a check sets others. */
let picPlan;
let calls = [];
let jev = [];
const { JEV_VERSIONS: JEV } = await import("../../src/core/model.ts");
let n = 0;
const stream = (steps) => (plans.set(String(++n), steps), { redirect: `/__stream/${n}` });
const c = await openChrome({
  stubs: {
    "/api/model": ({ body }) => {
      const r = JSON.parse(body);
      if (!r.user) return `${JSON.stringify({ done: true, warmed: true })}\n`;
      // Jev's yes/no calls (the resolver by default, resolve.engine 1; the add hint; the think router): yes only to the nav
      // as the reference, no to the rest. The resolver's takes RESOLVER_MS; the others answer at once.
      if (JEV.includes(r.model)) {
        jev.push(r.from);
        const ids = Object.keys(JSON.parse(r.user).questions);
        return stream([[r.from.startsWith("draw-refs") ? RESOLVER_MS : 1, JSON.stringify(Object.fromEntries(ids.map((id) => [id, { noul: id === "home-nav" ? 0.97 : 0.02 }])))]]);
      }
      calls.push(r.from);
      if (r.from === "draw-refs") return stream([[RESOLVER_MS, '{"refs": [{"phrase": "the nav", "ids": ["home-nav"]}]}']]);
      if (r.from === "draw") return stream(drawPlan);
      if (r.from === "picture") return stream((picPlan ?? DOODLE).map((el) => [PIC_GAP, el]));
      fail(`an unexpected model call from ${r.from}`);
    },
  },
});
const { page } = c;

// ---- The toy shop, its 16 doodles filled by a fake pictures file.
const raw = f.loadFixture("toyshop-home", { pictures: {} });
const fake = Object.fromEntries(raw.scene.stacked().filter((s) => s.drawing).map((s) => [f.pictureKey(s), { w: 100, h: 100, els: [{ tag: "circle", attrs: { cx: "50", cy: "50", r: "40", fill: "#ffa94d" } }] }]));
const toy = f.loadFixture("toyshop-home", { pictures: fake });
const TOY = JSON.parse(JSON.stringify(toy.scene.toJSON()));
const BARE = JSON.parse(JSON.stringify(raw.scene.toJSON()));
const CAMERA = toy.start;
const js = (v) => JSON.stringify(v);
const load = (scene = TOY) => page.eval(`rtEval.load(${js({ scene, camera: CAMERA })})`);
/** One send: the drawing reply's steps, then the outcome and the model calls it made. */
async function send(steps, words = "make the nav pink") {
  drawPlan = steps;
  calls = [];
  jev = [];
  const out = await page.eval(`rtEval.send(${js({ words, strokes: [] })})`);
  return { ...out, calls: [...calls], jev: [...jev] };
}

await page.goto(BRIDGE);
const h = await page.eval("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1200))).then(() => rtEval.health())");
check(h.ok && h.fonts && h.visible && h.sha === "c0ffee" && h.tuningId === "default" && h.rafPerSec >= 30, `health: ${js(h)}`);
const { sceneHash } = await load();
check(/^[0-9a-f]{64}$/.test(sceneHash), `load() gave no scene hash: ${sceneHash}`);
check(isDeepStrictEqual(await page.eval("rtEval.scene()"), TOY), "scene() isn't the scene load() was given");
check((await page.eval("document.querySelectorAll('#stage svg:first-of-type > g[data-id]').length")) === TOY.shapes.length, "the stage doesn't show every shape");

// ---- Signatures: a hash of each g[data-id]'s subtree; a redraw or a camera move changes none, a recolour exactly one.
const SIGS = `import("/evals/bridge/timing.ts").then((t) => { const svg = document.querySelector("#stage svg"); const s = t.signatures(svg);
  const subtree = [...svg.children].filter((g) => g.dataset?.id).every((g) => s.get(g.dataset.id) === t.hash(g.outerHTML.replace(/pic-clip-\\d+/g, "pic-clip")));
  return { subtree, sigs: Object.fromEntries(s) }; })`;
const s0 = await page.eval(SIGS);
check(s0.subtree && Object.keys(s0.sigs).length === TOY.shapes.length, "signatures aren't the subtree hashes of each g[data-id]");
await page.eval(`rtEval.restore(rtEval.scene())`);
await page.eval(`rtEval.setView(${js({ x: -400, y: -200, w: 2560, h: 1600 })})`);
check(isDeepStrictEqual((await page.eval(SIGS)).sigs, s0.sigs), "a redraw or a camera move changed a signature");
await page.eval(`rtEval.restore(${js({ ...TOY, shapes: TOY.shapes.map((s) => (s.id === "home-nav" ? { ...s, style: { ...s.style, fill: "#ffe3e3" } } : s)) })})`);
const s1 = (await page.eval(SIGS)).sigs;
check(isDeepStrictEqual(Object.keys(s1).filter((id) => s1[id] !== s0.sigs[id]), ["home-nav"]), "a recolour didn't change exactly its shape's signature");

// A renderer that changes a shape in place (the loop may write one) is seen too, not only today's full redraw.
const inPlace = await page.eval(`import("/evals/bridge/timing.ts").then(async (t) => {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.body.appendChild(document.createElementNS(NS, "svg"));
  const g = svg.appendChild(document.createElementNS(NS, "g"));
  g.setAttribute("data-id", "a");
  const rect = g.appendChild(document.createElementNS(NS, "rect"));
  const clock = t.watch(svg);
  const before = clock.enter();
  const at = performance.now();
  await new Promise((ok) => setTimeout(ok, 50));
  rect.setAttribute("fill", "#f00");
  await new Promise((ok) => setTimeout(ok, 20));
  const m = clock.measure(before, at);
  svg.remove();
  return m;
})`);
check(inPlace.ttfcMs >= 40 && isDeepStrictEqual(inPlace.changed, ["a"]), `a change inside a shape's group wasn't seen: ${js(inPlace)}`);

// ---- TTFC and TTD.
await load();
const recolour = await send([[DRAW_MS, RECOLOUR]]);
const t1 = recolour.timing;
check(t1.ttfcMs >= RESOLVER_MS + DRAW_MS && t1.ttdMs >= t1.ttfcMs, `a recolour: TTFC ${t1.ttfcMs} (want ≥ the resolver's ${RESOLVER_MS} + ${DRAW_MS}), TTD ${t1.ttdMs}`);
check(isDeepStrictEqual(recolour.calls, ["draw"]) && recolour.jev.includes("draw-refs-jev"), `a recolour send made these calls: ${recolour.calls.join(" ")}, Jev ${recolour.jev.join(" ")} (Jev's resolver and the drawing call expected, no picture call)`);
check(recolour.ops.length === 1 && recolour.ops[0].ok && recolour.after.shapes.find((s) => s.id === "home-nav").style.fill === "#ffe3e3", "the recolour's outcome is wrong");
check(t1.renders >= 1 && t1.heapMb > 0 && t1.enterAt > 0 && t1.ttloMs >= RESOLVER_MS, `timing: ${js(t1)}`);
// A recolour's first drawing is its lasting change; every frame of the send is timed.
check(t1.ttfdMs === t1.ttfcMs, `a recolour: TTFD ${t1.ttfdMs} isn't its TTFC ${t1.ttfcMs}`);
check(t1.renderP90Ms > 0 && t1.renderP50Ms <= t1.renderP90Ms && t1.renderP90Ms <= t1.renderMaxMs, `a recolour's render times: p50 ${t1.renderP50Ms}, p90 ${t1.renderP90Ms}, max ${t1.renderMaxMs}`);
check(recolour.spans.some((s) => s.name === "build the prompt") && recolour.spans.every((s) => s.startMs >= t1.enterAt - 1 && s.endMs >= s.startMs), "the send's spans are missing or not this send's");

await load();
const transient = await send([[DRAW_MS, TMP], [GAP, "remove(tmp-box)\n"]]);
check(transient.timing.ttfcMs === undefined && transient.ops.every((o) => o.ok), `a shape added and removed again got a TTFC: ${js(transient.timing)}`);
// Nothing kept: its first drawing is the send's end, so doing nothing never reads as fast.
check(transient.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + GAP - 15, `a send that kept nothing has TTFD ${transient.timing.ttfdMs} ms (want its end, ≥ ${RESOLVER_MS + DRAW_MS + GAP})`);
await load();
const later = await send([[DRAW_MS, TMP], [GAP, "remove(tmp-box)\n"], [GAP, RECOLOUR]]);
check(later.timing.ttfcMs >= RESOLVER_MS + DRAW_MS + 2 * GAP - 20, `TTFC came from the added-then-removed shape: ${later.timing.ttfcMs} ms (the recolour landed at ≥ ${RESOLVER_MS + DRAW_MS + 2 * GAP})`);
check(later.timing.ttfdMs === later.timing.ttfcMs, `TTFD came from the added-then-removed shape: ${later.timing.ttfdMs} ms (the recolour, kept, at ${later.timing.ttfcMs})`);

await load();
const cam = await send([[DRAW_MS, "camera(0 0 2560 1600)\n"]], "zoom out");
check(cam.timing.ttfcMs === undefined && cam.camera.w === 2560 && cam.ops[0]?.ok, `a camera-only reply: TTFC ${cam.timing.ttfcMs}, camera ${js(cam.camera)}`);
check(cam.timing.ttfdMs >= DRAW_MS, `a camera-only reply drew nothing but has TTFD ${cam.timing.ttfdMs} ms (want its end)`);

await load();
const pictured = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner")\ndrawing(gift, "a gift box with a bow")\n']]);
const picEnd = Math.max(...pictured.spans.filter((s) => s.name.startsWith("picture:")).map((s) => s.endMs)) - pictured.timing.enterAt;
check(pictured.calls.filter((x) => x === "picture").length === 1 && pictured.pics?.drawn === 1, `the new drawing didn't get one picture call: ${pictured.calls.join(" ")}`);
check(pictured.timing.ttdMs >= picEnd - 20 && pictured.timing.ttdMs >= RESOLVER_MS + DRAW_MS + DOODLE.length * PIC_GAP, `TTD ${pictured.timing.ttdMs} ms is before the last picture landed (${Math.round(picEnd)} ms)`);
check(pictured.timing.ttfcMs === pictured.timing.ttdMs, `the placeholder counted as a lasting change: TTFC ${pictured.timing.ttfcMs}, TTD ${pictured.timing.ttdMs}`);
// The picture's first streamed element is its first drawing: never the placeholder (on screen from the drawing() op, ~${RESOLVER_MS + DRAW_MS} ms),
// and well before the last element.
const placeholderMs = Math.min(...pictured.ops.filter((o) => o.line.startsWith("drawing(")).map((o) => o.ms));
check(pictured.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + PIC_GAP - 15, `the placeholder counted as a first drawing: TTFD ${pictured.timing.ttfdMs} ms (the first element lands ≥ ${RESOLVER_MS + DRAW_MS + PIC_GAP}; the drawing() op at ${placeholderMs} ms from the drawing call)`);
check(pictured.timing.ttfdMs <= pictured.timing.ttdMs - (DOODLE.length - 2) * PIC_GAP, `TTFD ${pictured.timing.ttfdMs} ms waited for the picture to finish (TTD ${pictured.timing.ttdMs} ms): a picture's first stroke counts`);

// Only visible ink counts (LOOP-V2.md A1): a speck, a white line and a see-through rect streamed first aren't the first
// drawing, the doodle's first real element (the 4th) is; nor is a shape nobody can see, drawn before one they can.
picPlan = ['<circle cx="50" cy="50" r="1" fill="#1e1e1e"/>\n', '<line x1="0" y1="50" x2="100" y2="50" stroke="#ffffff" stroke-width="3"/>\n', '<rect x="0" y="0" width="100" height="100" fill="#e03131" opacity="0"/>\n', ...DOODLE];
await load();
const specks = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner")\ndrawing(gift, "a gift box with a bow")\n']]);
picPlan = undefined;
check(specks.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + 4 * PIC_GAP - 15, `a speck, a white line or a see-through rect counted as the first drawing: TTFD ${specks.timing.ttfdMs} ms (the first real element lands ≥ ${RESOLVER_MS + DRAW_MS + 4 * PIC_GAP})`);
await load();
const unseen = await send([[DRAW_MS, 'shape(ghost, rect, 100 100 200 100, "an empty box nobody sees", stroke:transparent)\n'], [GAP, 'shape(seen, rect, 400 100 200 100, "a pink box", fill:#ffe3e3)\n']]);
check(unseen.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + GAP - 15, `a shape nobody sees counted as the first drawing: TTFD ${unseen.timing.ttfdMs} ms (the pink box lands ≥ ${RESOLVER_MS + DRAW_MS + GAP})`);
// A shape already on the board counts only once it visibly changed: a 1-unit nudge and a barely-there recolour sent first
// aren't the first drawing, the nav's recolour is (cream to pink, ΔE 12.6).
await load();
const nudged = await send([[DRAW_MS, 'move(card-robot, 81 740 340 420)\nshape(card-teddy, fill:#fff1f6)\n'], [GAP, RECOLOUR]]);
check(nudged.ops.every((o) => o.ok) && nudged.timing.ttfcMs < nudged.timing.ttfdMs && nudged.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + GAP - 15, `a nudge or a faint recolour counted as the first drawing: TTFC ${nudged.timing.ttfcMs}, TTFD ${nudged.timing.ttfdMs} ms (the recolour lands ≥ ${RESOLVER_MS + DRAW_MS + GAP}); ops ${nudged.ops.map((o) => o.error ?? "ok").join(", ")}`);
// A shape that ends with a drawing counts by its picture's first element or its words, never by its box, styled or not.
await load();
const boxed = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner", fill:#ffe3e3, stroke:#e03131)\ndrawing(gift, "a gift box with a bow")\n']]);
check(boxed.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + PIC_GAP - 15, `a pictured shape's styled box counted as its first drawing: TTFD ${boxed.timing.ttfdMs} ms (the first element lands ≥ ${RESOLVER_MS + DRAW_MS + PIC_GAP})`);
// Two specks first, so the picture's first visible element lands well after the words.
picPlan = ['<circle cx="50" cy="50" r="1" fill="#1e1e1e"/>\n', '<circle cx="50" cy="50" r="1" fill="#1e1e1e"/>\n', ...DOODLE];
await load();
const worded = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner")\ntext(gift, "Gifts")\ndrawing(gift, "a gift box with a bow")\n']]);
picPlan = undefined;
check(worded.timing.ttfdMs < RESOLVER_MS + DRAW_MS + 2 * PIC_GAP, `a pictured shape's words didn't count before its picture: TTFD ${worded.timing.ttfdMs} ms (the words land at ~${RESOLVER_MS + DRAW_MS}, the first visible element ≥ ${RESOLVER_MS + DRAW_MS + 3 * PIC_GAP})`);

// A picture drawn faded still shows (fade 1 dims it to 0.3): its first element is its first drawing, not the send's end.
await load();
const faded = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner", fade:1)\ndrawing(gift, "a gift box with a bow")\n']]);
check(faded.ops.every((o) => o.ok) && faded.timing.ttfdMs <= faded.timing.ttdMs - (DOODLE.length - 2) * PIC_GAP, `a faded picture's first element didn't count: TTFD ${faded.timing.ttfdMs} ms, TTD ${faded.timing.ttdMs} ms; ops ${faded.ops.map((o) => o.error ?? "ok").join(", ")}`);
// A caption shown only until the picture comes isn't its first drawing: only content the shape keeps counts.
await load();
const captioned = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner")\ntext(gift, "drawing a gift")\ndrawing(gift, "a gift box with a bow")\n'], [GAP, 'text(gift, "Gifts")\n']]);
check(captioned.timing.ttfdMs >= RESOLVER_MS + DRAW_MS + PIC_GAP - 15, `a caption replaced before the end counted as the first drawing: TTFD ${captioned.timing.ttfdMs} ms (the first element lands ≥ ${RESOLVER_MS + DRAW_MS + PIC_GAP})`);
// A picture already on screen, made bigger, is drawn when it grows, not when the reply ends (a camera move 3 gaps later).
await load();
const grown = await send([[DRAW_MS, "move(logo, 24 16 480 480)\n"], [3 * GAP, "camera(0 0 2560 1600)\n"]], "make the logo much bigger");
check(grown.ops.every((o) => o.ok) && grown.timing.ttfdMs < RESOLVER_MS + DRAW_MS + GAP, `a picture made bigger wasn't drawn when it grew: TTFD ${grown.timing.ttfdMs} ms (the move lands at ~${RESOLVER_MS + DRAW_MS}, the reply ends ≥ ${RESOLVER_MS + DRAW_MS + 3 * GAP})`);

// engine() times a real frame on both boards in one view: the board one change short painted, then the board, from fresh
// copies (A2), with how many lines applied and what each board held, so ab.ts can tell the same content from another.
const lines = (o) => o.ops.filter((x) => x.ok).map((x) => x.line);
const engIn = (other) => `rtEval.engine(${js({ before: TOY, view: CAMERA, own: { ops: lines(unseen), after: unseen.after }, other })})`;
await page.eval(`rtEval.restore(${js(unseen.after)})`);
const eng = await page.eval(engIn({ ops: [], after: TOY }));
check(eng.paintMs > 0 && eng.other?.paintMs > 0 && eng.ops === 2 && eng.applied === 2 && eng.other.ops === 0 && /^[0-9a-f]{64}$/.test(eng.board) && eng.other.board !== eng.board && !eng.deferred && !eng.skew, `engine() didn't time a frame on both boards: ${js(eng)}`);
const same = await page.eval(engIn({ ops: lines(unseen), after: unseen.after }));
check(same.other.board === same.board && same.other.applied === same.applied, `one board timed twice didn't read as the same content: ${js(same)}`);
// A renderer that leaves work for after render() returns (a timer that changes the stage) is caught.
await page.eval(`(() => { const svg = document.querySelector("#stage svg"); let k = 0;
  window.__late = new MutationObserver((rs) => rs.some((r) => r.type === "childList") && setTimeout(() => svg.firstElementChild?.setAttribute("data-late", String(++k)), 0));
  window.__late.observe(svg, { childList: true }); return true; })()`);
const late = await page.eval(engIn({ ops: [], after: TOY }));
await page.eval("window.__late.disconnect(), true");
check(late.deferred === true, `a render that finishes after it returns wasn't caught: ${js(late)}`);

// ---- Spoken words work too; a 16-picture fill renders at most once per animation frame.
await load(BARE);
await page.eval(`(() => { const svg = document.querySelector("#stage svg"); const f = { n: 0, per: {} }; (function tick() { f.n++; requestAnimationFrame(tick); })();
  new MutationObserver((rs) => { for (const r of rs) if (r.target === svg && [...r.removedNodes].some((x) => x.nodeName === "defs")) f.per[f.n] = (f.per[f.n] ?? 0) + 1; }).observe(svg, { childList: true });
  window.__frames = f; return true; })()`);
const fill = await send([[DRAW_MS, RECOLOUR]], [{ word: "pink", t0: 0, t1: 200 }, { word: "nav", t0: 220, t1: 400 }]);
const per = Object.values((await page.eval("window.__frames")).per);
check(fill.calls.filter((x) => x === "picture").length === 16 && fill.pics?.drawn === 16, `the fill made ${fill.calls.filter((x) => x === "picture").length} picture calls, drew ${fill.pics?.drawn}`);
check(per.length >= 16 && Math.max(...per) === 1 && fill.timing.renders >= per.length - 1, `renders per frame during the fill: max ${Math.max(...per)} over ${per.length} frames (bridge counted ${fill.timing.renders})`);
check(fill.after.shapes.filter((s) => s.drawing).every((s) => s.picture?.done), "the fill left a picture undone");
check(fill.timing.ttfdMs < fill.timing.ttdMs - 2 * PIC_GAP && fill.timing.renderP90Ms > 0, `a 16-picture fill: TTFD ${fill.timing.ttfdMs} ms, TTD ${fill.timing.ttdMs} ms, render p90 ${fill.timing.renderP90Ms} ms`);

// ---- After a reload, load() is ready within a second; the ink overlay draws numbered ink and goes again.
const reloaded = new Promise((r) => c.onEvent((m) => m.method === "Page.loadEventFired" && r()));
await page.send("Page.reload");
await reloaded;
const readyMs = await page.eval(`new Promise((r) => { const t = () => (window.rtEval ? r() : setTimeout(t, 5)); t(); }).then(() => rtEval.load(${js({ scene: TOY, camera: CAMERA })})).then(() => performance.now())`);
check(readyMs < 1000, `load() was ready ${Math.round(readyMs)} ms after the reload`);
const heap = (await send([[DRAW_MS, RECOLOUR]])).timing.heapMb;
check(heap > 0, `heapMb ${heap}`);
const sigsBefore = (await page.eval(SIGS)).sigs;
const at = (x, y, t) => [x, y, t];
const STROKES = [
  { id: 1, points: [at(100, 100, 0), at(160, 90, 40), at(200, 140, 80), at(150, 190, 120), at(100, 100, 160)], t0: 0, t1: 160 },
  { id: 2, points: [at(205, 145, 300), at(240, 170, 340)], t0: 300, t1: 340 },
  { id: 3, points: [at(900, 500, 3000), at(901, 500, 3010)], t0: 3000, t1: 3010 },
];
await page.eval(`rtEval.showInk(${js(STROKES)}, { numbers: true })`);
const ink = await page.eval(`(() => { const s = document.querySelectorAll("#stage svg")[1]; return { paths: s.querySelectorAll("path").length, nums: [...s.querySelectorAll("text")].map((t) => t.textContent) }; })()`);
check(ink.paths === 3 && isDeepStrictEqual(ink.nums, ["[1]", "[2]"]), `showInk drew ${ink.paths} strokes numbered ${ink.nums.join(" ")} (want 3 strokes, [1] [2])`);
check(isDeepStrictEqual((await page.eval(SIGS)).sigs, sigsBefore), "the ink overlay changed the scene's stage");
await page.eval("rtEval.hideInk()");
check((await page.eval(`document.querySelectorAll("#stage svg")[1].childElementCount`)) === 0, "hideInk left ink on the stage");
const restored = await page.eval(`(rtEval.restore(${js(TOY)}), rtEval.scene())`);
check(isDeepStrictEqual(restored, TOY), "restore() didn't bring the scene back");

// ---- A second tab with focus emulation runs at ≥ 30 rAF/s too, beside the first.
const { targetId } = await c.cdp("Target.createTarget", { url: "about:blank" });
const { sessionId: tab } = await c.cdp("Target.attachToTarget", { targetId, flatten: true });
c.onEvent((m) => {
  if (m.sessionId !== tab || m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  try {
    assertLocalOnly(request.url);
  } catch {
    fail(`the second tab sent a request off the machine: ${request.url}`);
  }
  if (new URL(request.url).pathname.startsWith("/api/")) fail(`the second tab sent ${request.url}, unstubbed`);
  c.cdp("Fetch.continueRequest", { requestId }, tab).catch(() => {});
});
for (const m of ["Page.enable", "Runtime.enable"]) await c.cdp(m, {}, tab);
await c.cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, tab);
await c.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, tab);
await c.cdp("Page.navigate", { url: BRIDGE }, tab);
await sleep(2000);
const h2 = JSON.parse((await c.cdp("Runtime.evaluate", { expression: "JSON.stringify(window.rtEval?.health() ?? null)", returnByValue: true }, tab)).result.value);
const h1 = await page.eval("rtEval.health()");
check(h2?.visible && h2.rafPerSec >= 30 && h1.visible && h1.rafPerSec >= 30, `two tabs: the second ${js(h2)}, the first ${js(h1)}`);
await c.cdp("Target.closeTarget", { targetId });

const counts = c.counts();
check(counts.seen === counts.stubbed && counts.stubbed > 0, `requests seen ${counts.seen}, stubbed ${counts.stubbed}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await vite.close();
finish();
