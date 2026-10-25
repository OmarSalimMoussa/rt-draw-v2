// The loop's CLI and its coordinator (spec §7.1, §7.7, §8.1, §11): a script, never an LLM session (v1's Opus
// coordinator re-read ~375k tokens a request, ~$72). Every step that can call a model goes through one gateway
// process under a hard --cap, so a loop or retry bug stops at the cap instead of burning a window (v1 burned two
// in a day). Tokens come only from the tokens file, read here (agents) and by the gateway, never from the
// environment: a systemd unit doesn't see the caller's variables.
//   node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts <command> [flags]      (`rte`, evals/RUNBOOK.md)
// Every command takes --cap n, --tokens <file> (checks; default ~/.config/rt-eval/tokens.env), --dev-token (the
// dev plugin's own token, only under --cap 60), --mock-api <url> (every Claude process on that fake API, checks),
// --port n (the first arm server's, default 5300) and --fakes <module> (checks: a canned critic, engineer, judge).
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { View } from "../../src/core/board.ts";
import { changeFrame, hidden } from "../core/diff.ts";
import { HitIndex } from "../../src/core/hittest.ts";
import { promptOf } from "../../src/core/prompts.ts";
import { plan, prompt } from "../../src/core/resolve.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";
import { TUNING } from "../core/scenarios.ts";
import { loadFixture } from "../fixtures/fixtures.ts";
import { assemble, checkCalibration, topUpContrast } from "../judge/calibrate.ts";
import { canaryDue, runCanary } from "../judge/canary.ts";
import { calibrationFile, combined, judgeId, judging, lastServed, positionsFor, variants } from "../judge/judge.ts";
import { caseFile, framed, readPacket } from "../judge/packet.ts";
import { writeDry } from "../mock/dry.ts";
import { startFakeApi } from "../mock/fake-api.ts";
import type { Label, PairRef } from "../pages/plugin.ts";
import * as agents from "../optimizer/agents.ts";
import { analystDigest, failureDigest, writeLossDigest, writeMissDigest } from "../optimizer/digest.ts";
import { bankedScenes, cardOwnerReasons, diffOf, g0, sceneRoundTrip, typecheck } from "../optimizer/gates.ts";
import { type ABResult, type ArmSpec, type Arms, type Judge, type Rig, benchCases, harnessTag, judgedOnce, openRig, product, runAB } from "./ab.ts";
import { bake } from "./bake.ts";
import { type BankSet, acceptBank, bankRefuses, buildBank, nextTopUp, refresh, topUp } from "./bank.ts";
import { type StoredCheckpoint, checkpoint, checkpointTrees, freeze } from "./checkpoint.ts";
import { type Page, capture } from "./chrome.ts";
import { ask, endCase, gatewayStatus, spawnGateway } from "./client.ts";
import { DRIVE_VIEW, LOOP, NOTIFY, WEEK_CHECK, configId } from "./config.ts";
import { type ScanResult, compareCase, scan } from "./diffscan.ts";
import { type DriveCtx, type Pages, continueFrom, driveSession, loadPage } from "./drive.ts";
import { closedPort } from "./gateway.ts";
import { commitHistory, decisionRow, historyAdd, historyRead, historyRows, openHistory, ownerItem, recordDecision, recordMachine, triedIndex } from "./history.ts";
import { type Shot, freezeHuman, pageShot } from "./human.ts";
import { pairedRatio } from "./latency.ts";
import { type Machine, type WaveSend, heartbeat, ladder, onAC, refuseFactorySlice, sampleLoad } from "./load.ts";
import { type MeterCall, readMeter, rollup } from "./meter.ts";
import { appendRow, meterOf, readRows, rowOf } from "./metrics.ts";
import { paths } from "./paths.ts";
import { ready } from "./ready.ts";
import { appendLine, caseDir, put, putImage, runFile, voidCase } from "./record.ts";
import { acceptProbe, probe, probeDue, probeRefuses } from "./probe.ts";
import { remetric } from "./remetric.ts";
import { CASE_USD, type CardState, type Decided, type Facts, type Notice, type State, lock, newState, notices, overrun, readState, rules, saveState, stampNow } from "./state.ts";
import { entryOrder, seedOf } from "./stats.ts";
import { stubPictures } from "./stubs.ts";
import { type SlotN, type Token, loadDevToken, loadTokens } from "./tokens.ts";
import { LockfileDiffers, contentHash, treeOf, worktreeOf } from "./trees.ts";
import type { AgentLog, Arm, CaseInfo, EpochRow, Fork, HypothesisCard, Judged, Row, SceneJSON, SendOutcome } from "./types.ts";
import { type Decision, type LoopState, decide } from "./verdict.ts";
import * as real from "../real/real.ts";

const USAGE = `usage: rte <command> [--cap n] [--tokens f | --dev-token] …   (evals/RUNBOOK.md)
  init --from <repo> [--refresh]       ready [--stub] [--mock-api]         ladder --max n
  smoke --cap n                        bake --cap n                         bank build --tuning n --heldout-gate n --heldout-chart n --cap n
  probe --cap n | --accept               bank accept (a bank that failed §2.3, used anyway)
  aa --shared --cases n                bench freeze                         human freeze
  real ingest [--raw stamp] | render | triage --cap n | gold --cap n | review [--host ip] [--port n] | freeze
       [--since yyyy-mm-dd] [--only <session>]   (testers' sends → triage → gold → bench R1, evals/real/README.md)
  checkpoint [--zero] --cap n          calib --contrast k=v [--more n] --cap n | --check [--cap n] [--variant 2] | --fake-labels (a dry run)
  sync --cap n                         export <host | /dir>                 decide <branch> [--goal latency --metric ttfc|ttd] [--owner-ok] --cap n
  loop [--epochs n] [--seed-cards f] [--quality-only] [--night-windows x] [--resume]
       [--notify-decisions n] [--notify-minutes m] [--notify-usd x] [--notify-checkpoint 0|1]   (owner notices; 0 is off)
  stop-after [--cancel]   (the running loop stops before its next step: nothing lost, loop --resume goes on)
  week --cap n            (reads again the weekly use of each token parked on an old reading, one one-word call each)
  status                               remetric <run>                       gc --trees
  packets <run>… (frames the changes a run's after captures missed, 0 calls)`;
const CO_AUTHOR = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
/** R8 and `aa`'s default: 16 cases, the champion against itself in timed replay. */
const AA_CASES = 16;
/** The smoke's driver session: 3 sends from the blank start (§11 step 1). */
const SMOKE_SENDS = 3;
/** How long U3 waits for the "off" process its second call left waiting. */
const U3_WARM_MS = 3000;
/** Sends per slot at each ladder step. */
const LADDER_ROUNDS = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "make the nav pink", spoken (the ladder's send and U3's resolver case). */
const SPOKEN = ([["make", 0, 180], ["the", 200, 300], ["nav", 320, 520], ["pink", 560, 800]] as const).map(([word, t0, t1]) => ({ word, t0, t1 }));

// ---- Flags, logs, git

type Opts = { cmd: string; pos: string[]; f: Record<string, string | true>; cap?: number; tokens?: string; devToken?: true | string; mockApi?: string; port: number };
let o: Opts = { cmd: "", pos: [], f: {}, port: 5300 };
const str = (k: string) => (typeof o.f[k] === "string" ? (o.f[k] as string) : undefined);
const num = (k: string) => (str(k) === undefined ? undefined : Number(str(k)));
function parse(argv: string[]): Opts {
  const pos: string[] = [];
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) pos.push(argv[i]);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) f[argv[i].slice(2)] = argv[++i];
    else f[argv[i].slice(2)] = true;
  }
  const cap = typeof f.cap === "string" ? Number(f.cap) : undefined;
  if (f.cap !== undefined && !(Number.isInteger(cap) && cap! >= 0)) throw new Error(`--cap takes a whole number of calls`);
  return { cmd: pos[0] ?? "", pos, f, cap, tokens: typeof f.tokens === "string" ? f.tokens : undefined, devToken: f["dev-token"], mockApi: typeof f["mock-api"] === "string" ? f["mock-api"] : undefined, port: Number(f.port ?? 5300) };
}
function needCap(what = o.cmd) {
  if (o.cap === undefined) throw new Error(`${what} makes real model calls: it needs --cap n (the gateway refuses call n+1)`);
}

/** Every line also goes to $RT_EVAL_HOME/logs/: a closed terminal (launch.sh) loses only the piped copy. */
function say(line: string) {
  console.log(line);
  try {
    mkdirSync(paths().logs, { recursive: true });
    appendFileSync(join(paths().logs, `run-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${o.cmd}: ${line}\n`);
  } catch {
    // no valid home yet (status, a refusal): the terminal has it
  }
}
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;
const maybe = <T>(f: string): T | undefined => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function tryGit(dir: string, ...a: string[]): string | undefined {
  try {
    return git(dir, ...a);
  } catch {
    return undefined; // a non-zero exit is the answer
  }
}
/** The loop always commits as itself: the machine's identity (the owner's email) would land in cand/* commits and tried patches. */
const IDENT = ["-c", "user.name=rt-eval loop", "-c", "user.email=rt-eval@localhost"];
function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, ...IDENT, "commit", "-q", "-m", message, "-m", CO_AUTHOR);
  return git(dir, "rev-parse", "HEAD");
}
const isAncestor = (a: string, b: string) => tryGit(paths().repo, "merge-base", "--is-ancestor", a, b) !== undefined;
const championSha = () => git(paths().repo, "rev-parse", "loop/champion");
const championArm = (): ArmSpec => {
  const sha = championSha();
  return { sha, tree: treeOf(sha) };
};
const initFrom = () => maybe<{ from: string }>(join(paths().home, "init.json"))?.from;
/** The branch init cloned (the owner's master; eval-build in a rehearsal): sync and init --refresh fetch it. */
const upstream = () => maybe<{ branch?: string }>(join(paths().home, "init.json"))?.branch ?? "master";

// ---- Tokens, the gateway, the rig

let tokenCache: Token[] | undefined;
/** The loop's tokens in memory (1–3 from the tokens file, or --dev-token's one); never printed or written. */
const tokens = () => (tokenCache ??= o.devToken ? loadDevToken(o.cap, typeof o.devToken === "string" ? o.devToken : undefined) : loadTokens(o.tokens));

/** Throwaway tokens for a gateway that must make no call: replay and scan only, cap 1, a dead API address. */
function fakeTokens(): string {
  const f = join(paths().home, "meter", "zero-call-tokens.env");
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${[1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-zero-call-${n}-${randomBytes(8).toString("hex")}`).join("\n")}\n`, { mode: 0o600 });
  }
  return f;
}
async function withGateway<T>(f: (gw: string) => Promise<T>, zeroCall = false): Promise<T> {
  const g = await spawnGateway(zeroCall ? { cap: 1, tokens: fakeTokens(), mockApi: "http://127.0.0.1:9" } : { cap: o.cap, tokens: o.tokens, devToken: o.devToken, mockApi: o.mockApi });
  try {
    return await f(g.url);
  } finally {
    await g.close();
  }
}
/** --mock-api for the agent sessions run here (the gateway sets up its own): nothing gets past the fake API. */
const agentMock = async () => (o.mockApi ? { baseUrl: o.mockApi, deadProxyPort: await closedPort() } : undefined);
const slotsHere = () => maybe<Machine>(paths().machine)?.slots ?? 1;
async function withRig<T>(gw: string, trees: string[], f: (rig: Rig) => Promise<T>, slots = slotsHere()): Promise<T> {
  const rig = await openRig({ trees, gateway: gw, slots, port: o.port });
  try {
    return await f(rig);
  } finally {
    await rig.close();
  }
}
/** Each case slot's champion page, for driver sessions. */
const championPages = (rig: Rig, tree: string) => Promise.all(Array.from({ length: rig.slots }, async (_, k): Promise<Pages> => ({ A: (await rig.tab(k, "A", tree)).page })));
const tuningIdOf = async (page: Page) => (await page.eval<{ tuningId: string }>("rtEval.health()")).tuningId;

/** Done, unvoided banked cases of these sets, by id. */
function banked(sets: string[]): string[] {
  const dir = paths().bankCases;
  return (existsSync(dir) ? readdirSync(dir) : []).filter((id) => !id.includes(".void") && existsSync(join(dir, id, "done")) && sets.includes(maybe<CaseInfo>(join(dir, id, "case.json"))!.set)).sort();
}
/** Cases in a seeded order that keeps each origin session together (as decisions enter them). */
const ordered = (ids: string[], seed: string) => entryOrder(ids, (id) => maybe<CaseInfo>(join(paths().bankCase(id), "case.json"))!.originSession, seedOf(seed));

// ---- The history branch

/** eval/history-import (pushed by another machine's `export`) into eval/history: a fast-forward, else a merge; a conflict goes to the owner. */
function importHistory() {
  if (tryGit(paths().repo, "rev-parse", "--verify", "-q", "refs/heads/eval/history-import") === undefined) return;
  const dir = openHistory();
  if (tryGit(dir, "merge-base", "--is-ancestor", "eval/history-import", "HEAD") !== undefined) return;
  if (tryGit(dir, "merge", "-q", "--ff-only", "eval/history-import") !== undefined) return say("history: fast-forwarded to eval/history-import");
  if (tryGit(dir, ...IDENT, "merge", "-q", "--no-edit", "eval/history-import") !== undefined) return say("history: merged eval/history-import");
  tryGit(dir, "merge", "--abort");
  ownerItem("eval/history and eval/history-import conflict: merge them by hand in $RT_EVAL_HOME/history");
  commitHistory("owner list: a history import to merge by hand");
}

// ---- init, export, status, ready

