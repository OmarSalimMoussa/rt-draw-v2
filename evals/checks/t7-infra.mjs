// T7's acceptance check: per-commit trees (keyed by content, the harness's evals/ laid
// over, node_modules linked), engineer worktrees, arm servers (the bridge served from
// the tree, no .env, voice refused, /api/model streamed to a gateway on time), Chrome
// in pipe mode (gone with a SIGKILLed harness, two pages at ≥ 30 rAF/s, x-rt-* labels,
// the allowlist aborting the run, captures), the ladder's knee and dispatch limit, the
// machine guards, and launch.sh run for real as a systemd user unit. 0 model calls: the
// only /api/model server is this check's dummy gateway, and every request is counted.
// Never a request to /api/tts or /api/stt-token: the voice refusal is checked through
// the arm server's own middleware stack, in process.
//   TMPDIR=<work dir> node --import ./evals/loop/node-hooks.mjs evals/checks/t7-infra.mjs
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeCount } from "./cdp.mjs";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const HOOKS = join(ROOT, "evals/loop/node-hooks.mjs");
const SELF = fileURLToPath(import.meta.url);
const PORTS = { a: 5260, b: 5261, gateway: 5262, inProcess: 5263, killed: 5264, nowhere: 5269 };
const GATEWAY = `http://127.0.0.1:${PORTS.gateway}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, why) => {
  for (const end = Date.now() + ms; !(await f()); await sleep(100)) if (Date.now() > end) return check(false, why);
  return true;
};
const portOpen = (port) => new Promise((r) => connect(port, "127.0.0.1").once("connect", function () { this.destroy(); r(true); }).once("error", () => r(false)));

// Child mode: a harness with an arm server and a Chrome page, killed by the parent with SIGKILL.
if (process.argv[2] === "harness-child") {
  const [tree, url] = process.argv.slice(3);
  const { serveArm } = await import("../loop/servers.ts");
  const { launchChrome } = await import("../loop/chrome.ts");
  const arm = await serveArm(tree, PORTS.killed, GATEWAY);
  const dir = join(process.env.RT_EVAL_HOME, "chrome-killed");
  const chrome = await launchChrome({ dir, onBlocked: () => {} });
  await (await chrome.newPage(arm.url, { run: "r-t7", case: "k", arm: "A", slot: 0 })).goto(url);
  console.log(`DIR ${dir}`);
  setInterval(() => {}, 1000);
} else await main();

async function main() {
  const home = tempHome();
  const { paths } = await import("../loop/paths.ts");

  // ---- A harness clone with four commits: two products, an evals/-only change, a new lockfile (on a side branch).
  const repo = paths().repo;
  mkdirSync(repo);
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (rel, text) => (mkdirSync(dirname(join(repo, rel)), { recursive: true }), writeFileSync(join(repo, rel), text));
  const commit = (m) => (g("add", "-A"), g("commit", "-q", "-m", m), g("rev-parse", "HEAD"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t7@check.invalid");
  g("config", "user.name", "t7 check");
  put(".gitignore", "node_modules\n.vite\n");
  put(".env", "VITE_T7_SECRET=leaked-from-env\n"); // a committed .env: arm servers must not load it
  put("package.json", '{ "name": "t7", "private": true, "type": "module" }\n');
  put("package-lock.json", '{ "name": "t7", "lockfileVersion": 3 }\n');
  put("tsconfig.json", '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2023", "lib": ["es2023", "dom"], "types": ["vite/client"] }, "include": ["src"] }\n');
  put("index.html", "<!doctype html><title>t7</title>\n");
  put("playgrounds/p/index.html", "<!doctype html><title>p</title>\n");
  put("src/a.ts", 'export const MARK: string = "one";\nexport const ENV: string = import.meta.env.VITE_T7_SECRET ?? "no env";\n');
  put("evals/bridge/index.html", `<!doctype html><meta charset="utf-8"><title>t7-bridge</title>
