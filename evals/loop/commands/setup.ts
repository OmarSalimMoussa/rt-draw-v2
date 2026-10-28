// rte's setup commands (spec §11): init, export, status, cost, ready, the ladder, the A/As, the smoke, the bake, the
// driver probe, the bank, the yardstick's freezes and gc. Each takes the command line as `rte` (rte.ts).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HitIndex } from "../../../src/core/hittest.ts";
import { promptOf } from "../../../src/core/prompts.ts";
import { plan, prompt } from "../../../src/core/resolve.ts";
import { DEFAULTS } from "../../../src/core/tuning.ts";
import { TUNING } from "../../core/scenarios.ts";
import { loadFixture } from "../../fixtures/fixtures.ts";
import { judging } from "../../judge/judge.ts";
import { writeDry } from "../../mock/dry.ts";
import { startFakeApi } from "../../mock/fake-api.ts";
import { type ArmSpec, checkpointRun, harnessTag, runAB } from "../ab.ts";
import { bake } from "../bake.ts";
import { type BankSet, acceptBank, buildBank } from "../bank.ts";
import { freeze } from "../checkpoint.ts";
import { type Page, capture } from "../chrome.ts";
import { ask, endCase, gatewayStatus, spawnGateway } from "../client.ts";
import { DRIVE_VIEW, LOOP } from "../config.ts";
import { compareCase } from "../diffscan.ts";
import { type DriveCtx, driveSession, loadPage } from "../drive.ts";
import { commitHistory, historyAdd, historyRead, openHistory, ownerItem, recordMachine } from "../history.ts";
import { freezeHuman, pageShot } from "../human.ts";
import { pairedRatio } from "../latency.ts";
import { type WaveSend, ladder, sampleLoad } from "../load.ts";
import { type MeterCall, readMeter, rollup } from "../meter.ts";
import { meterOf, readRows } from "../metrics.ts";
import { paths } from "../paths.ts";
import { ready } from "../ready.ts";
import { caseDir, put, runFile } from "../record.ts";
import { acceptProbe, probe, probeDue, probeRefuses } from "../probe.ts";
import { holder, lock, readState, stampNow } from "../state.ts";
import { stubPictures } from "../stubs.ts";
import { Slots } from "../tokens.ts";
import { contentHash, treeOf } from "../trees.ts";
import type { Arm, CaseInfo, Ratio, SendOutcome } from "../types.ts";
import { aaPass } from "../verdict.ts";
import { DAY, HOUR, IDENT, type Rte, banked, championArm, championPages, championSha, fakeTokens, git, initFrom, js, maybe, needBank, ordered, sleep, tryGit, tuningIdOf, upstream } from "../rte.ts";

/** R8 and `aa`'s default: 16 cases, the champion against itself in timed replay. */
const AA_CASES = 16;
/** The smoke's driver session: 3 sends from the blank start (§11 step 1). */
const SMOKE_SENDS = 3;
/** How long U3 waits for the "off" process its second call left waiting. */
const U3_WARM_MS = 3000;
/** Sends per slot at each ladder step. */
const LADDER_ROUNDS = 3;
/** "make the nav pink", spoken (the ladder's send and U3's resolver case). */
const SPOKEN = ([["make", 0, 180], ["the", 200, 300], ["nav", 320, 520], ["pink", 560, 800]] as const).map(([word, t0, t1]) => ({ word, t0, t1 }));

// ---- The history branch

