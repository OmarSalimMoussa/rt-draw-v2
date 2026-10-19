// T1's acceptance check: dev/claude.ts (the child env, stream handling, pools),
// the dev plugin and the TTS plugin, model.ts' warmModel, and the fake API's modes.
// 0 real calls: every Claude process gets a fake token, the fake API as its base
// URL and HTTPS_PROXY at a closed port, so a request that went anywhere else fails.
// The TTS plugin's handler is called in-process with fetch stubbed (never over HTTP).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t1-transport.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const home = tempHome();
// No real token or key may reach this process's children: start from a clean env, then plant canaries
// that a leaking childEnv() would copy (CLAUDE_CODE_OAUTH_TOKEN stays unset: vite's loadEnv prefers it).
const CANARY = `rt-canary-${randomBytes(6).toString("hex")}`;
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, cleanEnv(), { RT_EVAL_HOME: home, RT_DATA_DIR: join(home, "data"), ANTHROPIC_API_KEY: CANARY, RT_EVAL_TOKEN_1: CANARY, OPENROUTER_API_KEY: CANARY,
  CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: CANARY, CLAUDE_CODE_MESSAGING_SOCKET: CANARY, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_EFFORT: "max", RT_EVAL_CALL_CAP: "1" });
const FAKE = `sk-ant-oat01-fake-t1-${randomBytes(6).toString("hex")}`;
const FAKE_DEV = `${FAKE}-dev`;

