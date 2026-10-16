// T19's acceptance check: readiness passes on a clean build, and each planted fault
// fails its check. ready.ts runs from a harness clone at a tag in a temp RT_EVAL_HOME,
// as `rte ready` does from ~/rt-eval/repo. 0 model calls: ready.ts runs the pages on
// its stubs and the gateway on the fake API with fake tokens, this check hands it no
// token (cleanEnv), and each run's ready.json must show every fake-API request was one
// of the gateway's attempts. No request to /api/tts leaves Chrome (the planted one is
// failed by chrome.ts' allowlist). Ports 5300–5301 (and 5309, never listened on).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t19-ready.mjs
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const repo = join(home, "repo");
const work = mkdtempSync(join(home, "t19-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// ---- The harness clone: this checkout's commit plus its working evals/, committed and tagged, with linked node_modules.
git("clone", "-q", "--no-checkout", ROOT, repo);
git("-C", repo, "checkout", "-q", git("-C", ROOT, "rev-parse", "HEAD"));
execFileSync("cp", ["-a", join(ROOT, "evals") + "/.", join(repo, "evals")]);
git("-C", repo, "add", "-A", "evals");
if (git("-C", repo, "status", "--porcelain")) git("-C", repo, "-c", "user.name=rt-check", "-c", "user.email=check@localhost", "commit", "-qm", "t19: the working evals/");
git("-C", repo, "tag", "eval-harness-1");
execFileSync("cp", ["-al", join(ROOT, "node_modules"), join(repo, "node_modules")]);
// The owner's checkout, whose .data/ R6 watches (never the real one).
const owner = join(work, "owner");
mkdirSync(join(owner, ".data"), { recursive: true });
const ownerLog = join(owner, ".data", "model-calls.jsonl");

// ---- Planted faults.
const hook = (name, text) => (writeFileSync(join(work, name), text), join(work, name));
// dev/claude.ts without its 5-minute flags, in every node process of the run (the gateway's included).
const no5m = hook("no-5m.mjs", `import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const r = next(url, context);
  if (!url.endsWith("/dev/claude.ts")) return r;
  const src = String(r.source);
  const out = src.replace(/\\n\\s*FORCE_PROMPT_CACHING_5M: "1",\\n\\s*CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",/, "");
  if (out === src) throw new Error("t19 no-5m hook: the flags aren't in dev/claude.ts");
  return { ...r, source: out };
} });\n`);
// Blank captures (the shapes stay in the DOM, nothing shows) and a leak that outlives the per-case reload: 1.6 MB more per document, ~30 MB over 20 cases.
const blankLeak = hook("blank-leak.js", `addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: ".stage > svg > * { display: none }" })));
const n = Number(sessionStorage.getItem("leak") ?? 0) + 1;
sessionStorage.setItem("leak", String(n));
window.__leak = Array.from({ length: n }, () => new Array(200000).fill(0.5));\n`);
const tts = hook("tts.js", `fetch("/api/tts", { method: "POST", body: "{}" }).catch(() => {});\n`);

const NODE = [process.execPath, "--import", "./evals/loop/node-hooks.mjs", "evals/loop/ready.ts"];
const runs = [];
/** One readiness run from the clone: its exit code, its lines by check id, its ready.json. `during` runs once the header is out (after R6's snapshot). */
async function ready(args, { env = {}, during, prefix = [] } = {}) {
  const cmd = [...prefix, ...NODE, ...args];
  const child = spawn(cmd[0], cmd.slice(1), { cwd: repo, env: cleanEnv({ RT_EVAL_HOME: home, RT_DATA_DIR: join(home, "data"), ...env }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let started = false;
  child.stdout.on("data", (d) => {
    out += d;
    if (!started && /^ready ready-\S+:/m.test(out)) (started = true), during?.();
  });
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  const run = /^ready (ready-\S+):/m.exec(out)?.[1];
  const file = run && join(home, "ready", run, "ready.json");
  const json = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const lines = Object.fromEntries(out.split("\n").map((l) => /^(R\d+)\s+(ok|FAIL|skip)\s+(.*)$/.exec(l)).filter(Boolean).map(([, id, st, rest]) => [id, { st, rest }]));
  const r = { args: args.join(" "), code, out, lines, json };
  runs.push(r);
  return r;
}
const show = (r) => r.out.trim().split("\n").slice(-4).join(" | ");
// R7 refuses a busy machine (load1/cores, PSI cpu avg10): before a run that samples it, let this check's own load and other users' settle.
const { quiet, sampleLoad } = await import("../loop/load.ts");
async function settle() {
  for (let i = 0; i < 60 && !quiet(sampleLoad()); i++) await sleep(1000);
}

// ---- R7 first (the runs below load the machine): a factory-slice cgroup fails; the inhibitor is checked only when launched.
await settle();
const slice = `rtcheck${process.pid}`;
const r7f = await ready(["--only", "R7"], { prefix: ["systemd-run", "--user", "--scope", "-q", `--slice=${slice}-emberhub-factory.slice`] });
execFileSync("systemctl", ["--user", "stop", `${slice}.slice`]);
check(r7f.lines.R7?.st === "FAIL" && /emberhub-factory\.slice/.test(r7f.lines.R7.rest), `a fake factory-slice cgroup didn't fail R7: ${show(r7f)}`);
const r7l = await ready(["--only", "R7"], { env: { RT_EVAL_LAUNCHED: "1" } });
if (arch() === "arm64") check(/tmux launch/.test(r7l.lines.R7?.rest), `R7 on aarch64: ${show(r7l)}`);
else {
  check(r7l.lines.R7?.st === "FAIL" && /no 'rt eval' sleep inhibitor/.test(r7l.lines.R7.rest), `launched with no inhibitor held didn't fail R7: ${show(r7l)}`);
  const inhibitor = spawn("systemd-inhibit", ["--what=sleep:idle:handle-lid-switch", "--why=rt eval", "sleep", "30"], { stdio: "ignore", detached: true });
  for (let i = 0; i < 30 && !execFileSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" }).includes("rt eval"); i++) await sleep(100);
  const r7h = await ready(["--only", "R7"], { env: { RT_EVAL_LAUNCHED: "1" } });
  process.kill(-inhibitor.pid, "SIGTERM");
  check(r7h.lines.R7?.st === "ok" && /inhibitor held/.test(r7h.lines.R7.rest), `launched with the inhibitor held, R7: ${show(r7h)}`);
}

// ---- A clean build: every check passes (R8 skipped: no bank, no callback); the owner's server writes an untagged line meanwhile.
await settle();
const clean = await ready(["--stub", "--mock-api", "--repo", owner], { during: () => appendFileSync(ownerLog, `${JSON.stringify({ at: new Date().toISOString(), from: "draw", user: "make the header blue", ms: 900 })}\n`) });
const ids = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13"];
check(clean.code === 0 && ids.every((id) => clean.lines[id]), `a clean build: exit ${clean.code}: ${show(clean)}`);
check(ids.filter((id) => id !== "R8").every((id) => clean.lines[id]?.st === "ok") && clean.lines.R8?.st === "skip", `not every check passed on a clean build: ${Object.entries(clean.lines).filter(([, l]) => l.st !== "ok").map(([id, l]) => `${id} ${l.st} ${l.rest}`).join(" | ")}`);
check(/1 lines written/.test(clean.lines.R6?.rest), `R6 didn't see the owner's untagged line: ${clean.lines.R6?.rest}`);
check(/not launched, inhibitor not checked/.test(clean.lines.R7?.rest), `a bare run's R7 doesn't say the inhibitor went unchecked: ${clean.lines.R7?.rest}`);
check(clean.json?.pages?.A?.stubbed > 40 && clean.json.pages.A.seen === clean.json.pages.A.stubbed, `the pages' requests: ${JSON.stringify(clean.json?.pages)}`);

// ---- The transport without its 5-minute flags fails R3 (and R12: 1-hour writes on the meter).
const r3 = await ready(["--mock-api", "--only", "R3,R11,R12"], { env: { NODE_OPTIONS: `--import ${no5m}` } });
check(r3.code === 1 && r3.lines.R3?.st === "FAIL" && /1h|FORCE_PROMPT_CACHING_5M/.test(r3.lines.R3.rest), `removing the 5-minute flags didn't fail R3: ${show(r3)}`);
check(r3.lines.R12?.st === "FAIL", `1-hour cache writes didn't fail R12: ${r3.lines.R12?.rest}`);

// ---- Blank captures and a leaking page fail R4; a line with a harness tag in the owner's .data fails R6.
const r4 = await ready(["--stub", "--only", "R4,R6", "--page-hook", blankLeak, "--repo", owner], { during: () => appendFileSync(ownerLog, `${JSON.stringify({ at: new Date().toISOString(), from: "draw", tag: "eval-harness-1" })}\n`) });
check(r4.lines.R4?.st === "FAIL" && /capture blank/.test(r4.lines.R4.rest), `a blank-capture hook didn't fail R4: ${r4.lines.R4?.rest ?? show(r4)}`);
const grew = [...(r4.lines.R4?.rest ?? "").matchAll(/heap grew ([\d.]+) MB/g)].map((m) => Number(m[1]));
check(grew.length === 2 && grew.every((mb) => mb > 20 && mb < 40), `a page leaking ~30 MB over 20 cases didn't fail R4's heap check: ${r4.lines.R4?.rest}`);
check(r4.lines.R6?.st === "FAIL" && /harness tag/.test(r4.lines.R6.rest), `a harness-tagged line in the repo's .data didn't fail R6: ${r4.lines.R6?.rest ?? show(r4)}`);

// ---- A page asking for /api/tts fails R5 (chrome.ts fails the request inside Chrome).
const r5 = await ready(["--stub", "--only", "R5", "--page-hook", tts]);
check(r5.code === 1 && r5.lines.R5?.st === "FAIL" && /requested \/api\/tts/.test(r5.lines.R5.rest), `an extra /api/tts request didn't fail R5: ${show(r5)}`);

// ---- R13: a banked case resolves only when its reply files and image blobs are in this machine's cache.
const sha = (n) => String(n).repeat(64).slice(0, 64);
const bankCase = (id, reqHash) => {
  const dir = join(home, "bank", "cases", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "replies.json"), JSON.stringify([{ role: "draw", ordinal: 0, reqHash, cacheFile: `${reqHash}.json`, offsets: [3, 9] }]));
  writeFileSync(join(dir, "done"), "");
};
const reply = (reqHash, images) => {
  mkdirSync(join(home, "cache", "replies"), { recursive: true });
  writeFileSync(join(home, "cache", "replies", `${reqHash}.json`), JSON.stringify({ reqHash, run: "bank-1", role: "draw", request: { model: "claude-sonnet-5-5", system: "s", user: "u", images, effort: "low", thinking: "auto" }, text: "x", chunks: [], doneMs: 1, stats: {} }));
};
mkdirSync(join(home, "cache", "blobs"), { recursive: true });
writeFileSync(join(home, "cache", "blobs", `${sha("b")}.jpg`), "jpeg");
bankCase("c-t19-s1-1", sha(1));
reply(sha(1), [sha("b")]);
const r13ok = await ready(["--only", "R8,R13"]);
check(r13ok.code === 0 && r13ok.lines.R13?.st === "ok" && r13ok.lines.R8?.st === "skip", `a bank that resolves: ${show(r13ok)}`);
bankCase("c-t19-s1-2", sha(2));
const r13reply = await ready(["--only", "R13"]);
check(r13reply.lines.R13?.st === "FAIL" && /c-t19-s1-2: reply .* isn't in cache\/replies/.test(r13reply.lines.R13.rest), `a banked case whose reply file is missing didn't fail R13: ${show(r13reply)}`);
reply(sha(2), [sha(1)]); // its reply is there now, but its image isn't
const r13blob = await ready(["--only", "R13"]);
check(r13blob.lines.R13?.st === "FAIL" && /c-t19-s1-2: image .* isn't in cache\/blobs/.test(r13blob.lines.R13.rest) && !/cache\/replies/.test(r13blob.lines.R13.rest), `a banked case whose image blob is missing didn't fail R13: ${show(r13blob)}`);

// ---- R8 runs the injected A/A once a bank exists (in process: run.ts's wiring).
const { ready: readyIn } = await import("../loop/ready.ts");
const [r8] = await readyIn({ only: ["R8"], repo: owner, aaCheck: async () => ({ ok: false, detail: "canned A/A: ratio 1.07" }) }, () => {});
check(r8?.id === "R8" && !r8.ok && r8.detail === "canned A/A: ratio 1.07", `R8 didn't report the injected A/A: ${JSON.stringify(r8)}`);

// ---- 0 real calls in every case: every fake-API request was one of the gateway's attempts; the real meter was never written.
for (const r of runs.filter((x) => x.json?.calls)) check(r.json.calls.fakeApiRequests === r.json.calls.attempts && r.json.calls.attempts > 0, `run "${r.args}": ${JSON.stringify(r.json.calls)}`);
check(runs.filter((x) => x.json?.calls).length === 2, "the transport didn't run twice (clean, no-5m)");
check(!existsSync(join(home, "meter", "calls.jsonl")), "a readiness run wrote the loop's own meter");
check(runs.every((r) => r.json), `a run wrote no ready.json: ${runs.filter((r) => !r.json).map((r) => r.args).join(" | ")}`);
await sleep(500);
let left = "";
try {
  left = execFileSync("pgrep", ["-af", "--", home], { encoding: "utf8" }).trim();
} catch {} // none left
check(!left, `processes left behind: ${left.slice(0, 300)}`);
if (!runs.length) fail("no readiness run");
finish();