<style>body { margin: 0 } .stage { width: 1280px } .stage svg { display: block; width: 100%; height: auto }</style>
<div class="stage"><svg id="canvas" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="#fff"/>
<rect x="100" y="100" width="420" height="300" fill="none" stroke="#222" stroke-width="10"/><circle cx="900" cy="420" r="220" fill="#e66"/></svg></div>
<script type="module">
import { MARK, ENV } from "/src/a.ts";
Object.assign(window, { MARK, ENV, rtEval: { setView: async (v) => document.querySelector("#canvas").setAttribute("viewBox", [v.x, v.y, v.w, v.h].join(" ")) } });
</script>\n`);
  put("evals/loop/x.ts", "v1\n");
  const sha1 = commit("one");
  put("src/a.ts", readFileSync(join(repo, "src/a.ts"), "utf8").replace('"one"', '"two"'));
  put("evals/loop/x.ts", "v2\n");
  const sha2 = commit("two");
  put("evals/loop/x.ts", "v3\n");
  const sha3 = commit("evals only");
  g("branch", "loop/champion");
  g("checkout", "-q", "-b", "cand/lock");
  put("package-lock.json", '{ "name": "t7", "lockfileVersion": 3, "packages": {} }\n');
  const shaLock = commit("a new dependency");
  g("checkout", "-q", "main");
  execFileSync("cp", ["-al", join(ROOT, "node_modules"), join(repo, "node_modules")]);
  const linked = (dir) => statSync(join(dir, "node_modules/vite/package.json")).ino === statSync(join(repo, "node_modules/vite/package.json")).ino;

  // ---- Trees.
  const { treeOf, worktreeOf, contentHash, evalsHash, LockfileDiffers } = await import("../loop/trees.ts");
  const timed = (f) => {
    const t = performance.now();
    return [f(), performance.now() - t];
  };
  const [tree1, ms1] = timed(() => treeOf(sha1));
  const [tree2, ms2] = timed(() => treeOf(sha2));
  check(ms1 < 1000 && ms2 < 1000, `trees took ${ms1.toFixed(0)} and ${ms2.toFixed(0)} ms (want < 1000 each)`);
  check(tree1 === paths().tree(contentHash(sha1)) && tree2 === paths().tree(contentHash(sha2)) && tree1 !== tree2, `trees aren't $RT_EVAL_HOME/trees/<contentHash> per product: ${tree1}, ${tree2}`);
  check(treeOf(sha3) === tree2, "a commit that only changed evals/ got a tree of its own (the key must ignore evals/)");
  check(readFileSync(join(tree1, "src/a.ts"), "utf8").includes('"one"') && readFileSync(join(tree2, "src/a.ts"), "utf8").includes('"two"'), "a tree doesn't hold its commit's src/");
  const harness = evalsHash(repo);
  check(evalsHash(tree1) === harness && evalsHash(tree2) === harness, "a tree's evals/ isn't the harness's (hash differs)");
  check(readFileSync(join(tree1, "evals/loop/x.ts"), "utf8") === "v3\n", "the old commit's own evals/ survived in its tree");
  check(linked(tree1) && linked(tree2), "a tree's node_modules isn't hard-linked to the clone's");
  let refusal;
  try {
    treeOf(shaLock);
  } catch (e) {
    refusal = e;
  }
  check(refusal instanceof LockfileDiffers, `a candidate with its own lockfile wasn't refused (${refusal?.message ?? "built"})`);

  // ---- Engineer worktrees.
  const wt = worktreeOf("cand/t7-e1");
  check(wt === join(home, "wt", "cand/t7-e1") && existsSync(join(wt, "src/a.ts")), `worktreeOf made ${wt}`);
  check(g("rev-parse", "cand/t7-e1") === sha3, "the engineer branch wasn't created off loop/champion");
  check(linked(wt), "the worktree's node_modules isn't hard-linked");
  const tsc = (cwd) => {
    try {
      execFileSync("./node_modules/.bin/tsc", ["--noEmit"], { cwd, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status ?? -1;
    }
  };
  check(tsc(wt) === 0, "./node_modules/.bin/tsc --noEmit fails in the engineer worktree");
  writeFileSync(join(wt, "src/broken.ts"), "export const n: number = 'not a number';\n");
  check(tsc(wt) !== 0, "tsc in the worktree passed a type error (did it run at all?)");
  check(worktreeOf("cand/t7-e1") === wt, "worktreeOf isn't reusable for an existing worktree");

  // ---- A dummy gateway: chunks at fixed offsets, every request recorded.
  const OFFSETS = [0, 150, 400, 700];
  const calls = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const start = performance.now();
    for (const at of OFFSETS) {
      await sleep(start + at - performance.now());
      res.write(JSON.stringify({ text: `at ${at}` }) + "\n");
    }
    res.end(JSON.stringify({ done: true }) + "\n");
  });
  await new Promise((r) => gateway.listen(PORTS.gateway, "127.0.0.1", r));

  // ---- Arm servers.
  const { serveArm } = await import("../loop/servers.ts");
  const [armA, upA] = await (async (t) => [await serveArm(tree1, PORTS.a, GATEWAY), performance.now() - t])(performance.now());
  const [armB, upB] = await (async (t) => [await serveArm(tree2, PORTS.b, GATEWAY), performance.now() - t])(performance.now());
  check(upA < 2000 && upB < 2000, `arm servers up in ${upA.toFixed(0)} and ${upB.toFixed(0)} ms (want < 2000)`);
  const get = async (base, path) => {
    const r = await fetch(base + path);
    return { status: r.status, text: await r.text() };
  };
  const bridge = await get(armA.url, "/evals/bridge/");
  check(bridge.status === 200 && bridge.text.includes("t7-bridge"), `/evals/bridge/ on the arm server: ${bridge.status}`);
  const [aTs, bTs] = [await get(armA.url, "/src/a.ts"), await get(armB.url, "/src/a.ts")];
  check(aTs.text.includes('"one"') && bTs.text.includes('"two"') && !aTs.text.includes(": string"), "arm servers don't serve (and transform) their own tree's src/");
  check(!aTs.text.includes("leaked-from-env"), "an arm server loaded the tree's .env");
  check((await get(armA.url, "/evals/loop/x.ts")).text.includes("v3"), "an arm server doesn't serve the harness's evals/");
  check((await get(armA.url, "/no/such/page")).status === 404, "an unknown path isn't a 404 on an arm server");

  // /api/model through the proxy: chunk timing intact.
  const t0 = performance.now();
  const r = await fetch(`${armA.url}/api/model`, { method: "POST", body: '{"from":"t7-timing"}' });
  const arrivals = [];
  let text = "";
  for await (const chunk of r.body) {
    text += Buffer.from(chunk).toString();
    while (arrivals.length < text.split("\n").length - 1) arrivals.push(performance.now() - t0);
  }
  const offs = arrivals.slice(0, OFFSETS.length).map((t) => t - arrivals[0]);
  check(offs.length === OFFSETS.length && offs.every((t, i) => Math.abs(t - OFFSETS[i]) <= 50), `/api/model chunks arrived at +${offs.map((t) => t.toFixed(0)).join(", +")} ms (sent at +${OFFSETS.join(", +")}, want ± 50)`);

  // Voice: through the arm config's middleware stack in process (no request to /api/tts ever leaves this check).
  const { createServer: viteServer } = await import("vite");
  const { armConfig } = await import("../loop/arm.vite.config.ts");
  const vite = await viteServer(armConfig(tree1, GATEWAY, PORTS.inProcess));
  const answer = (url) =>
    new Promise((ok) => {
      const res = { statusCode: 200, setHeader() {}, getHeader() {}, end(body) { ok(`${this.statusCode} ${body ?? ""}`.trim()); } };
      vite.middlewares.handle({ url, method: "POST", headers: { host: `127.0.0.1:${PORTS.inProcess}` } }, res, () => ok("next"));
    });
  for (const url of ["/api/tts", "/api/tts?voice=x", "/api/stt-token"]) {
    const got = await answer(url);
    check(got.startsWith("403 voice is off"), `${url} on an arm server answered "${got}" (want 403 from the voice refusal)`);
  }
  await vite.close();

  // ---- Chrome: two arm pages.
  const { launchChrome, capture } = await import("../loop/chrome.ts");
  const blocked = [];
  let aborted;
  const dir = join(home, "chrome");
  const chrome = await launchChrome({ dir, onBlocked: (url, labels) => (blocked.push({ url, labels }), (aborted ??= url)) });
  const pa = await chrome.newPage(armA.url, { run: "r-t7", case: "c-1", arm: "A", slot: 0 });
  const pb = await chrome.newPage(armB.url, { run: "r-t7", case: "c-1", arm: "B", slot: 1 });
  await pa.goto(`${armA.url}/evals/bridge/`);
  await pb.goto(`${armB.url}/evals/bridge/`);
  await until(async () => (await pa.eval("window.MARK")) && (await pb.eval("window.MARK")), 10_000, "the bridge pages never ran their module");
  check((await pa.eval("window.MARK")) === "one" && (await pb.eval("window.MARK")) === "two", "a page didn't load its own arm's tree");
  check((await pa.eval("window.ENV")) === "no env", "a page saw the tree's .env");

  const RAF = "new Promise((r) => { let n = 0; const t = performance.now(); const f = () => (++n, performance.now() - t < 1000 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); })";
  const [rafA, rafB] = await Promise.all([pa.eval(RAF), pb.eval(RAF)]);
  const FOCUS = 'document.hasFocus() && document.visibilityState === "visible"';
  check((await pa.eval(FOCUS)) && (await pb.eval(FOCUS)), "a page isn't focused and visible (focus emulation, a window of its own)");
  check(rafA >= 30 && rafB >= 30, `rAF/s on two pages at once: ${rafA} and ${rafB} (want ≥ 30 each)`);

  const before = calls.length;
  const post = (page, from) => page.eval(`fetch("/api/model", { method: "POST", body: ${JSON.stringify(JSON.stringify({ from }))} }).then((r) => r.text())`);
  await post(pa, "t7-a");
  pb.labels.case = "c-2";
  await post(pb, "t7-b");
  const [ca, cb] = calls.slice(before);
  const labels = (c) => ["run", "case", "arm", "slot"].map((k) => c?.headers[`x-rt-${k}`]).join(" ");
  check(labels(ca) === "r-t7 c-1 A 0" && labels(cb) === "r-t7 c-2 B 1", `x-rt-* labels reaching the gateway: "${labels(ca)}", "${labels(cb)}"`);
  check(ca?.body === '{"from":"t7-a"}' && cb?.body === '{"from":"t7-b"}', "a labelled request lost its body");
  const elsewhere = `http://127.0.0.1:${PORTS.nowhere}/elsewhere`;
  const tryFetch = (page, url) => page.eval(`fetch(${JSON.stringify(url)}).then(() => "through", () => "failed")`);
  check((await tryFetch(pa, elsewhere)) === "failed" && (await tryFetch(pb, "/api/other")) === "failed", "a request outside the arm origin + /api/model got through");
  check(aborted === elsewhere, `the run wasn't aborted on the first request outside the allowlist (${aborted})`);
  check(blocked.length === 2 && blocked[0].labels.arm === "A" && blocked[1].url.endsWith("/api/other"), `blocked: ${JSON.stringify(blocked.map((b) => b.url))} (want exactly the two forbidden requests)`);
  check(calls.length === before + 2, `the gateway got ${calls.length - before} requests from the pages (want 2)`);

  const thrown = [];
  pa.on("Runtime.exceptionThrown", (e) => thrown.push(e.exceptionDetails.exception?.description ?? ""));
  await pa.send("Runtime.enable");
  await pa.eval('setTimeout(() => { throw new Error("t7-boom"); }); new Promise((r) => setTimeout(r, 50))');
  check(thrown.some((t) => t.includes("t7-boom")), "page.on() didn't deliver the page's exception");

  // Captures: the stage clip as JPEG at the driver's and the judges' widths, decoded by the page itself.
  const look = (buf) =>
    pa.eval(`(async () => {
      const img = new Image(); img.src = "data:image/jpeg;base64,${buf.toString("base64")}"; await img.decode();
      const c = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0, s2 = 0;
      for (let i = 0; i < d.length; i += 4) { const y = (d[i] + d[i + 1] + d[i + 2]) / 3; s += y; s2 += y * y; }
      const n = d.length / 4; return { w: c.width, h: c.height, variance: s2 / n - (s / n) ** 2 };
    })()`);
  const BLANK_VARIANCE = 25; // luminance variance (0–255 scale) below which a capture is blank
  const shot960 = await capture(pa, { width: 960, quality: 0.8 });
  const shot640 = await capture(pa, { width: 640, quality: 0.8 });
  const [l960, l640] = [await look(shot960), await look(shot640)];
  check(shot960[0] === 0xff && shot960[1] === 0xd8 && l960.w === 960 && l960.h === 600 && l960.variance > BLANK_VARIANCE, `960-px capture: ${JSON.stringify(l960)}`);
  check(l640.w === 640 && l640.h === 400 && l640.variance > BLANK_VARIANCE, `640-px capture: ${JSON.stringify(l640)}`);
  const zoomed = await capture(pa, { view: { x: 0, y: 0, w: 640, h: 400 }, width: 640, quality: 0.8 });
  check((await pa.eval('document.querySelector("#canvas").getAttribute("viewBox")')) === "0 0 640 400" && !zoomed.equals(shot640), "capture with a view didn't move the camera first");
  await pa.eval('document.querySelector("#canvas").innerHTML = ""');
  const blank = await look(await capture(pa, { width: 640, quality: 0.8 }));
  check(blank.variance <= BLANK_VARIANCE, `an empty stage didn't read as blank (variance ${blank.variance.toFixed(1)}): the blank test can't tell`);
  await chrome.close();
  await until(() => chromeCount(dir) === 0, 5000, `${chromeCount(dir)} Chrome processes left after close()`);

  // ---- A SIGKILLed harness leaves no Chrome and no arm server.
  const child = spawn(process.execPath, ["--import", HOOKS, SELF, "harness-child", tree1, `http://127.0.0.1:${PORTS.killed}/evals/bridge/`], { env: cleanEnv(), stdio: ["ignore", "pipe", "inherit"] });
  const killedDir = await new Promise((r) => {
    let out = "";
    child.stdout.on("data", (d) => (out += d) && /DIR (.+)\n/.test(out) && r(/DIR (.+)\n/.exec(out)[1]));
    child.once("exit", () => r(undefined));
    setTimeout(() => r(undefined), 20_000);
  });
  if (!killedDir) fail("the harness child never came up with Chrome and an arm server");
  check(chromeCount(killedDir) > 0 && (await portOpen(PORTS.killed)), "the harness child has no Chrome or arm server to leave behind");
  child.kill("SIGKILL");
  await until(() => chromeCount(killedDir) === 0, 5000, `a SIGKILLed harness left ${chromeCount(killedDir)} Chrome processes`);
  await until(async () => !(await portOpen(PORTS.killed)), 5000, "a SIGKILLed harness left its arm server listening");
  await Promise.all([armA.close(), armB.close()]);
  gateway.close();

  // ---- The ladder on synthetic measurements.
  const { LADDER, ladder, quiet, sampleLoad, beforeWave, suspendGap, heartbeat, inFactorySlice, managedSettingsHash, onAC } = await import("../loop/load.ts");
  const { LOOP } = await import("../loop/config.ts");
  const ran = [];
  const wave = (spec) => async (n) => {
    ran.push(n);
    const s = { lt: 40, psi: 0.02, p99: 2, ...spec[n] };
    return Array.from({ length: 6 * n }, (_, i) => ({ wallMs: s.wall, shotMs: 30, longTasksMs: s.lt, dispatchOffsetMs: i ? 1 : s.p99, loopDelayP99Ms: 3, load: { at: 0, load1: 0.3, psiCpu: s.psi, psiMemory: 0 } }));
  };
  const scenarios = [
    // The dispatch limit is always the cap (load.ts says why); the knee is what these vary.
    ["slower at 6", { 1: { wall: 1000 }, 2: { wall: 1060, p99: 6 }, 4: { wall: 1140, p99: 12 }, 6: { wall: 1200 }, 8: { wall: 1300 } }, 12, 4, LOOP.dispatchOffsetCapMs, [1, 2, 4, 6]],
    ["pressure at 4", { 1: { wall: 1000 }, 2: { wall: 1000, p99: 7 }, 4: { wall: 1000, psi: 0.12 } }, 12, 2, LOOP.dispatchOffsetCapMs, [1, 2, 4]],
    ["long tasks at 2", { 1: { wall: 1000, lt: 40 }, 2: { wall: 1000, lt: 70 } }, 12, 1, LOOP.dispatchOffsetCapMs, [1, 2]],
    ["offset over the cap", { 1: { wall: 1000 }, 2: { wall: 1000, p99: 40 }, 4: { wall: 2000 } }, 12, 1, LOOP.dispatchOffsetCapMs, [1, 2]], // V9 would void its cases
    ["--max 4", { 1: { wall: 1000 }, 2: { wall: 1000 }, 4: { wall: 1000, p99: 9 } }, 4, 4, LOOP.dispatchOffsetCapMs, [1, 2, 4]],
  ];
  for (const [name, spec, max, slots, limit, steps] of scenarios) {
    ran.length = 0;
    const m = await ladder(wave(spec), max);
    const saved = JSON.parse(readFileSync(paths().machine, "utf8"));
    check(m.slots === slots && m.dispatchLimitMs === limit && saved.slots === slots && saved.dispatchLimitMs === limit, `ladder "${name}": knee ${m.slots}, limit ${m.dispatchLimitMs} ms (want ${slots}, ${limit})`);
    check(ran.join() === steps.join(), `ladder "${name}" ran slots ${ran} (want ${steps}: it stops at the first step past the knee)`);
  }
  check(LADDER.slots.join() === "1,2,4,6,8,12,16", "the ladder's slots aren't 1, 2, 4, 6, 8, 12, 16 (§7.6's, plus a look's 16)");
  let busy;
  await ladder(wave({ 1: { wall: 1000, psi: 0.3 } }), 12, join(home, "busy-machine.json")).catch((e) => (busy = e));
  check(busy && !existsSync(join(home, "busy-machine.json")), "a machine under pressure at one slot still got a machine.json");

  // ---- Load gate, heartbeat, guards.
  const s = sampleLoad();
  check(Number.isFinite(s.load1) && s.load1 >= 0 && s.psiCpu >= 0 && s.psiCpu <= 1 && s.psiMemory >= 0, `sampleLoad: ${JSON.stringify(s)}`);
  const at = (load1, psiCpu) => ({ at: 0, load1, psiCpu, psiMemory: 0 });
  check(quiet(at(0.5, 0.05)) && !quiet(at(0.7, 0.05)) && !quiet(at(0.5, 0.1)), "quiet() isn't load1/cores < 0.6 and PSI < 10%");
  const [gate, gateMs] = await (async (t) => [await beforeWave(0), performance.now() - t])(performance.now());
  check(gateMs < 1000 && gate.ok === quiet(gate.sample), `beforeWave(0): ${JSON.stringify(gate)} in ${gateMs.toFixed(0)} ms`);
  check(suspendGap({ wall: 0, mono: 0 }, { wall: 25_000, mono: 10_000 }) > LOOP.suspendGapMs, "a 15-s sleep isn't a suspend");
  check(suspendGap({ wall: 0, mono: 0 }, { wall: 30_000, mono: 30_000 }) === 0, "a stalled event loop reads as a suspend");
  const stop = heartbeat(() => {});
  const hb = JSON.parse(readFileSync(paths().heartbeat, "utf8"));
  stop();
  check(hb.wall > 0 && hb.mono > 0 && hb.pid === process.pid, `heartbeat.json: ${JSON.stringify(hb)}`);
  const etc = join(home, "etc-claude-code");
  mkdirSync(join(etc, "managed-settings.d"), { recursive: true });
  const h0 = managedSettingsHash(etc);
  writeFileSync(join(etc, "managed-settings.json"), "{}\n");
  const h1 = managedSettingsHash(etc);
  writeFileSync(join(etc, "managed-settings.d", "10-x.json"), '{"x":1}\n');
  check(h0 === "absent" && /^[0-9a-f]{64}$/.test(h1) && managedSettingsHash(etc) !== h1 && /^([0-9a-f]{64}|absent)$/.test(managedSettingsHash()), "managedSettingsHash doesn't follow the settings and their drop-ins");
  check([true, false, undefined].includes(onAC()), `onAC(): ${onAC()}`);
  check(inFactorySlice() === false, "this check thinks it runs in the factory slice");

  // ---- launch.sh for real: a systemd user unit around a probe run.ts (and the tmux path with a fake tmux).
  const layout = join(home, "launch");
  mkdirSync(join(layout, "evals/loop"), { recursive: true });
  for (const f of ["launch.sh", "node-hooks.mjs"]) copyFileSync(join(ROOT, "evals/loop", f), join(layout, "evals/loop", f));
  writeFileSync(join(layout, "evals/loop/run.ts"), `import { readFileSync, writeFileSync } from "node:fs";
const out = { cwd: process.cwd(), node: process.version, env: Object.keys(process.env), argv: process.argv.slice(2), cgroup: readFileSync("/proc/self/cgroup", "utf8") };
writeFileSync(process.env.RT_EVAL_HOME + "/probe-" + process.argv[2] + ".json", JSON.stringify(out));
console.log(JSON.stringify(out));
await new Promise((r) => setTimeout(r, process.argv.includes("--long") ? 60_000 : 2_000));\n`);
  const launchSh = join(layout, "evals/loop/launch.sh");
  const fakeTokens = { RT_EVAL_TOKEN_1: "fake-t7", RT_EVAL_TOKEN_2: "fake-t7", CLAUDE_CODE_OAUTH_TOKEN: "fake-t7" };
  const env = cleanEnv({ RT_EVAL_HOME: home, ...fakeTokens });
  const probe = (name) => join(home, `probe-${name}.json`);
  const launch = (args, cwd = layout) => {
    const p = spawn("bash", [launchSh, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let [out, err] = ["", ""];
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    return { pid: p.pid, done: new Promise((r) => p.once("exit", (code) => r({ code, out, err }))) };
  };
  // The holder's PID column is launch.sh's own pid: it execs systemd-inhibit.
  const holding = (pid) => execFileSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" }).split("\n").some((l) => l.includes("rt eval") && new RegExp(`\\s${pid}\\s`).test(l));
  const unitState = (unit) => execFileSync("systemctl", ["--user", "show", "-p", "LoadState", "--value", unit], { encoding: "utf8" }).trim();
  const callerNode = execFileSync("bash", ["-c", "command -v node"], { env, encoding: "utf8" }).trim();
  const callerVersion = execFileSync(callerNode, ["--version"], { encoding: "utf8" }).trim();

  // On aarch64 launch.sh opens a tmux window, never a unit: the unit is checked here on the laptop, the window by the fake tmux below.
  if (process.arch === "x64") {
    const first = launch(["first", "--cap", "7"]);
    if (!(await until(() => existsSync(probe("first")), 15_000, "the first launch's probe never ran"))) fail(`launch.sh: ${(await first.done).err}`);
    const unit1 = readFileSync(join(home, "unit"), "utf8").trim();
    const heldWhile = holding(first.pid);
    const out = JSON.parse(readFileSync(probe("first"), "utf8"));
    const end1 = await first.done;
    check(end1.code === 0, `the first launch exited ${end1.code}: ${end1.err}`);
    check(end1.out.includes(JSON.stringify(out)), "the probe's output didn't reach launch.sh's terminal (-P)");
    check(heldWhile, "systemd-inhibit --list didn't show the 'rt eval' inhibitor while the probe ran");
    check(!holding(first.pid), "the 'rt eval' inhibitor outlived the unit");
    check(/^rt-eval-\d+-\d+$/.test(unit1) && out.cgroup.includes(`${unit1}.service`), `the probe didn't run in the recorded unit ${unit1}`);
    check(out.cwd === layout, `the unit's cwd is ${out.cwd} (want the launch directory ${layout})`);
    check(out.node === callerVersion, `the unit ran node ${out.node} (want the caller's ${callerNode}, ${callerVersion})`);
    check(out.env.includes("RT_EVAL_HOME") && out.env.includes("RT_EVAL_LAUNCHED"), "the unit lacks RT_EVAL_HOME or RT_EVAL_LAUNCHED");
    check(!out.env.some((k) => /^RT_EVAL_TOKEN_/.test(k) || k === "CLAUDE_CODE_OAUTH_TOKEN"), `a token variable reached the unit: ${out.env.filter((k) => /TOKEN/.test(k))}`);
    check(out.argv.join(" ") === "first --cap 7", `the unit got argv "${out.argv.join(" ")}" (want "first --cap 7")`);
    check(unitState(unit1) === "not-found", `the finished unit is still loaded (${unitState(unit1)}): --collect`);

    const second = launch(["second"], home); // right away, and from another directory
    const end2 = await second.done;
    const out2 = existsSync(probe("second")) && JSON.parse(readFileSync(probe("second"), "utf8"));
    check(end2.code === 0 && out2?.cwd === layout, `an immediate second launch failed (exit ${end2.code}, cwd ${out2?.cwd}): ${end2.err}`);

    const long = launch(["long", "--long"]);
    await until(() => existsSync(probe("long")), 15_000, "the long probe never ran");
    const unit3 = readFileSync(join(home, "unit"), "utf8").trim();
    execFileSync("bash", [launchSh, "stop"], { env, stdio: "ignore" });
    const stopped = await Promise.race([long.done, sleep(10_000).then(() => undefined)]);
    check(stopped !== undefined && unitState(unit3) === "not-found", `launch.sh stop didn't stop the running probe (${unitState(unit3)})`);
  } else console.log(`note: the systemd unit is checked on the laptop (this is ${process.arch})`);

  // The PGX's path (aarch64, a tmux window), as far as this laptop can check it: a uname that says aarch64 and a
  // tmux that records what it was asked.
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "uname"), '#!/bin/sh\n[ "$1" = -m ] && echo aarch64 || exec /usr/bin/uname "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/tmux-$1.args"\n`, { mode: 0o755 });
  const fakeEnv = { ...env, PATH: `${bin}:${env.PATH}`, RT_EVAL_TMUX: "" }; // the default session, whatever the caller set
  execFileSync("bash", [launchSh, "first", "--cap", "7"], { cwd: home, env: fakeEnv, stdio: "ignore" });
  execFileSync("bash", [launchSh, "stop"], { cwd: home, env: fakeEnv, stdio: "ignore" });
  const tmuxArgs = (verb) => (existsSync(join(home, `tmux-${verb}.args`)) ? readFileSync(join(home, `tmux-${verb}.args`), "utf8").trim().split("\n") : []);
  const win = tmuxArgs("new-window");
  const nodeAt = win.indexOf(callerNode);
  check(win.slice(0, 12).join(" ") === `new-window -t =rt: -n loop -c ${layout} -e RT_EVAL_HOME=${home} -e RT_EVAL_LAUNCHED=1 /usr/bin/env`, `tmux new-window got: ${win.slice(0, 12).join(" ")}`);
  check(["RT_EVAL_TOKEN_1", "RT_EVAL_TOKEN_2", "RT_EVAL_TOKEN_3", "CLAUDE_CODE_OAUTH_TOKEN"].every((k) => win.slice(12, nodeAt).includes(k)), `the tmux window keeps a token: env ${win.slice(12, nodeAt).join(" ")}`);
  check(nodeAt > 0 && win.slice(nodeAt).join(" ") === `${callerNode} --import ./evals/loop/node-hooks.mjs evals/loop/run.ts first --cap 7`, `the tmux window runs: ${win.slice(nodeAt).join(" ")}`);
  check(tmuxArgs("send-keys").join(" ") === "send-keys -t =rt:loop C-c", `launch.sh stop on aarch64 sent: ${tmuxArgs("send-keys").join(" ")}`);

  // Inside emberhub-factory.slice (a transient one of this check's own, removed after): refused, and load.ts agrees.
  const slice = `rtcheck${process.pid}`;
  let inside = "";
  try {
    inside = execFileSync("systemd-run", ["--user", "--scope", "-q", `--slice=${slice}-emberhub-factory.slice`, "sh", "-c",
      `bash "$1" factory; echo "launch=$?"; "$2" --input-type=module -e "import { inFactorySlice } from '$3'; console.log('slice=' + inFactorySlice())"`,
      "sh", launchSh, process.execPath, join(ROOT, "evals/loop/load.ts")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    execFileSync("systemctl", ["--user", "stop", `${slice}.slice`]);
  }
  check(/launch=[1-9]/.test(inside) && !existsSync(probe("factory")), `launch.sh didn't refuse inside emberhub-factory.slice: ${inside.trim()}`);
  check(inside.includes("slice=true"), `inFactorySlice() is false inside emberhub-factory.slice: ${inside.trim()}`);
  finish();
}