/** The clone's node_modules: hard links to the owner's when the lockfiles match (~0.1 s), else npm ci. */
function modules() {
  const p = paths();
  const from = initFrom();
  const lockOf = (d: string) => (existsSync(join(d, "package-lock.json")) ? readFileSync(join(d, "package-lock.json"), "utf8") : "");
  const stamp = join(p.home, "modules.lock");
  if (existsSync(join(p.repo, "node_modules")) && maybe<string>(stamp) === lockOf(p.repo)) return;
  rmSync(join(p.repo, "node_modules"), { recursive: true, force: true }); // the clone's own copy (links), never the owner's files
  if (from && existsSync(join(from, "node_modules")) && lockOf(from) === lockOf(p.repo)) {
    execFileSync("cp", ["-al", join(from, "node_modules"), join(p.repo, "node_modules")]);
    rmSync(join(p.repo, "node_modules", ".vite"), { recursive: true, force: true });
  } else execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: p.repo, stdio: "inherit" });
  writeFileSync(stamp, js(lockOf(p.repo)));
}
/** Tags the harness's HEAD eval-harness-<n> unless it's at one already. */
function pin(): string {
  const r = paths().repo;
  const at = tryGit(r, "describe", "--tags", "--exact-match", "--match", "eval-harness-*", "HEAD");
  if (at) return at;
  const n = Math.max(0, ...git(r, "tag", "-l", "eval-harness-*").split("\n").filter(Boolean).map((t) => Number(t.split("-").pop())));
  git(r, "tag", `eval-harness-${n + 1}`);
  return `eval-harness-${n + 1}`;
}

async function init() {
  const p = paths();
  const before = o.f.refresh ? tryGit(p.repo, "describe", "--tags", "--abbrev=0", "--match", "eval-harness-*", "HEAD") : undefined;
  if (o.f.refresh) {
    // Re-pins only the harness: the champion takes the owner's master through `sync` alone.
    if (!existsSync(join(p.repo, ".git"))) throw new Error(`no loop clone at ${p.repo}: init --from <repo> first`);
    if (git(p.repo, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${p.repo} has local changes: the harness is pinned, never edited`);
    git(p.repo, "fetch", "-q", "origin", upstream());
    git(p.repo, "merge", "-q", "--ff-only", "FETCH_HEAD");
  } else {
    if (typeof o.f.from !== "string") throw new Error("init --from <the owner's checkout>");
    const from = resolve(o.f.from);
    if (existsSync(p.repo)) throw new Error(`${p.repo} exists: use init --refresh`);
    const branch = git(from, "rev-parse", "--abbrev-ref", "HEAD");
    execFileSync("git", ["clone", "-q", "--branch", branch, from, p.repo], { stdio: ["ignore", "pipe", "pipe"] });
    git(p.repo, "branch", "loop/champion", branch);
    put(join(p.home, "init.json"), { from, branch, at: new Date().toISOString() });
  }
  modules();
  const tag = pin();
  // Trees key on the harness too, so the old harness's are never served again: aside, or R1 counts them stale.
  if (before && before !== tag && existsSync(join(p.home, "trees"))) {
    mkdirSync(join(p.home, "trees-old"), { recursive: true });
    renameSync(join(p.home, "trees"), join(p.home, "trees-old", `${before}-${stampNow()}`));
  }
  openHistory();
  importHistory();
  say(`init: ${p.repo} at ${tag}, champion ${championSha().slice(0, 12)}, history at ${p.history}`);
}

/** Copies what another machine can't rebuild for free (§7.8), never with --delete; eval/history goes over as eval/history-import. */
async function exportTo() {
  const host = o.pos[1];
  if (!host) throw new Error("export <host> (its ~/rt-eval) or export </absolute/dir> (that RT_EVAL_HOME)");
  const p = paths();
  const there = host.startsWith("/") ? host : `${host}:rt-eval`;
  const dirs = ["bank", "cache/replies", "cache/blobs", "labels", "human"].filter((d) => existsSync(join(p.home, d)));
  execFileSync("rsync", ["-aR", ...dirs, `${there}/`], { cwd: p.home, stdio: ["ignore", "inherit", "inherit"] });
  openHistory();
  git(p.repo, "push", "-q", "--force", `${there}/repo`, "eval/history:refs/heads/eval/history-import");
  say(`export: ${dirs.join(", ")} and eval/history (as eval/history-import) → ${there}; there: rte init --refresh`);
}

async function status() {
  const loaded = tokens().length; // a tokens file at any mode but 600, or inside a repo, fails here
  const inhibit = spawnSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" });
  const p = paths();
  const st = readState();
  for (const l of [
    `slots loaded: ${loaded} (${o.devToken ? "the dev plugin's token" : (o.tokens ?? "~/.config/rt-eval/tokens.env")})`,
    `cap: ${o.cap ?? "none"}`, `cwd: ${process.cwd()}`, `node: ${process.version} (${process.execPath})`,
    `launched: ${process.env.RT_EVAL_LAUNCHED === "1" ? "yes" : "no"}`,
    `inhibitor: ${inhibit.status === 0 ? (inhibit.stdout.includes("rt eval") ? "held ('rt eval')" : "not held") : "n/a"}`,
    `home: ${p.home}; champion ${tryGit(p.repo, "rev-parse", "--short", "loop/champion") ?? "none (init first)"}`,
    `loop: ${st ? `epoch ${st.epoch}, ${st.cards.filter((c) => c.status === "done").length} of ${st.cards.length} cards decided${st.blocked ? `; blocked: ${st.blocked}` : ""}` : "not started"}; lock ${existsSync(p.lock) ? readFileSync(p.lock, "utf8") : "free"}`,
  ]) say(l);
}

async function readyCmd() {
  const results = await ready({ stub: !!o.f.stub, mockApi: !!o.f["mock-api"], port: o.port, repo: initFrom(), aaCheck: () => aa(AA_CASES) });
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  if (existsSync(join(paths().repo, ".git"))) {
    openHistory();
    historyAdd("health.jsonl", { at: new Date().toISOString(), kind: "ready", pass: !failed.length, detail: { harness: harnessTag(), failed, skipped: results.filter((r) => r.skipped).map((r) => r.id) } });
    commitHistory(`ready: ${failed.length ? `FAIL ${failed.join(" ")}` : "ok"}`);
  }
  say(failed.length ? `ready: FAIL ${failed.join(" ")}` : "ready: ok");
  return failed.length ? 1 : 0;
}
/** The last readiness run passed, at this harness tag, within a day (§7.5: before every recording session). */
function readyOk(): boolean {
  const dir = join(paths().home, "ready");
  const last = (existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("ready-")).sort() : []).at(-1);
  const r = last ? maybe<{ at: string; harnessTag: string | null; results: { ok: boolean }[] }>(join(dir, last, "ready.json")) : undefined;
  return !!r && r.results.every((x) => x.ok) && (r.harnessTag ?? "") === harnessTag() && Date.now() - Date.parse(r.at) < DAY;
}

// ---- The zero-call measurements: the ladder and the shared A/A

/**
 * Each role's median timing in a call log, one line per role: the ladder's sends then differ only by the machine's
 * load (replayed in turn, a log's spread moved a 3-send median by ~30% and stopped the ladder at 1 slot).
 */
function medianTimings(log: string, out: string): string {
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const by = new Map<string, { first: number[]; rest: number[]; out: number[] }>();
  for (const r of readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.from && r.firstMs != null && !r.error && r.thinking !== "off")) {
    const b = by.get(r.from) ?? by.set(r.from, { first: [], rest: [], out: [] }).get(r.from)!;
    b.first.push(r.firstMs - (r.waitMs ?? 0)), b.rest.push(r.ms - r.firstMs), b.out.push(r.outTokens ?? 40);
  }
  writeFileSync(out, [...by].map(([from, b]) => js({ from, firstMs: med(b.first), ms: med(b.first) + med(b.rest), outTokens: med(b.out) })).join("\n") + "\n");
  return out;
}

/** N8: the concurrency knee on a fake API (logged latencies), 0 model calls; machine.json and history/machine/<host>.json. */
async function ladderCmd() {
  const champ = championArm();
  const work = join(paths().home, "ladder");
  // Sends shaped like a Q case's: every drawing reply adds 2 pictures, so a tab streams up to 3 calls and renders them
  // (a recolour alone streamed 1 and let a laptop claim slots its real cases would overload).
  const dry = writeDry(join(work, "dry"), { pictures: 2 });
  // The owner's logged timings, or --latency's, else the dry run's medians (a fresh clone, as on the PGX, has no log).
  const log = str("latency") ?? (initFrom() && join(initFrom()!, ".data", "model-calls.jsonl"));
  const api = await startFakeApi({ replies: dry.replies, latency: log && existsSync(log) ? medianTimings(log, join(work, "latency.jsonl")) : dry.latency });
  // Its own home: fake calls must not reach the loop's meter or slot state.
  const gw = await spawnGateway({ home: join(work, "gateway"), tokens: fakeTokens(), mockApi: api.url });
  try {
    const s0 = loadFixture("toyshop-home", { pictures: {} }).scene;
    const { scene, start } = loadFixture("toyshop-home", { pictures: stubPictures(s0) });
    const send = `rtEval.send(${js({ words: SPOKEN, strokes: [] })})`;
    const machine = await ladder((slots) => withRig(gw.url, [champ.tree], async (rig) => {
      const sends: WaveSend[] = [];
      for (let round = 0; round < LADDER_ROUNDS; round++)
        await Promise.all(Array.from({ length: slots }, async (_, k) => {
          const run = `ladder-${slots}`, id = `${run}-${round}-${k}`;
          const tabs = await Promise.all((["A", "B"] as Arm[]).map((a) => rig.tab(k, a, champ.tree)));
          for (const t of tabs) await loadPage(t.page, run, id, scene.toJSON(), start);
          const origin = await Promise.all(tabs.map((t) => t.page.eval<number>("performance.timeOrigin")));
          const t0 = performance.now();
          const out = await Promise.all(tabs.map((t) => t.page.eval<SendOutcome>(send)));
          const wallMs = performance.now() - t0;
          const s1 = performance.now();
          await capture(tabs[0].page, { width: DRIVE_VIEW.screenW, quality: DRIVE_VIEW.jpegQuality });
          const shotMs = performance.now() - s1;
          const end = (await endCase(run, id, gw.url)) as { loopP99Ms: number };
          sends.push({ wallMs, shotMs, longTasksMs: Math.max(...out.map((x) => x.timing.longTasksMs)), dispatchOffsetMs: Math.abs(origin[0] + out[0].timing.enterAt - origin[1] - out[1].timing.enterAt), loopDelayP99Ms: end.loopP99Ms, load: sampleLoad() });
        }));
      return sends;
    }, slots), num("max") ?? 12);
    say(`ladder: ${machine.slots} case slots, dispatch limit ${machine.dispatchLimitMs.toFixed(1)} ms (${machine.steps.map((s) => `${s.slots} ${s.ok ? "ok" : s.why}`).join("; ")})`);
    if (existsSync(join(paths().repo, ".git"))) {
      openHistory();
      recordMachine();
      commitHistory(`ladder: ${machine.host} runs ${machine.slots} case slots`);
    }
  } finally {
    await gw.close();
    await api.close();
  }
}

/** R8: the champion against itself in timed replay, shared: identical requests and scenes, TTFC ×1.00 ± 0.03, 0 calls. */
async function aa(n: number): Promise<{ ok: boolean; detail: string }> {
  // A timed replay serves each request its banked reply, so only cases recorded on the commit both arms serve replay
  // at 0 calls (top-ups and refreshes record on later champions): the champion's own if it has n, else the biggest
  // group whose commit this clone has, else every case on the champion.
  const all = banked(["tuning", "fresh"]);
  const bySha = new Map<string, string[]>();
  for (const id of all) {
    const k = maybe<CaseInfo>(join(paths().bankCase(id), "case.json"))!.championSha;
    bySha.set(k, [...(bySha.get(k) ?? []), id]);
  }
  const here = (sha: string) => tryGit(paths().repo, "cat-file", "-e", `${sha}^{commit}`) !== undefined;
  const champion = championArm();
  const sha = [...bySha].filter(([k, ids]) => ids.length >= n && here(k)).sort(([a, x], [b, y]) => Number(b === champion.sha) - Number(a === champion.sha) || y.length - x.length)[0]?.[0];
  const ids = ordered(sha ? bySha.get(sha)! : all, "aa").slice(0, n);
  if (ids.length < n) return { ok: false, detail: `the bank has ${ids.length} tuning cases (want ${n})` };
  const champ: ArmSpec = sha && sha !== champion.sha ? { sha, tree: treeOf(sha) } : champion;
  return withGateway((gw) => withRig(gw, [champ.tree], async (rig) => {
    const run = `aa-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const { rows } = await runAB(rig, { run, kind: "aa", arms: { A: champ, B: champ }, mode: "replay", share: true, seed: run, cases: ids });
    const same = ids.filter((id) => !compareCase(run, id).affected).length;
    const ttfc = pairedRatio(rows, "ttfc");
    const calls = (await gatewayStatus(gw)).calls as number;
    const ok = same === n && calls === 0 && !!ttfc && Math.abs(ttfc.est - 1) <= LOOP.nTimingBand;
    return { ok, detail: `${same} of ${n} cases identical, paired TTFC ×${ttfc?.est.toFixed(3) ?? "?"}, ${calls} calls (${run})` };
  }), true);
}
async function aaCmd() {
  if (!o.f.shared) throw new Error("only aa --shared is built here: the unshared A/A is checkpoint 0 (checkpoint --zero)");
  const r = await aa(num("cases") ?? AA_CASES);
  say(`aa: ${r.ok ? "ok" : "FAIL"} ${r.detail}`);
  return r.ok ? 0 : 1;
}

