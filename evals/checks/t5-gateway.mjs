// T5's acceptance check: the gateway as its own process on the fake API (sharing,
// scan, replay, the per-run judge cache, queues, pools, rotation, the cap, the
// meter, blobs), and tokens.ts' loaders and slot rules in-process. 0 real calls:
// fake tokens only, every Claude process on the fake API with HTTPS_PROXY at a
// closed port, and the fake API's request count must equal the gateways' call count.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t5-gateway.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const home = tempHome();
const work = mkdtempSync(join(tmpdir(), "rt-t5-"));
// A clean env, plus things the gateway must ignore: tokens in the environment and an env call cap.
const CANARY = `rt-canary-${randomBytes(6).toString("hex")}`;
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, cleanEnv(), { RT_EVAL_HOME: home, RT_DATA_DIR: join(home, "data"), RT_EVAL_TOKEN_1: CANARY, RT_EVAL_TOKEN_2: CANARY, RT_EVAL_CALL_CAP: "1" });
const TOKENS = [1, 2, 3].map((n) => `sk-ant-oat01-fake-t5-${n}-${randomBytes(6).toString("hex")}`);
const tokensFile = join(work, "tokens.env");
writeFileSync(tokensFile, TOKENS.map((t, i) => `RT_EVAL_TOKEN_${i + 1}=${t}`).join("\n") + "\n");
chmodSync(tokensFile, 0o600);

const { startFakeApi } = await import("../mock/fake-api.ts");
const { ask, endCase, gatewayStatus, setMode, spawnGateway } = await import("../loop/client.ts");
const { CALL_FIELDS } = await import("../loop/meter.ts");
const { paths } = await import("../loop/paths.ts");
const { Slots, loadDevToken, loadTokens } = await import("../loop/tokens.ts");

const DRAW = "You are the drawing model (t5).";
const LONG = "rect(10, 10, 200, 40)\ntext(20, 20, \"Shop\")\nrect(10, 60, 200, 300)\nline(0, 0, 50, 50)";
mkdirSync(join(work, "replies"));
writeFileSync(join(work, "replies", `draw.${sha(DRAW).slice(0, 12)}.txt`), LONG);
const api = await startFakeApi({ replies: join(work, "replies") });
const gw = await spawnGateway({ home, port: 5211, tokens: tokensFile, mockApi: api.url });
check(gw.pid !== process.pid, "the gateway isn't its own process");

// A product call the way an arm page makes it (CDP adds the x-rt-* labels), with each chunk's arrival time.
async function product(labels, body, url = gw.url) {
  const t0 = performance.now();
  // x-rt-at: when the page sent it, as the bridge stamps it.
  const res = await fetch(`${url}/api/model`, { method: "POST", headers: { "content-type": "application/json", "x-rt-at": String(performance.timeOrigin + t0), ...Object.fromEntries(Object.entries(labels).map(([k, v]) => [`x-rt-${k}`, String(v)])) }, body: JSON.stringify(body) });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const chunks = [];
  let done;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.text !== undefined) chunks.push({ ms: performance.now() - t0, text: m.text });
      if (m.done || m.warming !== undefined || m.error) done = m;
    }
  }
  return { chunks, text: chunks.map((c) => c.text).join(""), done, ms: performance.now() - t0 };
}
const upstream = () => api.requests.length;
const tag = (s) => `<${s}>`;
const reqsWith = (s) => api.requests.filter((r) => r.firstUser.includes(tag(s)));