/** eval/history-import (pushed by another machine's `export`) into eval/history: a fast-forward, else a merge; a conflict goes to the owner. */
function importHistory(rte: Rte) {
  if (tryGit(paths().repo, "rev-parse", "--verify", "-q", "refs/heads/eval/history-import") === undefined) return;
  const dir = openHistory();
  if (tryGit(dir, "merge-base", "--is-ancestor", "eval/history-import", "HEAD") !== undefined) return;
  if (tryGit(dir, "merge", "-q", "--ff-only", "eval/history-import") !== undefined) return rte.say("history: fast-forwarded to eval/history-import");
  if (tryGit(dir, ...IDENT, "merge", "-q", "--no-edit", "eval/history-import") !== undefined) return rte.say("history: merged eval/history-import");
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

export async function init(rte: Rte) {
  // A refresh moves the trees a running rig serves.
  const held = await lock("init");
  try {
    await initLocked(rte);
  } finally {
    held.release();
  }
}
async function initLocked(rte: Rte) {
  const p = paths();
  const before = rte.o.f.refresh ? tryGit(p.repo, "describe", "--tags", "--abbrev=0", "--match", "eval-harness-*", "HEAD") : undefined;
  if (rte.o.f.refresh) {
    // Re-pins only the harness: the champion takes the owner's master through `sync` alone.
    if (!existsSync(join(p.repo, ".git"))) throw new Error(`no loop clone at ${p.repo}: init --from <repo> first`);
    if (git(p.repo, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${p.repo} has local changes: the harness is pinned, never edited`);
    git(p.repo, "fetch", "-q", "origin", upstream());
    git(p.repo, "merge", "-q", "--ff-only", "FETCH_HEAD");
  } else {
    if (typeof rte.o.f.from !== "string") throw new Error("init --from <the owner's checkout>");
    const from = resolve(rte.o.f.from);
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
  importHistory(rte);
  rte.say(`init: ${p.repo} at ${tag}, champion ${championSha().slice(0, 12)}, history at ${p.history}`);
}

/** Copies what another machine can't rebuild for free (§7.8), never with --delete; eval/history goes over as eval/history-import. */
export async function exportTo(rte: Rte) {
  const host = rte.o.pos[1];
  if (!host) throw new Error("export <host> (its ~/rt-eval) or export </absolute/dir> (that RT_EVAL_HOME)");
  const p = paths();
  const there = host.startsWith("/") ? host : `${host}:rt-eval`;
  const dirs = ["bank", "cache/replies", "cache/blobs", "labels", "human"].filter((d) => existsSync(join(p.home, d)));
  execFileSync("rsync", ["-aR", ...dirs, `${there}/`], { cwd: p.home, stdio: ["ignore", "inherit", "inherit"] });
  openHistory();
  git(p.repo, "push", "-q", "--force", `${there}/repo`, "eval/history:refs/heads/eval/history-import");
  rte.say(`export: ${dirs.join(", ")} and eval/history (as eval/history-import) → ${there}; there: rte init --refresh`);
}

export async function status(rte: Rte) {
  const loaded = rte.tokens().length; // a tokens file at any mode but 600, or inside a repo, fails here
  const inhibit = spawnSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" });
  const p = paths();
  const st = readState();
  for (const l of [
    `slots loaded: ${loaded} (${rte.o.devToken ? "the dev plugin's token" : (rte.o.tokens ?? "~/.config/rt-eval/tokens.env")})`,
    `cap: ${rte.o.cap ?? "none"}`, `cwd: ${process.cwd()}`, `node: ${process.version} (${process.execPath})`,
    `launched: ${process.env.RT_EVAL_LAUNCHED === "1" ? "yes" : "no"}`,
    `inhibitor: ${inhibit.status === 0 ? (inhibit.stdout.includes("rt eval") ? "held ('rt eval')" : "not held") : "n/a"}`,
    `home: ${p.home}; champion ${tryGit(p.repo, "rev-parse", "--short", "loop/champion") ?? "none (init first)"}`,
    `loop: ${st ? `epoch ${st.epoch}, ${st.cards.filter((c) => c.status === "done").length} of ${st.cards.length} cards decided${st.blocked ? `; blocked: ${st.blocked}` : ""}` : "not started"}`,
    `run: ${st?.run ? `${st.run.status}${st.run.code ? ` (${st.run.code})` : ""} since ${st.run.at}${st.run.phase ? `; ${st.run.phase}` : ""}${st.run.why ? `; ${st.run.why}` : ""}` : "never"}`,
    `lock: ${(() => {
      const h = holder();
      return h ? `${h.cmd} (pid ${h.pid}, since ${h.start}${h.live ? "" : ", dead: stale"})` : "free";
    })()}`,
    `unit rt-loop: ${spawnSync("systemctl", ["--user", "is-active", "rt-loop"], { encoding: "utf8" }).stdout.trim() || "n/a"}`,
  ]) rte.say(l);
  // Each token's use as the server last said it (meter/slots.json): the loop pauses at LOOP.fiveHourPauseAt and LOOP.weekSevenDayMax.
  const pct = (x?: number) => (x === undefined ? "no reading" : `${Math.round(x * 100)}%`);
  const ago = (ms: number) => `${((Date.now() - ms) / HOUR).toFixed(1)} h ago`;
  for (const s of new Slots(rte.tokens().map((t) => t.slot), join(p.home, "meter", "slots.json")).status())
    rte.say(`token ${s.slot}: five-hour ${pct(s.fiveHour)}${s.resetsAt ? ` (window ${s.resetsAt * 1000 < Date.now() ? "reset since" : `resets ${new Date(s.resetsAt * 1000).toISOString().slice(11, 16)} UTC`})` : ""}, week ${pct(s.sevenDay)}${s.sevenDayAt ? ` (read ${ago(s.sevenDayAt)})` : ""}; the loop pauses past ${pct(LOOP.fiveHourPauseAt)} of five hours or ${pct(LOOP.weekSevenDayMax)} of the week${s.why ? `; parked: ${s.why}` : ""}`);
}

/** What runs cost (rte cost <run>…): upstream calls and list $ by role, each run with its sub-runs (<run>-g2, <run>~warm, …). */
export async function costCmd(rte: Rte) {
  const runs = rte.o.pos.slice(1);
  if (!runs.length) throw new Error("cost <run>…");
  const lines = readMeter(paths().calls);
  for (const run of runs) {
    const mine = lines.filter((l) => l.run === run || l.run.startsWith(`${run}-`) || l.run.startsWith(`${run}~`));
    const by = rollup(mine, (l) => l.role);
    const all = rollup(mine, () => "all").all;
    rte.say(`cost ${run}: ${all?.calls ?? 0} calls, $${(all?.usd ?? 0).toFixed(2)} list${all?.agentUsd ? ` + $${all.agentUsd.toFixed(2)} agents` : ""} (${Object.entries(by).sort((a, b) => b[1].usd - a[1].usd).map(([k, r]) => `${k} ${r.calls} $${r.usd.toFixed(2)}`).join(", ") || "nothing metered"})`);
  }
}

export async function readyCmd(rte: Rte) {
  // Its arm servers and Chrome take the ports a loop's rig uses.
  const held = await lock("ready");
  let results: Awaited<ReturnType<typeof ready>>;
  try {
    results = await ready({ stub: !!rte.o.f.stub, mockApi: !!rte.o.f["mock-api"], port: rte.o.port, repo: initFrom(), aaCheck: () => aa(rte, AA_CASES) });
  } finally {
    held.release();
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  if (existsSync(join(paths().repo, ".git"))) {
    openHistory();
    historyAdd("health.jsonl", { at: new Date().toISOString(), kind: "ready", pass: !failed.length, detail: { harness: harnessTag(), failed, skipped: results.filter((r) => r.skipped).map((r) => r.id) } });
    commitHistory(`ready: ${failed.length ? `FAIL ${failed.join(" ")}` : "ok"}`);
  }
  rte.say(failed.length ? `ready: FAIL ${failed.join(" ")}` : "ready: ok");
  return failed.length ? 1 : 0;
}
/** The last readiness run passed, at this harness tag, within a day (§7.5: before every recording session). */
export function readyOk(): boolean {
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
export async function ladderCmd(rte: Rte) {
  const champ = championArm();
  const work = join(paths().home, "ladder");
  // Sends shaped like a Q case's: every drawing reply adds 2 pictures, so a tab streams up to 3 calls and renders them
  // (a recolour alone streamed 1 and let a laptop claim slots its real cases would overload).
  const dry = writeDry(join(work, "dry"), { pictures: 2 });
  // The owner's logged timings, or --latency's, else the dry run's medians (a fresh clone, as on the PGX, has no log).
  const log = rte.str("latency") ?? (initFrom() && join(initFrom()!, ".data", "model-calls.jsonl"));
  const api = await startFakeApi({ replies: dry.replies, latency: log && existsSync(log) ? medianTimings(log, join(work, "latency.jsonl")) : dry.latency });
  // Its own home: fake calls must not reach the loop's meter or slot state.
  const gw = await spawnGateway({ home: join(work, "gateway"), tokens: fakeTokens(), mockApi: api.url });
  try {
    const s0 = loadFixture("toyshop-home", { pictures: {} }).scene;
    const { scene, start } = loadFixture("toyshop-home", { pictures: stubPictures(s0) });
    const send = `rtEval.send(${js({ words: SPOKEN, strokes: [] })})`;
    const machine = await ladder((slots) => rte.withRig(gw.url, [champ.tree], async (rig) => {
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
    }, slots), rte.num("max") ?? 12);
    rte.say(`ladder: ${machine.slots} case slots, dispatch limit ${machine.dispatchLimitMs.toFixed(1)} ms (${machine.steps.map((s) => `${s.slots} ${s.ok ? "ok" : s.why}`).join("; ")})`);
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
async function aa(rte: Rte, n: number): Promise<{ ok: boolean; detail: string }> {
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
  return rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    const run = `aa-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const { rows } = await runAB(rig, { run, kind: "aa", arms: { A: champ, B: champ }, mode: "replay", share: true, seed: run, cases: ids });
    const same = ids.filter((id) => !compareCase(run, id).affected).length;
    // The deciding latencies both within the band (LOOP-V2.md); TTFC is reported.
    const [ttfd, render, ttfc] = (["ttfd", "render", "ttfc"] as const).map((m) => pairedRatio(rows, m));
    const calls = (await gatewayStatus(gw)).calls as number;
    const flat = (r?: Ratio) => !!r && Math.abs(r.est - 1) <= LOOP.nTimingBand;
    const ok = same === n && calls === 0 && flat(ttfd) && flat(render);
    const x = (r?: Ratio) => `×${r?.est.toFixed(3) ?? "?"}`;
    return { ok, detail: `${same} of ${n} cases identical, paired TTFD ${x(ttfd)}, render ${x(render)} (TTFC ${x(ttfc)}), ${calls} calls (${run})` };
  }), true);
}
/**
 * Checkpoint 0's unshared A/A again (the re-validation's): today's champion against itself on B1, live, each arm its own
 * Vite, judged for fidelity and craft on every case, scored by aaPass. Writes nothing to history.
 */
async function aaLive(rte: Rte) {
  rte.needCap("aa --live");
  needBank();
  openHistory();
  const champ = championArm();
  const run = `aa-live-${stampNow()}`;
  const rows = await rte.withGateway((gw) => rte.withRig(gw, [champ.tree, champ.tree], async (rig) => (await checkpointRun(rig, { run, anchor: champ, champion: champ, seed: run, judge: judging(run, { seed: run, craft: "all" }) })).rows));
  const a = aaPass(rows);
  const x = (m: "ttfd" | "render") => `×${pairedRatio(rows, m)?.est.toFixed(3) ?? "?"}`;
  rte.say(`aa --live: ${a.pass ? "ok" : `FAIL on ${a.failed.join(", ")}`} (99% CR1: ${Object.entries(a.tests).map(([k, t]) => `${k} ${t.est.toFixed(3)} [${t.lo.toFixed(3)}, ${t.hi.toFixed(3)}]`).join("; ")}); first drawing ${x("ttfd")}, render ${x("render")}; ${rows.length} cases, ${rows.filter((r) => r.void).length} void (${run})`);
  return a.pass ? 0 : 1;
}
export async function aaCmd(rte: Rte) {
  if (rte.o.f.live) return aaLive(rte);
  if (!rte.o.f.shared) throw new Error("aa --shared --cases n (timed replay, 0 calls) | aa --live --cap n (checkpoint 0's unshared A/A again)");
  const r = await aa(rte, rte.num("cases") ?? AA_CASES);
  rte.say(`aa: ${r.ok ? "ok" : "FAIL"} ${r.detail}`);
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
  const known = (p?: (number | null)[]) => (p ?? []).filter((v): v is number => v !== null);
  openHistory();
  historyAdd("smoke.jsonl", {
    at: new Date(ended).toISOString(), run, pass, calls: live.length, listUsd: live.reduce((a, l) => a + l.listUsd, 0), minutes: (ended - started) / 60_000, cases: rows.length,
    share: rows.length ? rows.reduce((a, r) => a + (r.s + 1) / 2, 0) / rows.length : undefined,
    ttfcP50: p50(rows.flatMap((r) => r.ttfc.filter((v): v is number => v !== null))), ttdP50: p50(rows.flatMap((r) => r.ttd)),
    ttfdP50: p50(rows.flatMap((r) => known(r.ttfd))), renderP50: p50(rows.flatMap((r) => known(r.render))),
  });
  commitHistory(`smoke: ${pass ? "ok" : "FAIL"}, ${live.length} calls`);
}

/** §11 step 1, pinned to the blank start: every line must pass. */
export async function smoke(rte: Rte) {
  rte.needCap();
  const started = Date.now();
  const champ = championArm();
  const run = `smoke-${stampNow()}`;
  let fails = 0;
  const line = (ok: boolean | "note", what: string) => {
    if (ok === false) fails++;
    rte.say(`${ok === "note" ? "note" : ok ? "ok  " : "FAIL"} ${what}`);
  };
  await rte.withGateway(async (gw) => {
    const t = rte.tokens();
    line(true, `status: ${t.length} token slots, cap ${rte.o.cap}, launched ${process.env.RT_EVAL_LAUNCHED === "1" ? "yes" : "no"}`);
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
    await rte.withRig(gw, [champ.tree], async (rig) => {
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
  line(live.some((l) => l.fiveHour !== undefined && l.fiveHour !== null), `U1: ${live.filter((l) => l.fiveHour != null).length} of ${live.length} calls carried five-hour utilization (the budget's pause reads only that)`);
  line(live.every((l) => l.cacheWrite1h === 0), `cacheWrite1h 0 on all ${live.length} calls`);
  line(live.every((l) => !!l.servedModel), `served models: ${[...new Set(live.map((l) => l.servedModel))].join(", ")}`);
  // No email in any request: R3 shows the transport adds none on the fake API, but Claude Code puts the account's email
  // in every prompt (userEmail) once its config dir caches the account, which only a real login can do.
  const conf = paths().claudeConfig;
  const cached = (existsSync(conf) ? readdirSync(conf, { recursive: true, withFileTypes: true }) : []).filter((e) => e.isFile() && /"emailAddress"\s*:\s*"[^"]/.test(readFileSync(join(e.parentPath, e.name), "utf8")));
  line(readyOk() && !cached.length, `no email: readiness (R3) ${readyOk() ? "passed" : "not passed"} at this tag, ${cached.length} Claude config files cache an account email`);
  recordSmoke(run, !fails, started);
  rte.say(`smoke: ${fails ? `FAIL (${fails} lines)` : "ok"}, ${live.length} calls`);
  return fails ? 1 : 0;
}

export async function bakeCmd(rte: Rte) {
  rte.needCap();
  const champ = championArm();
  return rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    const page = (await rig.tab(0, "A", champ.tree)).page;
    page.labels.run = `bake-${stampNow()}`;
    const r = await bake(page);
    rte.say(`bake: ${Object.keys(r.pictures).length} pictures in ${r.file}${r.missing.length ? `; still undrawn: ${r.missing.join(", ")}` : ""}${r.stopped ? ` (${r.stopped})` : ""}`);
    rte.say(`review them, then commit only that file (§11 step 2) and rte init --refresh`);
    return r.missing.length ? 1 : 0;
  }, 1));
}

/** §2.8's driver probe before drivers bank (run when due, N14): why they may not, if they may not. */
export async function probed(rte: Rte, ctx: DriveCtx, page: Page): Promise<string | undefined> {
  const due = probeDue();
  if (due) {
    const p = await probe({ ...ctx, run: `${ctx.run}-probe` }, page);
    rte.say(`probe (${due}): ${p.pass ? "ok" : `FAIL: ${p.why.join("; ")}`}`);
  }
  return probeRefuses();
}
export async function probeCmd(rte: Rte) {
  if (rte.o.f.accept) return void rte.say(`probe: accepted by the owner: ${acceptProbe().why.join("; ") || "it passed"}`);
  rte.needCap();
  const champ = championArm();
  return rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    const page = (await rig.tab(0, "A", champ.tree)).page;
    const p = await probe({ run: `probe-${stampNow()}`, arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(page) } }, harnessTag: harnessTag() }, page);
    rte.say(`probe: ${p.pass ? "ok" : `FAIL: ${p.why.join("; ")}`} (good ${p.good ?? "-"}, bad ${p.bad ?? "-"}, ${p.targets.length} targets, asks ${p.asks.join(", ") || "none"})`);
    return p.pass ? 0 : 1;
  }, 1));
}

