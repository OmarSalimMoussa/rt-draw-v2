// T3's acceptance check: the knob gaps. Under DEFAULTS, buildPrompt's text and every
// request the product makes (resolver, drawing, pictures and their warm-up, describe)
// are byte for byte what they were before T3, on the 4 fixtures: the five modules T3
// changed are served from git beside today's in one page. Then each new knob does what
// it says. 0 model calls: one Chrome with every /api/* stubbed and counted, a Vite with
// no plugins but the git-served modules and a slow endpoint.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t3-knobs.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "vite";
import { modelReply, openChrome } from "./cdp.mjs";
import { ROOT, check, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();

// ---- The code before T3: the parent of the commit that added prompts.ts (HEAD until then).
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
const added = git("log", "--diff-filter=A", "--format=%H", "--", "src/core/prompts.ts").trim().split("\n").filter(Boolean).at(-1);
const ref = added ? `${added}^` : "HEAD";
const before = Object.fromEntries(["tuning", "draw", "resolve", "describe", "picture"].map((f) => [f, git("show", `${ref}:src/core/${f}.ts`)]));
if (before.draw.includes("prompts.ts")) fail(`${ref}'s draw.ts already uses prompts.ts: nothing to compare against`);

// ---- The registry: every new knob has a default that keeps today's behaviour, a range, a step, a doc and a component.
const { KNOBS, knobsOf, tune } = await import("../../src/core/tuning.ts");
const { PROMPTS } = await import("../../src/core/prompts.ts");
writeFileSync(join(home, "tuning-before.ts"), before.tuning); // it imports nothing, so it loads from anywhere
const old = await import(pathToFileURL(join(home, "tuning-before.ts")).href);
const NEW = { "draw.prompt": 0, "resolve.prompt": 0, "describe.prompt": 0, "picture.prompt": 0, "draw.noThink": 0, "resolve.noThink": 0, "picture.noThink": 0, "draw.mapMaxShapes": 0, "picture.timeoutMs": 120000,
  "resolve.engine": 0, "resolve.jevModel": 0, "resolve.jevMaxCandidates": 8, "resolve.jevYes": 0.5, "resolve.jevSure": 0.3, "resolve.jevRace": 0, "resolve.jevHints": 0, "resolve.jevHintMin": 0.2, "resolve.jevPrompt": 0, "resolve.speculate": 0,
  "draw.thinkRouter": 0, "draw.thinkYes": 0.5, "draw.thinkJevModel": 0, "draw.thinkPrompt": 0, "draw.copies": 1, "draw.copyAfterMs": 0, "picture.copies": 1, "picture.copyAfterMs": 0 };
// Knobs added after T3, at their defaults.
const LATER = { "draw.addHint": 1, "draw.addYes": 0.5, "draw.addWaitMs": 1500, "picture.strokeWidth": 3, "render.captionMaxShare": 0.4, "render.minTextScale": 0.4,
  "ops.waitForShape": 1, "picture.context": 2, "picture.contextColors": 8, "picture.contextPoints": 300, "render.pictureBox": 1,
  "ops.earlyShape": 1, "ops.earlyAtBox": 1, "draw.emptyBoardFast": 1, "board.oneViewWhenSame": 1, "board.sameViewShare": 0.9, "board.sameViewWidthRatio": 1.25,
  "camera.guard": 1, "camera.lookYes": 0.5, "camera.shownShare": 0.9 };
// Defaults the owner changed since T3 (decisions on eval/history, and LOOP-V2.md's product fixes), and later knobs that
// change what a send asks or shows, at their T3-time behaviour: the comparisons with the code before T3 run under these,
// since they're about T3's refactor, not later decisions.
const T3_TIME = { "resolve.noThink": 0, "picture.maxPaths": 24, "picture.colors": 4, "resolve.engine": 0, "resolve.jevHints": 0, "resolve.speculate": 0, "draw.prompt": 0, "picture.prompt": 0,
  "draw.addHint": 0, "picture.context": 0, "render.pictureBox": 0, "ops.waitForShape": 0, "draw.thinkRouter": 0,
  "ops.earlyShape": 0, "ops.earlyAtBox": 0, "draw.emptyBoardFast": 0, "board.oneViewWhenSame": 0, "board.markZoomFrac": 0.6, "camera.guard": 0 };
const OWNER_DEFAULTS = {
  "resolve.noThink": 1, // 2026-10-19: e2-h1, the resolver answers without thinking (TTFC ×0.66)
  "resolve.engine": 1, // 4420f45: Jev resolves references
  "resolve.jevHints": 1, // 94ba1c1: Jev's answers go to the drawing model as hints
  "resolve.speculate": 1, // 94ba1c1: the drawing call starts on Jev's guess
  "picture.maxPaths": 0, "picture.colors": 0, // LOOP-V2.md B1: no caps on a picture's elements or colors
  "picture.prompt": 3, // LOOP-V2.md B1: detail matched to the ask
  "draw.prompt": 2, // e88-h1 (4e0dca9), from the loop's champion: style-first shape and text lines (the illustrated manual was 1)
  "draw.thinkRouter": 1, "draw.thinkYes": 0.9, // e73-h2, the owner kept it 2026-10-27: Jev routes thinking at a 0.9 bar
  "board.markZoomFrac": 0.35, // e98-h3b (04f5558), from the loop's champion: a mark's close-up only when the camera is zoomed out
};
// Fields of knobs from before T3 that changed since, as they were then.
const T3_FIELDS = {
  "ops.minDescriptionWords": { doc: "a new shape's description needs at least this many words" },
  "shot.inkNumberGapPx": { doc: "the [n] sits this far up and right of the mark's top-right-most ink" },
  "picture.maxPaths": { value: 24, min: 4, doc: "a doodle may use at most this many paths" },
  "picture.colors": { value: 4, min: 1, doc: "and at most this many colors" },
  "board.markZoomFrac": { value: 0.6 },
};
for (const [key, value] of Object.entries({ ...NEW, ...LATER, ...OWNER_DEFAULTS })) {
  const k = KNOBS.find((x) => x.key === key);
  if (!check(k, `no knob ${key}`)) continue;
  const part = key.split(".")[0];
  check(k.value === value && k.min <= k.value && k.value <= k.max && k.step > 0 && k.doc.length >= 20 && !k.patches, `${key}: default ${k.value} (want ${value}), range ${k.min}–${k.max}, step ${k.step}, doc "${k.doc}"`);
  check(knobsOf(part).some((o) => o.key in old.DEFAULTS), `${key} belongs to no existing component`);
  if (key.endsWith(".prompt")) check(k.max === PROMPTS[part].length - 1, `${key} ranges to ${k.max} but prompts.ts has ${PROMPTS[part].length} variants`);
  if (key.endsWith(".noThink")) check(k.max === 1 && k.name, `${key} isn't an on/off knob`);
}
check(PROMPTS.picture.length >= 2, "no picture variant 1");
check(isDeepStrictEqual(KNOBS.filter((k) => !(k.key in NEW) && !(k.key in LATER)).map((k) => ({ ...k, ...T3_FIELDS[k.key] })), old.KNOBS), "a knob from before T3 changed (patches.* included, changes since at their T3-time fields), or one was added beyond the new and later ones");

// ---- A Vite serving today's src and, at /src/core/__base__/<f>.ts, the five modules as they were (their other imports are today's).
const BASE = join(ROOT, "src/core/__base__");
const VIRTUAL = /\/src\/core\/__base__\/(\w+)\.ts$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servedBefore = {
  name: "t3-before",
  enforce: "pre",
  async resolveId(source, importer) {
    const name = VIRTUAL.exec(source)?.[1];
    if (name) return join(BASE, `${name}.ts`);
    if (!importer?.startsWith(BASE)) return;
    const rel = /^\.\/(\w+)\.ts$/.exec(source)?.[1];
    if (rel) return rel in before ? join(BASE, `${rel}.ts`) : join(ROOT, "src/core", `${rel}.ts`);
    return this.resolve(source, join(ROOT, "src/core/picture.ts"), { skipSelf: true }); // roughjs and the like
  },
  load: (id) => before[VIRTUAL.exec(id)?.[1]],
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/__t3/") return res.setHeader("content-type", "text/html"), res.end("<!doctype html><meta charset=utf-8><body></body>");
      if (req.url !== "/__slow") return next();
      // A picture call that answers only after 3 s.
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const t = setTimeout(() => res.end(modelReply('<circle cx="50" cy="50" r="30" fill="#ffd43b"/>')), 3000);
      req.on("close", () => clearTimeout(t));
    });
  },
};
const vite = await createServer({
  root: ROOT, configFile: false, envDir: mkdtempSync(join(home, "env-")), cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null }, plugins: [servedBefore],
});
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;