// ---- Sharing inside a case: one call, the follower on its own clock plus the leader's offsets.
api.set({ mode: "slow", slowMs: 300, chunkMs: 120 });
const U1 = `${tag("shared")} draw a shop`;
const n0 = upstream();
const lead = product({ run: "r1", case: "c1", arm: "A", slot: 0 }, { model: "sonnet", system: DRAW, user: U1, from: "draw", warm: 0 });
await sleep(30);
const follow = await product({ run: "r1", case: "c1", arm: "B", slot: 0 }, { model: "sonnet", system: DRAW, user: U1, from: "draw", warm: 0 });
const leader = await lead;
check(upstream() - n0 === 1, `byte-identical requests 30 ms apart made ${upstream() - n0} upstream calls`);
check(leader.text === LONG && follow.text === LONG && leader.chunks.length >= 4, `shared texts: ${JSON.stringify(leader.text)} / ${JSON.stringify(follow.text)}`);
check(leader.done?.shared === "leader" && follow.done?.shared === "follower", `shared labels ${leader.done?.shared} / ${follow.done?.shared}`);
const drift = leader.chunks.map((c, i) => Math.abs((follow.chunks[i]?.ms ?? Infinity) - c.ms));
check(follow.chunks.length === leader.chunks.length && Math.max(...drift) <= 20, `the follower's chunks aren't at its own time + the leader's offsets ± 20 ms: ${drift.map(Math.round)}`);
const c1 = await endCase("r1", "c1");
check(typeof c1.loopP99Ms === "number" && c1.loopP99Ms >= 0 && c1.loopP99Ms < 20, `case loop delay p99: ${c1.loopP99Ms}`);
const recA = c1.calls?.A?.[0];
check(recA?.role === "draw" && recA.ordinal === 0 && recA.reqHash === leader.done.reqHash && recA.cacheFile && recA.offsets.length === leader.chunks.length, `the case's calls: ${JSON.stringify(c1.calls)}`);
check(c1.calls?.B?.[0]?.cacheFile === recA.cacheFile, "the follower's record doesn't point at the leader's reply");
// Unshared runs (A/A, checkpoints) and repeats within a live run: every product call is a fresh sample.
await setMode("r2", "live", { share: false });
const n5 = upstream();
const [ua, ub] = await Promise.all(["A", "B"].map((arm) => product({ run: "r2", case: "u1", arm, slot: 0 }, { model: "sonnet", system: DRAW, user: U1, from: "draw", warm: 0 })));
const again = await product({ run: "r1", case: "c6", arm: "A", slot: 0 }, { model: "sonnet", system: DRAW, user: U1, from: "draw", warm: 0 });
await setMode("r3", "live", { cached: [leader.done.reqHash] });
const banked = await Promise.all(["A", "B"].map((arm) => product({ run: "r3", case: "k1", arm, slot: 0 }, { model: "sonnet", system: DRAW, user: U1, from: "draw", warm: 0 })));
check(banked.every((r) => r.done?.mode === "replay" && r.text === LONG), `a request the run names as identical in both arms isn't replayed from the bank cache: ${banked.map((r) => r.done?.mode)}`);
check(upstream() - n5 === 3 && [ua, ub, again].every((r) => r.done?.mode === "live" && r.done?.shared === "-"), `unshared or repeated identical requests weren't all live: ${upstream() - n5} upstream, ${[ua, ub, again].map((r) => `${r.done?.mode}/${r.done?.shared}`)}`);
const n1 = upstream();
await Promise.all([product({ run: "r1", case: "c2", arm: "A", slot: 0 }, { model: "sonnet", system: "other", user: `${tag("diff-a")}`, warm: 0 }), product({ run: "r1", case: "c2", arm: "B", slot: 0 }, { model: "sonnet", system: "other", user: `${tag("diff-b")}`, warm: 0 })]);
check(upstream() - n1 === 2, `differing requests made ${upstream() - n1} upstream calls`);
const c2 = await endCase("r1", "c2");
api.set({ mode: "ok" });

// ---- Images: stored once as blobs, referenced by hash from each reply file.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const img = `data:image/jpeg;base64,${JPEG}`;
const i1 = await product({ run: "r1", case: "c3", arm: "A", slot: 1 }, { model: "sonnet", system: "pics", user: tag("img-1"), images: [img], warm: 0 });
const i2 = await product({ run: "r1", case: "c3", arm: "A", slot: 1 }, { model: "sonnet", system: "pics", user: tag("img-2"), images: [img], warm: 0 });
const p = paths(home);
const blobSha = sha(Buffer.from(JPEG, "base64"));
const blobs = existsSync(join(home, "cache", "blobs")) ? readdirSync(join(home, "cache", "blobs")) : [];
const replyImgs = [i1, i2].map((r) => JSON.parse(readFileSync(p.reply(r.done.reqHash), "utf8")).request.images);
check(blobs.length === 1 && blobs[0] === `${blobSha}.jpg` && replyImgs.every((x) => x.length === 1 && x[0] === blobSha), `blobs ${blobs}, reply images ${JSON.stringify(replyImgs)}`);
check(reqsWith("img-1")[0]?.images === 1, "the image didn't reach the fake API");
await endCase("r1", "c3");