export async function bankCmd(rte: Rte) {
  if (rte.o.pos[1] === "accept") return rte.say(`bank: accepted although it fails ${acceptBank().join("; ")}`);
  if (rte.o.pos[1] === "rerecord") return rerecord(rte);
  if (rte.o.pos[1] !== "build") throw new Error("bank build --tuning n --heldout-gate n --heldout-chart n --cap n | bank rerecord --cap n | bank accept");
  rte.needCap("bank build");
  const sets: BankSet[] = (["tuning", "heldout-gate", "heldout-chart"] as const).map((set) => ({ set, sessions: rte.num(set) ?? 0 })).filter((s) => s.sessions);
  const champ = championArm();
  return rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    const slots = await championPages(rig, champ.tree);
    const ctx: DriveCtx = { run: "bank-b1", arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(slots[0].A) } }, harnessTag: harnessTag() };
    const no = await probed(rte, ctx, slots[0].A);
    if (no) return rte.say(`bank: REFUSED before any session: ${no}`), 1;
    const r = await buildBank(ctx, slots, { bank: "b1", sets });
    rte.say(`bank: ${r.cases.length} cases; ${r.fails.length ? `REFUSED: ${r.fails.join("; ")}` : "every §2.3 gate passes"}`);
    return r.fails.length ? 1 : 0;
  }));
}

