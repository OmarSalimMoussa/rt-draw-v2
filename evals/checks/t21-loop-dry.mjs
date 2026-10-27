// T21's acceptance check: the coordinator end to end on t15's fake bank (doubled to 32 tuning cases), 0 real
// model calls. run.ts runs as its own process with fake tokens, every Claude process on the in-process fake API,
// and a canned critic, engineer and judge (--fakes). A dry loop of two epochs decides a knob card (kept), a code
// patch (reverted, its patch saved) and a no-op (reverted at 0 calls), then a frozen-path card (owner list); a
// second loop is refused by the lock; a SIGKILL mid-case and `loop --resume` re-pay nothing, after pausing until
// the slots' resetsAt. The owner's stop-after stops a running loop between steps, with a notice. Then sync (an owner step, a conflict, a scene-format change), export to a fake host, the
// --cap refusals, `launch.sh status` in a real systemd unit, and every §6.7 rule on crafted facts. Ports 5330–5339.
//   TMPDIR=<work dir> node --import ./evals/loop/node-hooks.mjs evals/checks/t21-loop-dry.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { arch, cpus, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromeCount } from "./cdp.mjs";
import { ROOT, check, cleanEnv, fail, finish } from "./lib.mjs";
import { fakeLoop } from "./t15-ab.mjs";

const env = cleanEnv(); // no token, key or Claude session variable, for this process and every child
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);