// ---- Stubs: every model request is tagged with its role by the page (x-t3-from), answered from REPLIES.
const WARMED = `${JSON.stringify({ done: true, warmed: true })}\n`;
const NEW_SHAPE = 'shape(t3-badge, pill, 100 100 200 60, "small red pill badge near the top announcing a sale on toys", fill:#e03131)\ndrawing(t3-badge, "a tiny gift box")';
const REPLIES = {
  "draw-refs": '{"refs": [{"phrase": "this one", "ids": ["page", "home"]}]}',
  draw: `${NEW_SHAPE}\nremove(no-such-shape)\ncamera(0 0 2560 1600)`,
  picture: '<circle cx="50" cy="50" r="30" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>\n<rect x="20" y="20" width="20" height="20" fill="#e03131"/>',
  describe: '{"t3-badge": "a small red pill badge near the top of the page announcing a toy sale"}',
};
let slowPictures = false;
const asked = [];
const c = await openChrome({
  stubs: {
    "/api/model": ({ headers }) => {
      const from = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-t3-from")?.[1];
      asked.push(from);
      if (from === "warm") return WARMED;
      if (from === "picture" && slowPictures) return { redirect: "/__slow" };
      return REPLIES[from] !== undefined ? modelReply(REPLIES[from]) : fail(`an unexpected model call from ${from}`);
    },
  },
});
const { page } = c;
await page.goto(`${base}/__t3/`);