/**
 * Every banked case's replies recorded again on today's champion: the diffscan's stand-ins and the timed replays' clocks
 * are then what the product makes now (illustration lines, say), so a change to that reads as affected, never as no
 * effect (LOOP-V2.md A6). One live A/A with sharing, each call paid once; a case's old replies.json stays beside the new
 * one as replies.<run>.json. The frozen bench holds no replies, so its hash doesn't move.
 */
async function rerecord(rte: Rte) {
  rte.needCap("bank rerecord");
  const champ = championArm();
  const run = `rerecord-${stampNow()}`;
  const ids = banked(["tuning", "fresh", "heldout-gate", "heldout-chart", "real"]);
  const n = (await recordOnChampion(rte, ids, run)).length;
  rte.say(`bank rerecord: ${n} of ${ids.length} cases recorded again on ${champ.sha.slice(0, 12)} (${run}); ${ids.length - n ? "the rest keep their old replies" : "every case"}`);
  return n === ids.length ? 0 : 1;
}

/**
 * Banked cases' replies recorded on today's champion (one live A/A with sharing, each call paid once); the ids recorded,
 * each passed to `recorded` as it's written. What finished is kept when the run throws (the call cap, a page that never
 * loads), so the same run name resumes the rest.
 */
export function recordOnChampion(rte: Rte, ids: string[], run: string, recorded?: (id: string) => void): Promise<string[]> {
  const champ = championArm();
  const want = new Set(ids);
  return rte.withGateway((gw) => rte.withRig(gw, [champ.tree, champ.tree], async (rig) => {
    const done: string[] = [];
    try {
      await runAB(rig, { run, kind: "ab", arms: { A: champ, B: champ }, mode: "live", share: true, seed: run, cases: ids });
    } finally {
      for (const r of readRows(run)) {
        const from = join(caseDir(run, r.case), "A", "replies.json");
        if (!want.has(r.case) || r.void || r.lost || !existsSync(from)) continue;
        // Crash-safe: the old file copied aside, the new one copied beside it, then one rename over it, so the case
        // always holds a whole replies.json.
        const to = join(paths().bankCase(r.case), "replies.json"), tmp = `${to}.${run}.tmp`;
        if (existsSync(to)) copyFileSync(to, join(paths().bankCase(r.case), `replies.${run}.json`));
        copyFileSync(from, tmp);
        renameSync(tmp, to);
        done.push(r.case);
        recorded?.(r.case);
      }
    }
    return done;
  }));
}