// ---- Pools: keyed (arm, slot, token, model, system, effort, thinking); eval roles never pool.
await product({ run: "r1", case: "c5", arm: "B", slot: 3 }, { model: "sonnet", system: "pooled", warm: 1, effort: "high", thinking: "off" });
await sleep(100);
const pools1 = (await gatewayStatus()).pools;
const pk = Object.keys(pools1).find((k) => k.startsWith("B|3|t1|claude-sonnet-5-5:high:off:"));
check(pk && pools1[pk] === 1, `a warm request for arm B slot 3 effort high thinking off isn't its own pool key: ${JSON.stringify(pools1)}`);

// ---- Eval roles: driver and judge replies reused only by their own run (a resume), never by another.
const n2 = upstream();
const j1 = await ask({ role: "judge", model: "sonnet", system: "judge sys", turns: [tag("judge-1"), "which is better?"], effort: "high", run: "j1", case: "x" });
const j1again = await ask({ role: "judge", model: "sonnet", system: "judge sys", turns: [tag("judge-1"), "which is better?"], effort: "high", run: "j1", case: "x" });
const j2 = await ask({ role: "judge", model: "sonnet", system: "judge sys", turns: [tag("judge-1"), "which is better?"], effort: "high", run: "j2", case: "x" });
const d1 = await ask({ role: "driver", model: "sonnet", system: "driver sys", turns: tag("driver-1"), run: "j1" });
const d2 = await ask({ role: "driver", model: "sonnet", system: "driver sys", turns: tag("driver-1"), run: "j2" });
check(upstream() - n2 === 4 && j1.stats.mode === "live" && j1again.stats.mode === "resume" && j2.stats.mode === "live" && d2.stats.mode === "live", `judge/driver across runs: ${upstream() - n2} upstream (want 4), modes ${[j1, j1again, j2, d1, d2].map((x) => x.stats.mode)}`);
check(reqsWith("judge-1")[0]?.effort === "high", "the judge's effort didn't reach the request");
check(JSON.stringify((await gatewayStatus()).pools) === JSON.stringify(pools1), "an eval-role call changed the pools");

// ---- Queues: 10 concurrent product calls all in flight; eval roles at most 6.
api.set({ mode: "slow", slowMs: 2500, chunkMs: 10 });
const overlap = (rs) => Math.max(...rs.map((r) => rs.filter((x) => x.at <= r.at && x.endAt > r.at).length));
await Promise.all(Array.from({ length: 10 }, (_, i) => product({ run: "r1", case: "c4", arm: i % 2 ? "B" : "A", slot: i >> 1 }, { model: "haiku", system: "conc", user: tag(`prod-${i}`), warm: 0 })));
const prodReqs = api.requests.filter((r) => /<prod-\d>/.test(r.firstUser));
check(prodReqs.length === 10 && overlap(prodReqs) === 10, `10 concurrent product calls: ${prodReqs.length} reached the fake API, ${overlap(prodReqs)} at once (want 10)`);
await endCase("r1", "c4");
await Promise.all(Array.from({ length: 10 }, (_, i) => ask({ role: "judge", model: "haiku", system: "conc", turns: tag(`eval-${i}`), run: "conc" })));
const evalReqs = api.requests.filter((r) => /<eval-\d>/.test(r.firstUser));
check(evalReqs.length === 10 && overlap(evalReqs) === 6, `10 concurrent eval calls: ${evalReqs.length} reached the fake API, ${overlap(evalReqs)} at once (want 6)`);
api.set({ mode: "ok" });

