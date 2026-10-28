// T0's acceptance check: the data dir's paths and refusals, the frozen numbers,
// the clean child env, the node hooks (and that every harness module imports in
// node), and the CDP stub client. 0 model calls: the one Chrome at a time loads a
// local static page whose every /api/* request is stubbed.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t0.mjs
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromeCount, modelReply, openChrome } from "./cdp.mjs";
import { ROOT, assertLocalOnly, check, cleanEnv, finish, tempHome } from "./lib.mjs";

const HOOKS = join(ROOT, "evals/loop/node-hooks.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// Child mode: a page that makes one forbidden request; cdp.mjs must end this process with FAIL.
if (process.argv[2] === "abort-child") {
  tempHome();
  const c = await openChrome();
  console.log(`DIR ${c.dir}`);
  await c.page.goto(process.argv[3]);
  await sleep(5000);
  console.log("NOT ABORTED");
  process.exit(0);
}

// ---- paths(): the §3.1 layout under a temp home, refused inside a repo or ~/projects.
const home = tempHome();
const { evalHome, paths } = await import("../loop/paths.ts");
const p = paths();
const fixed = { home: "", repo: "repo", history: "history", bankCases: "bank/cases", bankArchive: "bank/archive", calls: "meter/calls.jsonl", labels: "labels/labels.jsonl", human: "human", data: "data", claudeConfig: "claude-config", out: "out", logs: "logs", state: "state.json", lock: "loop.lock", heartbeat: "heartbeat.json", machine: "machine.json" };
for (const [k, rel] of Object.entries(fixed)) check(p[k] === join(home, rel), `paths().${k} is ${p[k]}`);
const byId = { worktree: ["cand/e1-h2", "wt/cand/e1-h2"], tree: ["c0ffee", "trees/c0ffee"], bankCase: ["c-b1-s07-3", "bank/cases/c-b1-s07-3"], resume: ["bakery", "bank/resume/bakery.json"], run: ["r1", "runs/r1"], reply: ["ab12", "cache/replies/ab12.json"], blob: ["ab12", "cache/blobs/ab12.jpg"], digest: ["d34d", "digests/d34d.md"] };
for (const [k, [id, rel]] of Object.entries(byId)) check(p[k](id) === join(home, rel), `paths().${k}("${id}") is ${p[k](id)}`);
check(process.env.RT_DATA_DIR === p.data, "tempHome()'s RT_DATA_DIR isn't paths().data");
const refused = (h) => {
  try {
    paths(h);
    return false;
  } catch {
    return true;
  }
};
const gitTree = mkdtempSync(join(tmpdir(), "rt-eval-check-git-"));
execFileSync("git", ["init", "-q", gitTree]);
check(refused(join(ROOT, "eval-home")), "paths() accepted a home inside this repo");
check(refused(join(gitTree, "a", "b")), "paths() accepted a home inside a git work tree (outside ~/projects)");
check(refused(join(homedir(), "projects", "no-such-eval-home")), "paths() accepted a home inside ~/projects");
process.env.RT_EVAL_HOME = join(gitTree, "home");
check(refused(), "paths() accepted RT_EVAL_HOME inside a git work tree");
delete process.env.RT_EVAL_HOME;
check(evalHome() === join(homedir(), "rt-eval"), `the default home is ${evalHome()}`);
process.env.RT_EVAL_HOME = home;

// ---- config.ts: §1.6 verbatim (pinned by its hash), browser-safe, the same id in every process.
// sha256 of LOOP and DRIVE_VIEW as spec §1.6 writes them (2026-10-16), plus latFloorZ and latFutilityZ (2026-10-17, before
// any run: a latency keep's fidelity floor by look), then the owner's v2 rules (2026-10-25, evals/LOOP-V2.md: first drawing
// and render decide with no allowance, no cost cap, the 60% / 50% budget, the search's numbers), then the cleanup's
// deletions (2026-10-26: the debts, the night cap, the window share, the over-use and cost thresholds, sampled craft,
// the void rerun's knobs; one pooled latency test), then the illustrations round's bars (2026-10-26, RUNBOOK 7b), then the
// audit's search (2026-10-27: 4 to 8 hypotheses, no near-wins list), then the funnel audit's (2026-10-27: Rule F to 160
// with looser early reverts, G3's veto at −1.645 and its direction from 16 cases), then the owner's week at 70% (2026-10-27),
// then V9's event-loop limit at 100 ms (2026-10-28: the PGX's own 21–95 ms lags voided whole decisions).
// Changing a frozen number changes what decides: update this on purpose.
const SPEC_CONFIG_ID = "d28a1633a5b05cb0e88551c93682db316edf5bb46f8fd309a185ac7b33d4db30";
const cfg = await import("../loop/config.ts");
check(cfg.configId === SPEC_CONFIG_ID, "config.ts' LOOP or DRIVE_VIEW differ from spec §1.6");
check(cfg.configId === sha(JSON.stringify({ LOOP: cfg.LOOP, DRIVE_VIEW: cfg.DRIVE_VIEW })), "configId isn't sha256(JSON.stringify({ LOOP, DRIVE_VIEW }))");
const texts = Array.from({ length: 200 }, (_, n) => "aé€😀b{}".repeat(n).slice(0, n * 3));
check(texts.every((s) => cfg.sha256(s) === sha(s)), "config.ts' sha256 disagrees with node:crypto");
const configUrl = pathToFileURL(join(ROOT, "evals/loop/config.ts")).href;
const again = execFileSync(process.execPath, ["--import", HOOKS, "--input-type=module", "-e", `import { configId } from ${JSON.stringify(configUrl)}; console.log(configId);`], { env: cleanEnv(), encoding: "utf8" }).trim();
check(again === cfg.configId, `configId differs in a second process (${again})`);
const cfgSrc = readFileSync(join(ROOT, "evals/loop/config.ts"), "utf8");
check(!/^\s*import\b|\bfrom\s+["']|\brequire\(|\bprocess\.|["']node:/m.test(cfgSrc), "config.ts imports something or uses node APIs (it must stay browser-safe)");

// ---- cleanEnv(): no tokens, keys or Claude session variables reach a child.
const fake = { RT_EVAL_TOKEN_1: "x", RT_EVAL_TOKEN_3: "x", CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: "http://x", ELEVENLABS_API_KEY: "x", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_CODE_MESSAGING_TOKEN: "x" };
Object.assign(process.env, fake);
const env = cleanEnv({ RT_CHECK_EXTRA: "1" });
check(Object.keys(fake).every((k) => !(k in env)), `cleanEnv() kept ${Object.keys(fake).filter((k) => k in env).join(", ")}`);
check(env.PATH && env.HOME && env.RT_EVAL_HOME === home && env.RT_CHECK_EXTRA === "1", "cleanEnv() dropped what a child needs");
const childKeys = execFileSync(process.execPath, ["-e", "console.log(Object.keys(process.env).join(' '))"], { env, encoding: "utf8" }).trim().split(" ");
const leaked = childKeys.filter((k) => /^(RT_EVAL_TOKEN_|CLAUDE_CODE_|CLAUDECODE|ANTHROPIC_|ELEVENLABS_)/.test(k));
check(!leaked.length, `a child saw ${leaked.join(", ")}`);
const isLocal = (u) => {
  try {
    return assertLocalOnly(u) === u;
  } catch {
    return false;
  }
};
check(["http://127.0.0.1:5200/api/model", "http://localhost:5180/", "data:text/plain,x"].every(isLocal), "assertLocalOnly refused a local URL");
check(!["https://api.anthropic.com/v1/messages", "https://api.elevenlabs.io/v1/tts", "http://127.0.0.1.example.com/"].some(isLocal), "assertLocalOnly let a remote URL through");

// ---- node-hooks.mjs: the product imports in node; ?raw is text, ?url a file: URL.
for (const f of ["board", "draw", "scene", "ops", "picture", "render", "tuning"]) {
  try {
    await import(`../../src/core/${f}.ts`);
  } catch (err) {
    check(false, `src/core/${f}.ts doesn't import in node: ${String(err.message).split("\n")[0]}`);
  }
}
const { default: raw } = await import("../../src/core/tuning.ts?raw");
check(raw === readFileSync(join(ROOT, "src/core/tuning.ts"), "utf8"), "a ?raw import isn't the file's text");
const { default: font } = await import("../../src/fonts/Excalifont-Regular.woff2?url");
check(font === pathToFileURL(join(ROOT, "src/fonts/Excalifont-Regular.woff2")).href && existsSync(new URL(font)), `a ?url import gave ${font}`);
// Every harness module, whichever tasks have landed (entry modules guard their main block); run.ts is the CLI.
const modules = ["evals/loop", "evals/core", "evals/judge", "evals/optimizer", "evals/fixtures"]
  .filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => readdirSync(join(ROOT, d), { recursive: true }).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`))
  .filter((f) => f !== "evals/loop/run.ts");
for (const f of modules) {
  try {
    await import(pathToFileURL(join(ROOT, f)).href);
  } catch (err) {
    check(false, `${f} doesn't import in node: ${String(err.message).split("\n")[0]}`);
  }
}

// ---- cdp.mjs: one Chrome, every /api/* stubbed and counted, an unstubbed or remote request aborts, nothing left after.
const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
if (location.search === "?nope") fetch("/api/nope");
else if (location.search === "?far") fetch("http://example.invalid/x", { mode: "no-cors" });
else {
  const post = (body) => fetch("/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());
  const draw = await post({ model: "haiku", system: "s", user: "u", from: "t0" });
  const warm = await post({ model: "haiku", system: "s", warm: 1 });
  const health = await fetch("/api/eval/health").then((r) => r.json());
  window.results = { draw, warm, health, focus: document.hasFocus(), visible: document.visibilityState };
}
</script>`;
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const DRAW = modelReply('shape(a, rect, 0 0 10 10, "a box drawn for the check only")\n', { firstMs: 1 });
const WARMED = `${JSON.stringify({ done: true, warmed: true })}\n`;
const asked = [];
const c = await openChrome({
  width: 640,
  height: 400,
  stubs: {
    "/api/model": ({ body }) => {
      const req = JSON.parse(body);
      asked.push(req);
      return req.user ? DRAW : WARMED;
    },
    "/api/eval/health": () => ({ body: '{"ok":true}', type: "application/json" }),
  },
});
await c.page.goto(base);
const got = await c.page.eval("new Promise((ok, no) => { const end = Date.now() + 10000; const t = () => (window.results ? ok(window.results) : Date.now() > end ? no(new Error('the page never finished')) : setTimeout(t, 20)); t(); })");
check(got.draw === DRAW && got.warm === WARMED && got.health?.ok === true, "the page didn't get the stubbed replies");
check(asked[0]?.from === "t0" && asked[1]?.warm === 1, "the stub didn't get the request bodies");
check(got.focus === true && got.visible === "visible", `focus emulation is off (hasFocus ${got.focus}, ${got.visible})`);
const n = c.counts();
check(n.seen === 3 && n.stubbed === 3 && n["/api/model"] === 2 && n["/api/eval/health"] === 1, `seen ${n.seen} != stubbed ${n.stubbed} (or wrong paths: ${JSON.stringify(n)})`);
check(!hits.some((u) => u.startsWith("/api/")), "an /api/* request reached the server");
const png = await c.page.shot();
check(png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 640 && png.readUInt32BE(20) === 400, "the screenshot isn't a 640×400 PNG");
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left after close()`);

// A forbidden request ends the check with FAIL, and Chrome goes with it (no close() called).
const child = (url) =>
  new Promise((r) => {
    const ch = spawn(process.execPath, ["--import", HOOKS, fileURLToPath(import.meta.url), "abort-child", url], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => ch.kill("SIGKILL"), 20_000);
    ch.on("exit", (code) => (clearTimeout(timer), r({ code, out })));
  });
for (const [q, want] of [["?nope", /^FAIL unstubbed request GET \/api\/nope/m], ["?far", /^FAIL a request left the machine: http:\/\/example\.invalid\//m]]) {
  const r = await child(base + q);
  check(r.code === 1 && want.test(r.out), `${q} didn't abort the check (exit ${r.code}: ${r.out.trim().split("\n").at(-1)})`);
  const dir = /^DIR (.+)$/m.exec(r.out)?.[1];
  for (let i = 0; i < 30 && dir && chromeCount(dir); i++) await sleep(100);
  check(dir && chromeCount(dir) === 0, `${q}: Chrome processes left after the aborted check`);
}
server.close();
finish();
