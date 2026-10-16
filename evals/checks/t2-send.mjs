// T2's acceptance check: the send contract (src/core/send.ts) and Scene.fromJSON.
// Scenes round-trip; the Drawing model playground, which now calls send(), gives the
// same op log, final scene and starting DOM as the playground before T2 (served from
// git beside it); with ?record=1 it posts one /api/eval/record per send. 0 model
// calls: one Chrome with every /api/* stubbed and counted, and a Vite with no
// plugins, so nothing could reach a model even unstubbed.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t2-send.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "vite";
import { modelReply, openChrome } from "./cdp.mjs";
import { ROOT, check, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const { Scene } = await import("../../src/core/scene.ts");
const { runScript } = await import("../../src/core/ops.ts");
const { asPage } = await import("../../src/core/board.ts");

// ---- Scene.fromJSON(toJSON()) is the scene again, doodles and groups included, also through JSON text.
const fixture = (f) => readFileSync(join(ROOT, "src/fixtures", `${f}.ops.txt`), "utf8");
const scripts = { board: fixture("board"), clowns: asPage(fixture("clowns"), "page", "Home"), messy: asPage(fixture("messy"), "page", "Home"), grid: asPage(fixture("grid"), "page", "Settings") };
for (const [name, script] of Object.entries(scripts)) {
  const { scene, errors } = runScript(script);
  check(!errors.length && scene.shapes.size > 5, `${name}: the fixture didn't load (${errors.length} errors)`);
  for (const s of scene.stacked()) if (s.drawing) s.picture = { subject: s.drawing, w: 120, h: 90, els: [{ tag: "circle", attrs: { cx: "60", cy: "45", r: "30", fill: "#ffd43b" } }], done: true };
  const j = scene.toJSON();
  check(j.v === 1, `${name}: toJSON() has no v: 1`);
  check(isDeepStrictEqual(Scene.fromJSON(j), scene), `${name}: Scene.fromJSON(scene.toJSON()) isn't the scene`);
  check(isDeepStrictEqual(Scene.fromJSON(JSON.parse(JSON.stringify(scene))), scene), `${name}: the scene doesn't survive JSON text`);
  if (name === "clowns") check(scene.groups.size && isDeepStrictEqual(Scene.fromJSON(j).groups, scene.groups), "clowns: groups lost");
}
check((() => {
  try {
    Scene.fromJSON({ ...new Scene().toJSON(), v: 2 });
    return false;
  } catch {
    return true;
  }
})(), "Scene.fromJSON read an unknown format");

// ---- The playground before T2 (the parent of the commit that added send.ts; HEAD until then), served beside today's.
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
const added = git("log", "--diff-filter=A", "--format=%H", "--", "src/core/send.ts").trim().split("\n").filter(Boolean).at(-1);
const ref = added ? `${added}^` : "HEAD";
const OLD = "/playgrounds/draw-before/";
const oldMain = join(ROOT, "playgrounds/draw-before/main.ts"); // never on disk: served from git by the plugin below
const oldSrc = git("show", `${ref}:playgrounds/draw/main.ts`);
check(!oldSrc.includes("core/send.ts"), `${ref}'s playground already uses send.ts: nothing to compare against`);
const before = {
  name: "t2-playground-before",
  enforce: "pre",
  resolveId: (id) => (id === `${OLD}main.ts` ? oldMain : undefined),
  load: (id) => (id === oldMain ? oldSrc : undefined),
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== OLD) return next();
      res.setHeader("content-type", "text/html");
      res.end(await server.transformIndexHtml(req.url, git("show", `${ref}:playgrounds/draw/index.html`)));
    });
  },
};
const vite = await createServer({
  root: ROOT, configFile: false, envDir: mkdtempSync(join(home, "env-")), cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null }, plugins: [before],
});
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;

// ---- Stubs: a resolver answer, a drawing reply (recolour, retext, a new pictured shape, a failing line, a camera move), one doodle for every picture.
const WARMED = `${JSON.stringify({ done: true, warmed: true })}\n`;
const REPLIES = {
  "draw-refs": modelReply('{"refs": [{"phrase": "the shop name", "ids": ["brand"]}]}'),
  draw: modelReply(['shape(home-nav, fill:#ffe3e3)', 'text(brand, "Clowns & Co", size:xl)', 'shape(sale-badge, pill, 1000 100 200 60, "small red pill badge in the top right corner announcing a toy sale", fill:#e03131)', 'drawing(sale-badge, "a tiny gift box")', "remove(no-such-shape)", "camera(0 0 2560 1600)"].join("\n")),
  picture: modelReply('<circle cx="50" cy="50" r="30" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>\n<rect x="20" y="20" width="20" height="20" fill="#e03131"/>'),
};
let asked = [];
const recorded = [];
const c = await openChrome({
  stubs: {
    "/api/model": ({ body }) => {
      const r = JSON.parse(body);
      asked.push(r.user ? r.from : "warm");
      return r.user ? (REPLIES[r.from] ?? fail(`an unexpected model call from ${r.from}`)) : WARMED;
    },
    "/api/eval/record": ({ body }) => (recorded.push(JSON.parse(body)), { body: "{}", type: "application/json" }),
  },
});
const { page } = c;
await page.send("Debugger.enable");