/** In the page: both versions' modules, a fetch wrapper that records every model request, and one send through either version. */
async function setup() {
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const load = (dir) => Promise.all(["draw", "picture", "describe", "tuning", "resolve"].map((m) => import(`/src/core/${dir}${m}.ts`))).then(([draw, picture, describe, tuning, resolve]) => ({ draw, picture, describe, tuning, resolve }));
  const [now, was, fx, trace, prompts] = await Promise.all([load(""), load("__base__/"), import("/evals/fixtures/fixtures.ts"), import("/src/core/trace.ts"), import("/src/core/prompts.ts")]);
  let bodies = [];
  const real = window.fetch;
  window.fetch = (url, init = {}) => {
    if (url !== "/api/model") return real(url, init);
    const r = JSON.parse(init.body);
    bodies.push(init.body);
    return real(url, { ...init, headers: { ...init.headers, "x-t3-from": r.user === undefined ? "warm" : r.from } });
  };
  /** The requests made so far, each as its hash and the parts the checks read; then starts a new list. */
  const take = async () => {
    const out = await Promise.all(bodies.map(async (b) => {
      const r = JSON.parse(b);
      return { sha: await sha(b), from: r.user === undefined ? "warm" : r.from, thinking: "thinking" in r ? r.thinking : null, system: r.system, user: r.user, images: r.images?.length ?? 0 };
    }));
    bodies = [];
    return out;
  };
  const marks = () => trace.finished().flatMap((s) => s.events).filter((e) => e.name === "first op applied").length;
  /** One send through version `v` on a fixture (pictures undrawn, a loop around the middle of the screen), then describe; or only the send with `noDescribe`. */
  async function send(v, id, changes = {}, o = {}) {
    const m = v === "now" ? now : was;
    const t = m.tuning.tune(changes);
    const { scene, start } = fx.loadFixture(id, { pictures: {} });
    const camera = o.canvas ? undefined : start;
    const { words, strokes } = now.resolve.caseInput({ words: "make this one stand out more", ink: [{ loop: [start.x + start.w * 0.4, start.y + start.h * 0.3, start.w * 0.2, start.h * 0.2] }], expect: [] });
    await take();
    const marked = marks();
    const pics = m.picture.pictureFiller(scene, t, () => {});
    const p = await m.draw.buildPrompt(scene, strokes, words, t, undefined, camera);
    const res = await m.draw.run(scene, p, t, () => pics.kick());
    const filled = await pics.finish();
    if (!o.noDescribe) await m.describe.describeAll(scene, t);
    const { resolveMs, shotsMs, ...features } = p.features;
    return {
      prompt: await sha(JSON.stringify({ system: p.system, user: p.user, transcript: p.transcript, images: p.images })), features,
      ops: res.ops.map((r) => ({ line: r.line, ok: r.ok, error: r.error, camera: !!r.camera })), firstOpMs: res.firstOpMs, firstOpAt: res.ops.find((r) => r.ok && !r.camera)?.ms, marks: marks() - marked,
      pics: { drawn: filled.drawn, failed: filled.failed }, requests: await take(),
    };
  }
  /** Fills the pictures a fixture needs under `changes`, timed. */
  async function fill(id, changes) {
    const t = now.tuning.tune(changes);
    const { scene } = fx.loadFixture(id, { pictures: {} });
    await take();
    const t0 = performance.now();
    const pics = now.picture.pictureFiller(scene, t, () => {});
    pics.kick();
    const r = await pics.finish();
    return { ...r, took: performance.now() - t0, requests: await take() };
  }
  /** Variant 0 of each prompt against the texts before T3. */
  const texts = () => {
    const T = was.tuning.DEFAULTS;
    const draw = [true, false].flatMap((board) => [0, 40].map((cell) => prompts.PROMPTS.draw[0].system(board, 1280, 800, cell, 1280) === was.draw.systemPrompt(board, 1280, 800, cell)));
    const P = prompts.PROMPTS;
    return {
      draw: draw.every(Boolean),
      resolve: P.resolve[0].system === was.resolve.RESOLVE_SYSTEM,
      describe: P.describe[0].batch === was.describe.SYSTEM_BATCH && P.describe[0].one === was.describe.SYSTEM_ONE,
      picture: P.picture[0].system(T) === was.picture.PICTURE_SYSTEM && P.picture[0].user("a red toy car", 120, 90, T) === was.picture.picturePrompt("a red toy car", 120, 90, T),
    };
  };
  window.t3 = { send, fill, texts };
  return true;
}
await page.eval(`(${setup})()`);
const run = (expr) => page.eval(`t3.${expr}`);
const js = JSON.stringify;