// ---- Setup steps with real calls (§11), each under its cap

/** One product call the way an arm page makes it (U3's case "u3"): its text. */
async function productCall(gw: string, run: string, body: object): Promise<string> {
  const res = await fetch(`${gw}/api/model`, { method: "POST", headers: { "content-type": "application/json", "x-rt-run": run, "x-rt-case": "u3", "x-rt-arm": "A", "x-rt-slot": "0" }, body: js(body) });
  return (await res.text()).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text?: string }).text ?? "").join("");
}
const parses = (t: string) => {
  try {
    return !!JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } catch {
    return false;
  }
};

const smokeCalls = (run: string) => readMeter(paths().calls).filter((l): l is MeterCall => !("agent" in l) && l.run.startsWith(run) && l.mode === "live" && l.shared !== "follower");
/** The smoke's point on the progress page (smoke.jsonl), from its meter lines and its A/B's rows. */
export function recordSmoke(run: string, pass: boolean, started: number, ended = Date.now()) {
  const live = smokeCalls(run);
  const rows = readRows(`${run}-ab`).filter((r) => !r.void);
  const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
  openHistory();
  historyAdd("smoke.jsonl", {
    at: new Date(ended).toISOString(), run, pass, calls: live.length, listUsd: live.reduce((a, l) => a + l.listUsd, 0), minutes: (ended - started) / 60_000, cases: rows.length,
    share: rows.length ? rows.reduce((a, r) => a + (r.s + 1) / 2, 0) / rows.length : undefined,
    ttfcP50: p50(rows.flatMap((r) => r.ttfc.filter((v): v is number => v !== null))), ttdP50: p50(rows.flatMap((r) => r.ttd)),
  });
  commitHistory(`smoke: ${pass ? "ok" : "FAIL"}, ${live.length} calls`);
}

/** §11 step 1, pinned to the blank start: every line must pass. */
async function smoke() {
  needCap();
  const started = Date.now();
  const champ = championArm();
  const run = `smoke-${stampNow()}`;
  let fails = 0;
  const line = (ok: boolean | "note", what: string) => {
    if (ok === false) fails++;
    say(`${ok === "note" ? "note" : ok ? "ok  " : "FAIL"} ${what}`);
  };
  await withGateway(async (gw) => {
    const t = tokens();
    line(true, `status: ${t.length} token slots, cap ${o.cap}, launched ${process.env.RT_EVAL_LAUNCHED === "1" ? "yes" : "no"}`);
    // U2: one tiny call per slot, so each slot reports its own reset (each its own request: the run's cache would serve a repeat).
    for (const k of t) await ask({ role: "probe", model: "haiku", system: "Answer with one word.", user: `Ready, slot ${k.slot}?`, run, token: k.slot }, gw);
    const slots = (await gatewayStatus(gw)).slots as { slot: number; resetsAt?: number }[];
    if (t.length < 2) line("note", "U2: skipped: one token");
    else line(slots.every((s) => s.resetsAt) && new Set(slots.map((s) => s.resetsAt)).size === slots.length, `U2: the slots' resetsAt ${slots.map((s) => s.resetsAt).join(", ")} differ`);
    // U3: three Haiku resolver calls, thinking auto / off / off; the third on the "off" process the second left waiting.
    const { scene } = loadFixture("toyshop-home", { pictures: {} });
    const user = prompt(plan(SPOKEN, [], scene, new HitIndex(scene), DEFAULTS), scene);
    const texts: string[] = [];
    for (const thinking of ["auto", "off", "off"]) {
      if (texts.length === 2) await sleep(U3_WARM_MS);
      texts.push(await productCall(gw, run, { model: "haiku", system: promptOf("resolve", DEFAULTS).system, user, thinking, from: "draw-refs" }));
    }
    const u3 = meterOf(run).filter((l) => l.case === "u3");
    // First text under 2 s is the "off" calls' bar (§11); the thinking call before them is the comparison (~2.9 s today).
    line(u3.length === 3 && u3.slice(1).every((l) => l.thinkingTokens === 0 && (l.firstMs ?? Infinity) < 2000) && texts.every(parses) && u3[2].readyAtTake === true,
      `U3: thinking tokens ${u3.map((l) => l.thinkingTokens).join("/")}, first text ${u3.map((l) => l.firstMs).join("/")} ms, third call ${u3[2]?.readyAtTake ? "on a warmed process" : "cold"}`);
    await withRig(gw, [champ.tree], async (rig) => {
      const page = (await rig.tab(0, "A", champ.tree)).page;
      const s = { ...(TUNING.find((x) => x.start === "blank") ?? TUNING[0]), start: "blank" as const, sends: SMOKE_SENDS };
      const ctx: DriveCtx = { run, arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(page) } }, harnessTag: harnessTag() };
      const sess = await driveSession(ctx, s, { A: page }, { bank: "smoke", session: 1, deposit: true });
      // The smoke's cases leave the bank at once, voided ones too: they check the harness, they're no fork points.
      const kept = join(paths().run(run), "bank");
      mkdirSync(kept, { recursive: true });
      for (const d of readdirSync(paths().bankCases).filter((d) => d.startsWith("c-smoke-"))) renameSync(paths().bankCase(d), join(kept, d));
      const events = existsSync(runFile(run, "events.jsonl")) ? readFileSync(runFile(run, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { v: string; why: string }) : [];
      // The driver's own notes (§2.7: a look, a clamp, a hedge, a missed beat) aren't the harness failing; every other V is.
      const harness = events.filter((e) => !["V2", "V3", "V5", "V11"].includes(e.v));
      line(sess.banked.length >= 2 && !harness.length, `driver session: ${sess.banked.length} of ${SMOKE_SENDS} sends banked (${sess.ended}), ${harness.length} harness events${events.length ? `: ${events.map((e) => `${e.v} ${e.why}`).join("; ")}` : ""}`);
      const ids = sess.banked.slice(0, 2);
      const ab = `${run}-ab`;
      const r = await runAB(rig, { run: ab, kind: "smoke", arms: { A: champ, B: champ }, mode: "live", share: false, seed: ab, judge: judging(ab, { seed: ab, craft: "none" }), cases: ids, source: (id) => join(kept, id) });
      line(r.rows.length === ids.length && r.rows.every((x) => !x.void) && ids.every((id) => existsSync(join(caseDir(ab, id), "judge", "fidelity-1.json"))), `unshared A/B: ${r.rows.length} cases, judged${r.rows.some((x) => x.void) ? `, voided: ${r.rows.map((x) => x.void).filter(Boolean).join("; ")}` : ""}`);
    });
  });
  const live = smokeCalls(run);
  line(live.some((l) => l.fiveHour !== undefined && l.fiveHour !== null) || "note", `U1: ${live.filter((l) => l.fiveHour != null).length} of ${live.length} calls carried five-hour utilization (none: the meter uses the W estimate)`);
  line(live.every((l) => l.cacheWrite1h === 0), `cacheWrite1h 0 on all ${live.length} calls`);
  line(live.every((l) => !!l.servedModel), `served models: ${[...new Set(live.map((l) => l.servedModel))].join(", ")}`);
  // No email in any request: R3 shows the transport adds none on the fake API, but Claude Code puts the account's email
  // in every prompt (userEmail) once its config dir caches the account, which only a real login can do.
  const conf = paths().claudeConfig;
  const cached = (existsSync(conf) ? readdirSync(conf, { recursive: true, withFileTypes: true }) : []).filter((e) => e.isFile() && /"emailAddress"\s*:\s*"[^"]/.test(readFileSync(join(e.parentPath, e.name), "utf8")));
  line(readyOk() && !cached.length, `no email: readiness (R3) ${readyOk() ? "passed" : "not passed"} at this tag, ${cached.length} Claude config files cache an account email`);
  recordSmoke(run, !fails, started);
  say(`smoke: ${fails ? `FAIL (${fails} lines)` : "ok"}, ${live.length} calls`);
  return fails ? 1 : 0;
}

async function bakeCmd() {
  needCap();
  const champ = championArm();
  return withGateway((gw) => withRig(gw, [champ.tree], async (rig) => {
    const page = (await rig.tab(0, "A", champ.tree)).page;
    page.labels.run = `bake-${stampNow()}`;
    const r = await bake(page);
    say(`bake: ${Object.keys(r.pictures).length} pictures in ${r.file}${r.missing.length ? `; still undrawn: ${r.missing.join(", ")}` : ""}${r.stopped ? ` (${r.stopped})` : ""}`);
    say(`review them, then commit only that file (§11 step 2) and rte init --refresh`);
    return r.missing.length ? 1 : 0;
  }, 1));
}

/** §2.8's driver probe before drivers bank (run when due, N14): why they may not, if they may not. */
async function probed(ctx: DriveCtx, page: Page): Promise<string | undefined> {
  const due = probeDue();
  if (due) {
    const p = await probe({ ...ctx, run: `${ctx.run}-probe` }, page);
    say(`probe (${due}): ${p.pass ? "ok" : `FAIL: ${p.why.join("; ")}`}`);
  }
  return probeRefuses();
}
async function probeCmd() {
  if (o.f.accept) return void say(`probe: accepted by the owner: ${acceptProbe().why.join("; ") || "it passed"}`);
  needCap();
  const champ = championArm();
  return withGateway((gw) => withRig(gw, [champ.tree], async (rig) => {
    const page = (await rig.tab(0, "A", champ.tree)).page;
    const p = await probe({ run: `probe-${stampNow()}`, arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(page) } }, harnessTag: harnessTag() }, page);
    say(`probe: ${p.pass ? "ok" : `FAIL: ${p.why.join("; ")}`} (good ${p.good ?? "-"}, bad ${p.bad ?? "-"}, ${p.targets.length} targets, asks ${p.asks.join(", ") || "none"})`);
    return p.pass ? 0 : 1;
  }, 1));
}

/** A bank that failed §2.3 is used by nothing after it (bench, checkpoints, calibration, decisions) until rebuilt or accepted. */
function needBank() {
  const no = bankRefuses();
  if (no) throw new Error(no);
}

async function bankCmd() {
  if (o.pos[1] === "accept") return say(`bank: accepted although it fails ${acceptBank().join("; ")}`);
  if (o.pos[1] !== "build") throw new Error("bank build --tuning n --heldout-gate n --heldout-chart n --cap n | bank accept");
  needCap("bank build");
  const sets: BankSet[] = (["tuning", "heldout-gate", "heldout-chart"] as const).map((set) => ({ set, sessions: num(set) ?? 0 })).filter((s) => s.sessions);
  const champ = championArm();
  return withGateway((gw) => withRig(gw, [champ.tree], async (rig) => {
    const slots = await championPages(rig, champ.tree);
    const ctx: DriveCtx = { run: "bank-b1", arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(slots[0].A) } }, harnessTag: harnessTag() };
    const no = await probed(ctx, slots[0].A);
    if (no) return say(`bank: REFUSED before any session: ${no}`), 1;
    const r = await buildBank(ctx, slots, { bank: "b1", sets });
    say(`bank: ${r.cases.length} cases; ${r.fails.length ? `REFUSED: ${r.fails.join("; ")}` : "every §2.3 gate passes"}`);
    return r.fails.length ? 1 : 0;
  }));
}

async function benchCmd() {
  if (o.pos[1] !== "freeze") throw new Error("bench freeze");
  needBank();
  openHistory();
  const m = freeze({ heldout: num("heldout"), tuning: num("tuning") }); // smaller only in a rehearsal
  say(`bench freeze: B1, ${Object.keys(m.files).length} files, hash ${m.hash.slice(0, 12)}`);
}
async function humanCmd() {
  if (o.pos[1] !== "freeze") throw new Error("human freeze");
  openHistory();
  const champ = championArm();
  await withGateway((gw) => withRig(gw, [champ.tree], async (rig) => {
    const m = await freezeHuman(pageShot((await rig.tab(0, "A", champ.tree)).page));
    say(`human freeze: U1, ${Object.keys(m.files).length} files, hash ${m.hash.slice(0, 12)}`);
  }, 1), true);
}