const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ID = ["-c", "user.name=rt-check", "-c", "user.email=check@localhost"];
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
// A JSONL file being appended to can end mid-line: that line isn't written yet.
const lines = (f) => {
  const t = existsSync(f) ? readFileSync(f, "utf8") : "";
  return t.slice(0, t.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => s.trim().split("\n").slice(-6).join(" | ").slice(0, 900);
const HOOKS = join(ROOT, "evals/loop/node-hooks.mjs"), RUN = join(ROOT, "evals/loop/run.ts");
const upstream = (ls) => ls.filter((l) => !l.agent && l.mode === "live" && l.shared !== "follower");
/** The fake API requests meter lines account for: each upstream call, and each turn of an agent session (the analyst). */
const requestsOf = (ls) => upstream(ls).length + ls.filter((l) => l.agent).reduce((n, l) => n + l.turns, 0);

/** run.ts in its own process group (a SIGKILL takes its gateway, arm servers and Chrome with it). */
const groups = new Set();
process.on("exit", () => groups.forEach((g) => { try { process.kill(-g, "SIGKILL"); } catch {} }));
function rte(args, o = {}) {
  const child = spawn(process.execPath, ["--import", HOOKS, RUN, ...args], { cwd: ROOT, env: o.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  groups.add(child.pid);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, o.timeoutMs ?? 900_000);
  const done = new Promise((r) => child.on("exit", (code, signal) => (clearTimeout(timer), groups.delete(child.pid), r({ code: code ?? signal, out }))));
  return { child, out: () => out, done };
}
async function until(f, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = f();
    if (v) return v;
  }
  fail(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}
const gone = (pid) => { try { process.kill(-pid, 0); return false; } catch { return true; } };

// ---- The fake loop home: t15's bank with 32 tuning cases (a keep needs look 32), the champion, the owner's repo.
const L = await fakeLoop({ port: 5330 });
const { p, repo, api } = L;
renameSync(p.bankCase(L.stray), `${p.bankCase(L.stray)}.void`);
for (const id of L.tuning) {
  const to = id.replace(/^c-t-/, "c-u-");
  cpSync(p.bankCase(id), p.bankCase(to), { recursive: true });
  const c = json(join(p.bankCase(to), "case.json"));
  writeFileSync(join(p.bankCase(to), "case.json"), JSON.stringify({ ...c, id: to, originSession: c.originSession.replace(/^t-/, "u-") }));
}
await L.rig.close();
await L.gw.close(); // run.ts starts its own; the fake API stays
writeFileSync(p.machine, JSON.stringify({ host: hostname(), arch: arch(), cores: cpus().length, at: new Date().toISOString(), slots: 2, dispatchLimitMs: 25, steps: [] }));
git("-C", repo, "branch", "loop/champion", "HEAD");
git("-C", repo, "branch", "-f", "master", "HEAD"); // -f: a checkout on master hands its clone a master already (HEAD is detached)
const owner = join(L.home, "owner");
git("clone", "-q", "--branch", "master", repo, owner);
execFileSync("cp", ["-al", join(ROOT, "node_modules"), join(owner, "node_modules")]);
git("-C", repo, "remote", "set-url", "origin", owner);
const ownerCommit = (file, edit, msg) => {
  const f = join(owner, file);
  writeFileSync(f, edit(readFileSync(f, "utf8")));
  git("-C", owner, "add", "-A");
  git("-C", owner, ...ID, "commit", "-qm", msg);
  return git("-C", owner, "rev-parse", "HEAD");
};
const C = await import("../loop/checkpoint.ts");
const { harnessTag } = await import("../loop/ab.ts");
const { notices, rules, RULES } = await import("../loop/state.ts");
// B1 from toy-shop cases only (blank ones held back), so the scene-format sync below leaves the yardstick loadable.
const blank = (id) => json(join(p.bankCase(id), "case.json")).start === "blank";
const held = readdirSync(p.bankCases).filter((id) => !id.includes(".void") && blank(id));
for (const id of held) renameSync(join(p.bankCase(id), "done"), join(p.bankCase(id), "done.held"));
C.freeze({ heldout: 2, tuning: 2, seed: "t21" });
for (const id of held) renameSync(join(p.bankCase(id), "done.held"), join(p.bankCase(id), "done"));
const readyDir = join(L.home, "ready", "ready-2026-10-16T00-00-00-000Z");
mkdirSync(readyDir, { recursive: true });
writeFileSync(join(readyDir, "ready.json"), JSON.stringify({ run: "ready-check", at: new Date().toISOString(), harnessTag: harnessTag(), results: [{ id: "R1", ok: true }] }));

// The canned optimizer: epoch 1 a knob card, a code patch (the resolver's prompt: every case's requests differ) and a no-op; epoch 2 a card that edits a frozen file.
const FAKES = join(L.work, "fakes.mjs");
const mod = (f) => JSON.stringify(pathToFileURL(join(ROOT, f)).href);
writeFileSync(FAKES, `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { worktreeOf } = await import(${mod("evals/loop/trees.ts")});
const { caseDir, put } = await import(${mod("evals/loop/record.ts")});
const card = (id, o) => ({ id, component: "draw", kind: "code", change: id, goal: "fidelity", classGuess: "Q", dialogue: false, isPatch: false, touchesFrozen: false, risk: "r", files: [], ...o });
const CARDS = {
  1: [card("knob", { kind: "knob", knobs: { "draw.sendMarks": 0 }, change: "draw.sendMarks = 0" }), card("points", { component: "resolve", change: "the resolver asks what ink points at" }), card("noop", { change: "a comment in draw.ts" })],
  2: [card("frozen", { change: "a vite.config.ts comment" })],
};
export const critic = async ({ run }) => ({ cards: CARDS[/-e(\\d+)-critic$/.exec(run)[1]] ?? [], dropped: [], result: {} });
const EDITS = { points: ["src/core/prompts.ts", (s) => s.replace("which shapes on a canvas a person means.", "which shapes on a canvas a person points at.")], noop: ["src/core/draw.ts", (s) => s + "\\n// rt-check: a comment that changes nothing\\n"], frozen: ["vite.config.ts", (s) => s + "\\n// rt-check\\n"] };
export async function engineer({ card, branch }) {
  const wt = worktreeOf(branch);
  const [f, edit] = EDITS[card.id];
  writeFileSync(join(wt, f), edit(readFileSync(join(wt, f), "utf8")));
  return { text: "", stop: "done", turns: 1, minutes: 0, usd: 0, denied: [], wt };
}
/** The knob card's arm wins every case, the patch's loses every case. */
export const judge = (run, card) => ({
  async judgeCase(id, positions) {
    const winner = card.id === "knob" ? "B" : "A";
    put(join(caseDir(run, id), "judge", "fidelity-1.json"), { winner: positions.left === winner ? "left" : "right", confidence: 3, why: "canned", positions, judgeId: "canned" });
  },
  flips: () => ({ audited: 0, flipped: 0 }),
});
`);
const tokens = join(L.work, "tokens.env");
const FLAGS = ["--tokens", tokens, "--mock-api", api.url, "--port", "5334", "--fakes", FAKES];

// ---- Real-call steps refuse to start without --cap.
for (const cmd of [["smoke"], ["bake"], ["bank", "build", "--tuning", "1"], ["checkpoint", "--zero"], ["calib", "--contrast", "draw.sendMarks=0"], ["calib", "--illustrations", "--contrast", "picture.model=0"]]) {
  const r = spawnSync(process.execPath, ["--import", HOOKS, RUN, ...cmd, ...FLAGS], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 60_000 });
  check(r.status !== 0 && /needs --cap/.test(r.stdout + r.stderr), `${cmd.join(" ")} without --cap: exit ${r.status}: ${short(r.stdout + r.stderr)}`);
}
check(api.requests.length === L.bootReqs, `the --cap refusals made ${api.requests.length - L.bootReqs} requests`);

// ---- Checkpoint 0, then the loop.
const ck0 = await rte(["checkpoint", "--zero", "--cap", "400", ...FLAGS]).done;
if (!lines(join(p.history, "checkpoints.jsonl")).some((c) => c.id === "ck-00")) fail(`checkpoint --zero wrote no ck-00 (exit ${ck0.code}): ${short(ck0.out)}`);
const first = rte(["loop", "--epochs", "2", ...FLAGS]);
await until(() => first.out().includes("loop: starting") || first.child.exitCode !== null, 120_000, "the loop to start");
const second = await rte(["loop", "--epochs", "1", ...FLAGS]).done;
check(second.code !== 0 && /another loop holds/.test(second.out), `a second loop wasn't refused by the lock (exit ${second.code}): ${short(second.out)}`);

// SIGKILL while a case of the knob card's A/B has paid calls but isn't done.
const midCase = () => upstream(lines(p.calls)).find((l) => /-e1-h1-ab$/.test(l.run) && l.case && !existsSync(join(p.run(l.run), "cases", l.case, "done")));
const hit = await until(() => midCase() ?? (first.child.exitCode !== null && "exited"), 900_000, () => `a paid call in the knob card's A/B: ${first.out().trim().split("\n").slice(-25).join(" | ").slice(-3000)}`);
if (hit === "exited") fail(`the loop ended before the knob card's A/B: ${short(first.out())}`);
process.kill(-first.child.pid, "SIGKILL");
await until(() => gone(first.child.pid), 20_000, "the killed loop's process group to end");
await until(() => chromeCount(join(p.home, "chrome")) === 0, 20_000, "the killed loop's Chrome to exit");
const killAt = Date.now(), reqsAtKill = api.requests.length, meterAtKill = lines(p.calls).length;
check(!existsSync(join(p.run(hit.run), "cases", hit.case, "done")), `case ${hit.case} finished before the kill (not mid-case)`);

// Every slot past its five-hour pause line (90%): the resumed loop pauses until the earliest resetsAt.
const now = Math.floor(Date.now() / 1000);
writeFileSync(join(p.home, "meter", "slots.json"), JSON.stringify([1, 2, 3].map((slot) => ({ slot, status: "allowed", fiveHour: 0.95, sevenDay: 0.1, resetsAt: now + 6 + slot, windowStart: (now + 6 + slot) * 1000 - 5 * 3600_000, usdWindow: 1, limited: false, hours: {} }))));
const resumed = await rte(["loop", "--resume", ...FLAGS]).done;
check(resumed.code === 0 && /loop: done/.test(resumed.out), `loop --resume didn't finish (exit ${resumed.code}): ${short(resumed.out)}`);
check(/pause until .*every slot is past 90% of its five-hour window/.test(resumed.out), "the resumed loop didn't pause for the spent slots");
const after = api.requests.slice(reqsAtKill);
check(after.length > 0 && after[0].at >= (now + 7) * 1000, `the first call after the resume came at ${after[0]?.at}, before the earliest resetsAt ${(now + 7) * 1000}`);
const all = lines(p.calls);
const key = (l) => `${l.run}|${l.case}|${l.arm}|${l.role}|${l.reqHash}`;
const paidBefore = new Set(upstream(all.slice(0, meterAtKill)).map(key));
const repaid = upstream(all.slice(meterAtKill)).filter((l) => paidBefore.has(key(l)));
check(!repaid.length, `${repaid.length} calls paid before the kill were paid again: ${repaid.slice(0, 3).map(key).join(", ")}`);
check(after.length === requestsOf(all.slice(meterAtKill)), `after the kill the fake API got ${after.length} requests for ${requestsOf(all.slice(meterAtKill))} metered`);

// ---- What the two epochs decided, all on eval/history.
const H = p.history;
const dec = Object.fromEntries(lines(join(H, "decisions.jsonl")).map((d) => [d.id, d]));
const say = (d) => (d ? `${d.verdict} (${d.class}): ${d.reasons.join("; ")}` : "none");
check(dec["e1-h1"]?.verdict === "keep" && dec["e1-h1"].class === "Q", `the knob card: ${say(dec["e1-h1"])}`);
// A resolver card is class D (08aed14: what a later send's words point at moves, so the continuation sends run).
check(dec["e1-h2"]?.verdict === "revert" && dec["e1-h2"].class === "D", `the code patch: ${say(dec["e1-h2"])}`);
check(dec["e1-h3"]?.verdict === "revert" && dec["e1-h3"].class === "N" && /no effect/.test(dec["e1-h3"].reasons.join()), `the no-op: ${say(dec["e1-h3"])}`);
const noopCalls = upstream(all).filter((l) => /-e1-h3-/.test(l.run)).length;
check(noopCalls === 0, `the no-op's decision made ${noopCalls} calls`);
check(dec["e2-h1"]?.verdict === "owner" && /frozen path vite\.config\.ts/.test(dec["e2-h1"].reasons.join()), `the frozen-path card: ${say(dec["e2-h1"])}`);
const tried = join(H, "tried", "e1-h2.patch");
check(existsSync(tried) && readFileSync(tried, "utf8").includes("a person points at."), "the reverted patch wasn't saved in tried/");
const ownerList = existsSync(join(H, "owner-list.md")) ? readFileSync(join(H, "owner-list.md"), "utf8") : "";
check(/e2-h1: frozen path vite\.config\.ts/.test(ownerList), "the frozen-path card isn't on the owner list");
check(git("-C", repo, "rev-parse", "loop/champion") === dec["e1-h1"]?.candSha && git("-C", repo, "show", "loop/champion:src/core/tuning.ts").includes('B("draw.sendMarks", 0,'), "loop/champion isn't the kept knob commit");
const cks = lines(join(H, "checkpoints.jsonl")).map((c) => c.id);
check(cks.join() === "ck-00,ck-01", `checkpoints after the loop: ${cks.join(", ")} (want ck-00 and the end-of-loop ck-01)`);
check(lines(join(H, "epochs.jsonl")).map((e) => e.epoch).join() === "1,2" && lines(join(H, "budget.jsonl")).length === 6, "epochs.jsonl or budget.jsonl isn't one row per epoch (per slot)");
check(!git("-C", H, "status", "--porcelain"), "the history worktree has uncommitted files");

// ---- The owner's stop-after: asked while no loop runs, the next start drops it; asked while one runs, it stops before its
// next step, says so, leaves a "stopped" notice and spends nothing more; the epoch and the lock are as they were.
const noticesOf = () => lines(join(p.home, "notices.jsonl"));
const asked = await rte(["stop-after", ...FLAGS]).done;
check(asked.code === 0 && /no loop is running/.test(asked.out) && existsSync(join(p.home, "stop.request")), `stop-after with no loop: ${short(asked.out)}`);
const r0 = api.requests.length, n0 = noticesOf().length;
const running = rte(["loop", "--epochs", "1", ...FLAGS]);
await until(() => running.out().includes("loop: starting") || running.child.exitCode !== null, 120_000, "the loop to start");
check(/an old stop-after request was dropped/.test(running.out()), "the start didn't drop the old stop-after request");
writeFileSync(join(p.home, "stop.request"), "{}"); // what stop-after writes, the moment the loop is up
const stopped = await running.done;
const last = noticesOf().slice(n0).at(-1);
check(stopped.code === 0 && /STOP: as the owner asked \(rte stop-after\)/.test(stopped.out) && !/loop: done/.test(stopped.out) && !existsSync(join(p.home, "stop.request")) && !existsSync(p.lock),
  `stop-after didn't stop the running loop between steps (exit ${stopped.code}): ${short(stopped.out)}`);
check(last?.kind === "stopped" && /as asked/.test(last.why) && last.epoch === 3 && json(p.state).epoch === 3 && api.requests.length === r0, `the stop's notice: ${JSON.stringify(last)?.slice(0, 300)}, ${api.requests.length - r0} requests`);
const bad = await rte(["loop", "--resume", ...FLAGS, "--notify-usd", "-1"]).done;
check(bad.code !== 0 && /--notify-usd takes a number/.test(bad.out), `--notify-usd -1 wasn't refused: ${short(bad.out)}`);

// ---- week: a token parked for its week on a 27-hour-old reading gets one one-word call; one parked on a fresh reading
// gets none. The server's answer brings the first back, and every slot goes to budget.jsonl with when it was read.
const slotsFile = join(p.home, "meter", "slots.json"), slotsBefore = readFileSync(slotsFile, "utf8");
const wNow = Date.now(), oldRead = wNow - 27 * 3600_000;
const slot = (n, o) => ({ slot: n, status: "allowed", usdWindow: 0, limited: false, hours: {}, ...o });
writeFileSync(slotsFile, JSON.stringify([slot(1, { sevenDay: 0.1, sevenDayAt: wNow }), slot(2, { sevenDay: 0.94, sevenDayAt: oldRead }), slot(3, { sevenDay: 0.6, sevenDayAt: wNow - 3600_000 })]));
const w0 = api.requests.length;
const wk = await rte(["week", "--cap", "5", ...FLAGS]).done;
check(wk.code === 0 && /token 2's week read again: 94% to 11% of its weekly limit \(the loop stops at 50%\); back in use/.test(wk.out) && api.requests.length === w0 + 1,
  `week (exit ${wk.code}, ${api.requests.length - w0} requests): ${short(wk.out)}`);
const wb = lines(join(H, "budget.jsonl")).slice(-3);
check(wb.map((b) => b.slot).join() === "1,2,3" && wb[1].sevenDay === 0.11 && wb[1].sevenDayAt >= wNow && /^(ok|allowed)$/.test(wb[1].status) && wb[2].status === "weekly allowance" && wb[2].sevenDayAt === wNow - 3600_000,
  `week's budget rows: ${JSON.stringify(wb).slice(0, 500)}`);
writeFileSync(slotsFile, slotsBefore);

// ---- sync: an owner commit merges as an owner step; a conflict pauses; a scene-format change queues a refresh.
const state = () => json(p.state);
const o1 = ownerCommit("src/core/draw.ts", (s) => `${s}\n// owner: a note\n`, "owner: a note in draw.ts");
const s1 = await rte(["sync", "--cap", "300", ...FLAGS]).done;
check(s1.code === 0 && /1 owner commits merged/.test(s1.out), `sync didn't merge the owner's commit (exit ${s1.code}): ${short(s1.out)}`);
check(tryAncestor(o1, "loop/champion") && lines(join(H, "decisions.jsonl")).some((d) => d.kind === "owner-step") && lines(join(H, "markers.jsonl")).some((m) => m.kind === "owner-step") && lines(join(H, "checkpoints.jsonl")).length === 3,
  "the sync wasn't an owner step (merge, owner-step decision and marker, a checkpoint)");
const champ1 = git("-C", repo, "rev-parse", "loop/champion");
ownerCommit("src/core/tuning.ts", (s) => s.replace('B("draw.sendMarks", 1, "send marks"', 'B("draw.sendMarks", 1, "send the marks"'), "owner: rename a knob's label");
const s2 = await rte(["sync", "--cap", "300", ...FLAGS]).done;
check(s2.code !== 0 && /PAUSED/.test(s2.out) && /conflicts with the champion in src\/core\/tuning\.ts/.test(readFileSync(join(H, "owner-list.md"), "utf8")) && state().blocked
  && git("-C", repo, "rev-parse", "loop/champion") === champ1, `a conflicting master didn't pause sync with an owner item (exit ${s2.code}): ${short(s2.out)}`);
const blockedLoop = await rte(["loop", "--epochs", "1", ...FLAGS]).done;
check(/STOP: paused for the owner: sync/.test(blockedLoop.out), `the loop ran while sync was paused: ${short(blockedLoop.out)}`);
git("-C", owner, "reset", "-q", "--hard", "HEAD~1");
const live = () => readdirSync(p.bankCases).filter((d) => !d.includes(".void"));
const toyBefore = live().filter((id) => !blank(id)).sort().join();
ownerCommit("src/core/scene.ts", (s) => s.replace("    const scene = new Scene(j.width, j.height);", '    if (j.shapes.length < 2) throw new Error("a page without content isn\'t a scene this code reads");\n    const scene = new Scene(j.width, j.height);'), "owner: a scene has content");
const s3 = await rte(["sync", "--cap", "300", ...FLAGS]).done;
check(s3.code === 0 && state().refreshQueued && !state().blocked && held.length > 4 && live().sort().join() === toyBefore && /scene-format change/.test(readFileSync(join(H, "owner-list.md"), "utf8")),
  `a scene-format change didn't refuse the ${held.length} blank-page cases and queue a refresh (exit ${s3.code}, ${live().length} cases left): ${short(s3.out)}`);
function tryAncestor(a, b) {
  try {
    git("-C", repo, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
}

// ---- export to a fake host: the irreplaceable files, and eval/history as eval/history-import that init --refresh fast-forwards.
mkdirSync(join(p.home, "labels"), { recursive: true });
writeFileSync(p.labels, `${JSON.stringify({ pair: "p1", label: "A" })}\n`);
mkdirSync(p.human, { recursive: true });
writeFileSync(join(p.human, "h-x.json"), "{}");
const host = mkdtempSync(join(tmpdir(), "rt-eval-host-"));
const hostEnv = { ...process.env, RT_EVAL_HOME: host, RT_DATA_DIR: join(host, "data") };
const hi = await rte(["init", "--from", owner], { env: hostEnv }).done;
check(hi.code === 0 && existsSync(join(host, "repo", "node_modules")), `init on the host failed (exit ${hi.code}): ${short(hi.out)}`);
const ex = await rte(["export", host]).done;
const hr = await rte(["init", "--refresh"], { env: hostEnv }).done;
const srcHead = git("-C", H, "rev-parse", "HEAD");
check(ex.code === 0 && hr.code === 0 && /fast-forwarded/.test(hr.out) && git("-C", join(host, "history"), "rev-parse", "HEAD") === srcHead, `export → init --refresh didn't fast-forward the host's eval/history (exit ${ex.code}/${hr.code}): ${short(ex.out + hr.out)}`);
const copied = ["bank/cases", "cache/replies", "cache/blobs", "labels/labels.jsonl", "human/h-x.json"].filter((f) => !existsSync(join(host, f)) || (f.includes("/") && !f.includes(".") && !readdirSync(join(host, f)).length));
check(!copied.length, `export didn't copy ${copied.join(", ")}`);

// ---- launch.sh in a real systemd unit: the child reports the slots and the cap; a mode-644 tokens file is refused.
// On aarch64 launch.sh opens a tmux window and returns at once, with none of the child's output: the PGX's launcher is
// proven by its own ladder run, never by a window opened here in the owner's session.
if (process.arch === "x64") {
  const sHome = mkdtempSync(join(tmpdir(), "rt-eval-status-"));
  const sTokens = join(sHome, "tokens.env");
  copyFileSync(tokens, sTokens);
  chmodSync(sTokens, 0o600);
  const launch = () => spawnSync("bash", [join(ROOT, "evals/loop/launch.sh"), "status", "--tokens", sTokens, "--cap", "7"], { env: { ...process.env, RT_EVAL_HOME: sHome }, encoding: "utf8", timeout: 60_000 });
  const l1 = launch();
  check(l1.status === 0 && /slots loaded: 3/.test(l1.stdout) && /cap: 7/.test(l1.stdout) && /launched: yes/.test(l1.stdout) && /inhibitor: held/.test(l1.stdout) && !l1.stdout.includes("sk-ant"),
    `launch.sh status: exit ${l1.status}: ${short(l1.stdout + l1.stderr)}`);
  chmodSync(sTokens, 0o644);
  const l2 = launch();
  check(l2.status !== 0 && /chmod 600/.test(l2.stdout + l2.stderr), `a mode-644 tokens file wasn't refused: exit ${l2.status}: ${short(l2.stdout + l2.stderr)}`);
} else console.log(`note: launch.sh status is checked on the laptop (this is ${process.arch})`);

// ---- Every §6.7 rule on crafted facts.
const T = Date.now();
const base = { now: T, pace: { ok: true }, recent: [], ready: true, calib: "pass", overloads: [], diskGb: 500, onAC: true };
const d = (verdict, o = {}) => ({ id: "x", verdict, component: "draw", at: new Date(T).toISOString(), ...o });
const fires = {
  "slots spent → pause": [{ pace: { ok: false, pauseUntil: T + 5000 } }, "pause", /five-hour/],
  "weekly allowance → stop": [{ pace: { ok: false, stop: "every slot past its weekly allowance" } }, "stop", /weekly/],
  "2 voids in a row → stop": [{ recent: [d("keep"), d("void"), d("void")] }, "stop", /2 void/],
  "V9 → stop": [{ recent: [d("void", { v9: true })] }, "stop", /V9/],
  "readiness → stop": [{ ready: false }, "stop", /readiness/],
  "calibration → stop": [{ calib: "stop" }, "stop", /calibration/],
  "no passed calibration → stop": [{ calib: "more" }, "stop", /isn't calibrated/],
  "never calibrated → stop": [{ calib: undefined }, "stop", /never checked/],
  "--cap reached → stop": [{ capped: true, error: "the call cap is reached" }, "stop", /--cap/],
  "a sync conflict → stop for the owner": [{ blocked: "sync: master conflicts" }, "stop", /paused for the owner/],
  "/api/tts → abort": [{ error: "run x aborted: a page requested http://127.0.0.1:5334/api/tts" }, "stop", /aborted/],
  // The dry well scales with the cards an epoch (LOOP-V2.md D3): 2 epochs' worth in a row, one epoch's on a component.
  [`${RULES.revertsInRow} reverts → owner`]: [{ recent: Array.from({ length: RULES.revertsInRow }, (_, i) => d("revert", { component: "abc"[i % 3] })) }, "owner", new RegExp(`dry well: ${RULES.revertsInRow}`)],
  [`${RULES.componentRevertsInRow} reverts on one component → skip it`]: [{ recent: [d("revert"), d("keep", { component: "picture" }), ...Array.from({ length: RULES.componentRevertsInRow - 1 }, () => d("revert"))] }, "skip", new RegExp(`${RULES.componentRevertsInRow} reverts in a row on draw`)],
  "a sweep's values are one try": [{ recent: Array.from({ length: RULES.revertsInRow + 3 }, (_, i) => d("revert", { component: "abc"[i % 3], ...(i < 4 ? { sweep: "e1-h1" } : {}) })) }, "owner", new RegExp(`dry well: ${RULES.revertsInRow}`)],
  "3 overloads in 10 min → pause": [{ overloads: [T - 1000, T - 2000, T - 3000] }, "pause", /overloaded/],
  "disk < 20 GB → owner": [{ diskGb: 15, daysLeft: 3 }, "owner", /days left/],
  "disk < 10 GB → pause": [{ diskGb: 5 }, "pause", /free disk/],
  "battery → pause": [{ onAC: false }, "pause", /battery/],
};

// ---- The owner's notices on crafted facts: a heads-up as a step comes near, one when it's reached, each once, never a stop.
const every = { decisions: 2, minutes: 120, usd: 20, checkpoint: 1, soon: 0.8 };
const nf = (o = {}) => ({ now: T, every, ...o, leg: { start: T - 60_000, usd: 0, decisions: 0, checkpoints: [], ...o.leg } });
const due = (f, sent = new Set()) => notices(f, sent).map((n) => `${n.kind} ${n.key}`).join();
const want = {
  quiet: [nf(), ""], "$16.50 → soon": [nf({ leg: { usd: 16.5 } }), "soon usd:1:soon"], "$20.20 → reached": [nf({ leg: { usd: 20.2 } }), "reached usd:1"],
  "$37 → reached, the next soon": [nf({ leg: { usd: 37 } }), "reached usd:1,soon usd:2:soon"], "97 min → soon": [nf({ leg: { start: T - 97 * 60_000 } }), "soon minutes:1:soon"],
  "1 decision → none": [nf({ leg: { decisions: 1 } }), ""], "2 decisions → reached": [nf({ leg: { decisions: 2 } }), "reached decisions:1"],
  "a checkpoint → one": [nf({ leg: { checkpoints: ["ck-01"] } }), "checkpoint checkpoint:ck-01"], "a checkpoint, notices off → none": [nf({ every: { ...every, checkpoint: 0 }, leg: { checkpoints: ["ck-01"] } }), ""],
  "everything off → none": [nf({ every: { decisions: 0, minutes: 0, usd: 0, checkpoint: 0, soon: 0 }, leg: { usd: 999, decisions: 9, checkpoints: ["ck-01"], start: T - 999 * 60_000 } }), ""],
};
for (const [name, [f, keys]] of Object.entries(want)) check(due(f) === keys, `notices, ${name}: ${due(f)} (want ${keys || "none"})`);
check(due(nf({ leg: { usd: 37 } }), new Set(["usd:1", "usd:2:soon"])) === "", "a notice already sent was sent again");
check(notices(nf({ leg: { usd: 37 } }), new Set()).every((n) => !/stop/.test(n.kind)), "a notice is a stop");
check(!rules(base).length, `rules fire on quiet facts: ${JSON.stringify(rules(base))}`);
for (const [name, [facts, act, why]] of Object.entries(fires)) {
  const out = rules({ ...base, ...facts });
  check(out.some((a) => a.do === act && why.test(a.why) && (act !== "pause" || a.until > T) && (act !== "skip" || a.component === "draw")), `${name}: ${JSON.stringify(out)}`);
}
check(rules({ ...base, overloads: [T - RULES.overloadWindowMs - 1, T - 1000, T - 2000] }).every((a) => a.do !== "pause"), "an overload older than 10 min counted");
// A pause that ran out (RULES.pauseEpochs epochs on) counts the component's reverts again from then, not from the checkpoint.
const reverts = Array.from({ length: RULES.componentRevertsInRow }, () => d("revert"));
check(rules({ ...base, recent: reverts }).some((a) => a.do === "skip") && !rules({ ...base, recent: reverts, wellFrom: { draw: T + 1 } }).some((a) => a.do === "skip"), "a dry well counts reverts from before its pause ran out");
const voided = [d("void", { at: new Date(T - 60_000).toISOString() }), d("void", { at: new Date(T - 50_000).toISOString() })];
check(rules({ ...base, recent: voided, ownerStepAt: T - 40_000 }).every((a) => !/void/.test(a.why)), "2 voids before the owner's sync still stop the loop");
check(rules({ ...base, recent: [...voided, d("void")], ownerStepAt: T - 40_000 }).every((a) => !/void/.test(a.why)), "one void after the owner's sync stops the loop");

// ---- No leak: every fake API request is a metered upstream call or agent turn (but the ones the SIGKILL cut off), no Chrome left.
const total = requestsOf(lines(p.calls)), cut = reqsAtKill - requestsOf(all.slice(0, meterAtKill));
check(api.requests.length === total + cut && cut <= 4, `the fake API got ${api.requests.length} requests for ${total} metered and ${cut} cut off by the kill`);
await api.close();
check(chromeCount(join(p.home, "chrome")) === 0, "Chrome processes are left");
console.error(`t21: ${total} fake calls, ${cut} cut off by the kill; decisions ${Object.values(dec).map((x) => `${x.id} ${x.verdict}`).join(", ")}; killed in ${hit.case} at ${new Date(killAt).toISOString()}`);
finish();