// ---- Variant 0 is today's text.
// The drawing call is the one role the owner changed since T3 on purpose: the manual's shipped text (8819cc1's ordering
// rule, 8a12c01's links, b5de72e and 0855a54's pages) and its user text (the site map, Jev's add hint, 4f0de87). Its
// prompt and request are no longer T3's, so they're left out of the comparisons below; every other role still is T3's.
const CHANGED_SINCE = new Set(["draw"]);
const texts = await run("texts()");
for (const [role, same] of Object.entries(texts)) if (!CHANGED_SINCE.has(role)) check(same, `${role}: variant 0 isn't the text before T3`);

// ---- Under DEFAULTS (T3's), byte for byte the same requests as before T3 on the 4 fixtures, the drawing call's aside.
const FIXTURES = ["toyshop-home", "clowns", "messy", "grid"];
for (const id of FIXTURES) {
  const was = await run(`send("was", ${js(id)})`);
  const now = await run(`send("now", ${js(id)}, ${js(T3_TIME)})`);
  const shas = (r) => r.requests.filter((q) => !CHANGED_SINCE.has(q.from)).map((q) => `${q.from} ${q.sha}`).sort();
  check(isDeepStrictEqual(shas(now), shas(was)), `${id}: requests differ from before T3 (before: ${shas(was).filter((s) => !shas(now).includes(s)).map((s) => s.split(" ")[0])}; now: ${shas(now).filter((s) => !shas(was).includes(s)).map((s) => s.split(" ")[0])})`);
  check(isDeepStrictEqual(now.ops, was.ops) && isDeepStrictEqual(now.pics, was.pics), `${id}: ops or pictures differ from before T3`);
  const roles = new Set(now.requests.map((q) => q.from));
  check(["warm", "draw-refs", "draw", "picture", "describe"].every((r) => roles.has(r)), `${id}: not every role was asked (${[...roles]})`);
  check(now.requests.every((q) => q.thinking === null), `${id}: a request under DEFAULTS carries thinking`);
}
// The canvas (no camera) and describe one shape per call: the other texts, the same way.
const wasCanvas = await run(`send("was", "clowns", { "describe.batch": 0, "draw.gridCellPx": 40 }, { canvas: true })`);
const nowCanvas = await run(`send("now", "clowns", ${js({ ...T3_TIME, "describe.batch": 0, "draw.gridCellPx": 40 })}, { canvas: true })`);
const others = (r) => r.requests.filter((q) => !CHANGED_SINCE.has(q.from)).map((q) => q.sha).sort();
check(isDeepStrictEqual(others(nowCanvas), others(wasCanvas)), "on a canvas with one shape per describe call, the requests differ from before T3");