// ---- Scan: an exact hit at once, else the case's stand-in (by subject for pictures, else role and ordinal), else empty.
const caseDir = p.bankCase("bank-c1");
mkdirSync(caseDir, { recursive: true });
writeFileSync(join(caseDir, "replies.json"), JSON.stringify([
  { role: "draw", ordinal: 0, reqHash: recA.reqHash, cacheFile: recA.cacheFile, offsets: recA.offsets },
  { role: "picture", ordinal: 7, subject: "a red kite", reqHash: c2.calls.A[0].reqHash, cacheFile: c2.calls.A[0].cacheFile, offsets: [] },
]));
await setMode("scan1", "scan");
const n3 = upstream();
const scanLabels = { run: "scan1", case: "bank-c1", arm: "B", slot: 0 };
const exact = await product(scanLabels, { model: "sonnet", system: DRAW, user: U1, from: "draw" });
const sDraw = await product({ ...scanLabels, arm: "A" }, { model: "sonnet", system: DRAW, user: "a request the bank never saw", from: "draw" });
const sPic = await product(scanLabels, { model: "sonnet", system: "picture sys", user: "Doodle: a red kite\nin a 100 × 80 box", from: "picture" });
const sMiss = await product(scanLabels, { model: "haiku", system: "camera sys", user: "frame the cart", from: "camera" });
check(upstream() === n3, `scan mode made ${upstream() - n3} upstream calls`);
check(exact.text === LONG && exact.done?.scan === "hit" && exact.done?.mode === "scan" && exact.ms < 150, `scan exact hit: ${exact.done?.scan} in ${Math.round(exact.ms)} ms`);
check(sDraw.text === LONG && sDraw.done?.scan === "standin", `scan stand-in by role and ordinal: ${sDraw.done?.scan} ${JSON.stringify(sDraw.text.slice(0, 20))}`);
check(sPic.text === "ok" && sPic.done?.scan === "standin", `scan stand-in by picture subject: ${sPic.done?.scan} ${JSON.stringify(sPic.text)}`);
check(sMiss.text === "" && sMiss.done?.scan === "miss" && !sMiss.done?.error, `scan miss: ${sMiss.done?.scan} ${JSON.stringify(sMiss.text)}`);

// ---- Replay: the recorded offsets, on the requester's own clock.
await setMode("rep1", "replay");
const n4 = upstream();
const rep = await product({ run: "rep1", case: "rc", arm: "A", slot: 0 }, { model: "sonnet", system: DRAW, user: U1, from: "draw" });
const recorded = JSON.parse(readFileSync(p.reply(recA.cacheFile.replace(/\.json$/, "")), "utf8")).chunks;
const repDrift = recorded.map((c, i) => Math.abs((rep.chunks[i]?.ms ?? Infinity) - c.ms));
check(upstream() === n4 && rep.done?.mode === "replay" && rep.text === LONG && Math.max(...repDrift) <= 20, `replay: ${upstream() - n4} upstream, mode ${rep.done?.mode}, offsets off by ${repDrift.map(Math.round)}`);

