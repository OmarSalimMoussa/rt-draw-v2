// T6's acceptance check: the bridge page (window.rtEval) and the harness clock.
// Model replies stream from a local endpoint over time (resolver, drawing ops line by
// line, doodles element by element), so TTFC and TTD are measured on real frames.
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
let calls = [];
let n = 0;
const stream = (steps) => (plans.set(String(++n), steps), { redirect: `/__stream/${n}` });
const c = await openChrome({
  stubs: {
    "/api/model": ({ body }) => {
      const r = JSON.parse(body);
      if (!r.user) return `${JSON.stringify({ done: true, warmed: true })}\n`;
      calls.push(r.from);
      if (r.from === "draw-refs") return stream([[RESOLVER_MS, '{"refs": [{"phrase": "the nav", "ids": ["home-nav"]}]}']]);
      if (r.from === "draw") return stream(drawPlan);
      if (r.from === "picture") return stream(DOODLE.map((el) => [PIC_GAP, el]));
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
  const out = await page.eval(`rtEval.send(${js({ words, strokes: [] })})`);
  return { ...out, calls: [...calls] };
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
check(isDeepStrictEqual(recolour.calls, ["draw-refs", "draw"]), `a recolour send made these calls: ${recolour.calls.join(" ")} (no picture call expected)`);
check(recolour.ops.length === 1 && recolour.ops[0].ok && recolour.after.shapes.find((s) => s.id === "home-nav").style.fill === "#ffe3e3", "the recolour's outcome is wrong");
check(t1.renders >= 1 && t1.heapMb > 0 && t1.enterAt > 0 && t1.ttloMs >= RESOLVER_MS, `timing: ${js(t1)}`);
check(recolour.spans.some((s) => s.name === "build the prompt") && recolour.spans.every((s) => s.startMs >= t1.enterAt - 1 && s.endMs >= s.startMs), "the send's spans are missing or not this send's");

await load();
const transient = await send([[DRAW_MS, TMP], [GAP, "remove(tmp-box)\n"]]);
check(transient.timing.ttfcMs === undefined && transient.ops.every((o) => o.ok), `a shape added and removed again got a TTFC: ${js(transient.timing)}`);
await load();
const later = await send([[DRAW_MS, TMP], [GAP, "remove(tmp-box)\n"], [GAP, RECOLOUR]]);
check(later.timing.ttfcMs >= RESOLVER_MS + DRAW_MS + 2 * GAP - 20, `TTFC came from the added-then-removed shape: ${later.timing.ttfcMs} ms (the recolour landed at ≥ ${RESOLVER_MS + DRAW_MS + 2 * GAP})`);

await load();
const cam = await send([[DRAW_MS, "camera(0 0 2560 1600)\n"]], "zoom out");
check(cam.timing.ttfcMs === undefined && cam.camera.w === 2560 && cam.ops[0]?.ok, `a camera-only reply: TTFC ${cam.timing.ttfcMs}, camera ${js(cam.camera)}`);

await load();
const pictured = await send([[DRAW_MS, 'shape(gift, rect, 900 700 200 160, "a small gift box picture near the bottom right of the banner")\ndrawing(gift, "a gift box with a bow")\n']]);
const picEnd = Math.max(...pictured.spans.filter((s) => s.name.startsWith("picture:")).map((s) => s.endMs)) - pictured.timing.enterAt;
check(pictured.calls.filter((x) => x === "picture").length === 1 && pictured.pics?.drawn === 1, `the new drawing didn't get one picture call: ${pictured.calls.join(" ")}`);
check(pictured.timing.ttdMs >= picEnd - 20 && pictured.timing.ttdMs >= RESOLVER_MS + DRAW_MS + DOODLE.length * PIC_GAP, `TTD ${pictured.timing.ttdMs} ms is before the last picture landed (${Math.round(picEnd)} ms)`);
check(pictured.timing.ttfcMs === pictured.timing.ttdMs, `the placeholder counted as a lasting change: TTFC ${pictured.timing.ttfcMs}, TTD ${pictured.timing.ttdMs}`);

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
