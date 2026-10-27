// Jev's acceptance check: TypeSafe AI's decision model as a product model (dev/jev.ts,
// src/core/decide.ts). The gateway's Jev path on the fake API (one chunk, recorded,
// replayed, metered at Jev's price, counted toward the cap, no process or slot, no
// call without a key), the resolver's engines (Jev alone, Jev with Claude when
// unsure, the race, hints, the prompt and version knobs, Claude untouched at the
// defaults), the think router, and the dev server's route. 0 real calls: fake
// tokens, the fake API's Jev, and a canary key that must never reach it.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t22-jev.mjs
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { ROOT, assertLocalOnly, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

// Nothing in this process may reach past this machine: the dev servers below run here, and a real key on a real
// URL would be a paid call. (A vite root is where the dev plugin reads .env: never the repo's, which holds the owner's.)
const localFetch = globalThis.fetch;
globalThis.fetch = (url, init) => localFetch(assertLocalOnly(String(url)), init);

const sha = (b) => createHash("sha256").update(b).digest("hex");
const home = tempHome();
const work = mkdtempSync(join(tmpdir(), "rt-t22-"));
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, cleanEnv(), { RT_EVAL_HOME: home, RT_DATA_DIR: join(home, "data") });
const CANARY = `ts-canary-${randomBytes(6).toString("hex")}`;
const tokensFile = join(work, "tokens.env");
writeFileSync(tokensFile, [1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-fake-t22-${n}-${randomBytes(6).toString("hex")}`).join("\n") + "\n");
chmodSync(tokensFile, 0o600);

const { startFakeApi } = await import("../mock/fake-api.ts");
const { gatewayStatus, setMode, spawnGateway } = await import("../loop/client.ts");
const { paths } = await import("../loop/paths.ts");
const { PROMPTS, promptOf } = await import("../../src/core/prompts.ts");
const { runScript } = await import("../../src/core/ops.ts");
const { SCREEN, asPage } = await import("../../src/core/board.ts");
const { HitIndex } = await import("../../src/core/hittest.ts");
const { groupStrokes } = await import("../../src/core/marks.ts");
const { caseInput, resolve } = await import("../../src/core/resolve.ts");
const { buildPrompt, run: runDraw } = await import("../../src/core/draw.ts");
const { send } = await import("../../src/core/send.ts");
const { tune } = await import("../../src/core/tuning.ts");

const { scene } = runScript(asPage(readFileSync(join(ROOT, "src/fixtures/clowns.ops.txt"), "utf8"), "page", "Home"));
const [A, B] = scene.stacked().filter((s) => s.kind !== "frame").map((s) => s.id);
const CLAUDE_REFS = JSON.stringify({ refs: [{ phrase: "the clown", ids: [B] }] });
mkdirSync(join(work, "replies"));
writeFileSync(join(work, "replies", `resolver.${sha(PROMPTS.resolve[0].system).slice(0, 12)}.txt`), CLAUDE_REFS);
// The drawing model's reply on the canvas (resolve.speculate's check): one move of the clown the resolver names.
writeFileSync(join(work, "replies", `draw.${sha(promptOf("draw", tune({})).system(false, scene.width, scene.height, 0, SCREEN.w)).slice(0, 12)}.txt`), `move(${B}, 10 20 300 200)`);
const api = await startFakeApi({ replies: join(work, "replies") });
const jevReqs = () => api.requests.filter((r) => r.path === "/v1/systemone");
const claudeReqs = () => api.requests.filter((r) => r.path.endsWith("/v1/messages"));
const gw = await spawnGateway({ home, port: 5222, tokens: tokensFile, mockApi: api.url });

/** A product call as an arm page makes it: NDJSON text lines, then the stats line. */
async function product(labels, body, url = gw.url) {
  const res = await fetch(`${url}/api/model`, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(Object.entries(labels).map(([k, v]) => [`x-rt-${k}`, String(v)])) }, body: JSON.stringify(body) });
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { text: lines.filter((l) => l.text !== undefined).map((l) => l.text).join(""), texts: lines.filter((l) => l.text !== undefined).length, done: lines.find((l) => l.done || l.error || l.warming !== undefined) };
}
const question = (s) => ({ type: "noul", instructions: `Is it ${s}?`, criteria: { yes: "it is", no: "it isn't" } });
const JEV = { model: "jev-1.13.0", system: "", user: JSON.stringify({ state: { request: "t22" }, questions: { a: question("a"), b: question("b") } }), from: "draw-refs-jev" };

// ---- The gateway: one chunk, the fake API's Jev only, no process, metered at Jev's price.
api.set({ jev: { a: 0.9 } });
const live = await product({ run: "r1", case: "c1", arm: "A", slot: 0 }, JEV);
const answers = JSON.parse(live.text || "{}");
check(answers.a?.noul === 0.9 && answers.b?.noul === 0.1 && live.texts === 1, `the Jev reply: ${live.text} in ${live.texts} chunks`);
check(live.done?.done && live.done.model === "jev-1.13.0" && live.done.mode === "live" && live.done.waitMs === undefined && !live.done.error, `the Jev stats line: ${JSON.stringify(live.done)}`);
check(jevReqs().length === 1 && jevReqs()[0].auth === "mock" && jevReqs()[0].questions.join() === "a,b" && !claudeReqs().length, `the fake Jev got ${jevReqs().length} requests (auth ${jevReqs()[0]?.auth}), Claude ${claudeReqs().length}`);
const st = await gatewayStatus(gw.url);
check(st.calls === 1 && !Object.keys(st.pools).length, `after a Jev call the gateway counted ${st.calls} calls and has pools ${JSON.stringify(st.pools)}`);
const meter = readFileSync(paths(home).calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const m = meter.at(-1);
check(m.model === "jev-1.13.0" && m.role === "draw-refs-jev" && m.inTokens > 0 && Math.abs(m.listUsd - (m.inTokens * 0.042) / 1e6) < 1e-12 && m.token == null && m.waitMs == null, `the Jev meter line: ${JSON.stringify(m)}`);
// Replayed from the cache: no new request.
await setMode("r2", "replay", {}, gw.url);
const again = await product({ run: "r2", case: "c1", arm: "A", slot: 0 }, JEV);
check(again.text === live.text && again.done?.mode === "replay" && jevReqs().length === 1, `a replayed Jev call: mode ${again.done?.mode}, ${jevReqs().length} requests`);
// A scan asks a Jev question the bank never recorded live (a change to how its answer is used must show), both arms
// sharing one answer; a recorded one is a hit, not asked again.
await setMode("s1", "scan", {}, gw.url);
const unseen = { ...JEV, user: JEV.user.replace("t22", "t22 scan") };
const n1 = jevReqs().length;
const [sa, sb] = await Promise.all(["A", "B"].map((arm) => product({ run: "s1", case: "c1", arm, slot: 0 }, unseen)));
const sh = await product({ run: "s1", case: "c2", arm: "A", slot: 0 }, JEV);
check(jevReqs().length === n1 + 1 && sa.text === sb.text && JSON.parse(sa.text || "{}").a?.noul === 0.9 && sh.text === live.text && sh.done?.mode === "scan", `a scan's Jev questions: ${jevReqs().length - n1} asked, ${sa.text} / ${sb.text}, the recorded one ${sh.done?.mode}`);
// Warming a Jev model starts nothing.
const warm = await product({ run: "r1", case: "c1", arm: "A", slot: 0 }, { model: "jev-1.13.0", system: "", warm: 2 });
check(warm.done?.warming === 0 && !Object.keys((await gatewayStatus(gw.url)).pools).length, `warming Jev: ${JSON.stringify(warm.done)}`);

// The cap counts Jev calls.
const capped = await spawnGateway({ home: mkdtempSync(join(work, "capped-")), port: 5223, tokens: tokensFile, mockApi: api.url, cap: 1 });
const c1 = await product({ run: "r1", case: "c1", arm: "A", slot: 0 }, { ...JEV, user: JEV.user.replace("t22", "t22 cap") }, capped.url);
const c2 = await product({ run: "r1", case: "c1", arm: "A", slot: 0 }, { ...JEV, user: JEV.user.replace("t22", "t22 cap 2") }, capped.url);
check(!c1.done?.error && /call cap 1 reached/.test(c2.done?.error ?? ""), `the cap on Jev calls: ${c1.done?.error} / ${c2.done?.error}`);
await capped.close();
// Without --mock-api and with no TYPESAFE_API_KEY in the tokens file, a Jev call fails before any request.
const keyless = await spawnGateway({ home: mkdtempSync(join(work, "keyless-")), port: 5224, tokens: tokensFile });
const n0 = jevReqs().length;
const k1 = await product({ run: "r1", case: "c1", arm: "A", slot: 0 }, { ...JEV, user: JEV.user.replace("t22", "t22 keyless") }, keyless.url);
check(/no TYPESAFE_API_KEY/.test(k1.done?.error ?? "") && jevReqs().length === n0, `a keyless Jev call: ${JSON.stringify(k1.done)}`);
await keyless.close();

// ---- The product's resolver, in this process, through the gateway: /api/model goes there with an arm's labels.
globalThis.window = new EventTarget();
globalThis.location = { pathname: "/t22" };
const realFetch = globalThis.fetch;
let run = "p1";
globalThis.fetch = (url, init) => (url === "/api/model" ? realFetch(`${gw.url}/api/model`, { ...init, headers: { ...init.headers, "x-rt-run": run, "x-rt-case": "c2", "x-rt-arm": "A", "x-rt-slot": "0" } }) : realFetch(url, init));
const { words, strokes } = caseInput({ words: "make the clown with the balloon bigger", ink: [] });
const marks = groupStrokes(strokes);
const hits = new HitIndex(scene);
let k = 0;
/** One resolve under these knobs; the requests it made of the fake API. */
async function resolved(knobs, jev) {
  api.set({ jev });
  run = `p${++k}`;
  const [j0, c0] = [jevReqs().length, claudeReqs().length];
  const r = await resolve(words, strokes, marks, scene, hits, tune(knobs), "draw-refs");
  return { r, c0, jev: jevReqs().slice(j0), claude: claudeReqs().length - c0 };
}

// Claude's resolver (resolve.engine 0, the default until 4420f45 made Jev alone the default, kept as e23-h1).
const claude = await resolved({ "resolve.engine": 0, "resolve.jevHints": 0 }, {});
check(claude.r.via === "model" && !claude.jev.length && claude.claude === 1 && claude.r.ids.join() === B, `Claude's resolver: via ${claude.r.via}, ${claude.jev.length} Jev calls, ${claude.claude} Claude, ids ${claude.r.ids}`);
const def = await resolved({}, { [A]: 0.9 });
check(def.r.via === "jev" && def.jev.length === 1 && def.claude === 0 && def.r.ids.join() === A, `the default resolver (Jev alone): via ${def.r.via}, ${def.jev.length} Jev calls, ${def.claude} Claude, ids ${def.r.ids}`);

const one = await resolved({ "resolve.engine": 1 }, { [A]: 0.9 });
const q = one.jev[0];
const state = q ? JSON.parse(q.firstUser) : {};
check(one.r.via === "jev" && one.r.ids.join() === A && one.claude === 0 && one.jev.length === 1, `engine 1: via ${one.r.via}, ids ${one.r.ids}, ${one.claude} Claude calls`);
check(q?.model === "jev-1.13.0" && q.questions.join() === one.r.jevCandidates.join() && state.task === PROMPTS.resolveJev[0].task && /Said: /.test(state.request) && one.r.refs[0]?.ids.join() === A, `engine 1's request: ${q?.model}, questions ${q?.questions}, task ${state.task?.slice(0, 40)}`);
check(one.r.features.engine === 1 && one.r.features.jevShapes === one.r.jevCandidates.length && one.r.stats?.model === "jev-1.13.0", `engine 1's features ${JSON.stringify(one.r.features)}`);

const v1 = await resolved({ "resolve.engine": 1, "resolve.jevPrompt": 1, "resolve.jevModel": 1, "resolve.jevMaxCandidates": 2 }, {});
const s1 = v1.jev[0] ? JSON.parse(v1.jev[0].firstUser) : {};
check(s1.task === PROMPTS.resolveJev[1].task && v1.jev[0]?.model === "jev-latest" && v1.r.jevCandidates.length === 2 + v1.r.jevCandidates.filter((id) => scene.get(id).kind === "frame").length && v1.r.ids.length === 0 && v1.r.refs.length === 0, `the prompt, version and candidate knobs: task ${s1.task?.slice(0, 30)}, ${v1.jev[0]?.model}, ${v1.r.jevCandidates.length} candidates, ids ${v1.r.ids}`);

const sure = await resolved({ "resolve.engine": 2 }, { [A]: 0.9 });
check(sure.r.via === "jev" && sure.claude === 0 && !sure.r.jev.unsure.length, `engine 2, Jev sure: via ${sure.r.via}, ${sure.claude} Claude, unsure ${sure.r.jev?.unsure}`);
const unsure = await resolved({ "resolve.engine": 2 }, { [A]: 0.9, [B]: 0.6 });
check(unsure.r.via === "model" && unsure.claude === 1 && unsure.r.ids.join() === B && unsure.r.jev.unsure.join() === B && unsure.r.features.jevUnsure === 1, `engine 2, Jev unsure: via ${unsure.r.via}, ${unsure.claude} Claude, ids ${unsure.r.ids}, unsure ${unsure.r.jev?.unsure}`);
const raced = await resolved({ "resolve.engine": 2, "resolve.jevRace": 1 }, { [A]: 0.9 });
// Claude was asked too (its request reaches the fake API once its process is up), and its answer dropped.
for (let i = 0; i < 300 && claudeReqs().length === raced.c0; i++) await new Promise((r) => setTimeout(r, 100));
check(raced.r.via === "jev" && claudeReqs().length > raced.c0 && raced.r.ids.join() === A, `the race: via ${raced.r.via}, ids ${raced.r.ids}, Claude asked ${claudeReqs().length - raced.c0}×`);
const hinted = await resolved({ "resolve.engine": 1, "resolve.jevHints": 1 }, { [A]: 0.9, [B]: 0.35 });
check(hinted.r.via === "jev" && hinted.r.hints?.length === 1 && hinted.r.hints[0].id === B && hinted.r.hints[0].p === 0.35, `hints: ${JSON.stringify(hinted.r.hints)}`);
const failed = await resolved({ "resolve.engine": 1 }, {});
check(failed.r.via === "jev" && !failed.r.ids.length, `engine 1, every shape at 0.1: via ${failed.r.via}, ids ${failed.r.ids}`);

// ---- The think router: one question beside the resolver; "off" below draw.thinkYes, the model's choice above it.
const typed = "move the clown left";
const off = tune({ "draw.thinkRouter": 1, "draw.thinkYes": 0.5, "draw.sendScreenshot": 0, "draw.sendRefs": 0 });
api.set({ jev: { think: 0.2 } });
const j0 = jevReqs().length;
const quick = await buildPrompt(scene, [], typed, off);
const tq = jevReqs()[j0];
check(quick.thinking === "off" && quick.features.thinkP === 0.2 && tq?.questions.join() === "think" && JSON.parse(tq.firstUser).said === typed, `the think router on a small edit: ${quick.thinking}, p ${quick.features.thinkP}, ${tq?.questions}`);
api.set({ jev: { think: 0.8 } });
const deep = await buildPrompt(scene, [], typed, off);
check(deep.thinking === undefined && deep.features.thinkP === 0.8, `the think router on a big ask: ${deep.thinking}, p ${deep.features.thinkP}`);
const j1 = jevReqs().length;
const plain = await buildPrompt(scene, [], typed, tune({ "draw.sendScreenshot": 0, "draw.sendRefs": 0 }));
// The default asks Jev whether to think (e73-h2, kept 2026-10-27) at a 0.9 bar: a send it rates 0.8 drafts straight away.
const asked = jevReqs().slice(j1).map((r) => r.questions.join());
check(plain.thinking === "off" && plain.features.thinkP === 0.8 && asked.some((q) => q.split(",").includes("think")), `the default on a send Jev rates 0.8: ${plain.thinking}, p ${plain.features.thinkP}, asked ${asked.join(" | ")}`);

// ---- resolve.speculate: the drawing call starts on Jev's guess, its ops held until the resolver answers; the same
// prompt lets them land (one drawing call), another drops that call and draws again on the answer.
// Speculation guesses only for Claude's resolver (resolve.engine 0): Jev alone has nothing to wait for. The fake resolver
// answers a second late, as a live one does: answering at once (3 ms, before Jev's 90) drops a wrong guess's call
// before its request goes out, so the call dropped in flight is never seen.
const spec = tune({ "resolve.speculate": 1, "resolve.engine": 0, "resolve.jevHints": 0, "draw.addHint": 0, "draw.thinkRouter": 0, "draw.sendScreenshot": 0, "draw.fillPictures": 0 });
const fresh = () => runScript(asPage(readFileSync(join(ROOT, "src/fixtures/clowns.ops.txt"), "utf8"), "page", "Home")).scene;
const said = "make the clown with the balloon bigger";
const draws = () => api.requests.filter((r) => r.role === "draw").length;
async function speculated(jev) {
  api.set({ jev, roleMs: { resolver: 1000 } });
  run = `p${++k}`;
  const sc = fresh(), d0 = draws(), j0 = jevReqs().length, ops = [];
  const { prompt, result } = await send(sc, { strokes: [], words: said }, spec, { onOp: (r) => ops.push(r) });
  return { sc, prompt, result, ops, draws: draws() - d0, jev: jevReqs().length - j0 };
}
const hit = await speculated({ [B]: 0.9 });
check(hit.prompt.features.spec === "hit" && hit.draws === 1 && hit.jev === 1 && hit.ops.length === 1 && hit.ops[0].ok && hit.sc.get(B).box.w === 300 && !hit.result.error,
  `a right guess: spec ${hit.prompt.features.spec}, ${hit.draws} drawing calls, ${hit.ops.length} ops, error ${hit.result.error}`);
check(/^References \(resolved before this call\): /m.test(hit.prompt.user) && hit.prompt.user.includes(`: ${B}\n`) && !/→/.test(hit.prompt.user), `the references as ids alone: ${hit.prompt.user.split("\n").find((l) => l.startsWith("References"))}`);
const miss = await speculated({ [A]: 0.9 });
check(miss.prompt.features.spec === "miss" && miss.draws === 2 && miss.ops.length === 1 && miss.sc.get(B).box.w === 300 && miss.prompt.refs.via === "model" && miss.prompt.user.includes(`: ${B}\n`),
  `a wrong guess: spec ${miss.prompt.features.spec}, ${miss.draws} drawing calls, ${miss.ops.length} ops applied`);
const none = await speculated({});
check(none.prompt.features.spec === "miss" && none.draws === 2, `a guess of nothing against the answer ${B}: spec ${none.prompt.features.spec}, ${none.draws} drawing calls`);
api.set({ roleMs: {} });
// The gate itself: ops wait for it; a shut gate applies none.
for (const open of [true, false]) {
  const sc = fresh(), at = [];
  let opened = 0;
  const gate = new Promise((r) => setTimeout(() => ((opened = performance.now()), r(open)), 300));
  const p = await buildPrompt(sc, [], said, spec);
  const r = await runDraw(sc, p, spec, () => at.push(performance.now()), undefined, undefined, undefined, gate);
  if (open) check(at.length === 1 && at[0] >= opened && sc.get(B).box.w === 300 && !r.error, `an open gate: ${at.length} ops, first ${at[0] - opened} ms after it opened`);
  else check(!at.length && sc.get(B).box.w !== 300 && /dropped/.test(r.error ?? ""), `a shut gate applied ${at.length} ops (error ${r.error})`);
}
globalThis.fetch = realFetch;

// ---- The dev server's route: a Jev call on the fake API with the fake key, never .env's.
const { modelApi } = await import("../../dev/model-plugin.ts");
const { closedPort } = await import("../loop/gateway.ts");
const envRoot = mkdtempSync(join(work, "root-"));
writeFileSync(join(envRoot, ".env"), `TYPESAFE_API_KEY=${CANARY}\n`);
const vite = await createServer({
  root: envRoot, configFile: false, cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null }, plugins: [modelApi({ mockApi: { baseUrl: api.url, deadProxyPort: await closedPort() } })],
});
await vite.listen();
const dev = `http://127.0.0.1:${vite.httpServer.address().port}`;
api.set({ jev: { a: 0.7 } });
const jd = jevReqs().length;
const viaDev = await product({}, { ...JEV, user: JEV.user.replace("t22", "t22 dev") }, dev);
check(JSON.parse(viaDev.text || "{}").a?.noul === 0.7 && viaDev.done?.model === "jev-1.13.0" && viaDev.done.settings?.via?.includes("Jev") && jevReqs().length === jd + 1, `the dev route: ${viaDev.text}, ${JSON.stringify(viaDev.done)}`);
check(api.requests.every((r) => r.auth !== CANARY), "the dev server sent .env's TYPESAFE_API_KEY to the fake API");
const log = readFileSync(join(home, "data", "model-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
check(log.model === "jev-1.13.0" && log.reply === viaDev.text && !JSON.stringify(log).includes(CANARY), "the dev server's call log has no Jev line, or holds the key");
await vite.close();
// Without a key and without the fake API, the route refuses before any request.
const bare = await createServer({
  root: mkdtempSync(join(work, "root-")), configFile: false, cacheDir: join(home, "vite2"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null }, plugins: [modelApi()],
});
await bare.listen();
const res = await fetch(`http://127.0.0.1:${bare.httpServer.address().port}/api/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(JEV) });
check(res.status === 500 && /TYPESAFE_API_KEY is not set/.test((await res.json()).error ?? ""), `the keyless dev route answered ${res.status}`);
await bare.close();

await gw.close();
await api.close();
if (!api.requests.length) fail("the fake API saw no requests");
finish();