/** Local (the owner's dev server) sessions before this aren't triaged: the hosted app's testers started then. */
const REAL_SINCE = "2026-10-22";
/** Opus calls in flight at once in triage and gold (the gateway runs eval roles 6 at a time). */
const REAL_PARALLEL = 4;
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}
/** The real-use loop (evals/real/README.md): render and shots on a zero-call gateway, triage and gold under --cap. */
async function realCmd() {
  const step = o.pos[1];
  const since = str("since") ?? REAL_SINCE, only = str("only");
  const shots = (f: (shot: Shot) => Promise<void>) => {
    const champ = championArm();
    return withGateway((gw) => withRig(gw, [champ.tree], async (rig) => f(pageShot((await rig.tab(0, "A", champ.tree)).page)), 1), true);
  };
  if (step === "ingest") for (const line of real.ingestStep(str("raw"))) say(`real ingest: ${line}`);
  else if (step === "render") {
    await shots(async (shot) => {
      let n = 0;
      for (const { dir, s } of real.chosen(since, only)) n += await real.renderSession(dir, s, shot);
      say(`real render: ${n} images made, ${await real.shootGold(shot)} gold images`);
    });
  } else if (step === "triage") {
    needCap("real triage");
    const run = `real-triage-${stampNow()}`;
    const todo = real.chosen(since, only);
    let made = 0, kept = 0, failed = 0;
    await withGateway(() => pool(todo, REAL_PARALLEL, async ({ dir, s }) => {
      try {
        const t = await real.triageSession(dir, s, run);
        if (t === "kept") return void kept++;
        made++;
        say(`real triage: ${s.id} (${s.project.name.slice(0, 30)}): ${t.sends.filter((x) => x.landed !== "yes").length} of ${t.sends.length} missed, ${t.sends.filter((x) => x.gold).length} for gold`);
      } catch (e) {
        failed++;
        say(`real triage: ${s.id} failed: ${msg(e)}`);
      }
    }));
    say(`real triage: ${made} sessions triaged, ${kept} already current, ${failed} failed`);
    return failed ? 1 : 0;
  } else if (step === "gold") {
    needCap("real gold");
    const run = `real-gold-${stampNow()}`;
    const todo = real.wantGold(since, only);
    const batch = real.nextBatch();
    let failed = 0;
    await withGateway(() => pool(todo, REAL_PARALLEL, async (c) => {
      try {
        const g = await real.goldSend(c, run, batch);
        say(`real gold: ${c.x.key} ${g.error ? `unreadable: ${g.error}` : `${g.gold!.pictures.length} pictures${g.problems.length ? `, ${g.problems.length} problems` : ""}`}`);
        if (g.error) failed++;
      } catch (e) {
        failed++;
        say(`real gold: ${c.x.key} failed: ${msg(e)}`);
      }
    }));
    await shots(async (shot) => void say(`real gold: batch ${batch}, ${todo.length} sends, ${failed} failed, ${await real.shootGold(shot)} gold images`));
    return failed ? 1 : 0;
  } else if (step === "review") {
    const url = await real.serveReview(str("host") ?? "127.0.0.1", num("port") ?? 5182);
    say(`real review: ${url} (Ctrl-C stops it)`);
    await new Promise(() => {});
  } else if (step === "freeze") {
    openHistory();
    const r = real.freezeReal();
    commitHistory(`real freeze: R1 = ${r.cases} cases (${r.tune} tune, ${r.hold} hold), ${r.hash.slice(0, 12)}`);
    say(`real freeze: R1, ${r.cases} cases (${r.tune} R-tune, ${r.hold} R-hold), ${r.inkWaiting} waiting for synthesized ink, hash ${r.hash.slice(0, 12)}`);
  } else throw new Error("real ingest | render | triage | gold | review | freeze");
}

/** A checkpoint of today's champion (an owner step for `sync`), then the champion-miss digest from its losses. */
async function runCheckpoint(gw: string, epoch: number, owner?: { commits: number; baseSha: string; candSha: string }, champ = championArm()): Promise<StoredCheckpoint> {
  const ck = await withRig(gw, checkpointTrees(champ), (rig) => checkpoint({ rig, epoch, champion: champ, owner }));
  writeMissDigest(champ.sha, { run: ck.run, champion: "B" });
  say(`${ck.id}: champion share ${ck.share.all?.share.toFixed(2)} [${ck.share.all?.lo90.toFixed(2)}, ${ck.share.all?.hi90.toFixed(2)}] against ${ck.anchor}, Q ${ck.Q.value.toFixed(2)}, TTFC ×${ck.latency.ratioTtfc.est.toFixed(2)}, trust ${ck.trust}${ck.aa ? `; A/A ${ck.aa.pass ? "passes" : "FAILS"}: ${Object.entries(ck.aa.tests).map(([k, t]) => `${k} ${t.est.toFixed(2)} ±${t.halfWidth.toFixed(2)}`).join(", ")}` : ""}`);
  return ck;
}
async function checkpointCmd() {
  needCap(o.f.zero ? "checkpoint --zero" : "checkpoint");
  needBank();
  openHistory();
  const zero = !historyRows("checkpoints.jsonl").length;
  if (o.f.zero && !zero) throw new Error("checkpoint 0 exists already");
  if (!o.f.zero && zero) throw new Error("no checkpoint 0 yet: checkpoint --zero --cap 750 first");
  const ck = await withGateway((gw) => runCheckpoint(gw, readState()?.epoch ?? 0));
  return ck.aa && !ck.aa.pass ? 1 : 0;
}

/** A rehearsal's labels, only on the fake API: the judge's own verdicts as the owner's, so `calib --check` runs end to end. */
function fakeLabels() {
  if (!o.mockApi) throw new Error("calib --fake-labels is for a dry run on the fake API: pass --mock-api");
  const at = new Date().toISOString();
  const pairs = JSON.parse(readFileSync(join(dirname(paths().labels), "pairs.json"), "utf8")) as PairRef[];
  const lines = pairs.flatMap((p, i): Label[] => {
    const dir = join(caseDir(p.run, p.case), "judge");
    const [a, b] = (p.question === "craft" ? ["craft.json"] : ["fidelity-1.json", "fidelity-2.json"]).map((f) => maybe<Judged>(join(dir, f)));
    if (!a) return [];
    const label = combined(a, b);
    const pos = readPacket(p.run, p.case).positions;
    const left = p.swap ? pos.right : pos.left;
    return [{ id: `fake-${i}`, pair: p.id, packet: `runs/${p.run}/cases/${p.case}/judge/packet.json`, subset: p.subset, question: p.question, side: label === "tie" ? "tie" : label === left ? "left" : "right", label, strength: label === "tie" ? null : "clear", ms: 0, at }];
  });
  appendFileSync(paths().labels, lines.map((l) => `${js(l)}\n`).join(""));
  say(`calib: ${lines.length} fake labels (the judge's own verdicts) in ${paths().labels}; next: rte calib --check`);
}

/** §4.5: the contrast run and the label pairs, or the labels against the judge. */
/**
 * Packet version 2 for runs judged before it, from their saved scenes (0 calls): both arms framed on what changed when a
 * result's screen left it, added to the packet; those cases' fidelity and craft verdicts move to judge/blind/, so calibration and
 * any reader judge them again with the framed images. Rerunnable: a case that no longer needs a frame gets its verdicts back.
 */
async function packetsCmd() {
  const runs = o.pos.slice(1);
  if (!runs.length) throw new Error("packets <run>…");
  for (const run of runs) {
    const info = maybe<{ arms: Record<Arm, { tree: string }> }>(runFile(run, "run.json"));
    if (!info) throw new Error(`no run ${run}`);
    const trees = [info.arms.A.tree, info.arms.B.tree];
    let cases = 0, done = 0;
    await withGateway((gw) => withRig(gw, trees, async (rig) => {
      for (const c of readdirSync(runFile(run, "cases")).sort()) {
        const dir = caseDir(run, c);
        if (!existsSync(join(dir, "judge", "packet.json")) || !existsSync(join(dir, "fork.json"))) continue;
        cases++;
        const after = { A: maybe<SceneJSON>(join(dir, "A", "after.scene.json"))!, B: maybe<SceneJSON>(join(dir, "B", "after.scene.json"))! };
        const { cameras } = maybe<{ cameras: Record<Arm, View> }>(join(dir, "fork.json"))!;
        const before = maybe<SceneJSON>(caseFile(c, "before.scene.json", run))!;
        const frame = changeFrame(before, [after.A, after.B], cameras.A.w / cameras.A.h);
        const need = !!frame && (["A", "B"] as Arm[]).some((a) => hidden(before, after[a], cameras[a]));
        for (const a of ["A", "B"] as Arm[]) {
          if (!need) {
            rmSync(join(dir, a, "changed.jpg"), { force: true });
            continue;
          }
          const { page } = await rig.tab(0, a, trees[a === "A" ? 0 : 1]);
          await loadPage(page, run, c, after[a], cameras[a]);
          putImage(join(dir, a, "changed.jpg"), await capture(page, { view: frame!, width: LOOP.judgePx, quality: LOOP.judgeQuality }));
        }
        const p = readPacket(run, c);
        const { leftChanged: _l, rightChanged: _r, ...images } = p.images;
        put(join(dir, "judge", "packet.json"), { ...p, images: { ...images, ...framed(run, c, p.positions) } });
        // Verdicts judged without the frame go aside while the packet has one, and come back when it doesn't.
        for (const sub of ["", "v1", "v2"])
          for (const f of ["fidelity-1.json", "fidelity-2.json", "craft.json"]) {
            const [live, blind] = [join(dir, "judge", sub, f), join(dir, "judge", "blind", sub, f)];
            if (need && existsSync(live)) mkdirSync(dirname(blind), { recursive: true }), renameSync(live, blind);
            if (!need && existsSync(blind) && !existsSync(live)) mkdirSync(dirname(live), { recursive: true }), renameSync(blind, live);
          }
        if (need) done++;
      }
    }, 1), true);
    say(`packets: ${run}: ${done} of ${cases} cases framed on what changed (their fidelity and craft verdicts moved to judge/blind/), 0 calls`);
  }
}

async function calib() {
  openHistory();
  if (o.f["fake-labels"]) return fakeLabels();
  if (o.f.check) {
    const variant = num("variant") === 2 ? 2 : 1;
    if (variant === 2) needCap("calib --check --variant 2");
    // Variant 1 reads the runs' own verdicts (0 calls), except those set aside for framed images (judge/blind/): with --cap it judges them again.
    const r = await withGateway(() => checkCalibration(variant), variant === 1 && o.cap === undefined);
    historyAdd("health.jsonl", r.health);
    commitHistory(`calibration: ${r.outcome} (variant ${variant})`);
    say(`calib: ${r.outcome}; fidelity ${r.fidelity.clear.score} of ${r.fidelity.clear.n} clear, craft ${r.craft.score} of ${r.craft.n}${r.outcome === "variant-2" ? "; next: calib --check --variant 2 --cap 150" : ""}`);
    return r.outcome === "pass" || r.outcome === "pass-no-craft" ? 0 : 1;
  }
  const [knob, value] = (str("contrast") ?? "").split("=");
  if (!knob || value === undefined) throw new Error("calib --contrast <knob=value> --cap n | calib --check [--variant 2]");
  needCap("calib --contrast");
  needBank();
  const ck0 = (historyRows("checkpoints.jsonl") as StoredCheckpoint[])[0];
  if (!ck0) throw new Error("no checkpoint 0 yet: its A/A pairs are most of the label set");
  const champ = championArm();
  const run = "calib-contrast";
  // --more n (calib --check said "more"): n further cases into the same run, their pairs appended to the label set.
  const more = num("more") ?? 0;
  const ids = ordered(banked(["tuning", "fresh"]), run).slice(0, LOOP.calib.contrast + more);
  await withGateway((gw) => withRig(gw, [champ.tree], async (rig) => {
    await runAB(rig, { run, kind: "calib", arms: { A: champ, B: { ...champ, tuning: { [knob]: Number(value) } } }, mode: "live", share: true, seed: run, judge: judging(run, { seed: run, craft: "none" }), cases: ids });
    if (more) return void say(`calib: ${topUpContrast(run).length} more fidelity pairs appended to labels/pairs.json: label them at /evals/label/, then rte calib --check --cap n`);
    const page = (await rig.tab(0, "A", champ.tree)).page;
    // One page: assemble() asks for its probes' captures at once, and two loads racing on one page never finished.
    let busy: Promise<unknown> = Promise.resolve();
    const shot = (scene: SceneJSON, camera: View) => {
      const r = busy.then(async () => (await loadPage(page, run, "calib-shot", scene, camera), capture(page, { width: LOOP.judgePx, quality: LOOP.judgeQuality })));
      busy = r.catch(() => {});
      return r;
    };
    const pairs = await assemble({ aa: ck0.run, contrast: run, seed: run, capture: shot });
    say(`calib: ${pairs.length} pairs in labels/pairs.json: label them at /evals/label/ (60 clear fidelity, 30 craft), then rte calib --check`);
  }));
}

// ---- The owner's own commits: sync (§8.6)