/** A breakpoint that never pauses: runs `effect` in the frame at the first line of `file` that holds `marker`. */
async function inject(file, marker, effect) {
  const src = await page.eval(`fetch(${JSON.stringify(file)}).then((r) => r.text())`);
  const lineNumber = src.split("\n").findIndex((l) => l.includes(marker));
  if (lineNumber < 0) fail(`no "${marker}" in ${file} as served`);
  const urlRegex = `${file.replace(/[.]/g, "\\.")}$`;
  return (await page.send("Debugger.setBreakpointByUrl", { urlRegex, lineNumber, condition: `(${effect}, false)` })).breakpointId;
}
const settle = () => page.eval("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))");
const waitFor = (cond, what) => page.eval(`new Promise((ok, no) => { const end = Date.now() + 15000; const t = () => (${cond}) ? ok(true) : Date.now() > end ? no(new Error(${JSON.stringify(`timed out waiting for ${what}`)})) : setTimeout(t, 20); t(); })`);
const WORDS = [["make", 100, 300], ["the", 320, 380], ["shop", 400, 600], ["name", 620, 800], ["bigger", 820, 1100]].map(([word, t0, t1]) => ({ word, t0, t1 }));

/** One send on the page at `path`: typed, or spoken (words put in the playground's `words` by a breakpoint, never by Scribe). */
async function sendOn(path, { typed = "make the shop name bigger", spoken = false, goto = true } = {}) {
  if (goto) {
    await page.goto(base + path);
    await settle();
  }
  const dom = await page.eval("document.body.outerHTML");
  const main = `${path.split("?")[0]}main.ts`;
  const bps = [await inject("/src/core/render.ts", "svg.replaceChildren(", "globalThis.__scene = JSON.stringify(scene)")];
  if (spoken) bps.push(await inject(main, "const typed = $", `words.length || words.push(...${JSON.stringify(WORDS)})`));
  const n = await page.eval("document.querySelectorAll('#sends tr').length");
  await page.eval(`(document.querySelector("#words").value = ${JSON.stringify(spoken ? "" : typed)}, document.querySelector("#send").click(), true)`);
  await waitFor(`document.querySelectorAll("#sends tr").length === ${n + 1} && !document.querySelector("#send").disabled`, `send ${n + 1} on ${path}`);
  await settle();
  for (const breakpointId of bps) await page.send("Debugger.removeBreakpoint", { breakpointId });
  const log = (await page.eval("document.querySelector('#opLog').textContent")).replace(/^ *\d+ ms /gm, "");
  const scene = JSON.parse(await page.eval("globalThis.__scene"));
  return { dom, log, scene };
}

asked = [];
const old = await sendOn(OLD);
const oldCalls = asked.sort().join(" ");
asked = [];
const now = await sendOn("/playgrounds/draw/");
check(now.dom === old.dom, "the playground's DOM before any send differs from before T2");
check(now.log === old.log && /✗ remove\(no-such-shape\)/.test(now.log) && /✓ camera\(/.test(now.log), `the op log differs:\n${old.log}\n---\n${now.log}`);
check(isDeepStrictEqual(now.scene, old.scene), "the final scene differs from the playground's before T2");
check(now.scene.shapes.some((s) => s.id === "sale-badge" && s.picture?.done), "the new pictured shape didn't get its picture");
check(asked.sort().join(" ") === oldCalls && asked.filter((a) => a === "picture").length === 17, `model calls differ: before T2 ${oldCalls}, now ${asked.join(" ")}`);
check(!recorded.length, "a playground without ?record=1 posted to /api/eval/record");

// ---- ?record=1: one record per send; input as typed text, then as the timed words of a spoken send.
const typed = await sendOn("/playgrounds/draw/?record=1", { typed: "make this badge smaller" });
await new Promise((r) => setTimeout(r, 200));
check(recorded.length === 1, `${recorded.length} records after one send`);
const r0 = recorded[0] ?? {};
check(r0.input === "make this badge smaller" && Array.isArray(r0.strokes) && typeof r0.at === "string" && r0.view?.w > 0, `the typed send's record: ${JSON.stringify({ ...r0, scene: undefined })}`);
check(isDeepStrictEqual(r0.scene, JSON.parse(JSON.stringify(runScript(scripts.board).scene))), "the record's scene isn't the scene before the send");
await sendOn("/playgrounds/draw/?record=1", { spoken: true, goto: false });
await new Promise((r) => setTimeout(r, 200));
check(recorded.length === 2, `${recorded.length} records after two sends`);
check(isDeepStrictEqual(recorded[1]?.input, WORDS), `the spoken send's input isn't its words: ${JSON.stringify(recorded[1]?.input)}`);
check(recorded[1]?.scene?.shapes?.some((s) => s.id === "sale-badge"), "the second record's scene isn't the scene after the first send");
check(typed.log === now.log, "the recorded page's op log differs");

const n = c.counts();
check(n.seen === n.stubbed && n["/api/eval/record"] === 2, `requests seen ${n.seen}, stubbed ${n.stubbed}, records ${n["/api/eval/record"]}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await vite.close();
finish();