const { startFakeApi } = await import("../mock/fake-api.ts");
const claude = await import("../../dev/claude.ts");
const { CallError, Pool, childEnv, keepOf, keyOf, startProcess, streamCall, toContent } = claude;
const api = await startFakeApi();
const closedPort = async () => {
  const s = netServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const mockApi = { baseUrl: api.url, deadProxyPort: await closedPort() };
const configDir = join(home, "claude-config");

// ---- Every Claude process this check starts, by its env (read from /proc while it's alive).
const childEnvs = new Map();
// Direct children only: the SDK spawns Claude Code itself; its own hook subprocesses add their own env.
function children() {
  const out = [];
  for (const t of readdirSync(`/proc/${process.pid}/task`)) {
    try {
      out.push(...readFileSync(`/proc/${process.pid}/task/${t}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {}
  }
  return out;
}
function sampleChildren() {
  for (const pid of children()) {
    if (childEnvs.has(pid)) continue;
    try {
      const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      if ("CLAUDE_CODE_OAUTH_TOKEN" in env) childEnvs.set(pid, env);
    } catch {}
  }
}
const alive = (pid) => existsSync(`/proc/${pid}`) && !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));

// Calls this check makes whose replies are one request each, by a marker in the message.
let marks = 0;
const mark = () => `<t1-call-${++marks}>`;
const reqOf = (m) => api.requests.filter((r) => r.firstUser.includes(m));
async function call(model, system, o = {}, user = mark()) {
  const p = startProcess(model, system, { token: FAKE, configDir, maxRetries: 2, mockApi, ...o });
  try {
    await p.ready;
    sampleChildren();
    const t0 = Date.now();
    const out = await streamCall(p, toContent(user));
    return { ...out, user, ms: Date.now() - t0 };
  } catch (err) {
    return { err, user };
  } finally {
    p.q.close();
  }
}

// ---- childEnv: the allowlist, the mock-API pair only when asked.
const ALLOWED = new Set(["PATH", "HOME", "LANG", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_PROMPT_CACHE_TTL", "DISABLE_AUTOUPDATER", "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_RETRIES", "CLAUDE_CODE_EXTRA_BODY", "ANTHROPIC_BASE_URL", "HTTPS_PROXY", "NO_PROXY",
  // the Agent SDK's own, set when it spawns Claude Code
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE"]);
const QUIET = { FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096" };
const FORBIDDEN = /^(CLAUDECODE|CLAUDE_CODE_SESSION|CLAUDE_CODE_MESSAGING|CLAUDE_CODE_CHILD_SESSION|CLAUDE_EFFORT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|RT_EVAL_TOKEN_|ELEVENLABS_|OPENROUTER_|TYPESAFE_|RT_EVAL_CALL_CAP)/;
function envOk(env, label, { token, mock, config, base = api.url }) {
  const keys = Object.keys(env);
  check(keys.every((k) => ALLOWED.has(k)), `${label}: keys outside the allowlist: ${keys.filter((k) => !ALLOWED.has(k)).join(",")}`);
  check(!keys.some((k) => FORBIDDEN.test(k)), `${label}: has ${keys.filter((k) => FORBIDDEN.test(k)).join(",")}`);
  check(!Object.values(env).some((v) => v.includes(CANARY)), `${label}: a parent secret leaked into it`);
  check(Object.entries(QUIET).every(([k, v]) => env[k] === v), `${label}: missing the 5-minute cache or quiet flags`);
  check(env.CLAUDE_CODE_OAUTH_TOKEN === token, `${label}: not the expected fake token`);
  if (config) check(env.CLAUDE_CONFIG_DIR === config, `${label}: CLAUDE_CONFIG_DIR is ${env.CLAUDE_CONFIG_DIR}, not ${config}`);
  check(mock ? env.ANTHROPIC_BASE_URL === base && env.HTTPS_PROXY === `http://127.0.0.1:${mockApi.deadProxyPort}` : !("ANTHROPIC_BASE_URL" in env) && !("HTTPS_PROXY" in env), `${label}: ANTHROPIC_BASE_URL/HTTPS_PROXY wrong (mock ${!!mock})`);
}
const plain = childEnv(FAKE, { configDir });
envOk(plain, "childEnv without mockApi", { token: FAKE, mock: false, config: configDir });
check(!("CLAUDE_CODE_EXTRA_BODY" in plain) && !("CLAUDE_CODE_MAX_RETRIES" in plain), "childEnv adds EXTRA_BODY or MAX_RETRIES unasked");
const full = childEnv(FAKE, { configDir, mockApi, maxRetries: 2, thinking: "off", model: "claude-sonnet-5-5" });
envOk(full, "childEnv with mockApi", { token: FAKE, mock: true, config: configDir });
check(full.CLAUDE_CODE_MAX_RETRIES === "2" && JSON.parse(full.CLAUDE_CODE_EXTRA_BODY).thinking, "childEnv with maxRetries 2 / thinking off misses them");
check(!("CLAUDE_CODE_EXTRA_BODY" in childEnv(FAKE, { configDir, thinking: "auto", model: "claude-sonnet-5-5" })), "thinking auto adds an extra body");

// ---- streamCall on the fake API: the request Claude Code sends, the stats, errors.
const SYS = `You draw wireframes. t1 ${CANARY.slice(-4)}`;
const ok = await call("claude-sonnet-5-5", SYS);
const okReq = reqOf(ok.user);
if (ok.err || okReq.length !== 1) fail(`a plain call failed or didn't reach the fake API once: ${ok.err?.message} (${okReq.length} requests)`);
const r0 = okReq[0];
check(r0.ttls.length > 0 && r0.ttls.every((t) => t === "5m"), `cache breakpoints not all 5m: ${r0.ttls}`);
check(!/extended-cache-ttl/.test(r0.beta), "the extended-ttl beta was sent");
check(r0.firstUser === ok.user, `the first user message isn't exactly ours: ${JSON.stringify(r0.firstUser.slice(0, 120))}`);
check(!/system-reminder|userEmail|@[a-z0-9-]+\.[a-z]/i.test(r0.firstUser), "the first user message carries a system-reminder or an email");
check(r0.thinking === undefined, "thinking auto sent a thinking field");
const st = ok.stats;
check(ok.text === "ok" && st.served === "claude-sonnet-5-5-fake" && st.stopReason === "end_turn" && typeof st.costUsd === "number", `stats miss text/served/stopReason/cost: ${JSON.stringify(st)}`);
check(st.write5m > 0 && st.write1h === 0 && st.cacheWrite === st.write5m, `the 5m/1h split is wrong: ${JSON.stringify(st)}`);
check(st.rateLimit?.fiveHour === 0.42 && st.rateLimit?.sevenDay === 0.11 && st.rateLimit?.resetsAt > 0 && st.rateLimit?.status === "allowed", `rate_limit_event utilization missing: ${JSON.stringify(st.rateLimit)}`);

api.set({ mode: "thinking" });
const th = await call("claude-haiku-5-5", SYS, { thinking: "off" });
check(!th.err && th.stats.thinkingTokens === 57 && th.stats.thinkingBlocks === 1, `thinking tokens/blocks not recorded: ${th.err?.message ?? JSON.stringify(th.stats)}`);
check(JSON.stringify(reqOf(th.user)[0]?.thinking) === '{"type":"disabled"}', "haiku thinking off didn't send thinking: disabled");
api.set({ mode: "ok" });
const off = await call("claude-sonnet-5-5", SYS, { thinking: "off" });
check(JSON.stringify(reqOf(off.user)[0]?.thinking) === '{"type":"between_tools"}', "sonnet thinking off didn't send thinking: between_tools");

let expectedErrorRequests = 0;
for (const [mode, attempts] of [["limit", 1], ["auth", 2], ["overload", 3]]) {
  api.set({ mode });
  const before = api.requests.length;
  const t0 = Date.now();
  const r = await call("claude-sonnet-5-5", SYS);
  const ms = Date.now() - t0;
  api.set({ mode: "ok" });
  check(r.err instanceof CallError, `${mode}: no error thrown (${r.err?.message ?? `text ${JSON.stringify(r.text)}`})`);
  check(api.requests.length - before === attempts, `${mode}: ${api.requests.length - before} attempts, expected ${attempts}`);
  expectedErrorRequests += attempts;
  if (mode === "limit") check(r.err?.stats?.rateLimit?.status === "rejected", "a 429 didn't record the rejected rate limit");
  if (mode === "overload") check(ms < 5000 && r.err?.stats?.retries === 2, `a 529 storm took ${ms} ms with ${r.err?.stats?.retries} retries (MAX_RETRIES=2)`);
}
api.set({ mode: "maxtokens" });
const before = api.requests.length;
const mt = await call("claude-sonnet-5-5", SYS);
const mtAttempts = api.requests.length - before;
api.set({ mode: "ok" });
check(!mt.err && mt.stats.stopReason === "max_tokens" && mt.text.length > 0, `a cut-off reply: ${mt.err?.message ?? JSON.stringify(mt.stats)}`);

// ---- Pool: top-up rule, readyAtTake, the idle reaper.
check(keepOf(undefined, 4) === 1 && keepOf(0, 4) === 0 && keepOf(2, 4) === 2 && keepOf(9, 4) === 4, "keepOf: no warm → 1, warm 0 → 0, warm n → n, capped at 4");
const start = (system) => () => startProcess("claude-sonnet-5-5", system, { token: FAKE, configDir, mockApi });
const pool = new Pool({ idleMs: 500 });
const kA = keyOf("claude-sonnet-5-5", "pool A");
pool.warm(kA, 1, start("pool A"));
const early = pool.take(kA, 0, start("pool A"));
check(early.waiting && !early.readyAtTake, `a still-starting spare: waiting ${early.waiting}, readyAtTake ${early.readyAtTake}`);
early.proc.q.close();
pool.warm(kA, 2, start("pool A"));
await sleep(150);
sampleChildren();
const pooled = children().filter((pid) => childEnvs.has(pid) && alive(pid));
check(pool.sizes()[kA] === 2, `warm 2 left ${pool.sizes()[kA]} waiting`);
await sleep(1300);
check(!pool.sizes()[kA], `idle processes weren't reaped: ${JSON.stringify(pool.sizes())}`);
await sleep(300);
check(pooled.length >= 2 && pooled.every((pid) => !alive(pid)), `reaped processes still running (${pooled.filter(alive).length} of ${pooled.length})`);
pool.closeAll();
const pool2 = new Pool();
const kB = keyOf("claude-sonnet-5-5", "pool B");
pool2.warm(kB, 1, start("pool B"));
await sleep(1500);
const later = pool2.take(kB, 0, start("pool B"));
check(later.waiting && later.readyAtTake, `a spare that had finished starting: waiting ${later.waiting}, readyAtTake ${later.readyAtTake}`);
later.proc.q.close();
pool2.closeAll();

// ---- The dev plugin through a Vite server on this check's port: NDJSON, warm default, keys, log, config dir.
const root = mkdtempSync(join(tmpdir(), "rt-t1-root-"));
writeFileSync(join(root, ".env"), `CLAUDE_CODE_OAUTH_TOKEN=${FAKE_DEV}\n`);
const { createServer } = await import("vite");
const { modelApi, poolSizes } = await import("../../dev/model-plugin.ts");
const PORT = 5210;
const vite = await createServer({ root, configFile: false, envDir: root, logLevel: "silent", appType: "custom", plugins: [modelApi({ mockApi })], server: { port: PORT, strictPort: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
await vite.listen();
const base = `http://127.0.0.1:${PORT}`;
async function post(body) {
  const res = await fetch(`${base}/api/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.headers.get("content-type")?.includes("ndjson")) return { json: await res.json() };
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { lines, done: lines.at(-1), text: lines.filter((l) => l.text).map((l) => l.text).join("") };
}
const SON = "claude-sonnet-5-5";
const m1 = mark();
const d1 = await post({ model: "sonnet", system: "dev one", user: m1, tag: "t1-tag" });
check(d1.text === "ok" && d1.done?.done && !d1.done.error && d1.done.served === "claude-sonnet-5-5-fake" && d1.done.write1h === 0 && d1.done.settings, `dev plugin reply: ${JSON.stringify(d1.done)}`);
check(poolSizes()[keyOf(SON, "dev one")] === 1, `a request without warm left ${poolSizes()[keyOf(SON, "dev one")] ?? 0} waiting (want 1)`);
sampleChildren();
const m2 = mark();
await post({ model: "sonnet", system: "dev two", user: m2, warm: 0 });
check(!poolSizes()[keyOf(SON, "dev two")], "a request with warm 0 left a process waiting");
const w = await post({ model: "sonnet", system: "dev three", warm: 1 });
check(w.json?.warming === 1 && poolSizes()[keyOf(SON, "dev three")] === 1, "a warm request didn't start one process");
await sleep(600);
const m3 = mark();
const d3 = await post({ model: "sonnet", system: "dev three", user: m3, thinking: "off" });
check(d3.done?.warm === false && JSON.stringify(reqOf(m3)[0]?.thinking) === '{"type":"between_tools"}', `a thinking:off request was served by a process warmed without it (warm ${d3.done?.warm}, thinking ${JSON.stringify(reqOf(m3)[0]?.thinking)})`);
check(poolSizes()[keyOf(SON, "dev three")] === 1 && poolSizes()[keyOf(SON, "dev three", "low", "off")] === 1, `pool keys don't separate thinking: ${JSON.stringify(poolSizes())}`);
await post({ model: "sonnet", system: "dev four", warm: 1, effort: "high" });
const m4 = mark();
const d4 = await post({ model: "sonnet", system: "dev four", user: m4, effort: "high" });
check(d4.done?.warm === true && d4.done?.readyAtTake === false && reqOf(m4)[0]?.effort === "high", `a still-starting spare: warm ${d4.done?.warm}, readyAtTake ${d4.done?.readyAtTake}, effort ${reqOf(m4)[0]?.effort}`);
sampleChildren();
const logFile = join(process.env.RT_DATA_DIR, "model-calls.jsonl");
const logged = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const l1 = logged.find((l) => l.user === m1);
check(l1 && l1.tag === "t1-tag" && l1.served && l1.write5m > 0 && l1.write1h === 0 && "thinkingTokens" in l1 && l1.stopReason === "end_turn" && l1.rateLimit, `RT_DATA_DIR/model-calls.jsonl misses the call or its new fields: ${JSON.stringify(l1)}`);
check(!existsSync(join(root, ".data")), "the dev plugin wrote <root>/.data despite RT_DATA_DIR");
const devEnvs = [...childEnvs.values()].filter((e) => e.CLAUDE_CODE_OAUTH_TOKEN === FAKE_DEV);
check(devEnvs.length >= 3, `saw ${devEnvs.length} dev-plugin processes`);
for (const e of devEnvs) envOk(e, "a dev-plugin process", { token: FAKE_DEV, mock: true, config: join(process.env.RT_DATA_DIR, "claude-config") });
check(devEnvs.every((e) => !("CLAUDE_CODE_MAX_RETRIES" in e)), "the dev plugin sets MAX_RETRIES (it should keep Claude Code's default)");
await vite.close();
globalThis.__rtV2Pool?.closeAll();

// ---- warmModel sends effort and thinking (model.ts in node, fetch stubbed).
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response("{}"));
const { warmModel } = await import("../../src/core/model.ts");
warmModel("sonnet", "S", 2, { effort: "high", thinking: "off" });
warmModel("sonnet", "S");
await sleep(10);
globalThis.fetch = realFetch;
check(JSON.stringify(sent[0]?.body) === JSON.stringify({ model: "sonnet", system: "S", warm: 2, effort: "high", thinking: "off" }), `warmModel with opts sent ${JSON.stringify(sent[0]?.body)}`);
check(JSON.stringify(sent[1]?.body) === JSON.stringify({ model: "sonnet", system: "S", warm: 1 }), `warmModel without opts sent ${JSON.stringify(sent[1]?.body)}`);

// ---- The TTS plugin: 403 under RT_DENY_TTS=1, today's behaviour otherwise, RT_DATA_DIR for its cache and log.
let ttsFetches = 0;
globalThis.fetch = async () => {
  ttsFetches++;
  throw new Error("no network in this check");
};
const { ttsApi } = await import("../../dev/tts-plugin.ts");
const tts = ttsApi();
let handler;
tts.configResolved({ mode: "development", root });
tts.configureServer({ middlewares: { use: (_p, fn) => (handler = fn) } });
async function ttsCall(body) {
  const req = { method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  await handler(req, res);
  return res;
}
process.env.RT_DENY_TTS = "1";
check((await ttsCall({ text: "hello" })).statusCode === 403, "/api/tts didn't answer 403 with RT_DENY_TTS=1");
delete process.env.RT_DENY_TTS;
check((await ttsCall({ text: "" })).statusCode === 400, "/api/tts without the deny doesn't behave as today (400 on empty text)");
const cached = `${createHash("sha256").update("eleven_v4\nbIHbv24MWmeRgasZH58o\ncached line").digest("hex").slice(0, 32)}.json`;
mkdirSync(join(process.env.RT_DATA_DIR, "tts"), { recursive: true });
writeFileSync(join(process.env.RT_DATA_DIR, "tts", cached), JSON.stringify({ audio: "", words: [], chars: 11 }));
const hit = await ttsCall({ text: "cached line" });
check(hit.statusCode === 200 && JSON.parse(hit.body).cached === true && existsSync(join(process.env.RT_DATA_DIR, "tts-calls.jsonl")), "the TTS plugin doesn't keep its cache and log in RT_DATA_DIR");
check(ttsFetches === 0, `the TTS plugin fetched ${ttsFetches} times`);
globalThis.fetch = realFetch;

// ---- The fake API's own modes: --replies (via its CLI entry), --script, --latency.
const work = mkdtempSync(join(tmpdir(), "rt-t1-fake-"));
const SYS_R = "You are the drawing model (canned).";
mkdirSync(join(work, "replies"));
writeFileSync(join(work, "replies", `draw.${sha12(SYS_R)}.txt`), "canned draw reply");
const child = spawn(process.execPath, ["--import", join(ROOT, "evals/loop/node-hooks.mjs"), join(ROOT, "evals/mock/fake-api.ts"), "--replies", join(work, "replies")], { env: cleanEnv(), stdio: ["ignore", "pipe", "inherit"] });
const fakeUrl = await new Promise((resolve, reject) => {
  child.stdout.on("data", (d) => /READY (\S+)/.test(String(d)) && resolve(/READY (\S+)/.exec(String(d))[1]));
  child.on("exit", () => reject(new Error("fake-api.ts exited")));
  setTimeout(() => reject(new Error("fake-api.ts didn't print READY")), 5000);
});
const viaReplies = async (system) => {
  const p = startProcess("claude-sonnet-5-5", system, { token: FAKE, configDir, mockApi: { ...mockApi, baseUrl: fakeUrl } });
  try {
    await p.ready;
    sampleChildren();
    return (await streamCall(p, toContent(mark()))).text;
  } finally {
    p.q.close();
  }
};
const canned = await viaReplies(SYS_R);
const other = await viaReplies("no file for this one");
const replyLog = (await (await fetch(`${fakeUrl}/_log`)).json()).requests;
child.kill();
check(canned === "canned draw reply" && replyLog[0]?.role === "draw", `--replies didn't route by role marker + system hash: ${JSON.stringify(canned)} role ${replyLog[0]?.role}`);
check(other === "ok" && replyLog[1]?.role === "?", "--replies: an unmatched system prompt isn't answered 'ok' with role '?'");

async function sse(fake, messages) {
  const t0 = Date.now();
  const res = await fetch(`${fake.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", system: [{ type: "text", text: "s" }], messages, stream: true }) });
  const events = [];
  let firstTextMs;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const data = /data: (.*)/.exec(buf.slice(0, i))?.[1];
      buf = buf.slice(i + 2);
      if (!data) continue;
      const e = JSON.parse(data);
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") firstTextMs ??= Date.now() - t0;
      events.push(e);
    }
  }
  return { events, firstTextMs, ms: Date.now() - t0 };
}
writeFileSync(join(work, "script.json"), JSON.stringify([{ content: [{ type: "text", text: "Reading it." }, { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }] }, { content: [{ type: "text", text: "finished" }] }]));
const scripted = await startFakeApi({ script: join(work, "script.json") });
const s1 = await sse(scripted, [{ role: "user", content: "go" }]);
const toolStart = s1.events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
const toolJson = s1.events.find((e) => e.delta?.type === "input_json_delta")?.delta.partial_json;
check(toolStart?.content_block.name === "Read" && JSON.parse(toolJson ?? "{}").file_path === "/tmp/x" && s1.events.find((e) => e.type === "message_delta")?.delta.stop_reason === "tool_use", "--script didn't play the tool_use turn");
const s2 = await sse(scripted, [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "Reading it." }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "data" }] }]);
check(s2.events.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("") === "finished", "--script didn't play turn 2 after one assistant message");
await scripted.close();
writeFileSync(join(work, "calls.jsonl"), `${JSON.stringify({ from: "draw", ms: 1000, firstMs: 700, waitMs: 100, outTokens: 80 })}\n`);
const timed = await startFakeApi({ latency: join(work, "calls.jsonl") });
const s3 = await sse(timed, [{ role: "user", content: "hi" }]);
check(Math.abs(s3.firstTextMs - 600) < 80 && Math.abs(s3.ms - 900) < 120, `--latency replayed first text at ${s3.firstTextMs} ms (want ~600) and the end at ${s3.ms} ms (want ~900)`);
await timed.close();

// ---- Every spawned env, and the fake API saw exactly the calls this check made.
sampleChildren();
check(childEnvs.size >= 10, `only ${childEnvs.size} Claude processes were seen`);
for (const [pid, env] of childEnvs) envOk(env, `Claude process ${pid}`, { token: env.CLAUDE_CODE_OAUTH_TOKEN === FAKE_DEV ? FAKE_DEV : FAKE, mock: true, base: env.ANTHROPIC_BASE_URL === fakeUrl ? fakeUrl : api.url });
check([...childEnvs.values()].every((e) => e.ANTHROPIC_BASE_URL === api.url || e.ANTHROPIC_BASE_URL === fakeUrl), "a Claude process wasn't pointed at a fake API");
// One request per plain call (each carries its marker); the error modes' attempts and the max-tokens continuations counted above.
const single = api.requests.filter((r) => /<t1-call-\d+>/.test(r.firstUser));
check(api.requests.length === single.length, `the fake API got ${api.requests.length - single.length} requests no call of this check made`);
const plainCalls = [ok, th, off].map((c) => c.user).concat([m1, m2, m3, m4]);
check(plainCalls.every((m) => reqOf(m).length === 1), `a plain call reached the fake API other than once: ${plainCalls.map((m) => reqOf(m).length)}`);
check(mtAttempts === 4, `a max-tokens reply made ${mtAttempts} requests (Claude Code continues it 3 times: expected 4)`);
check(api.requests.length === plainCalls.length + expectedErrorRequests + mtAttempts, `the fake API's ${api.requests.length} requests aren't this check's ${plainCalls.length} calls + ${expectedErrorRequests} error attempts + ${mtAttempts} max-tokens requests`);
check(api.requests.every((r) => r.ttls.every((t) => t === "5m")), "a request asked for a 1-hour cache");
await api.close();
finish();