/** Merges the owner's master into the champion as an owner step: G0's build checks, the bank's scene round trip, a checkpoint. */
async function sync(gw: string, st: State): Promise<"merged" | "nothing" | "paused"> {
  const p = paths();
  openHistory();
  git(p.repo, "fetch", "-q", "origin", upstream());
  const master = git(p.repo, "rev-parse", "FETCH_HEAD");
  const base = championSha();
  if (isAncestor(master, base)) {
    // The owner undid what conflicted: nothing to merge, nothing blocks.
    if (st.blocked?.startsWith("sync:")) (st.blocked = undefined), saveState(st);
    return "nothing";
  }
  const block = (why: string) => {
    ownerItem(`sync: ${why}`);
    commitHistory(`sync paused: ${why.slice(0, 80)}`);
    st.blocked = `sync: ${why}`;
    saveState(st);
    say(`sync: PAUSED: ${why}`);
    return "paused" as const;
  };
  const wt = worktreeOf(`sync/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (tryGit(wt, ...IDENT, "merge", "-q", "--no-edit", "-m", "Merge the owner's master into the champion (rte sync)", "-m", CO_AUTHOR, master) === undefined) {
    const files = (tryGit(wt, "diff", "--name-only", "--diff-filter=U") ?? "").split("\n").join(", ");
    tryGit(wt, "merge", "--abort");
    return block(`master ${master.slice(0, 12)} conflicts with the champion in ${files || "?"}: resolve it on master, then rte sync`);
  }
  const merged = git(wt, "rev-parse", "HEAD");
  // Commits that change no product file (evals/, docs, the bake's pictures.json) leave every arm's tree as it was:
  // the champion takes them without a checkpoint, which would measure the same product again (~600 calls).
  if (contentHash(merged) === contentHash(base)) {
    git(p.repo, "branch", "-f", "loop/champion", merged);
    if (st.blocked?.startsWith("sync:")) (st.blocked = undefined), saveState(st);
    say(`sync: master ${master.slice(0, 12)} changes no product file: the champion takes it without a checkpoint`);
    return "merged";
  }
  // G0's build checks only: the path, UX and lint gates bind the loop's own candidates, not the owner.
  let tree: string;
  try {
    tree = treeOf(merged);
  } catch (err) {
    if (err instanceof LockfileDiffers) return block(err.message);
    throw err;
  }
  const broken = typecheck(tree);
  if (broken.length) return block(`${broken.map((f) => f.why).join("; ")} (update evals/ on master, then rte init --refresh)`);
  // V8 on every banked and yardstick before-scene through the merged Scene.fromJSON: a banked case that fails is
  // refused; a yardstick case that fails is the owner's (B1 refrozen, a new era) before the champion can take it.
  const scenes = bankedScenes().filter((f) => !f.includes(".void"));
  const rt = sceneRoundTrip(tree, [...scenes, ...benchCases().map((c) => join(c.dir, "before.scene.json"))]);
  const failed = rt.failed.filter((f) => f.startsWith(`${p.bankCases}/`));
  const other = rt.failed.find((f) => !failed.includes(f));
  if (other) return block(`master's Scene.fromJSON refuses ${other}: refreeze the yardstick (bench freeze, a new era) first`);
  const commits = Number(git(p.repo, "rev-list", "--count", `${base}..${master}`));
  const ck = await runCheckpoint(gw, st.epoch, { commits, baseSha: base, candSha: merged }, { sha: merged, tree });
  git(p.repo, "branch", "-f", "loop/champion", merged);
  for (const f of failed) voidCase(dirname(f.slice(0, f.indexOf(": "))), `V8 after rte sync to ${master.slice(0, 12)}: ${f}`);
  if (failed.length > LOOP.sync.sceneFailMax * scenes.length) {
    ownerItem(`sync: a scene-format change in ${master.slice(0, 12)}: ${failed.length} of ${scenes.length} banked before-scenes don't round-trip; they're refused and a bank refresh is queued`);
    st.refreshQueued = `scene format (${master.slice(0, 12)})`;
    commitHistory("owner list: a scene-format change, bank refresh queued");
  }
  Object.assign(st, { blocked: undefined, lastOwnerStep: new Date().toISOString(), keepsSinceCheckpoint: 0, paused: [] });
  saveState(st);
  say(`sync: ${commits} owner commits merged into the champion as an owner step (${ck.id})${failed.length ? `; ${failed.length} banked cases refused (V8)` : ""}`);
  return "merged";
}
async function syncCmd() {
  needCap("sync");
  const st = readState() ?? newState(nextEpoch());
  const r = await withGateway((gw) => sync(gw, st));
  if (r === "nothing") say("sync: master has nothing new for the champion");
  return r === "paused" ? 1 : 0;
}

// ---- One decision: the funnel (§1.2)

type Fakes = Partial<Pick<typeof agents, "analyst" | "critic" | "engineer">> & { judge?: (run: string, card: HypothesisCard) => Judge | undefined };
let fakes: Fakes = {};
const engine = () => ({ analyst: fakes.analyst ?? agents.analyst, critic: fakes.critic ?? agents.critic, engineer: fakes.engineer ?? agents.engineer });
const hasU1 = () => benchCases().some((c) => c.bench === "U1");
/** Machine suspends the heartbeat saw (V10): a decision in flight through one is void. */
const suspends: number[] = [];

/** The last checkpoint's debts and cost against the anchor, for the vetoes (§1.4 items 3, 4, 6). */
function loopState(): LoopState {
  const last = (historyRows("checkpoints.jsonl") as StoredCheckpoint[]).at(-1);
  const u = last?.productUsdPerSend;
  return { latencyDebt: !!last?.debts.latency.debt, qualityDebt: !!last?.debts.quality.debt, costVsAnchor: u && u.anchor > 0 ? u.champion / u.anchor : 1 };
}
/** Request hashes this run already paid for: a resumed run gets them from the cache (§6.5's resume cache). */
const paid = (run: string) => meterOf(run).filter((c) => product(c) && c.mode === "live" && c.shared !== "follower" && !c.apiError).map((c) => c.reqHash);
/** A decision's live $ so far, the candidate arm's product calls left out: what the candidate itself costs is the cost veto's (usdRatio), never a harness overrun. */
const spent = (prefix: string) => readMeter(paths().calls).reduce((a, l) => a + ("agent" in l ? 0 : l.run.startsWith(prefix) && l.mode === "live" && l.shared !== "follower" && l.arm !== "B" ? l.listUsd : 0), 0);

/** Rows for the fork cases drive.ts wrote to a run (G4 continuations, top-ups): judged at once (the gateway caps eval roles), kept in rows.jsonl. */
async function forkedRows(run: string, ids: string[], judge: Judge, o: { seed: string; cls: Row["class"]; cluster: (id: string) => string }): Promise<Row[]> {
  const pos = positionsFor(ids, o.seed);
  const voided = await Promise.all(ids.map((id) => judgedOnce(judge, id, pos.get(id)!)));
  const calls = meterOf(run);
  return ids.map((id, i) => {
    const info = maybe<CaseInfo>(caseFile(id, "case.json", run))!;
    const fork = maybe<Fork>(join(caseDir(run, id), "fork.json"))!;
    const row = rowOf(run, { case: id, cluster: o.cluster(id), affected: true, class: o.cls, overuse: [false, false], ask: info.ask, beat: info.beat, firstArm: fork.order[0], void: voided[i] }, calls);
    appendRow(run, row);
    return row;
  });
}
/** Each case slot's pages of both arms and the driver's context, for live fork sends in a decision run. */
async function forkCtx(rig: Rig, arms: Arms, run: string): Promise<{ ctx: DriveCtx; slots: Pages[] }> {
  const slots = await Promise.all(Array.from({ length: rig.slots }, async (_, k): Promise<Pages> => ({ A: (await rig.tab(k, "A", arms.A.tree)).page, B: (await rig.tab(k, "B", arms.B.tree)).page })));
  return { slots, ctx: { run, arms: { A: { sha: arms.A.sha, tuningId: await tuningIdOf(slots[0].A) }, B: { sha: arms.B.sha, tuningId: "", tuning: arms.B.tuning } }, harnessTag: harnessTag() } };
}

/** G4 (class D): the driver continues on B's result; each send is forked, judged and made a row (a veto only). */
const continuation = (rig: Rig, arms: Arms, run: string) => async (caseId: string, b: { run: string; after: SceneJSON; camera: View }, sends: number, slot: number): Promise<Row[]> => {
  const had = readRows(run).filter((r) => r.case.startsWith(`${caseId}-k`));
  if (had.length) return had; // a resumed decision paid for this one already
  const { ctx, slots } = await forkCtx(rig, arms, run);
  const s = await continueFrom(ctx, slots[slot], caseId, b, sends, "B");
  return forkedRows(run, s.cases.filter((c) => existsSync(caseDir(run, c))), judging(run, { seed: run, craft: "none" }), { seed: run, cls: "D", cluster: () => caseId });
};

/** A fork send's arms differ: their product requests, or their after-scenes. Only those are judged (§1.3). */
function differs(run: string, id: string): boolean {
  const reqs = (a: Arm) => (maybe<{ calls: { reqHash: string }[] }>(join(caseDir(run, id), a, "result.json"))?.calls ?? []).map((c) => c.reqHash).sort().join();
  return !maybe<Fork>(join(caseDir(run, id), "fork.json"))?.identicalAfter || reqs("A") !== reqs("B");
}
/** A top-up's fork case (bank.ts' c-u<k>-s<n>-<send>), not a continuation of one (<case>-k<n>). */
const TOP_UP = /^c-u\d+-s\d+-\d+$/;
const clusterIn = (run: string) => (id: string) => maybe<CaseInfo>(caseFile(id, "case.json", run))!.originSession;
/** A top-up whose case was written whole: one whose expectation came back unreadable (V7) has sends but no case.json. */
const deposited = (run: string, id: string) => existsSync(caseFile(id, "case.json", run));
/** Top-ups (§1.3) for a decision whose bank ran short: live fork sends on the champion, continuing on A, deposited as new cases. */
const topUps = (rig: Rig, arms: Arms, run: string, judge: Judge, cls: Row["class"]) => async (n: number): Promise<Row[]> => {
  const { ctx, slots } = await forkCtx(rig, arms, run);
  const k = nextTopUp();
  const ids = (await topUp(ctx, slots, n, k)).filter((id) => existsSync(caseDir(run, id)) && deposited(run, id) && differs(run, id));
  return forkedRows(run, ids, judge, { seed: `${run} top-up ${k}`, cls, cluster: clusterIn(run) });
};
/**
 * A resumed decision's top-ups: every send it already paid for, and their rows (judging those a stop cut off before theirs).
 * Its banked cases aren't among them, though an earlier decision's top-ups are banked under the same c-u names.
 */
async function toppedUp(run: string, banked: string[], judge: Judge, cls: Row["class"]): Promise<{ sends: number; rows: Row[] }> {
  const dirs = existsSync(runFile(run, "cases")) ? readdirSync(runFile(run, "cases")) : [];
  const not = new Set(banked);
  const ids = [...new Set(dirs.map((d) => d.replace(/\.void(\.\d+)?$/, "")))].filter((id) => TOP_UP.test(id) && !not.has(id));
  const had = new Set(readRows(run).map((r) => r.case));
  const cut = ids.filter((id) => !had.has(id) && existsSync(join(caseDir(run, id), "done")) && deposited(run, id) && differs(run, id));
  if (cut.length) await forkedRows(run, cut, judge, { seed: `${run} top-up resumed`, cls, cluster: clusterIn(run) });
  const own = new Set(ids);
  return { sends: ids.length, rows: readRows(run).filter((r) => own.has(r.case)) };
}

/** What a decision teaches the next analyst: its candidate-loss digest and one failure-analyst call on its losses. */
async function lessons(run: string, rows: Row[]) {
  if (!existsSync(runFile(run, "rows.jsonl"))) return;
  writeLossDigest(run);
  const lost = rows.filter((r) => !r.void && r.s < 0).slice(0, 12);
  if (lost.length) put(runFile(run, "failures.json"), await agents.failureAnalyst(failureDigest(lost.map((r) => ({ case: r.case, run }))), run).catch(() => []));
}

/** One card through G0 → G1 → G2 (→ G3, G4) → vetoes; a keep fast-forwards loop/champion. Recorded either way. */
async function decideCard(gw: string, st: State, c: CardState, attempt = ""): Promise<Decided> {
  const p = paths();
  const id = `${c.id}${attempt}`;
  const run = (stage: string) => `${st.stamp}-${id}-${stage}`;
  const base = championSha();
  const cand = c.cand!;
  const t0 = Date.now();
  const affected = { tuning: 0, of: 0, topUp: 0 };
  const record = (d: Decision, at: string, result: Omit<ABResult, "invariants"> = { rows: [] }, owner: string[] = []) => {
    const row = decisionRow({ id, epoch: st.epoch, card: c.card, candSha: cand, baseSha: base, run: at, judgeId: judgeId("fidelity", lastServed(), variants().fidelity), result: { ...result, decision: d }, affected });
    if (d.verdict === "keep") git(p.repo, "branch", "-f", "loop/champion", cand);
    if (!historyRows("decisions.jsonl").some((x) => x.id === id)) recordDecision(row, { owner });
    c.run = at;
    say(`${id}: ${d.verdict} (${d.class}, ${d.goal}): ${[...d.reasons, ...d.vetoes].join("; ")}`);
    return row;
  };
  // The card is done in state.json at once: a stop before lessons() and the rig's close would otherwise re-decide a keep
  // on resume as "no change was made" (its candidate is the champion by then).
  const settle = (d: Decided): Decided => {
    if (!st.cards.includes(c)) return d; // rte decide: no epoch's card
    Object.assign(c, { status: "done", verdict: d.verdict });
    st.recent = [...st.recent, d].slice(-50);
    if (d.verdict === "keep") st.keepsSinceCheckpoint++, st.keepsSinceRefresh++;
    saveState(st);
    return d;
  };
  const gate = (verdict: "revert" | "owner", reasons: string[], o: { owner?: string[]; cls?: Decision["class"] } = {}): Decided => {
    const d: Decision = { verdict, reasons, goal: c.card.goal, class: o.cls ?? c.card.classGuess, looks: [], vetoes: [], configId, counts: { wins: 0, losses: 0, ties: 0, n: 0, look: 0 }, latency: { byThinking: {}, tails: {} }, work: 1, emptyRise: 0, failedPicRise: 0, usdRatio: 1 };
    put(runFile(run("g0"), "verdict.json"), d);
    record(d, run("g0"), undefined, o.owner ?? (verdict === "owner" ? reasons : []));
    return settle({ id, verdict, component: c.card.component, at: new Date().toISOString() });
  };
  // More than 2× its class's $ per measured case (the candidate's calls aside), or past 30 min of measuring at 8 slots: harness suspect (§6.7).
  const overBy = (cls: Decision["class"], measured: number, slots: number) => {
    const usd = spent(`${st.stamp}-${id}-`), minutes = (Date.now() - t0) / 60_000;
    return overrun(cls, usd, measured, minutes, slots) ? `overran: $${usd.toFixed(2)} (the candidate's calls aside) for ${measured} measured cases in ${minutes.toFixed(0)} min (class ${cls}: $${CASE_USD[cls]} a case)` : undefined;
  };

  // G0, free: the diff's gates, then (code cards) the typecheck and the scene round trip in the candidate's tree.
  if (cand === base) return gate("revert", ["no change was made"]);
  const knob = c.card.kind === "knob";
  let tree: string | undefined;
  try {
    tree = knob ? undefined : treeOf(cand);
  } catch (err) {
    if (err instanceof LockfileDiffers) return gate("owner", [err.message]);
    throw err;
  }
  const g = g0({ diff: diffOf(p.repo, base, cand), tree, ownerOk: c.card.ownerOk });
  if (g.waived) say(`${id}: the owner waived ${g.waived.length} owner finding${g.waived.length > 1 ? "s" : ""}: ${g.waived.join("; ").slice(0, 300)}`);
  if (g.verdict !== "pass") return gate(g.verdict === "owner" ? "owner" : "revert", g.reasons);

  // A knob card is one tree with two tunings (§7.2).
  const champ: ArmSpec = { sha: base, tree: treeOf(base) };
  const arms: Arms = { A: champ, B: knob ? { sha: cand, tree: champ.tree, tuning: c.card.knobs } : { sha: cand, tree: tree! } };
  const decided = await withRig(gw, [arms.A.tree, arms.B.tree], async (rig) => {
    // G1: the diffscan at 0 calls (a finished scan is read back on resume).
    const scanRun = run("scan");
    const sc = maybe<ScanResult>(runFile(scanRun, "scan.json")) ?? (await scan(rig, { run: scanRun, arms, seed: scanRun, card: c.card, cases: banked(["tuning", "fresh", "heldout-gate"]) }));
    const tuning = [...(sc.affected.tuning ?? []), ...(sc.affected.fresh ?? [])];
    Object.assign(affected, { tuning: tuning.length, of: sc.cases.filter((x) => x.set !== "heldout-gate").length });
    if (o.f["quality-only"] && sc.class === "S") {
      say(`${id}: a schedule change (S): latency-goal cards wait for the PGX (--quality-only)`);
      return settle({ id, verdict: "deferred", component: c.card.component, at: new Date().toISOString() });
    }
    // Top-ups are live sends (R runs on the banked replies: a top-up has none). Too rare (§1.3) at 0 calls when even
    // every top-up send, affected at the scan's rate, can't bring the affected cases to LOOP.rareMin.
    const tops = sc.class === "Q" || sc.class === "D";
    const more = tops && affected.of ? (LOOP.topUpMaxSends * tuning.length) / affected.of : 0;
    if (sc.class !== "N" && sc.class !== "S" && tuning.length + more < LOOP.rareMin) {
      const why = `too rare to measure: ${tuning.length} affected cases${tops ? `, ~${more.toFixed(0)} more from ${LOOP.topUpMaxSends} top-up sends` : ""} (< ${LOOP.rareMin})`;
      return gate("revert", [why], { owner: [why], cls: sc.class });
    }
    let at: string, result: ABResult;
    if (sc.class === "N" || sc.class === "S") {
      // N reverts at 0 calls; S is decided on the timed replay's latency, also at 0 calls.
      at = sc.class === "N" ? scanRun : sc.timed!.run;
      const sets = new Map(sc.cases.map((x) => [x.case, x.set]));
      const rows = readRows(at).filter((r) => sets.get(r.case) !== "heldout-gate").map((r) => ({ ...r, class: sc.class, affected: sc.class === "S" }));
      result = { rows, decision: decide({ tuning: rows, exhausted: true }, c.card, loopState()), invariants: [] };
      put(runFile(at, "verdict.json"), result.decision!);
    } else {
      // G2 (+ G3, G4): only the affected cases, live (R: on the banked replies), identical calls shared and cached.
      at = run("ab");
      const judge = fakes.judge?.(at, c.card) ?? judging(at, { seed: at, craft: c.card.goal === "craft" ? "all" : "sampled" });
      result = await runAB(rig, {
        run: at, kind: "ab", arms, mode: sc.class === "R" ? "scan" : "live", share: true, cached: [...sc.cached, ...paid(at)], seed: at, card: c.card, judge, cases: tuning,
        cls: sc.class,
      }, {
        card: c.card, state: loopState(), heldout: sc.affected["heldout-gate"], continueFrom: sc.class === "D" ? continuation(rig, arms, at) : undefined,
        topUp: tops ? topUps(rig, arms, at, judge, sc.class) : undefined, toppedUp: tops ? await toppedUp(at, tuning, judge, sc.class) : undefined, overrun: (n) => overBy(sc.class, n, rig.slots),
      });
      affected.topUp = result.topUps ?? 0;
    }
    let d = result.decision!;
    const owner: string[] = [];
    // A timing trip voided its case only (ab.ts' Invariant): the harness is suspect when the arms got different things.
    const v9 = result.invariants.some((x) => x.why.startsWith("V9") && !x.timing);
    if (suspends.some((t) => t >= t0) && d.verdict !== "void") d = { ...d, verdict: "void", reasons: [...d.reasons, "V10: the machine was suspended during the decision"] };
    // A void is rerun once (new runs, after this rig closes), then goes to the owner list (§1.4 item 9). Not an overrun:
    // rerunning it would pay G2 again on the harness it suspects, and hide it from the night's overrun count.
    if (d.verdict === "void" && !attempt && !v9 && !result.overrun) {
      record(d, at, result);
      st.recent.push({ id, verdict: "void", component: c.card.component, at: new Date().toISOString() });
      return "rerun" as const;
    }
    if (d.verdict === "void") owner.push(`void: ${d.reasons.join("; ")}`);
    if (d.ownerList) owner.push(`too rare to measure: ${result.rows.filter((r) => !r.void).length} affected cases`);
    if (d.verdict === "owner") owner.push(...d.vetoes);
    if (d.verdict === "keep") {
      const hold = [...cardOwnerReasons(c.card, { u1: hasU1() }), ...(c.card.goal === "craft" && !variants().craftCalibrated ? ["a craft keep before craft calibration passed"] : [])];
      if (hold.length) (d = { ...d, verdict: "owner", vetoes: [...d.vetoes, ...hold] }), owner.push(...hold);
    }
    // The whole path's measuring against its class budget per case (§6.7): void, harness suspect.
    const measured = [...result.rows, ...(result.heldout ?? []), ...(result.continuation ?? [])].filter((r) => !r.void).length + (result.topUps ?? 0);
    // A no-effect card (class N) ends at the scan and its timed replay, both a fixed size: its $0 a case budget is for
    // the decision past them, so the timed replay's live calls (a champion whose prompts the bank doesn't hold) don't overrun it.
    const over = result.overrun ?? (d.verdict === "void" || d.class === "N" ? undefined : overBy(d.class, measured, rig.slots));
    if (over && !result.overrun) d = { ...d, verdict: "void", reasons: [...d.reasons, over] };
    record(d, at, { ...result, decision: d }, owner);
    const done = settle({ id, verdict: d.verdict, component: c.card.component, at: new Date().toISOString(), overrun: !!over, v9 });
    await lessons(at, result.rows);
    return done;
  });
  return decided === "rerun" ? decideCard(gw, st, c, "r") : decided;
}

// ---- Building cards: knob cards by script, code cards by engineers

/** A knob card's commit: the defaults in tuning.ts set to the card's values, within each knob's range. */
function applyKnobs(wt: string, knobs: Record<string, number>) {
  const file = join(wt, "src/core/tuning.ts");
  let src = readFileSync(file, "utf8");
  for (const [key, v] of Object.entries(knobs)) {
    const k = key.replace(/\./g, "\\.");
    const lit = new RegExp(`(\\b(K|B)\\("${k}",\\s*)(-?[\\d.]+)(,\\s*(-?[\\d.]+),\\s*(-?[\\d.]+))?`).exec(src);
    const role = /^(\w+)\.prompt$/.exec(key)?.[1];
    const variant = role && new RegExp(`\\{ \\.\\.\\.P\\("${role}"\\), value: [\\d.]+ \\}|\\bP\\("${role}"\\)`).exec(src);
    if (lit) {
      const [min, max] = lit[2] === "B" ? [0, 1] : [Number(lit[5]), Number(lit[6])];
      if (!(v >= min && v <= max)) throw new Error(`knob ${key} = ${v} is outside its range ${min}–${max}`);
      src = src.replace(lit[0], `${lit[1]}${v}${lit[4] ?? ""}`);
    } else if (variant) src = src.replace(variant[0], `{ ...P("${role}"), value: ${v} }`);
    else throw new Error(`no knob ${key} with a literal default in src/core/tuning.ts`);
  }
  writeFileSync(file, src);
}

/** Builds a card on its branch (cand/e<E>-h<n>, off the champion): a commit, or the champion itself when nothing changed. */
async function build(gw: string, st: State, c: CardState) {
  try {
    const wt = worktreeOf(c.branch);
    if (git(wt, "status", "--porcelain")) git(wt, "reset", "-q", "--hard"), git(wt, "clean", "-qfd");
    if (Number(git(wt, "rev-list", "--count", "loop/champion..HEAD")) === 0) {
      if (c.card.kind === "knob") applyKnobs(wt, c.card.knobs ?? {});
      else await engine().engineer({ card: c.card, branch: c.branch, run: `${st.stamp}-${c.id}-engineer`, token: await agents.slotToken(tokens(), gw), mockApi: await agentMock() });
      if (git(wt, "status", "--porcelain")) commitAll(wt, `${c.card.change}\n\n${c.id}: a ${c.card.kind} card on ${c.card.component} (goal ${c.card.goal}), written by the eval loop`);
    }
    Object.assign(c, { cand: git(wt, "rev-parse", "HEAD"), status: "built" });
  } catch (err) {
    say(`${c.id}: not built: ${msg(err)}`);
    c.status = "dropped";
  }
  saveState(st);
}

/** The candidate on top of today's champion (a keep moved it); a conflict rebuilds it once (the engineer once more). */
async function rebased(gw: string, st: State, c: CardState): Promise<boolean> {
  const champ = championSha();
  if (isAncestor(champ, c.cand!)) return true;
  const wt = worktreeOf(c.branch);
  if (tryGit(wt, ...IDENT, "rebase", "-q", "loop/champion") !== undefined) {
    c.cand = git(wt, "rev-parse", "HEAD");
    return true;
  }
  tryGit(wt, "rebase", "--abort");
  git(wt, "reset", "-q", "--hard", "loop/champion");
  say(`${c.id}: conflicts with the moved champion: built once more`);
  await build(gw, st, c);
  return c.status === "built";
}

// ---- The loop (§8.1)

const nextEpoch = () => Math.max(0, ...historyRows("epochs.jsonl").map((e) => e.epoch)) + 1;
let readyAtStart = false;
let diskAtStart: { at: number; gb: number } | undefined;
let nightWindows: number = LOOP.nightWindows;
/** $ a meter line spent: an agent session's cost, an upstream call's list $ (a follower and a replay pay nothing). */
const paidUsd = (l: ReturnType<typeof readMeter>[number]) => ("agent" in l ? l.totalCostUsd : l.mode === "live" && l.shared !== "follower" ? l.listUsd : 0);

/** The meter read as it grows: $ and upstream calls since `from` (ms), by role, without rereading the whole file. */
class MeterTail {
  private off = 0;
  private rest = "";
  usd = 0;
  calls = 0;
  byRole: Record<string, number> = {};
  private file: string;
  private from: number;
  constructor(file: string, from: number) {
    this.file = file;
    this.from = from;
  }
  read(): this {
    if (!existsSync(this.file)) return this;
    const size = statSync(this.file).size;
    if (size <= this.off) return this;
    const buf = Buffer.alloc(size - this.off);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.off);
    } finally {
      closeSync(fd);
    }
    this.off = size;
    const parts = (this.rest + buf.toString("utf8")).split("\n");
    this.rest = parts.pop() ?? "";
    for (const raw of parts) {
      if (!raw.trim()) continue;
      const l = JSON.parse(raw) as ReturnType<typeof readMeter>[number];
      if (Date.parse(l.at) < this.from) continue;
      const usd = paidUsd(l);
      this.usd += usd;
      if (!("agent" in l) && usd > 0) this.calls++;
      this.byRole[l.role] = (this.byRole[l.role] ?? 0) + usd;
    }
    return this;
  }
}