export async function benchCmd(rte: Rte) {
  if (rte.o.pos[1] !== "freeze") throw new Error("bench freeze");
  needBank();
  openHistory();
  const m = freeze({ heldout: rte.num("heldout"), tuning: rte.num("tuning") }); // smaller only in a rehearsal
  rte.say(`bench freeze: B1, ${Object.keys(m.files).length} files, hash ${m.hash.slice(0, 12)}`);
}
export async function humanCmd(rte: Rte) {
  if (rte.o.pos[1] !== "freeze") throw new Error("human freeze");
  openHistory();
  const champ = championArm();
  await rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    const m = await freezeHuman(pageShot((await rig.tab(0, "A", champ.tree)).page));
    rte.say(`human freeze: U1, ${Object.keys(m.files).length} files, hash ${m.hash.slice(0, 12)}`);
  }, 1), true);
}

export async function gc(rte: Rte) {
  if (!rte.o.f.trees) throw new Error("gc --trees");
  const p = paths();
  // What a run may still serve: the champion, every anchor, the cards in flight.
  const keep = new Set([championSha(), ...historyRead("anchors.json").map((a) => a.sha), ...(readState()?.cards.flatMap((c) => (c.cand ? [c.cand] : [])) ?? [])].map((s) => p.tree(contentHash(s))));
  const all = existsSync(join(p.home, "trees")) ? readdirSync(join(p.home, "trees")).map((d) => join(p.home, "trees", d)) : [];
  for (const d of all.filter((d) => !keep.has(d))) rmSync(d, { recursive: true, force: true });
  // An old harness's trees (init --refresh moved them aside): nothing serves them again.
  const old = existsSync(join(p.home, "trees-old")) ? readdirSync(join(p.home, "trees-old")).length : 0;
  rmSync(join(p.home, "trees-old"), { recursive: true, force: true });
  rte.say(`gc: ${all.filter((d) => !keep.has(d)).length} trees removed, ${all.filter((d) => keep.has(d)).length} kept${old ? `, ${old} old harness's tree folders cleared` : ""}`);
}