// ---- Rotation end to end: off a slot at five-hour 0.90 and on a 429, at the next case boundary.
api.set({ util5h: 0.95 });
await product({ run: "rot", case: "rot1", arm: "A", slot: 0 }, { model: "haiku", system: "rot", user: tag("rot-1"), warm: 0 });
api.set({ util5h: 0.42, mode: "limit" });
const limited = await product({ run: "rot", case: "rot2", arm: "A", slot: 0 }, { model: "haiku", system: "rot", user: tag("rot-2"), warm: 0 });
api.set({ mode: "ok" });
await product({ run: "rot", case: "rot3", arm: "A", slot: 0 }, { model: "haiku", system: "rot", user: tag("rot-3"), warm: 0 });
const st1 = await gatewayStatus();
const meterLines = () => readFileSync(p.calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tokenOfCase = (c) => meterLines().find((l) => l.case === c)?.token;
check(limited.done?.error && tokenOfCase("rot1") === 1 && tokenOfCase("rot2") === 2 && tokenOfCase("rot3") === 3, `rotation: tokens per case ${["rot1", "rot2", "rot3"].map(tokenOfCase)} (want 1, 2, 3; the 429 ${limited.done?.error ? "failed" : "didn't fail"})`);
check(/five-hour/.test(st1.slots[0].why) && /rate limited/.test(st1.slots[1].why) && !st1.slots[2].why && st1.slots[2].current, `slot status: ${JSON.stringify(st1.slots.map((s) => [s.slot, s.why, s.current]))}`);

// ---- Slots in-process: the estimate, the weekly allowance, W_k on allowed_warning, one account, pacing.
let now = Date.UTC(2026, 9, 16, 3);
const s = new Slots([1, 2], undefined, () => now);
s.record(1, { usd: 10, rateLimit: { status: "allowed" } });
s.record(1, { usd: 8, rateLimit: { status: "allowed_warning" } });
check(s.status()[0].windowUsd === 20 && s.status()[0].calibrated, `W_k after an allowed_warning at $18: ${s.status()[0].windowUsd} (want 20)`);
check(s.boundary() === 2, "allowed_warning didn't move work to slot 2");
const s2 = new Slots([1, 2], undefined, () => now);
s2.record(1, { usd: 150 });
check(!s2.why(1), "slot 1 is off at $150 of $170");
s2.record(1, { usd: 3.01 });
check(/five-hour/.test(s2.why(1) ?? "") && s2.boundary() === 2, `the list-$ estimate at 0.90 doesn't rotate: ${s2.why(1)}`);
const s3 = new Slots([1, 2, 3], undefined, () => now);
s3.record(1, { usd: 0.01, rateLimit: { status: "allowed", fiveHour: 0.1, sevenDay: 0.41 } });
for (let h = 0; h < 6; h++) {
  now += 3600_000 * 5.5; // across windows: only the week adds up
  s3.record(2, { usd: 100 });
}
check(s3.why(1) === "weekly allowance" && s3.why(2) === "weekly allowance" && s3.boundary() === 3, `the weekly allowance: ${s3.why(1)} / ${s3.why(2)}`);
const reset = Math.floor(now / 1000) + 1800;
s3.record(3, { usd: 0, rateLimit: { status: "allowed", resetsAt: reset } });
s3.record(2, { usd: 0, rateLimit: { status: "allowed", resetsAt: reset } });
check(JSON.stringify(s3.sameAccount()) === "[2,3]", `equal resetsAt isn't one account: ${JSON.stringify(s3.sameAccount())}`);
const s4 = new Slots([1], undefined, () => now);
s4.record(1, { usd: 0.5 * 170 });
check(s4.pace(0.5).ok === false && s4.pace(1.2).ok === true, "the night cap doesn't stop at 0.5 windows");
const home4 = mkdtempSync(join(tmpdir(), "rt-t5-same-"));
mkdirSync(join(home4, "meter"));
writeFileSync(join(home4, "meter", "slots.json"), JSON.stringify([1, 2].map((slot) => ({ slot, resetsAt: Math.floor(Date.now() / 1000) + 3000, usdWindow: 0, W: 170, calibrated: false, limited: false, hours: {} }))));
const refusedSame = await spawnGateway({ home: home4, tokens: tokensFile, mockApi: api.url }).then((g) => (g.close(), "started"), (e) => e.message);
check(/same resetsAt/.test(refusedSame), `a gateway whose slots 1 and 2 share a resetsAt: ${refusedSame}`);

// ---- The call cap: a flag, never the env (RT_EVAL_CALL_CAP=1 is set in this env all along).
const home2 = mkdtempSync(join(tmpdir(), "rt-t5-cap-"));
const capped = await spawnGateway({ home: home2, port: 5212, cap: 3, tokens: tokensFile, mockApi: api.url });
const capCalls = [];
for (let i = 0; i < 4; i++) capCalls.push(await ask({ role: "judge", model: "haiku", system: "cap", turns: tag(`cap-${i}`), run: "cap" }, capped.url).then((r) => r.text, (e) => `ERR ${e.message}`));
const capStatus = await gatewayStatus(capped.url);
check(capCalls.slice(0, 3).every((t) => t === "ok") && /call cap 3 reached/.test(capCalls[3]) && capStatus.calls === 3 && capStatus.capReached, `--cap 3 with RT_EVAL_CALL_CAP=1 in the env: ${capCalls}`);

// ---- The dev token (O3): only under a cap ≤ 60, read from the checkout's .env files into memory.
const checkout = mkdtempSync(join(tmpdir(), "rt-t5-checkout-"));
const DEV = `sk-ant-oat01-fake-t5-dev-${randomBytes(6).toString("hex")}`;
writeFileSync(join(checkout, ".env"), `ELEVENLABS_API_KEY=not-this\nCLAUDE_CODE_OAUTH_TOKEN=${DEV}-old\n`);
writeFileSync(join(checkout, ".env.local"), `CLAUDE_CODE_OAUTH_TOKEN=${DEV}\n`);
const refusedDev = await Promise.all([undefined, 100].map((cap) => spawnGateway({ home: home2, cap, devToken: checkout, mockApi: api.url }).then((g) => (g.close(), "started"), (e) => e.message)));
check(refusedDev.every((m) => /--cap 60 or less/.test(m)), `--dev-token without a cap ≤ 60: ${refusedDev}`);
const home3 = mkdtempSync(join(tmpdir(), "rt-t5-dev-"));
const dev = await spawnGateway({ home: home3, port: 5213, cap: 30, devToken: checkout, mockApi: api.url });
const devCall = await ask({ role: "probe", model: "haiku", system: "probe", turns: tag("dev-1"), run: "dev" }, dev.url);
check(devCall.text === "ok" && reqsWith("dev-1").length === 1, "a --dev-token gateway didn't make its call");

// ---- loadTokens / loadDevToken in-process.
const refusedLoad = (f) => {
  try {
    loadTokens(f, () => {});
    return false;
  } catch {
    return true;
  }
};
const loose = join(work, "loose.env");
writeFileSync(loose, `RT_EVAL_TOKEN_1=${TOKENS[0]}\n`);
chmodSync(loose, 0o644);
const repo = join(work, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
const inRepo = join(repo, "tokens.env");
writeFileSync(inRepo, `RT_EVAL_TOKEN_1=${TOKENS[0]}\n`);
chmodSync(inRepo, 0o600);
const one = join(work, "one.env");
writeFileSync(one, `# one loop account\nRT_EVAL_TOKEN_1=${TOKENS[0]}\n`);
chmodSync(one, 0o600);
const warned = [];
const loaded = loadTokens(one, (w) => warned.push(w));
check(refusedLoad(loose) && refusedLoad(inRepo), "loadTokens accepted a mode-644 file or one inside a repo");
check(loaded.length === 1 && loaded[0].token === TOKENS[0] && warned.length === 1 && !warned[0].includes(TOKENS[0]), "one token loads with a warning (and the warning names no token)");
check(loadTokens(tokensFile, () => {}).every((t, i) => t.token === TOKENS[i]), "RT_EVAL_TOKEN_* in the env displaced the file's tokens");
check(loadDevToken(40, checkout)[0].token === DEV, "loadDevToken didn't read CLAUDE_CODE_OAUTH_TOKEN the way vite does (.env.local over .env)");

// ---- No token in the gateways' env, logs, meter lines or slot state; every meter line complete; the fake saw only the gateways' calls.
const gws = [gw, capped, dev];
const secrets = [...TOKENS, DEV, CANARY];
for (const g of gws) {
  const env = readFileSync(`/proc/${g.pid}/environ`, "utf8");
  check(!secrets.some((t) => env.includes(t)), `a token is in gateway ${g.pid}'s env`);
  check(!secrets.slice(0, 4).some((t) => g.logs().includes(t)), `a token is in gateway ${g.pid}'s output`);
}
const statuses = await Promise.all(gws.map((g) => gatewayStatus(g.url)));
const homes = [home, home2, home3];
for (const h of homes) {
  const text = existsSync(join(h, "meter", "calls.jsonl")) ? readFileSync(join(h, "meter", "calls.jsonl"), "utf8") : "";
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check(lines.length > 0 && lines.every((l) => CALL_FIELDS.every((k) => k in l)), `a meter line in ${h} misses §3.4 fields`);
  check(lines.every((l) => l.cacheWrite1h === 0 && l.sdk && l.reqHash), `a meter line in ${h} has a 1-hour write or no sdk/reqHash`);
  check(!secrets.some((t) => text.includes(t) || readFileSync(join(h, "meter", "slots.json"), "utf8").includes(t)), `a token is in ${h}'s meter`);
  const replies = readdirSync(join(h, "cache", "replies"));
  check(!replies.some((f) => secrets.some((t) => readFileSync(join(h, "cache", "replies", f), "utf8").includes(t))), `a token is in ${h}'s reply cache`);
}
const { rollup } = await import("../loop/meter.ts");
const byRole = rollup(meterLines(), (l) => l.role);
check(byRole.judge?.calls === 12 && byRole.judge.usd > 0 && byRole.judge.write1h === 0 && byRole.draw?.calls >= 3, `rollup by role: ${JSON.stringify(byRole.judge)}`);
const live = meterLines().filter((l) => l.mode === "live" && l.shared !== "follower");
check(live.length === statuses[0].calls, `gateway 1: ${live.length} live meter lines, ${statuses[0].calls} calls`);
const gatewayCalls = statuses.reduce((a, x) => a + x.calls, 0);
check(api.requests.length === gatewayCalls, `the fake API got ${api.requests.length} requests, the gateways made ${gatewayCalls} calls`);
for (const g of gws) await g.close();
await sleep(300);
check(gws.every((g) => !existsSync(`/proc/${g.pid}`) || /State:\s+Z/.test(readFileSync(`/proc/${g.pid}/status`, "utf8"))), "a gateway outlived close()");
await api.close();
if (!existsSync(p.calls)) fail("no meter file");
finish();