/** This leg of the loop (since it last started or resumed): its notices (config.ts' NOTIFY), the meter since it began. */
let leg = { start: Date.now(), every: { ...NOTIFY } as Record<keyof typeof NOTIFY, number>, sent: new Set<string>(), spent: new MeterTail("", 0), night: new MeterTail("", 0) };
const stopFile = () => join(paths().home, "stop.request");
/** A long step (a decision, a checkpoint) still gets its notices: the clock and the meter are looked at this often. */
const NOTICE_MS = 60_000;
let noticeChain: Promise<void> = Promise.resolve();
/** Sends the notices due (and `extra`): the log and notices.jsonl, each once per leg. Never stops anything. */
const notify = (gw: string, st: State, extra?: Omit<Notice, "key">) => (noticeChain = noticeChain.then(() => notifyNow(gw, st, extra)).catch((err) => say(`notice: skipped (${msg(err)})`)));
async function notifyNow(gw: string, st: State, extra?: Omit<Notice, "key">) {
  const spent = leg.spent.read(), night = leg.night.read();
  const s = (await gatewayStatus(gw)) as { slots: SlotStatus[] };
  const W = s.slots.reduce((a, x) => a + x.windowUsd, 0) / Math.max(1, s.slots.length);
  const decided = st.recent.filter((d) => Date.parse(d.at) >= leg.start);
  const cks = (historyRows("checkpoints.jsonl") as StoredCheckpoint[]).filter((c) => Date.parse(c.at) >= leg.start);
  const due = notices({ now: Date.now(), leg: { start: leg.start, usd: spent.usd, decisions: decided.length, checkpoints: cks.map((c) => c.id) }, every: leg.every, nightUsd: night.usd, nightCapUsd: nightWindows * W }, leg.sent);
  if (extra) due.push({ key: `${extra.kind}:${Date.now()}`, ...extra });
  if (!due.length) return;
  const rows = new Map(historyRows("decisions.jsonl").map((d) => [d.id, d]));
  const minutes = (Date.now() - leg.start) / 60_000;
  const byRole = Object.entries(spent.byRole).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([role, usd]) => `${role} $${usd.toFixed(2)}`);
  const summary = {
    epoch: st.epoch, champion: championSha(), minutes: Math.round(minutes), calls: spent.calls, listUsd: spent.usd, byRole, nightUsd: night.usd, nightCapUsd: nightWindows * W,
    decided: decided.map((d) => ({ id: d.id, verdict: d.verdict, change: rows.get(d.id)?.card?.change ?? d.component, why: rows.get(d.id)?.reasons.slice(0, 2) })),
    checkpoints: cks.map((c) => ({ id: c.id, trust: c.trust, share: c.share.all?.share })),
    stop: "rte stop-after (before the next step: nothing lost; loop --resume goes on)",
  };
  for (const n of due) {
    leg.sent.add(n.key);
    appendLine(join(paths().home, "notices.jsonl"), { at: new Date().toISOString(), ...n, ...summary });
    say(`loop: NOTICE (${n.kind}): ${n.why}; this leg ${summary.minutes} min, ${summary.calls} calls, $${spent.usd.toFixed(2)} list${byRole.length ? ` (${byRole.slice(0, 3).join(", ")})` : ""}, ${decided.length} decisions${n.kind === "stopped" ? "" : `; to stop: ${summary.stop}`}`);
  }
}
type SlotStatus = { slot: SlotN; fiveHour?: number; sevenDay?: number; sevenDayAt?: number; resetsAt?: number; status?: string; usdThisWindow: number; windowUsd: number; usd7d: number; why?: string };

