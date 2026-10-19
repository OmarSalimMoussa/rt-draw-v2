// Readiness R1–R13 (spec §7.5), before every recording session, at 0 model calls:
// the pages answer from the stub table (stubs.ts), the transport runs on the fake API
// with fake tokens and an empty config dir. v1 lost two baselines and ~45 min to
// blank captures, an overloaded laptop and harness bugs a paid run found; here a
// broken harness fails a line instead.
//
//   node --import ./evals/loop/node-hooks.mjs evals/loop/ready.ts --stub --mock-api
//        [--only R3,R7] [--repo <owner's checkout>] [--port 5300] [--page-hook <file.js>]
// prints one line per check as it finishes (R6 last, so it covers the whole run) and
// exits 1 on any failure. --page-hook: a script run at the start of every bridge
// document (checks plant faults with it). Each run keeps its files under
// $RT_EVAL_HOME/ready/<run>/ (the fake-API gateway's home, ready.json); the Chrome
// profile, ~60 MB, is one for all runs (ready/chrome).
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { arch, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { View } from "../../src/core/board.ts";
import { parseTurn, systemPrompt } from "../core/driver.ts";
import { synthesize } from "../core/synth.ts";
import { loadFixture } from "../fixtures/fixtures.ts";
import { type FakeMode, type FakeRequest, startFakeApi } from "../mock/fake-api.ts";
import type { Reply } from "./cache.ts";
import { BLANK_VARIANCE, type Chrome, type Page, capture, captureVariance, launchChrome } from "./chrome.ts";
import { ask, gatewayStatus, spawnGateway } from "./client.ts";
import { LOOP } from "./config.ts";
import { inFactorySlice, managedSettingsHash, onAC, quiet, sampleLoad } from "./load.ts";
import { type MeterCall, readMeter } from "./meter.ts";
import { type Paths, paths } from "./paths.ts";
import { serveArm } from "./servers.ts";
import { RESOLVER_DELAY_MS, type Stubs, fakeApiReplies, serveStubs, stubPictures, stubReply } from "./stubs.ts";
import { type SlotN, Slots } from "./tokens.ts";
import { evalsHash, treeOf } from "./trees.ts";
import type { RecordedReply, SceneJSON, SendOutcome } from "./types.ts";

export type Result = { id: string; ok: boolean; skipped?: boolean; detail: string };
type Out = Omit<Result, "id">;
export type ReadyOpts = {
  /** Pages on the stub table (R2, R4, R5's pages). */ stub?: boolean;
  /** The transport on the fake API (R3, R11, R12). */ mockApi?: boolean;
  only?: string[];
  /** The owner's checkout, whose .data/ R6 watches. */ repo?: string;
  /** The two arm servers' ports: port and port + 1. */ port?: number;
  pageHook?: string;
  /** R8 once a bank exists: run.ts wires it to `aa --shared --cases 16`. */
  aaCheck?: () => Promise<{ ok: boolean; detail: string }>;
};

export const NAMES: Record<string, string> = {
  R1: "frozen side", R2: "stub integrity", R3: "transport over the fake API", R4: "pages", R5: "voice", R6: "data dirs", R7: "machine",
  R8: "timed-replay A/A", R9: "driver parsing", R10: "tokens", R11: "first-message purity", R12: "budget sanity", R13: "bank resolves here",
};
/** The machine before anything here loads it; R6 last, so it covers everything readiness did. */
const ORDER = ["R1", "R7", "R9", "R10", "R13", "R3", "R11", "R12", "R2", "R4", "R5", "R8", "R6"];

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 5300;
const MIN_RAF = 30;
const HEAP_CASES = 20;
const STORM_MAX_MS = 5000;
const FOLLOWER_MS = 20;
/** The flags that keep a Claude process on the 5-minute cache and quiet (dev/claude.ts' childEnv). */
const QUIET: Record<string, string> = { FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_SESSION|CLAUDE_CODE_MESSAGING|CLAUDE_CODE_CHILD_SESSION|CLAUDE_EFFORT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|RT_EVAL_TOKEN_|ELEVENLABS_|OPENROUTER_|TYPESAFE_)/;
const IMPURE = /system-reminder|additionalContext|userEmail|@[a-z0-9-]+\.[a-z]/i;
/** The probe calls' system prompts (the driver's is its real one). */
const SYS = { draw: "rt readiness probe: the drawing model", judge: "rt readiness probe: a judge", expectation: "rt readiness probe: the expectation" };
/** "make the nav pink", spoken: the resolver is asked (no ink), and the canned drawing reply recolours the nav. */
const SPOKEN = [["make", 0, 180], ["the", 200, 300], ["nav", 320, 520], ["pink", 560, 800]].map(([word, t0, t1]) => ({ word, t0, t1 }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const tryGit = (dir: string, ...a: string[]) => {
  try {
    return git(dir, ...a);
  } catch {
    return undefined;
  }
};
const verdict = (why: string[], detail: string) => ({ ok: !why.length, detail: why.length ? why.join("; ") : detail });
const skip = (detail: string) => ({ ok: true, skipped: true, detail });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const line = (r: Result) => `${r.id.padEnd(3)} ${r.skipped ? "skip" : r.ok ? "ok  " : "FAIL"} ${NAMES[r.id]}: ${r.detail}`;

/** Runs the checks (all, or `only`), printing a header, then each as it finishes; writes $RT_EVAL_HOME/ready/<run>/ready.json. */
export async function ready(o: ReadyOpts, print: (line: string) => void = console.log): Promise<Result[]> {
  const unknown = o.only?.filter((id) => !NAMES[id]);
  if (unknown?.length) throw new Error(`no check ${unknown.join(", ")} (R1–R13)`);
  const p = paths();
  const run = `ready-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = join(p.home, "ready", run);
  mkdirSync(dir, { recursive: true });
  // Product plugins the harness starts write here, never into a repo's .data (R6).
  process.env.RT_DATA_DIR ||= p.data;
  const ids = ORDER.filter((id) => !o.only || o.only.includes(id));
  const tag = tryGit(ROOT, "describe", "--tags", "--exact-match", "--match", "eval-harness-*", "HEAD");
  const callLog = join(o.repo ?? join(homedir(), "projects/rt-draw-v2"), ".data", "model-calls.jsonl");
  const logStart = existsSync(callLog) ? statSync(callLog).size : 0;
  print(`ready ${run}: ${ids.join(" ")}`);

  // The arms' tree (the champion's) and the two expensive phases run once, when a check first needs them.
  let tree: string | undefined;
  const sha = () => {
    if (!existsSync(p.repo)) throw new Error(`no harness clone at ${p.repo} (rte init first)`);
    return tryGit(p.repo, "rev-parse", "--verify", "loop/champion") ?? git(p.repo, "rev-parse", "HEAD");
  };
  const armTree = () => (tree ??= treeOf(sha()));
  let tp: Promise<Transport> | undefined;
  const transport = () => (tp ??= probeTransport(join(dir, "gateway"), run));
  let pp: Promise<Pages> | undefined;
  const pages = () => (pp ??= runPages({ tree: armTree(), sha: sha(), port: o.port ?? PORT, hook: o.pageHook && readFileSync(o.pageHook, "utf8"), chrome: join(p.home, "ready", "chrome"), run, heap: ids.includes("R4") }));
  const needs = (flag: boolean | undefined, name: string, f: () => Promise<Out>) => (flag ? f() : skip(`needs ${name}`));
  const managed = managedSettingsHash();

  const CHECKS: Record<string, () => Out | Promise<Out>> = {
    R1: () => frozen(p, tag),
    R2: () => needs(o.stub, "--stub", async () => stubIntegrity(await pages())),
    R3: () => needs(o.mockApi, "--mock-api", async () => transportOk(await transport())),
    R4: () => needs(o.stub, "--stub", async () => pagesOk(await pages())),
    R5: async () => voice(armTree(), o.port ?? PORT, o.stub ? await pages() : undefined),
    R6: () => dataDirs(p, callLog, logStart, [run, tag].filter((x): x is string => !!x)),
    R7: () => machine(p, managed),
    R8: async () => (!o.aaCheck ? skip("run.ts wires it to `aa --shared --cases 16`") : !bankCases(p).length ? skip("no bank yet") : o.aaCheck()),
    R9: () => driverParsing(),
    R10: () => tokens(p),
    R11: () => needs(o.mockApi, "--mock-api", async () => purity(await transport())),
    R12: () => needs(o.mockApi, "--mock-api", async () => budget(await transport())),
    R13: () => bankResolves(p),
  };
  const results: Result[] = [];
  for (const id of ids) {
    let r: Out;
    try {
      r = await CHECKS[id]();
    } catch (err) {
      r = { ok: false, detail: errText(err) };
    }
    results.push({ id, ...r });
    print(line({ id, ...r }));
  }
  const t = tp && (await tp.catch(() => undefined));
  const pg = pp && (await pp.catch(() => undefined));
  writeFileSync(join(dir, "ready.json"), `${js({
    run, at: new Date().toISOString(), harnessTag: tag ?? null, managedSettings: managed, results,
    // What proves 0 real calls: every fake-API request is one of the gateway's attempts, every page request was stubbed.
    calls: t && { fakeApiRequests: t.requests.length, attempts: attempts(t.meter), gatewayCalls: t.calls },
    pages: pg && Object.fromEntries(pg.sides.map((s) => [s.arm, { seen: s.seen.length, stubbed: pg.stubbed[s.arm] }])),
  }, null, 2)}\n`);
  return results;
}

// ---- R1: the harness at a tag, every tree with its evals/, the yardstick unchanged.
function frozen(p: Paths, tag: string | undefined) {
  const why: string[] = [];
  if (!tag) why.push(`the harness (${ROOT}) isn't at an eval-harness-<n> tag`);
  if (tryGit(ROOT, "status", "--porcelain", "--", "evals")) why.push("the harness's evals/ has uncommitted changes");
  const mine = evalsHash(ROOT);
  const dir = join(p.home, "trees");
  const trees = existsSync(dir) ? readdirSync(dir).filter((d) => !d.includes(".tmp-")) : [];
  const stale = trees.filter((t) => evalsHash(join(dir, t)) !== mine);
  if (stale.length) why.push(`${stale.length} of ${trees.length} trees carry another evals/ (${stale.slice(0, 3).join(", ")})`);
  const benchDir = join(p.history, "bench");
  const benches = existsSync(benchDir) ? readdirSync(benchDir).filter((b) => existsSync(join(benchDir, b, "manifest.json"))) : [];
  for (const b of benches) {
    const m = JSON.parse(readFileSync(join(benchDir, b, "manifest.json"), "utf8")) as { files: Record<string, string> };
    const bad = Object.entries(m.files).filter(([rel, h]) => !existsSync(join(benchDir, b, rel)) || sha256(readFileSync(join(benchDir, b, rel))) !== h);
    if (bad.length) why.push(`yardstick ${b}: ${bad.length} files differ from its manifest (${bad[0][0]})`);
  }
  return verdict(why, `${tag}; trees with its evals/: ${trees.length}; ${benches.length ? `yardsticks ${benches.join(", ")} match` : "no yardstick yet"}`);
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---- R3, R11, R12: the gateway on the fake API with fake tokens and an empty config dir.
type Probe = { chunks: { ms: number; text: string }[]; done?: Record<string, any> };
type Transport = Awaited<ReturnType<typeof probeTransport>>;

/** An arm page's /api/model the way CDP labels it, with each chunk's arrival counted from when it was sent. */
async function product(gw: string, arm: string, run: string, body: object): Promise<Probe> {
  const t0 = performance.now();
  const headers = { "content-type": "application/json", "x-rt-run": run, "x-rt-case": "r3", "x-rt-arm": arm, "x-rt-slot": "0", "x-rt-at": String(performance.timeOrigin + t0) };
  const res = await fetch(`${gw}/api/model`, { method: "POST", headers, body: js(body) });
  const out: Probe = { chunks: [] };
  let buf = "";
  for await (const piece of res.body!.pipeThrough(new TextDecoderStream())) {
    buf += piece;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      if (m.text !== undefined) out.chunks.push({ ms: performance.now() - t0, text: m.text });
      else out.done = m;
    }
  }
  return out;
}

/** The env of each Claude process `pid` has running (the SDK starts Claude Code as its direct child). */
function claudeEnvs(pid: number): Record<string, string>[] {
  const kids = readdirSync(`/proc/${pid}/task`).flatMap((t) => {
    try {
      return readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  });
  return kids.flatMap((k) => {
    try {
      const env = Object.fromEntries(readFileSync(`/proc/${k}/environ`, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      return "CLAUDE_CODE_OAUTH_TOKEN" in env ? [env] : [];
    } catch {
      return []; // it exited meanwhile
    }
  });
}

async function probeTransport(home: string, run: string) {
  mkdirSync(home, { recursive: true });
  const tokens = join(home, "tokens.env");
  writeFileSync(tokens, `${[1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-ready-fake-${randomBytes(8).toString("hex")}`).join("\n")}\n`, { mode: 0o600 });
  const replies = join(home, "fake-replies");
  fakeApiReplies(replies, { draw: SYS.draw, judge: SYS.judge, expectation: SYS.expectation, driver: systemPrompt() });
  const api = await startFakeApi({ replies });
  const gw = await spawnGateway({ home, tokens, mockApi: api.url });
  const sent = new Set<string>();
  const say = (s: string) => (sent.add(s), s);
  try {
    // A waiting product process: its env is every call's.
    const warm = { model: "haiku", system: SYS.draw, warm: 1, from: "draw" };
    await fetch(`${gw.url}/api/model`, { method: "POST", headers: { "content-type": "application/json", "x-rt-run": run, "x-rt-case": "r3", "x-rt-arm": "A", "x-rt-slot": "0" }, body: js(warm) });
    let envs: Record<string, string>[] = [];
    for (let i = 0; i < 50 && !(envs = claudeEnvs(gw.pid)).length; i++) await sleep(100);
    // Both arms send one request 30 ms apart: one call, the follower on its own clock.
    api.set({ mode: "slow", slowMs: 300, chunkMs: 100 });
    const shared = { model: "sonnet", system: SYS.draw, user: say("<ready-shared> make the nav pink"), from: "draw", warm: 0 };
    const leading = product(gw.url, "A", run, shared);
    await sleep(30);
    const follower = await product(gw.url, "B", run, shared);
    const leader = await leading;
    api.set({ mode: "ok" });
    // Eval roles get their canned replies through the gateway; the judge asks thinking off.
    const roles = {
      judge: await ask({ role: "judge", model: "sonnet", system: SYS.judge, turns: say("<ready-judge> which is better?"), effort: "high", thinking: "off", run }, gw.url),
      expectation: await ask({ role: "expectation", model: "sonnet", system: SYS.expectation, turns: say("<ready-expectation> what should change?"), effort: "high", run }, gw.url),
      driver: await ask({ role: "driver", model: "sonnet", system: systemPrompt(), turns: say("<ready-driver> your turn"), run }, gw.url),
    };
    const failing = async (mode: FakeMode) => {
      api.set({ mode });
      const t0 = performance.now();
      const error = await ask({ role: "probe", model: "haiku", system: SYS.draw, turns: say(`<ready-${mode}>`), run }, gw.url).then(() => undefined, errText);
      api.set({ mode: "ok" });
      return { error, ms: Math.round(performance.now() - t0) };
    };
    const limit = await failing("limit");
    const overload = await failing("overload");
    const { calls } = await gatewayStatus(gw.url);
    return { api: api.url, config: paths(home).claudeConfig, requests: [...api.requests] as FakeRequest[], envs, leader, follower, roles, limit, overload, calls: calls as number, meter: readMeter(paths(home).calls), sent };
  } finally {
    await gw.close();
    await api.close();
  }
}

/** Requests the fake API should have seen: one per upstream call plus its retries. */
const attempts = (meter: ReturnType<typeof readMeter>) =>
  meter.filter((l): l is MeterCall => "mode" in l && l.mode === "live" && l.shared !== "follower").reduce((n, l) => n + 1 + (l.retries ?? 0), 0);

function transportOk(t: Transport) {
  const why: string[] = [];
  const reqs = t.requests;
  const of = (marker: string) => reqs.filter((r) => r.firstUser.includes(marker));
  const ttls = [...new Set(reqs.flatMap((r) => r.ttls))];
  if (!reqs.length || ttls.join() !== "5m") why.push(`cache breakpoints ${ttls.join(",") || "none"} (want 5m only)`);
  if (reqs.some((r) => /extended-cache-ttl/.test(r.beta))) why.push("the extended-ttl beta was sent");
  if (reqs.some((r) => IMPURE.test(r.firstUser))) why.push("a first user message carries a system-reminder or an email");
  if (!t.envs.length) why.push("no Claude process seen to read its env");
  for (const env of t.envs) {
    const bad = Object.keys(env).filter((k) => SESSION_VARS.test(k));
    const missing = Object.entries(QUIET).filter(([k, v]) => env[k] !== v).map(([k]) => k);
    if (bad.length) why.push(`a Claude process has ${bad.join(", ")} in its env`);
    if (missing.length) why.push(`a Claude process lacks ${missing.join(", ")}`);
    if (env.CLAUDE_CONFIG_DIR !== t.config || env.ANTHROPIC_BASE_URL !== t.api || !env.HTTPS_PROXY) why.push("a Claude process isn't on the fake API with readiness's own config dir");
  }
  if (!/rate.?limit/i.test(t.limit.error ?? "")) why.push(`a 429 didn't surface as a rate-limit error (${t.limit.error ?? "it succeeded"})`);
  if (!t.overload.error || t.overload.ms >= STORM_MAX_MS) why.push(`a 529 storm ${t.overload.error ? `failed after ${t.overload.ms} ms` : "didn't fail"} (want < ${STORM_MAX_MS} ms)`);
  const done = t.leader.done ?? {};
  if (done.rateLimit?.fiveHour === undefined) why.push("rate_limit_event not parsed");
  if (done.stopReason !== "end_turn") why.push(`stop_reason not recorded (${done.stopReason})`);
  if (of("<ready-judge>")[0]?.thinking === undefined) why.push("thinking off sent no thinking field");
  if (of("<ready-shared>")[0]?.thinking !== undefined) why.push("a call that didn't ask sent a thinking field");
  const drift = t.leader.chunks.map((c, i) => Math.abs((t.follower.chunks[i]?.ms ?? Infinity) - c.ms));
  if (of("<ready-shared>").length !== 1 || done.shared !== "leader" || t.follower.done?.shared !== "follower") why.push(`a shared request made ${of("<ready-shared>").length} calls (${done.shared} / ${t.follower.done?.shared})`);
  else if (t.leader.chunks.length < 2 || t.follower.chunks.length !== t.leader.chunks.length || Math.max(...drift) > FOLLOWER_MS) why.push(`follower offsets off by ${drift.map(Math.round).join(", ")} ms (want ± ${FOLLOWER_MS})`);
  for (const role of ["judge", "expectation", "driver"] as const) if (t.roles[role].text !== stubReply(role)) why.push(`the ${role}'s canned reply didn't come back intact`);
  if (reqs.length !== attempts(t.meter)) why.push(`the fake API got ${reqs.length} requests for ${attempts(t.meter)} attempts: something called it from outside the gateway`);
  return verdict(why, `${t.calls} calls (${reqs.length} requests) on the fake API: 5m cache only, quiet env, errors surface, a 529 storm fails in ${t.overload.ms} ms, follower within ${Math.round(Math.max(...drift))} ms`);
}

function purity(t: Transport) {
  const impure = t.requests.filter((r) => !t.sent.has(r.firstUser) || IMPURE.test(r.firstUser));
  if (impure.length) return { ok: false, detail: `${impure.length} first user messages aren't exactly what was sent, e.g. ${js(impure[0].firstUser.slice(0, 100))}` };
  return { ok: t.requests.length > 0, detail: `${t.requests.length} first user messages hold only what was sent` };
}

function budget(t: Transport) {
  const lines = t.meter.filter((l): l is MeterCall => "cacheWrite1h" in l);
  const bad = lines.filter((l) => l.cacheWrite1h !== 0);
  if (!lines.length) return { ok: false, detail: "no meter line was written" };
  return bad.length ? { ok: false, detail: `${bad.length} of ${lines.length} meter lines have 1-hour cache writes (${bad[0].cacheWrite1h} tokens)` } : { ok: true, detail: `cacheWrite1h 0 on all ${lines.length} meter lines` };
}

// ---- R2, R4, R5: both arms' bridge pages on the stub table, through the arm servers and chrome.ts.
type Side = {
  arm: string; page: Page; seen: string[]; errors: string[]; health: Record<string, any>; shapes: number; variance: number;
  recolour: SendOutcome; recolourPictures: number; driven: SendOutcome; heap: number[];
};
type Pages = Awaited<ReturnType<typeof runPages>>;
const UP = "new Promise((r) => { const t = () => (window.rtEval ? r() : setTimeout(t, 20)); t(); })";

/** The toy shop's home page with every doodle filled (the canned one), so a recolour needs no picture call. */
function toyShop() {
  const pictures = stubPictures(loadFixture("toyshop-home", { pictures: {} }).scene);
  const { scene, start } = loadFixture("toyshop-home", { pictures });
  return { scene: JSON.parse(js(scene.toJSON())) as SceneJSON, camera: start };
}

/** The canned driver turn as a send: parsed on the start view and played out by the synthesizer, like a session's. */
function driverSend(camera: View) {
  const { turn } = parseTurn(stubReply("driver"), camera);
  const t = synthesize(turn.steps, { mess: 0.3, disfluency: 0.3 }, 1, { view: camera });
  return { words: t.words, strokes: t.strokes };
}

async function runPages(o: { tree: string; sha: string; port: number; hook?: string; chrome: string; run: string; heap: boolean }) {
  const stubs = await serveStubs();
  const blocked: string[] = [];
  const arms: Awaited<ReturnType<typeof serveArm>>[] = [];
  let chrome: Chrome | undefined;
  try {
    for (const i of [0, 1]) arms.push(await serveArm(o.tree, o.port + i, stubs.url));
    chrome = await launchChrome({ dir: o.chrome, onBlocked: (url) => blocked.push(url) });
    const { scene, camera } = toyShop();
    const loadArg = js({ scene, camera });
    const sides = await Promise.all(["A", "B"].map((arm, i) => session(chrome!, arms[i].url, arm, o, loadArg, camera, stubs)));
    // A scene round trip: each page restores the other's scene exactly.
    const [a, b] = sides;
    const [sa, sb] = [await a.page.eval<SceneJSON>("rtEval.scene()"), await b.page.eval<SceneJSON>("rtEval.scene()")];
    const roundTrip = isDeepStrictEqual(await b.page.eval(`(rtEval.restore(${js(sa)}), rtEval.scene())`), sa) && isDeepStrictEqual(await a.page.eval(`(rtEval.restore(${js(sb)}), rtEval.scene())`), sb);
    // Cases reload their page (the product keeps every call and span in memory): the heap after 20 of them.
    if (o.heap) await Promise.all(sides.map((s) => heapCases(s, loadArg)));
    return { sides, roundTrip, blocked, unexpected: stubs.unexpected, stubbed: Object.fromEntries(sides.map((s) => [s.arm, stubs.count(s.arm)])) };
  } finally {
    await chrome?.close();
    for (const a of arms) await a.close();
    await stubs.close();
  }
}

async function session(chrome: Chrome, url: string, arm: string, o: { sha: string; hook?: string; run: string }, loadArg: string, camera: View, stubs: Stubs): Promise<Side> {
  const page = await chrome.newPage(url, { run: o.run, case: "ready", arm, slot: 0 });
  const seen: string[] = [];
  const errors: string[] = [];
  page.on("Network.requestWillBeSent", ({ request }) => new URL(request.url).pathname.startsWith("/api/") && seen.push(new URL(request.url).pathname));
  page.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => errors.push(d.exception?.description ?? d.text));
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  if (o.hook) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: o.hook });
  await page.goto(`${url}/evals/bridge/?sha=${o.sha}`);
  // rAF/s counts the last second's frames: give it one.
  const health = await page.eval<Record<string, any>>(`${UP}.then(() => document.fonts.ready).then(() => new Promise((r) => setTimeout(r, 1100))).then(() => rtEval.health())`);
  await page.eval(`rtEval.load(${loadArg})`);
  const shapes = await page.eval<number>(`document.querySelectorAll(".stage > svg > g[data-id]").length`);
  const variance = await captureVariance(page, await capture(page, { width: LOOP.judgePx, quality: LOOP.judgeQuality }));
  const pics = stubs.count(arm, "picture");
  const recolour = await page.eval<SendOutcome>(`rtEval.send(${js({ words: SPOKEN, strokes: [] })})`);
  const recolourPictures = stubs.count(arm, "picture") - pics;
  const driven = await page.eval<SendOutcome>(`rtEval.send(${js(driverSend(camera))})`);
  return { arm, page, seen, errors, health, shapes, variance, recolour, recolourPictures, driven, heap: [] };
}

async function heapCases(s: Side, loadArg: string) {
  for (let i = 0; i < HEAP_CASES; i++) {
    await s.page.reload();
    await s.page.eval(UP);
    await s.page.eval(`rtEval.load(${loadArg})`);
    await s.page.eval(`rtEval.send(${js({ words: SPOKEN, strokes: [] })})`);
    await s.page.send("HeapProfiler.collectGarbage");
    s.heap.push((await s.page.send("Runtime.getHeapUsage")).usedSize / 2 ** 20);
  }
}

function stubIntegrity(pg: Pages) {
  const why: string[] = [];
  for (const s of pg.sides) if (s.seen.length !== pg.stubbed[s.arm]) why.push(`arm ${s.arm}: ${s.seen.length} /api/* requests seen, ${pg.stubbed[s.arm]} stubbed`);
  if (pg.blocked.length) why.push(`blocked: ${[...new Set(pg.blocked)].join(", ")}`);
  if (pg.unexpected.length) why.push(`unexpected at the stubs: ${pg.unexpected.slice(0, 3).join(", ")}`);
  return verdict(why, pg.sides.map((s) => `arm ${s.arm}: ${s.seen.length} seen = stubbed`).join(", "));
}

function pagesOk(pg: Pages) {
  const why: string[] = [];
  for (const s of pg.sides) {
    const h = s.health;
    const tag = `arm ${s.arm}`;
    if (!(h.ok && h.fonts && h.visible && h.rafPerSec >= MIN_RAF)) why.push(`${tag}: health ${js(h)}`);
    if (!s.shapes || s.variance <= BLANK_VARIANCE) why.push(`${tag}: capture blank (variance ${s.variance.toFixed(1)}, ${s.shapes} shapes)`);
    if (s.recolourPictures) why.push(`${tag}: a recolour send made ${s.recolourPictures} picture calls`);
    const ttfc = s.recolour.timing.ttfcMs;
    if (!(ttfc !== undefined && ttfc > RESOLVER_DELAY_MS)) why.push(`${tag}: recolour TTFC ${ttfc} ms (want > the resolver's ${RESOLVER_DELAY_MS} ms)`);
    const failed = [s.recolour, s.driven].flatMap((x) => [x.error, ...x.ops.filter((op) => !op.ok).map((op) => op.error ?? op.line)]).filter(Boolean);
    if (failed.length) why.push(`${tag}: a send failed (${failed[0]})`);
    if (s.errors.length) why.push(`${tag}: page error ${s.errors[0]}`);
    const grow = s.heap.length ? s.heap.at(-1)! - s.heap[0] : 0;
    if (grow > LOOP.heapGrowMaxMb) why.push(`${tag}: the JS heap grew ${grow.toFixed(1)} MB from case 1 to ${HEAP_CASES} (max ${LOOP.heapGrowMaxMb})`);
  }
  if (!pg.roundTrip) why.push("a scene round trip A→B or B→A changed the scene");
  const [a] = pg.sides;
  return verdict(why, `both arms healthy (${a.health.rafPerSec} rAF/s), captures non-blank (variance ${a.variance.toFixed(0)}), recolour TTFC ${a.recolour.timing.ttfcMs} ms with 0 pictures, scenes round-trip, heap +${pg.sides.map((s) => (s.heap.at(-1)! - s.heap[0]).toFixed(1)).join("/")} MB over ${HEAP_CASES} cases`);
}

async function voice(tree: string, port: number, pg?: Pages) {
  const why: string[] = [];
  // The arm config's own middleware stack, in process: no request to /api/tts ever leaves readiness.
  const { createServer } = await import("vite");
  const { armConfig } = await import("./arm.vite.config.ts");
  const vite = await createServer(armConfig(tree, "http://127.0.0.1:9", port + 9));
  try {
    for (const url of ["/api/tts", "/api/tts?voice=x", "/api/stt-token"]) {
      const got = await new Promise<number | "next">((ok) => {
        const res = { statusCode: 200, setHeader() {}, getHeader() {}, end() { ok(this.statusCode); } };
        vite.middlewares.handle({ url, method: "POST", headers: { host: `127.0.0.1:${port + 9}` } } as never, res as never, () => ok("next"));
      });
      if (got !== 403) why.push(`${url} on an arm server answers ${got}, not 403`);
    }
  } finally {
    await vite.close();
  }
  const asked = pg ? [...pg.blocked, ...pg.sides.flatMap((s) => s.seen)].filter((u) => /\/api\/(tts|stt-token)/.test(u)) : [];
  if (asked.length) why.push(`a page requested ${[...new Set(asked.map((u) => new URL(u, "http://x").pathname))].join(", ")}`);
  return verdict(why, `/api/tts and /api/stt-token answer 403 on the arm servers${pg ? "; no page asked for them" : " (pages not run: no --stub)"}`);
}

// ---- R6, R7, R9, R10, R13.
function dataDirs(p: Paths, callLog: string, from: number, marks: string[]) {
  const why: string[] = [];
  if (resolve(process.env.RT_DATA_DIR ?? "") !== p.data) why.push(`RT_DATA_DIR is ${process.env.RT_DATA_DIR}, not ${p.data}`);
  const text = existsSync(callLog) ? readFileSync(callLog) : Buffer.alloc(0);
  // The owner's own server may write there meanwhile: only a harness tag or this run's id is a leak.
  const added = (text.length >= from ? text.subarray(from) : text).toString("utf8").split("\n").filter(Boolean);
  const leaked = added.filter((l) => /eval-harness-\d+/.test(l) || marks.some((m) => l.includes(m)));
  if (leaked.length) why.push(`${leaked.length} of the ${added.length} lines written to ${callLog} during readiness carry a harness tag or run id`);
  return verdict(why, `RT_DATA_DIR is ${p.data}; ${added.length} lines written to ${callLog} meanwhile, none the harness's`);
}

function machine(p: Paths, managed: string) {
  const why: string[] = [];
  const notes = [`managed settings ${managed.slice(0, 12)}`];
  if (inFactorySlice()) why.push("inside emberhub-factory.slice");
  if (onAC() === false) why.push("on battery");
  if (process.env.RT_EVAL_LAUNCHED !== "1") notes.push("not launched, inhibitor not checked");
  else if (arch() === "arm64") notes.push("tmux launch (no inhibitor there)");
  else {
    const list = execFileSync("systemd-inhibit", ["--list", "--no-pager", "--no-legend"], { encoding: "utf8" });
    if (!list.split("\n").some((l) => l.includes("rt eval") && l.includes("sleep"))) why.push("launched, but no 'rt eval' sleep inhibitor is held");
    else notes.push("inhibitor held");
  }
  const s = sampleLoad();
  if (!quiet(s)) why.push(`busy: load1/cores ${s.load1.toFixed(2)} (max ${LOOP.loadMax}), PSI cpu ${(s.psiCpu * 100).toFixed(0)}% (max ${LOOP.psiMax * 100}%)`);
  const fs = statfsSync(p.home);
  const gb = (fs.bavail * fs.bsize) / 1e9;
  if (gb < LOOP.diskPauseGb) why.push(`${gb.toFixed(1)} GB free (min ${LOOP.diskPauseGb})`);
  else if (gb < LOOP.diskOwnerGb) notes.push(`owner list: ${gb.toFixed(1)} GB free, under ${LOOP.diskOwnerGb}`);
  return verdict(why, `load1/cores ${s.load1.toFixed(2)}, PSI cpu ${(s.psiCpu * 100).toFixed(0)}%, ${gb.toFixed(0)} GB free, ${onAC() === undefined ? "no battery" : "on AC"}; ${notes.join("; ")}`);
}

function driverParsing() {
  const stored = readFileSync(join(ROOT, "evals/checks/data/driver-replies.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { src: string; reply: string });
  const view = { x: 0, y: 0, w: 1280, h: 800 };
  const bad = stored.filter((r) => {
    try {
      parseTurn(r.reply, view);
      return false;
    } catch {
      return true;
    }
  });
  if (!stored.length || bad.length) return { ok: false, detail: `${bad.length} of ${stored.length} stored driver replies don't parse (${bad[0]?.src})` };
  return { ok: true, detail: `all ${stored.length} stored driver replies parse` };
}

function tokens(p: Paths) {
  const file = join(p.home, "meter", "slots.json");
  if (!existsSync(file)) return { ok: true, detail: "no slot state yet (no loop call made)" };
  const slots = (JSON.parse(readFileSync(file, "utf8")) as { slot: SlotN }[]).map((s) => s.slot);
  const same = new Slots(slots, file).sameAccount();
  return same ? { ok: false, detail: `slots ${same[0]} and ${same[1]} report the same resetsAt: they are one account` } : { ok: true, detail: `${slots.length} slots, known resetsAt all differ` };
}

/** Banked cases: the ones with their done marker (it's written last). */
const bankCases = (p: Paths) => (existsSync(p.bankCases) ? readdirSync(p.bankCases).filter((id) => existsSync(join(p.bankCase(id), "done"))) : []);

function bankResolves(p: Paths) {
  const cases = bankCases(p);
  if (!cases.length) return { ok: true, detail: "no bank yet" };
  const why: string[] = [];
  let replies = 0;
  for (const id of cases) {
    const file = join(p.bankCase(id), "replies.json");
    if (!existsSync(file)) {
      why.push(`${id}: no replies.json`);
      continue;
    }
    for (const r of JSON.parse(readFileSync(file, "utf8")) as RecordedReply[]) {
      replies++;
      const reply = r.cacheFile ? p.reply(basename(r.cacheFile, ".json")) : "";
      if (!reply || !existsSync(reply)) {
        why.push(`${id}: reply ${r.cacheFile || "(none)"} isn't in cache/replies`);
        continue;
      }
      for (const img of (JSON.parse(readFileSync(reply, "utf8")) as Reply).request.images ?? [])
        if (!existsSync(p.blob(img))) why.push(`${id}: image ${img.slice(0, 12)} isn't in cache/blobs`);
    }
  }
  return verdict(why.length > 5 ? [...why.slice(0, 5), `${why.length - 5} more`] : why, `${cases.length} cases, ${replies} replies and their images resolve here`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  try {
    const results = await ready({ stub: argv.includes("--stub"), mockApi: argv.includes("--mock-api"), only: arg("only")?.split(","), repo: arg("repo"), port: arg("port") ? Number(arg("port")) : undefined, pageHook: arg("page-hook") });
    const failed = results.filter((r) => !r.ok).map((r) => r.id);
    console.log(failed.length ? `ready: FAIL ${failed.join(" ")}` : `ready: ok (${results.filter((r) => !r.skipped).length} passed, ${results.filter((r) => r.skipped).length} skipped)`);
    process.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.log(`ready: FAIL ${errText(err)}`);
    process.exit(1);
  }
}