// ---- <role>.noThink = 1 sets thinking "off" on that role's requests (and its warm-up) and on no other.
for (const [role, froms] of [["draw", ["draw"]], ["resolve", ["draw-refs"]], ["picture", ["picture", "warm"]]]) {
  const r = await run(`send("now", "grid", ${js({ ...T3_TIME, [`${role}.noThink`]: 1 })}, { noDescribe: true })`);
  const bad = r.requests.filter((q) => (froms.includes(q.from) ? q.thinking !== "off" : q.thinking !== null));
  check(!bad.length && froms.every((f) => r.requests.some((q) => q.from === f)), `${role}.noThink=1: thinking wrong on ${bad.map((q) => `${q.from}=${q.thinking}`)}`);
}

// ---- draw.mapMaxShapes caps the site map (and the canvas id map); the rest are counted.
const capped = await run(`send("now", "toyshop-home", ${js({ ...T3_TIME, "draw.mapMaxShapes": 10 })}, { noDescribe: true })`);
const uncapped = await run(`send("now", "toyshop-home", ${js(T3_TIME)}, { noDescribe: true })`);
check(capped.features.mapChars > 0 && capped.features.mapChars < uncapped.features.mapChars / 2, `draw.mapMaxShapes=10: site map ${capped.features.mapChars} chars against ${uncapped.features.mapChars}`);
const drawReq = (r) => r.requests.find((q) => q.from === "draw");
check(/\(\d+ more shapes not listed\)/.test(drawReq(capped)?.user ?? "") && (drawReq(capped).user.match(/^[ \t]*- /gm) ?? []).length === 10, "draw.mapMaxShapes=10 doesn't list exactly 10 shapes and count the rest");

// ---- A reply of only camera(...) has no first op and no 'first op applied' mark; a scene op after it does.
REPLIES.draw = "camera(0 0 2560 1600)";
const cam = await run(`send("now", "toyshop-home", ${js(T3_TIME)}, { noDescribe: true })`);
check(cam.ops.length === 1 && cam.ops[0].ok && cam.ops[0].camera, `the camera-only reply didn't apply as a camera move: ${js(cam.ops)}`);
check(cam.firstOpMs === undefined && cam.marks === 0, `a camera-only reply gave firstOpMs ${cam.firstOpMs} and ${cam.marks} 'first op applied' marks`);
REPLIES.draw = `camera(0 0 2560 1600)\n${NEW_SHAPE}`;
const after = await run(`send("now", "toyshop-home", ${js(T3_TIME)}, { noDescribe: true })`);
check(after.firstOpMs !== undefined && after.firstOpMs === after.firstOpAt && after.marks === 1, `camera then a shape: firstOpMs ${after.firstOpMs} (the shape at ${after.firstOpAt}), ${after.marks} marks`);

// ---- A picture call past picture.timeoutMs is stopped and counts as failed (the slow endpoint answers at 3 s).
slowPictures = true;
const late = await run(`fill("grid", { "picture.timeoutMs": 300 })`);
slowPictures = false;
check(late.failed.length === 1 && late.drawn === 0 && late.took < 2000, `picture.timeoutMs=300: ${late.drawn} drawn, ${late.failed.length} failed after ${Math.round(late.took)} ms`);

// ---- picture.prompt=1 and picture.noThink=1: the warm-up at Send has the system prompt and thinking of the picture calls.
const v1 = await run(`fill("grid", { "picture.prompt": 1, "picture.noThink": 1 })`);
const warm = v1.requests.filter((q) => q.from === "warm");
const pics = v1.requests.filter((q) => q.from === "picture");
const v0system = PROMPTS.picture[0].system(tune());
check(warm.length === 1 && pics.length === 1 && v1.drawn === 1, `picture.prompt=1: ${warm.length} warm-ups, ${pics.length} picture calls, ${v1.drawn} drawn`);
check(pics.every((q) => q.system === warm[0]?.system && q.thinking === "off" && warm[0]?.thinking === "off"), "picture.prompt=1, noThink=1: the warm-up's system prompt or thinking isn't the picture calls'");
check(pics.every((q) => q.system === PROMPTS.picture[1].system(tune()) && q.system !== v0system && q.user.length < 120), "picture.prompt=1 didn't send variant 1 (the rules in the system prompt, a short message)");

// ---- 0 real calls: every model request the page made was stubbed, and nothing else reached /api.
const counts = c.counts();
check(counts.seen === counts.stubbed && counts.stubbed === asked.length && counts["/api/model"] === asked.length, `requests seen ${counts.seen}, stubbed ${counts.stubbed}, model ${counts["/api/model"]}, asked ${asked.length}`);
check(!c.errors.length, `page errors: ${c.errors.slice(0, 3).join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await vite.close();
finish();