async function facts(gw: string, st: State, error?: string): Promise<Facts> {
  const s = (await gatewayStatus(gw)) as { pace: Facts["pace"]; slots: SlotStatus[]; cap?: number; capReached: boolean };
  const W = s.slots.reduce((a, x) => a + x.windowUsd, 0) / s.slots.length;
  const nightStart = Date.parse(st.nightStart);
  const lines = readMeter(paths().calls);
  const nightUsd = lines.reduce((a, l) => a + (Date.parse(l.at) < nightStart ? 0 : paidUsd(l)), 0);
  const fs = statfsSync(paths().home);
  const gb = (fs.bavail * fs.bsize) / 1e9;
  diskAtStart ??= { at: Date.now(), gb };
  const perDay = ((diskAtStart.gb - gb) / (Date.now() - diskAtStart.at)) * DAY;
  return {
    now: Date.now(), pace: s.pace, nightUsd, nightCapUsd: nightWindows * W, nightStart, recent: st.recent, ownerStepAt: Date.parse(st.lastOwnerStep ?? "1970-01-01"), checkpointAt: Date.parse(historyRows("checkpoints.jsonl").at(-1)?.at ?? "1970-01-01"), ready: readyAtStart, calib: o.mockApi ? "dry" : maybe<{ outcome: string }>(calibrationFile())?.outcome, error: error ?? (s.capReached ? `call cap ${s.cap} reached` : undefined),
    blocked: st.blocked, emptyEpochs: st.emptyEpochs ?? 0, overloads: lines.flatMap((l) => ("agent" in l || !l.apiError || !/overload|529/i.test(l.apiError) ? [] : [Date.parse(l.at)])), diskGb: gb,
    daysLeft: perDay > 0 ? Math.max(0, (gb - LOOP.diskPauseGb) / perDay) : undefined, onAC: onAC(),
  };
}

/** When each slot's week was last checked (ms): a check the server answers without a reading waits WEEK_CHECK.afterH too. */
const weekChecked = new Map<SlotN, number>();
const weekOf = (x?: SlotStatus) => (x?.sevenDay === undefined ? "unknown" : `${Math.round(x.sevenDay * 100)}%`);

/** WEEK_CHECK: one one-word call on each token parked for its week on an old reading (or none), so its week is read again. */
async function recheckWeeks(gw: string) {
  const s = (await gatewayStatus(gw)) as { stale?: SlotN[]; slots: SlotStatus[] };
  for (const slot of s.stale ?? []) {
    if (Date.now() - (weekChecked.get(slot) ?? 0) < WEEK_CHECK.afterH * HOUR) continue;
    weekChecked.set(slot, Date.now());
    // Its own request each time: the run's cache would serve a repeat.
    const req = { role: "probe", model: "haiku", system: "Answer with one word.", user: `Week check, slot ${slot}, ${new Date().toISOString()}?`, run: `week-${stampNow()}`, token: slot } as const;
    const error = await ask(req, gw).then(() => "", (e: Error) => e.message);
    const now = ((await gatewayStatus(gw)) as { slots: SlotStatus[] }).slots.find((x) => x.slot === slot);
    say(`loop: token ${slot}'s week read again: ${weekOf(s.slots.find((x) => x.slot === slot))} to ${weekOf(now)} of its weekly limit (the loop stops at ${Math.round(LOOP.weekSevenDayMax * 100)}%)${error ? `; the call failed: ${error}` : ""}; ${now?.why ? `still parked: ${now.why}` : "back in use"}`);
  }
}

/** §6.7 before new work: true when a rule stops the loop (it says why); pauses wait here. */
async function halt(gw: string, st: State, error?: string): Promise<boolean> {
  await notify(gw, st);
  // The owner asked for a stop (rte stop-after): here, between steps, nothing is lost.
  if (existsSync(stopFile())) {
    rmSync(stopFile());
    say("loop: STOP: as the owner asked (rte stop-after); loop --resume goes on from here");
    await notify(gw, st, { kind: "stopped", why: "stopped as asked (rte stop-after); loop --resume goes on from here" });
    return true;
  }
  for (;;) {
    await recheckWeeks(gw);
    const acts = rules(await facts(gw, st, error));
    const noted = acts.filter((a) => a.do === "owner" || a.do === "stop" || a.do === "skip");
    for (const a of noted) ownerItem(a.why);
    for (const a of acts) if (a.do === "skip" && !st.paused.includes(a.component!)) st.paused.push(a.component!);
    if (noted.length) commitHistory(`owner list: ${noted.map((a) => a.why).join("; ").slice(0, 100)}`);
    const stop = acts.find((a) => a.do === "stop");
    if (stop) {
      say(`loop: STOP: ${stop.why}`);
      await notify(gw, st, { kind: "stopped", why: `the loop stopped: ${stop.why}` });
      return true;
    }
    const pauses = acts.filter((a) => a.do === "pause");
    if (!pauses.length) return false;
    const until = Math.max(...pauses.map((a) => a.until!));
    say(`loop: pause until ${new Date(until).toISOString()}: ${pauses.map((a) => a.why).join("; ")}`);
    await sleep(Math.max(1000, until - Date.now()));
  }
}

/** ≤ 3 cards: queued seed cards first, else digests → analyst → critic (§8.2). */
async function propose(gw: string, st: State): Promise<HypothesisCard[]> {
  if (st.queue.length) return st.queue.splice(0, 3);
  const sha = championSha();
  const last = (historyRows("checkpoints.jsonl") as StoredCheckpoint[]).at(-1);
  const ck = last && { run: last.run, champion: "B" as Arm };
  const run = `${st.stamp}-e${st.epoch}-analyst`;
  const notes = [...(await agents.championFailures(sha, run, ck)), ...st.lastRuns.flatMap((r) => maybe<agents.FailureNote[]>(runFile(r, "failures.json")) ?? [])];
  // What the coordinator would drop unrun: told up front, so an epoch isn't spent on cards that can't be measured.
  const wont = [
    ...(st.paused.length ? [`paused until the next checkpoint (dry well): cards on ${st.paused.join(", ")}`] : []),
    ...(o.f["quality-only"] ? ["latency-goal cards: this run is --quality-only (they wait for the PGX)"] : []),
    ...(!hasU1() ? ["cards on the ink readers (marks, arrow, hit, link): no U1 set to check them on, they go to the owner"] : []),
    "patch knobs, cost-raising changes, frozen areas and model switches: they go to the owner unmeasured",
  ];
  const digest = analystDigest({
    championSha: sha, checkpoint: ck, runs: st.lastRuns, wont, failures: notes.map((n) => `${n.case} · ${n.component} · ${n.tag}: ${n.evidence}`),
    ledger: historyRows("decisions.jsonl").slice(-12).map((d) => `${d.id} ${d.card?.change ?? d.reasons[0]} → ${d.verdict}`), tried: triedIndex(),
  });
  const analysis = await engine().analyst(digest, run);
  const criticRun = `${st.stamp}-e${st.epoch}-critic`;
  const r = await engine().critic({ run: criticRun, token: await agents.slotToken(tokens(), gw), analysis, digest, tried: triedIndex(), tree: treeOf(sha), mockApi: await agentMock() });
  // Its answer as written, so a dropped or empty epoch can be read back.
  put(runFile(criticRun, "critic.json"), { text: r.result?.text ?? "", cards: r.cards.map((c) => c.id), dropped: r.dropped });
  if (r.dropped.length) say(`critic: dropped ${r.dropped.join("; ")}`);
  return r.cards.slice(0, 3);
}

async function loopCheckpoint(gw: string, st: State): Promise<string> {
  const ck = await runCheckpoint(gw, st.epoch);
  Object.assign(st, { keepsSinceCheckpoint: 0, paused: [] });
  saveState(st);
  return ck.id;
}

/** Between epochs: the owner's master (at most daily), a bank refresh (5 keeps, weekly, or queued), the judge canary. */
async function between(gw: string, st: State) {
  if (Date.now() - Date.parse(st.lastOwnerStep ?? "1970-01-01") >= LOOP.sync.minHours * HOUR) await sync(gw, st);
  const lastRefresh = st.lastRefresh ?? maybe<{ at: string }>(join(paths().home, "bank", "gates.json"))?.at;
  if (st.refreshQueued || st.keepsSinceRefresh >= LOOP.bank.refreshEveryKeeps || (lastRefresh && Date.now() - Date.parse(lastRefresh) >= 7 * DAY)) {
    const n = st.refreshes + 1;
    const champ = championArm();
    try {
      await withRig(gw, [champ.tree], async (rig) => {
        const slots = await championPages(rig, champ.tree);
        const ctx: DriveCtx = { run: `${st.stamp}-refresh${n}`, arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(slots[0].A) } }, harnessTag: harnessTag() };
        const no = await probed(ctx, slots[0].A);
        if (no) throw new Error(no);
        const r = await refresh(ctx, slots, n);
        say(`refresh ${n}: ${r.cases.length} new cases, ${r.retired.length} to bank/archive${r.fails.length ? ` (the new cases failed ${r.fails.join("; ")})` : ""}`);
      });
    } catch (err) {
      ownerItem(`bank refresh ${n} failed: ${msg(err)}`);
      commitHistory(`owner list: bank refresh ${n} failed`);
    }
    Object.assign(st, { refreshes: n, keepsSinceRefresh: 0, refreshQueued: undefined, lastRefresh: new Date().toISOString() });
    saveState(st);
  }
  if (canaryDue()) {
    try {
      const h = await runCanary();
      historyAdd("health.jsonl", h);
      if (!h.pass) ownerItem(`judge drift: the canary agreed on ${(h.detail as { agree: number }).agree} of ${LOOP.canary.packets} stable packets, confirmed`);
      commitHistory(`canary: ${h.pass ? "stable" : "drift"}`);
    } catch (err) {
      say(`canary: skipped (${msg(err)})`);
    }
  }
}

/** One epoch: cards, built ahead (≤ 2 engineers at once) while the ones before them are measured, then decided in turn. */
async function epoch(gw: string, st: State): Promise<boolean> {
  const started = Date.now();
  if (!st.cards.length) {
    const cards = await propose(gw, st);
    st.cards = cards.map((card, i) => ({ id: `e${st.epoch}-h${i + 1}`, card, branch: `cand/e${st.epoch}-h${i + 1}`, status: "todo" }));
    saveState(st);
    say(`epoch ${st.epoch}: ${st.cards.map((c) => `${c.id} ${c.card.kind} ${c.card.component}: ${c.card.change}`).join(" | ") || "no cards"}`);
  }
  // Card rules that need no evidence (§8.4) send a card to the owner before anything is built.
  for (const c of st.cards.filter((x) => x.status === "todo")) {
    const why = cardOwnerReasons(c.card, { u1: hasU1() }).filter((w) => !/patch|cost/.test(w));
    const skip = st.paused.includes(c.card.component) ? `${c.card.component} is paused (dry well)` : o.f["quality-only"] && c.card.goal === "latency" ? "a latency-goal card waits for the PGX (--quality-only)" : undefined;
    if (why.length) ownerItem(`${c.id}: ${c.card.change}: ${why.join("; ")}`), commitHistory(`owner list: ${c.id}`);
    if (why.length || skip) (c.status = "dropped"), say(`${c.id}: not run: ${[...why, skip].filter(Boolean).join("; ")}`);
  }
  const two = limiter(2);
  const built = st.cards.map((c) => (c.status === "todo" ? two(() => build(gw, st, c)) : Promise.resolve()));
  let ck: string | undefined;
  let stopped = false;
  for (const [i, c] of st.cards.entries()) {
    await built[i];
    // decideCard marks the card done in state.json itself, right as it is recorded.
    if (c.status === "built" && !stopped && !(stopped = await halt(gw, st)) && (await rebased(gw, st, c))) {
      try {
        await decideCard(gw, st, c);
      } catch (err) {
        // A cap, a blocked request or a broken step: the rules say whether the loop goes on.
        say(`${c.id}: failed: ${msg(err)}`);
        if ((stopped = await halt(gw, st, msg(err)))) continue;
        throw err;
      }
    }
    // Here, not only after a decision: a resumed epoch owes the checkpoint a stop just before it skipped.
    if (!stopped && st.keepsSinceCheckpoint >= LOOP.checkpointEveryKeeps && !(stopped = await halt(gw, st))) ck = await loopCheckpoint(gw, st);
  }
  await Promise.allSettled(built);
  if (stopped) return false;
  // An epoch that decided nothing (no well-formed card, or every one dropped) pays the analyst and critic again for the
  // same digest: §6.7's rules stop the loop after RULES.emptyEpochs of them in a row.
  st.emptyEpochs = st.cards.some((c) => c.status === "done" && c.verdict !== "deferred") ? 0 : (st.emptyEpochs ?? 0) + 1;
  const rec = await epochRecord(gw, st, started, ck);
  say(`epoch ${st.epoch}: ${rec.decisions.length} decisions, ${rec.cost.calls} calls, $${rec.cost.listUsd.toFixed(2)} (${(100 * rec.cost.windowShare).toFixed(1)}% of a window), ${rec.minutes.total.toFixed(0)} min`);
  Object.assign(st, { epoch: st.epoch + 1, stamp: stampNow(), cards: [], lastRuns: st.cards.flatMap((c) => (c.run ? [c.run] : [])) });
  saveState(st);
  return true;
}

/** epochs.jsonl and budget.jsonl (§5.3) from the meter, one commit. */
async function epochRecord(gw: string, st: State, started: number, ck?: string): Promise<EpochRow> {
  const lines = readMeter(paths().calls).filter((l) => l.run.startsWith(`${st.stamp}-e${st.epoch}-`) || (ck !== undefined && l.run.startsWith(ck)));
  const zero = { calls: 0, usd: 0, agentUsd: 0, in: 0, cacheRead: 0, write5m: 0, write1h: 0, out: 0, thinking: 0 };
  const all = rollup(lines, () => "all").all ?? zero;
  const slots = ((await gatewayStatus(gw)) as { slots: SlotStatus[] }).slots;
  const W = slots.reduce((a, s) => a + s.windowUsd, 0) / slots.length;
  const agentMin = lines.reduce((a, l) => a + ("agent" in l ? (l as AgentLog).minutes : 0), 0);
  const measure = st.cards.reduce((a, c) => a + (c.run ? (maybe<{ meter: { minutes: number } }>(runFile(c.run, "run.json"))?.meter.minutes ?? 0) : 0), 0);
  const total = (Date.now() - started) / 60_000;
  const at = new Date().toISOString();
  const row: EpochRow = {
    epoch: st.epoch, at, era: (historyRows("checkpoints.jsonl").at(-1)?.era ?? 1), machine: arch() === "arm64" ? "pgx" : "laptop", championSha: championSha(), configId,
    decisions: st.cards.filter((c) => c.status === "done").map((c) => c.id), ...(ck ? { checkpoint: ck } : {}),
    cost: {
      listUsd: all.usd, windowShare: all.usd / W, calls: all.calls, agentUsd: all.agentUsd,
      byRole: Object.fromEntries(Object.entries(rollup(lines, (l) => l.role)).map(([k, r]) => [k, { calls: r.calls, usd: r.usd }])),
      tokens: { in: all.in, cacheRead: all.cacheRead, write5m: all.write5m, write1h: all.write1h, out: all.out, thinking: all.thinking },
    },
    minutes: { total, agents: agentMin, measure, idle: Math.max(0, total - agentMin - measure) },
    slots: slots.map((s) => ({ slot: s.slot, fiveHour: s.fiveHour, sevenDay: s.sevenDay, sevenDayAt: s.sevenDayAt, usdThisWindow: s.usdThisWindow, status: s.why ?? s.status ?? "ok" })),
  };
  historyAdd("epochs.jsonl", row);
  logBudget(slots, st.epoch, at);
  recordMachine();
  commitHistory(`epoch ${st.epoch}: ${row.decisions.length} decisions, $${all.usd.toFixed(2)}`);
  return row;
}

function limiter(n: number) {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    while (busy >= n) await new Promise<void>((r) => waiting.push(r));
    busy++;
    try {
      return await f();
    } finally {
      busy--;
      waiting.shift()?.();
    }
  };
}

async function loop() {
  // --cap bounds gateway calls only: the critic and engineers would run on the owner's own token past it.
  if (o.devToken) throw new Error("--dev-token is for capped smoke, bake and decide runs: the loop's agent sessions aren't under --cap");
  refuseFactorySlice();
  const held = lock(); // first: a second loop refuses before it touches anything
  const stopBeat = heartbeat((gap) => (suspends.push(Date.now()), say(`loop: a ${Math.round(gap / 1000)}-s suspend: the decision in flight is voided`)));
  try {
    needBank();
    openHistory();
    if (!historyRows("checkpoints.jsonl").length) throw new Error("no checkpoint 0 yet: checkpoint --zero --cap 750 first (§11 step 5)");
    const resume = !!o.f.resume || held.stale;
    const st = readState() ?? newState(nextEpoch());
    if (!resume) {
      const epochs = num("epochs");
      Object.assign(st, { until: epochs === undefined ? undefined : st.epoch + epochs - 1, nightStart: new Date().toISOString() });
      if (typeof o.f["seed-cards"] === "string") {
        const seen = new Set([...historyRows("decisions.jsonl").map((d) => d.card?.id), ...st.queue.map((c) => c.id), ...st.cards.map((c) => c.card.id)]);
        st.queue.push(...(JSON.parse(readFileSync(o.f["seed-cards"], "utf8")) as HypothesisCard[]).filter((c) => !seen.has(c.id)));
      }
    } else if (Date.now() - Date.parse(st.nightStart) >= DAY) st.nightStart = new Date().toISOString();
    saveState(st);
    nightWindows = num("night-windows") ?? LOOP.nightWindows;
    const every = Object.fromEntries(Object.entries(NOTIFY).map(([k, v]) => [k, num(`notify-${k}`) ?? v])) as typeof leg.every;
    for (const [k, v] of Object.entries(every)) if (!(Number.isFinite(v) && v >= 0)) throw new Error(`--notify-${k} takes a number ≥ 0 (0 is off)`);
    const start = Date.now();
    leg = { start, every, sent: new Set(), spent: new MeterTail(paths().calls, start), night: new MeterTail(paths().calls, Date.parse(st.nightStart)) };
    // A stop asked for while no loop ran is stale: this start is the owner's newer word.
    if (existsSync(stopFile())) rmSync(stopFile()), say("loop: an old stop-after request was dropped (this start is newer)");
    readyAtStart = readyOk();
    say(`loop: ${resume ? "resuming" : "starting"} at epoch ${st.epoch}${st.until !== undefined ? ` (to ${st.until})` : ""}, champion ${championSha().slice(0, 12)}, night cap ${nightWindows} windows, notices every ${["decisions", "minutes", "usd"].map((k) => `${k} ${leg.every[k as keyof typeof NOTIFY] || "off"}`).join(", ")}, checkpoint ${leg.every.checkpoint ? "on" : "off"}`);
    await withGateway(async (gw) => {
      const ticker = setInterval(() => void notify(gw, st), NOTICE_MS);
      try {
        while (st.until === undefined || st.epoch <= st.until) {
          if (await halt(gw, st)) return;
          // After an owner step, a refresh or the canary: the rules (and the owner's notices) again before the next epoch.
          if (!st.cards.length && ((await between(gw, st)), await halt(gw, st))) return;
          if (!(await epoch(gw, st))) return;
        }
        if (st.keepsSinceCheckpoint > 0) await loopCheckpoint(gw, st);
        say(`loop: done at epoch ${st.epoch - 1}, champion ${championSha().slice(0, 12)}`);
        await notify(gw, st, { kind: "stopped", why: `the loop is done at epoch ${st.epoch - 1}` });
      } finally {
        clearInterval(ticker);
        await noticeChain;
      }
    });
  } finally {
    stopBeat();
    held.release();
  }
}

/** The owner's graceful stop: the running loop stops before its next step (a decision, an epoch, a checkpoint). */
/** budget.jsonl: each slot's spend and the server's limits, now. */
function logBudget(slots: SlotStatus[], epoch: number, at: string) {
  for (const s of slots)
    historyAdd("budget.jsonl", { at, epoch, slot: s.slot, usdThisWindow: s.usdThisWindow, fiveHour: s.fiveHour, sevenDay: s.sevenDay, sevenDayAt: s.sevenDayAt, windowUsd: s.windowUsd, status: s.why ?? s.status ?? "ok", resetsAt: s.resetsAt, usd7d: s.usd7d });
}

/** WEEK_CHECK by hand, the loop stopped: reads each parked token's week again (one one-word call each) and logs every slot. */
async function weekCmd() {
  needCap();
  const held = lock(); // a running loop's gateway owns slots.json
  try {
    openHistory();
    await withGateway(async (gw) => {
      await recheckWeeks(gw);
      const slots = ((await gatewayStatus(gw)) as { slots: SlotStatus[] }).slots;
      for (const s of slots) say(`week: token ${s.slot}: ${weekOf(s)} of its weekly limit${s.sevenDayAt ? `, read ${new Date(s.sevenDayAt).toISOString()}` : ""}; ${s.why ? `parked: ${s.why}` : "in use"}`);
      logBudget(slots, readState()?.epoch ?? 0, new Date().toISOString());
      commitHistory("week: the tokens' weekly use, read again");
    });
  } finally {
    held.release();
  }
}

async function stopAfterCmd() {
  if (o.f.cancel) {
    if (existsSync(stopFile())) rmSync(stopFile());
    return void say("stop-after: cancelled");
  }
  put(stopFile(), { at: new Date().toISOString() });
  say(existsSync(paths().lock) ? "stop-after: the loop stops before its next step (what's in flight finishes first); loop --resume goes on from there" : "stop-after: no loop is running (its next start drops this request)");
}

async function decideCmd() {
  const branch = o.pos[1];
  if (!branch) throw new Error("decide <branch> [--goal latency --metric ttfc|ttd] [--owner-ok] --cap n");
  // The owner's own change, judged on what it's for: fidelity by default, or a speed change (one the loop's gates sent
  // to the owner and the owner wants measured) on its metric.
  const goal = str("goal") ?? "fidelity", metric = str("metric");
  if (!["fidelity", "latency"].includes(goal)) throw new Error("decide --goal takes fidelity or latency");
  if (goal === "latency" && !["ttfc", "ttd"].includes(metric ?? "")) throw new Error("decide --goal latency needs --metric ttfc or ttd");
  needCap("decide");
  needBank();
  openHistory();
  const st = readState() ?? newState(nextEpoch());
  const card: HypothesisCard = { id: branch, component: "owner", kind: "code", change: `rte decide ${branch}`, goal: goal as HypothesisCard["goal"], ...(goal === "latency" ? { metric: metric as "ttfc" | "ttd" } : {}), ...(o.f["owner-ok"] ? { ownerOk: true } : {}), classGuess: "Q", dialogue: false, predicts: "", isPatch: false, raisesCost: false, touchesFrozen: false, risk: "", files: [] };
  const c: CardState = { id: `d-${branch.replace(/[^\w-]+/g, "-")}`, card, branch, status: "built", cand: git(paths().repo, "rev-parse", branch) };
  const d = await withGateway(async (gw) => ((await rebased(gw, st, c)) ? decideCard(gw, st, c) : undefined));
  return d?.verdict === "keep" ? 0 : 1;
}

async function gc() {
  if (!o.f.trees) throw new Error("gc --trees");
  const p = paths();
  // What a run may still serve: the champion, every anchor, the cards in flight.
  const keep = new Set([championSha(), ...historyRead("anchors.json").map((a) => a.sha), ...(readState()?.cards.flatMap((c) => (c.cand ? [c.cand] : [])) ?? [])].map((s) => p.tree(contentHash(s))));
  const all = existsSync(join(p.home, "trees")) ? readdirSync(join(p.home, "trees")).map((d) => join(p.home, "trees", d)) : [];
  for (const d of all.filter((d) => !keep.has(d))) rmSync(d, { recursive: true, force: true });
  // An old harness's trees (init --refresh moved them aside): nothing serves them again.
  const old = existsSync(join(p.home, "trees-old")) ? readdirSync(join(p.home, "trees-old")).length : 0;
  rmSync(join(p.home, "trees-old"), { recursive: true, force: true });
  say(`gc: ${all.filter((d) => !keep.has(d)).length} trees removed, ${all.filter((d) => keep.has(d)).length} kept${old ? `, ${old} old harness's tree folders cleared` : ""}`);
}

const COMMANDS: Record<string, () => Promise<number | void>> = {
  init, ready: readyCmd, ladder: ladderCmd, smoke, bake: bakeCmd, probe: probeCmd, bank: bankCmd, aa: aaCmd, bench: benchCmd, human: humanCmd, real: realCmd,
  checkpoint: checkpointCmd, calib, sync: syncCmd, export: exportTo, decide: decideCmd, loop, "stop-after": stopAfterCmd, week: weekCmd, status,
  remetric: async () => void say(`remetric: ${js(remetric(o.pos[1]))}`), gc, packets: packetsCmd,
};

if (import.meta.main) {
  process.stdout.on("error", () => {}); // a closed terminal must not end the run: logs/ has every line
  try {
    o = parse(process.argv.slice(2));
    const run = COMMANDS[o.cmd];
    if (!run) throw new Error(`no command "${o.cmd}"\n${USAGE}`);
    if (typeof o.f.fakes === "string") fakes = await import(pathToFileURL(resolve(o.f.fakes)).href);
    process.exitCode = (await run()) ?? 0;
  } catch (err) {
    say(`run.ts ${o.cmd}: ${msg(err)}`);
    process.exitCode = 1;
  }
  // Pages, servers and Claude processes are closed; a stray timer must not hold the step open.
  setTimeout(() => process.exit(), 1000).unref();
}
