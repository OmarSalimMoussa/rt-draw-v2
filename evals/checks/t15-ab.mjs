// T15's acceptance check: the diffscan and the A/B runner on a 16-case fake bank, through real bridge
// pages (one headless Chrome, one arm server on a tree of this checkout), the gateway in its own process
// and the fake API. 0 real model calls: fake tokens, every Claude process on the fake API with HTTPS_PROXY
// at a closed port (the gateway's mockApi), the fake API's request count must equal the gateway's call
// count, and scans and replays must make no call at all. The bank is built at 0 calls too: a first scan
// serves each case's canned replies as stand-ins, then every request hash it saw gets its canned reply.
// t20-history.mjs builds on fakeLoop(). Ports 5320–5322 (t20: 5325–5327).
//   TMPDIR=<work dir> node --import ./evals/loop/node-hooks.mjs evals/checks/t15-ab.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
/** The fake API serves `${model}-fake`: banked expectations carry the judgeId a judge call there gives. */
export const SERVED = "claude-sonnet-5-5-fake";
export const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const SUBJECTS = ["red toy car", "blue kite", "green ball"];
const word = (w, t0, t1) => ({ word: w, t0, t1 });

/** Case i's drawing reply: kind 0 adds a shape with a 7-word description (a parser knob at 9 refuses it), the rest add 2–3 pictures. */
function drawReply(start, i) {
  const kind = i % 4;
  const lines = start === "blank"
    ? [`shape(title-${i}, rect, 60 60 600 80, "the big welcome title at the top of the home page", stroke:none)`, `text(title-${i}, "Hello ${i}")`]
    : [`shape(home-nav, fill:${["#ffe3e3", "#d0ebff", "#d3f9d8", "#fff3bf"][i % 4]})`];
  // Kind 0's badge is placed on grid cells: ops.cellPx decides where it lands (the parser tweak).
  if (kind === 0) lines.push(`shape(sale-${i}, pill, W3-Z4, "small pill badge for the toy sale", fill:#ffd43b)`);
  else
    for (const [j, subject] of SUBJECTS.slice(0, kind === 1 ? 3 : 2).entries())
      lines.push(`shape(pic-${i}-${j}, rect, ${100 + j * 300} 300 240 240, "a framed picture of a ${subject} on the home page", stroke:none)`, `drawing(pic-${i}-${j}, "${subject}")`);
  return lines;
}

/**
 * A harness clone of this checkout (its working evals/ committed), a tree of it, the fake API, the gateway on
 * it with fake tokens, a rig, and a fake bank: 16 tuning cases (8 sessions × 2), 4 H-gate, 4 H-chart and one
 * whose before-scene still needs a picture. Returns the handles and the case ids.
 */
export async function fakeLoop({ port, slots = 2 }) {
  const home = tempHome();
  const work = mkdtempSync(join(home, "work-"));
  const repo = join(home, "repo");
  git("clone", "-q", "--no-checkout", ROOT, repo);
  git("-C", repo, "checkout", "-q", git("-C", ROOT, "rev-parse", "HEAD"));
  execFileSync("cp", ["-a", join(ROOT, "evals") + "/.", join(repo, "evals")]);
  git("-C", repo, "add", "-A", "evals");
  if (git("-C", repo, "status", "--porcelain")) git("-C", repo, "-c", "user.name=rt-check", "-c", "user.email=check@localhost", "commit", "-qm", "check: the working evals/");
  git("-C", repo, "tag", "eval-harness-1");
  execFileSync("cp", ["-al", join(ROOT, "node_modules"), join(repo, "node_modules")]);

  const { treeOf } = await import("../loop/trees.ts");
  const { paths } = await import("../loop/paths.ts");
  const { put } = await import("../loop/record.ts");
  const { loadFixture } = await import("../fixtures/fixtures.ts");
  const { stubPictures, stubReply } = await import("../loop/stubs.ts");
  const { startFakeApi } = await import("../mock/fake-api.ts");
  const { spawnGateway } = await import("../loop/client.ts");
  const { openRig, runAB } = await import("../loop/ab.ts");
  const { judgeId } = await import("../judge/judge.ts");
  const P = await import("../judge/prompts.ts");
  const { promptOf } = await import("../../src/core/prompts.ts");
  const { DEFAULTS } = await import("../../src/core/tuning.ts");
  const { SCREEN } = await import("../../src/core/board.ts");
  const p = paths();
  const champSha = git("-C", repo, "rev-parse", "HEAD");
  const champ = { sha: champSha, tree: treeOf(champSha) };

  // ---- The fake API: canned replies for live runs, keyed by each role's real system prompt: the one today's defaults
  // send (promptOf), so a new default variant can't leave the fake answering "ok" to every draw.
  const replies = join(work, "fake-replies");
  mkdirSync(replies);
  const note = (fill, x) => `shape(live-note, rect, ${x} 120 320 60, "a short note the live drawing reply adds near the top", fill:${fill})`;
  const files = {
    [`draw.${sha(promptOf("draw", DEFAULTS).system(true, 1280, 800, 0, SCREEN.w)).slice(0, 12)}.json`]: [note("#ffc9c9", 100), note("#a5d8ff", 140)],
    [`resolver.${sha(promptOf("resolve", DEFAULTS).system).slice(0, 12)}.txt`]: '{"refs": []}',
    [`picture.${sha(promptOf("picture", DEFAULTS).system(DEFAULTS)).slice(0, 12)}.txt`]: stubReply("picture"),
    // One system prompt for every judge role: each reply reads as a verdict and as an expectation.
    [`judge.${sha(P.SYSTEM).slice(0, 12)}.json`]: ["left", "right", "tie", "left", "right"].map((w, i) => JSON.stringify({ winner: w, confidence: 2 + (i % 2), why: `fake ${w}`, should: ["the asked change is made"], mustNot: ["nothing else moves"] })),
  };
  for (const [f, body] of Object.entries(files)) writeFileSync(join(replies, f), typeof body === "string" ? body : JSON.stringify(body));
  const api = await startFakeApi({ port, replies });
  const tokens = join(work, "tokens.env");
  writeFileSync(tokens, [1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-fake-check-${n}-${randomBytes(6).toString("hex")}`).join("\n") + "\n");
  chmodSync(tokens, 0o600);
  const gw = await spawnGateway({ home, port: port + 1, tokens, mockApi: api.url });
  const rig = await openRig({ trees: [champ.tree], gateway: gw.url, slots, port: port + 2 });

  // ---- The fake bank's cases (each set's sessions alternate the toy shop and a blank page).
  const toy = (() => {
    const s = loadFixture("toyshop-home", { pictures: {} }).scene;
    const { scene, start } = loadFixture("toyshop-home", { pictures: stubPictures(s) });
    return { scene: scene.toJSON(), start };
  })();
  const blank = (() => {
    const { scene, start } = loadFixture("blank", { pictures: {} });
    return { scene: scene.toJSON(), start };
  })();
  const sets = [["tuning", "t", 8, 2], ["heldout-gate", "g", 2, 2], ["heldout-chart", "c", 2, 2]];
  const cases = [];
  for (const [set, tag, sessions, sends] of sets)
    for (let k = 1; k <= sessions; k++) for (let n = 1; n <= sends; n++) cases.push({ id: `c-${tag}-s${k}-${n}`, set, session: `${tag}-s${k}`, n, start: k % 2 ? "toyshop-home" : "blank" });
  cases.push({ id: "c-x-stray", set: "tuning", session: "x-s1", n: 1, start: "toyshop-home", stray: true });
  const standIn = (id, role, text, chunks, subject) => {
    const name = sha(`standin|${id}|${role}|${subject ?? ""}`);
    put(p.reply(name), { reqHash: name, run: "bank", role, at: new Date().toISOString(), request: { model: "", system: "", user: "", images: [], effort: "low", thinking: "auto" }, text, chunks, doneMs: chunks.at(-1).ms + 20, stats: {} });
    return { role, ordinal: 0, ...(subject ? { subject } : {}), reqHash: name, cacheFile: `${name}.json`, offsets: chunks.map((c) => c.ms) };
  };
  for (const [i, c] of cases.entries()) {
    const base = c.start === "blank" ? blank : toy;
    const scene = structuredClone(base.scene);
    // The stray case's robot picture never finished: the product redraws it on a send that doesn't touch it (V12's guard).
    if (c.stray) delete scene.shapes.find((s) => s.id === "robot-pic").picture;
    const lines = c.stray ? ["shape(home-nav, fill:#e5dbff)"] : drawReply(c.start, i);
    const subjects = c.stray ? ["toy robot"] : lines.map((l) => /^drawing\([^,]+, "(.+)"\)$/.exec(l)?.[1]).filter(Boolean);
    const dir = p.bankCase(c.id);
    put(join(dir, "case.json"), { id: c.id, set: c.set, scenario: c.session, persona: "explorer", style: "typical", start: c.start, ask: i % 4 ? "add" : "restyle", seed: i, originSession: c.session, send: c.n,
      championSha: champSha, tuningId: "defaults", harnessTag: "eval-harness-1", configId: "check", recordedAt: new Date().toISOString(), hedged: false, beatDone: true, flags: [] });
    const at = c.start === "blank" ? [300, 100] : [600, 40];
    // The last word makes every case's requests its own.
    const said = c.start === "blank" ? [word("add", 0, 200), word("a", 220, 300), word("title", 320, 600)] : [word("make", 0, 200), word("this", 220, 400), word("pink", 420, 700)];
    put(join(dir, "input.json"), { camera: base.start, words: [...said, word(`please${i}`, 720, 900)],
      strokes: [{ id: 1, points: [[at[0], at[1], 250], [at[0] + 1, at[1] + 1, 300]], t0: 250, t1: 300 }], enterAtMs: 1200, inputHash: "check" });
    put(join(dir, "before.scene.json"), scene);
    put(join(dir, "meant.json"), { meant: `case ${c.id}: ${lines[0]}`, hedged: false });
    put(join(dir, "expectation.json"), { judgeId: judgeId("expectation", SERVED), should: ["the asked change is made"], mustNot: ["nothing else moves"] });
    put(join(dir, "readings.json"), { marks: [{ n: 1, kind: "tap", how: "check", targets: c.start === "blank" ? ["page"] : ["home-nav"] }], refs: [] });
    writeFileSync(join(dir, "before-ink.jpg"), JPEG);
    put(join(dir, "replies.json"), [
      standIn(c.id, "draw-refs", c.start === "blank" ? '{"refs": []}' : '{"refs": [{"phrase": "this", "ids": ["home-nav"]}]}', [{ ms: 200, text: c.start === "blank" ? '{"refs": []}' : '{"refs": [{"phrase": "this", "ids": ["home-nav"]}]}' }]),
      standIn(c.id, "draw", lines.join("\n"), lines.map((l, k) => ({ ms: 300 + 50 * k, text: `${l}\n` }))),
      ...subjects.map((s) => standIn(c.id, "picture", stubReply("picture"), [{ ms: 300, text: stubReply("picture") }], s)),
    ]);
  }

  // ---- The bootstrap scan: every request each case makes, by its real hash, gets the stand-in's reply.
  const ids = cases.map((c) => c.id);
  const boot = await runAB(rig, { run: "bootstrap", kind: "scan", arms: { A: champ, B: champ }, mode: "scan", share: true, seed: "boot", cases: ids, loadWaitMs: 0 });
  const roles = new Set();
  for (const id of ids) {
    const calls = json(join(p.run("bootstrap"), "cases", id, "A", "replies.json"));
    const banked = calls.map((c) => {
      roles.add(c.role);
      // Jev's yes/no calls (the resolver, the add hint) have no stand-in: an empty answer (no one is a yes), the add hint's
      // 600 ms late, so draw.addWaitMs is a pure schedule change (the scheduling tweak below).
      const slow = c.role === "draw-add" ? 600 : 30;
      const src = c.cacheFile ? json(p.reply(c.cacheFile.replace(/\.json$/, ""))) : { text: "{}", chunks: [{ ms: slow, text: "{}" }], doneMs: slow + 10, stats: {}, request: {} };
      put(p.reply(c.reqHash), { ...src, reqHash: c.reqHash, run: "bank", role: c.role });
      return { ...c, cacheFile: `${c.reqHash}.json`, offsets: src.chunks.map((x) => x.ms) };
    });
    put(join(p.bankCase(id), "replies.json"), banked);
    writeFileSync(join(p.bankCase(id), "done"), `${new Date().toISOString()}\n`);
  }
  const of = (set) => cases.filter((c) => c.set === set && !c.stray).map((c) => c.id);
  return {
    home, work, p, repo, champ, api, gw, rig, boot, roles: [...roles],
    tuning: of("tuning"), gate: of("heldout-gate"), chart: of("heldout-chart"), stray: "c-x-stray", kindOf: (id) => cases.findIndex((c) => c.id === id) % 4,
    async close() {
      await rig.close();
      await gw.close();
      await api.close();
    },
  };
}

if (import.meta.main) {
  // A clean env for this process and every child: no token, key or Claude session variable.
  const env = cleanEnv();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  const L = await fakeLoop({ port: 5320 });
  const { p, champ, api, gw, rig } = L;
  const { runAB, checkpointRun, firstArm } = await import("../loop/ab.ts");
  const { scan } = await import("../loop/diffscan.ts");
  const { gatewayStatus } = await import("../loop/client.ts");
  const { pairedRatio } = await import("../loop/latency.ts");
  const { aaPass } = await import("../loop/verdict.ts");
  const { readRows } = await import("../loop/metrics.ts");
  const { caseDir, put, runFile } = await import("../loop/record.ts");
  const { judging } = await import("../judge/judge.ts");
  const { OVERUSE } = await import("../optimizer/patterns.ts");
  const { chromeCount } = await import("./cdp.mjs");
  const calls = async () => (await gatewayStatus(gw.url)).calls;
  const fork = (run, id) => json(join(caseDir(run, id), "fork.json"));
  const card = (o = {}) => ({ id: "t15", component: "draw", kind: "knob", change: "t15", knobs: o.knobs ?? {}, goal: "fidelity", classGuess: o.classGuess ?? "Q", dialogue: !!o.dialogue,
    ...(o.overuse ? { overuseDetector: o.overuse } : {}), isPatch: false, touchesFrozen: false, risk: "", files: [] });
  const arm = (tuning) => ({ ...champ, tuning });
  const base = { arms: { A: champ, B: champ }, seed: "t15", loadWaitMs: 0 };
  /** A judge that always prefers `arm`, written the way judge.ts writes a verdict. */
  const canned = (run, winner) => ({
    async judgeCase(id, positions) {
      put(join(caseDir(run, id), "judge", "fidelity-1.json"), { winner: positions.left === winner ? "left" : "right", confidence: 3, why: "canned", positions, judgeId: "canned" });
    },
    flips: () => ({ audited: 0, flipped: 0 }),
  });
  check(["draw-refs-jev", "draw-add", "draw", "picture"].every((r) => L.roles.includes(r)), `the bank's sends made roles ${L.roles.join(", ")} (want draw-refs-jev, draw-add, draw, picture)`);
  check((await calls()) === 0 && api.requests.length === 0, "building the bank made a call");

  // ---- 1. An identical candidate is N at 0 calls; its rows carry over-use per arm and the first arm.
  const n = await scan(rig, { ...base, run: "scan-n", cases: L.tuning, card: card({ overuse: "extra-shapes" }) });
  const timed = (t) => JSON.stringify({ ttfd: t?.ttfd?.est, render: t?.render?.est, tails: Object.fromEntries(Object.entries(t?.tails ?? {}).map(([k, r]) => [k, r.est])) });
  check(n.class === "N" && n.timed && (n.affected.tuning ?? []).length === 0, `an identical candidate is ${n.class} (affected ${n.affected.tuning?.length ?? 0}, timed ${timed(n.timed)})`);
  if (process.env.T15_DEBUG) for (const x of readRows("scan-n")) console.error(`scan-n ${x.case} first ${x.firstArm} ttfd ${JSON.stringify(x.ttfd)} ttfc ${JSON.stringify(x.ttfc)}`);
  if (process.env.T15_DEBUG) for (const x of readRows(n.timed.run)) console.error(`render ${x.case} ${JSON.stringify(x.render)} ttfd ${JSON.stringify(x.ttfd)} engine ${["A", "B"].map((a) => JSON.stringify(json(join(caseDir(n.timed.run, x.case), a, "timing.json")).engine)).join(" ")}`);
  const nHits = readFileSync(p.calls, "utf8").split("\n").filter((l) => l.includes('"run":"scan-n"'));
  check(nHits.length > 0 && nHits.every((l) => JSON.parse(l).scan === "hit"), "the identical scan wasn't served by exact hits only (the bank doesn't resolve)");
  const nRows = readRows("scan-n");
  const fired = nRows.map((r) => {
    const before = json(join(p.bankCase(r.case), "before.scene.json"));
    return ["A", "B"].map((a) => OVERUSE["extra-shapes"]({ before, after: json(join(caseDir("scan-n", r.case), a, "after.scene.json")) }));
  });
  check(nRows.length === 16 && nRows.every((r, i) => JSON.stringify(r.overuse) === JSON.stringify(fired[i])) && fired.some((f) => f[0]) && fired.some((f) => !f[0]), `rows' overuse isn't patterns.ts' extra-shapes on each arm (${nRows.map((r) => r.overuse.map(Number).join("")).join(" ")})`);
  check(nRows.every((r) => r.firstArm === fork("scan-n", r.case).order[0]), "a row's firstArm isn't the recorded dispatch order");

  // ---- 2–4. A parser tweak is R on exactly the cases it changes; a request tweak Q; a scheduling tweak S.
  const r = await scan(rig, { ...base, arms: { A: champ, B: arm({ "ops.cellPx": 35 }) }, run: "scan-r", cases: L.tuning, card: card({ classGuess: "R" }) });
  const want = L.tuning.filter((id) => L.kindOf(id) === 0).sort();
  check(r.class === "R" && JSON.stringify([...(r.affected.tuning ?? [])].sort()) === JSON.stringify(want), `the parser tweak is ${r.class} on ${r.affected.tuning?.join(",")} (want R on ${want.join(",")})`);
  check(r.cases.every((c) => !c.requests.length), "the parser tweak changed a request");
  const q = await scan(rig, { ...base, arms: { A: champ, B: arm({ "draw.sendMarks": 0 }) }, run: "scan-q", cases: [...L.tuning, ...L.gate], card: card() });
  check(q.class === "Q" && q.cases.some((c) => c.requests.includes("draw")) && (q.affected["heldout-gate"] ?? []).length > 0, `the request tweak is ${q.class} (draw differs on ${q.cases.filter((c) => c.requests.includes("draw")).length})`);
  // Drawing starts without waiting for a late add hint (the bank's comes at 600 ms, with nothing to add): first drawing moves.
  const s = await scan(rig, { ...base, arms: { A: champ, B: arm({ "draw.addWaitMs": 100 }) }, run: "scan-s", cases: L.tuning, card: card({ classGuess: "S" }) });
  check(s.class === "S" && s.cases.every((c) => !c.scene && !c.svg && !c.requests.length) && s.timed?.ttfd?.est < 0.9, `the scheduling tweak is ${s.class} (scenes identical: ${s.cases.every((c) => !c.scene)}, requests identical: ${s.cases.every((c) => !c.requests.length)}, timed ${timed(s.timed)})`);
  // Pictures one at a time only make the send end later: time to done decides nothing (LOOP-V2.md), so it's no effect.
  const tdOnly = await scan(rig, { ...base, arms: { A: champ, B: arm({ "picture.parallel": 1 }) }, run: "scan-ttd", cases: L.tuning, card: card({ classGuess: "S" }) });
  check(tdOnly.class === "N" && tdOnly.timed?.ttd?.est > 1.03, `pictures one at a time are ${tdOnly.class} (want N: TTD ×${tdOnly.timed?.ttd?.est?.toFixed(3)} alone, timed ${timed(tdOnly.timed)})`);
  check(n.mismatch && !r.mismatch && !s.mismatch && json(runFile("scan-n", "scan.json")).declared === "Q", "the card's declared class isn't logged against the scan's in scan.json");
  check((await calls()) === 0 && api.requests.length === 0, `the scans and timed replays made ${await calls()} calls`);

  // ---- 5. The shared A/A in timed replay (the identical candidate's: the champion against itself): paired first drawing and render 1.00 ± 0.03, 0 calls.
  const aa = readRows(n.timed.run);
  const [aaTtfd, aaRender] = [pairedRatio(aa, "ttfd"), pairedRatio(aa, "render")];
  check(aa.length === 16 && aaTtfd && Math.abs(aaTtfd.est - 1) <= 0.03 && aaRender && Math.abs(aaRender.est - 1) <= 0.03 && aa.every((x) => !x.void),
    `shared A/A first drawing ×${aaTtfd?.est?.toFixed(3)}, render ×${aaRender?.est?.toFixed(3)} on ${aa.length} (want 1.00 ± 0.03 on 16), voids ${aa.filter((x) => x.void).map((x) => x.void).join("; ")}`);

  // ---- 7, 11. Dispatch order: seeded, alternated, recorded; every case on a freshly reloaded page.
  const orders = n.cases.map((c) => fork("scan-n", c.case).order[0]);
  const pairsOk = [0, 2, 4, 6, 8, 10, 12, 14].every((i) => new Set([orders[i], orders[i + 1]]).size === 2);
  const again = Array.from({ length: 16 }, (_, i) => firstArm("t15", i));
  check(pairsOk && JSON.stringify(orders) === JSON.stringify(again) && JSON.stringify(again) !== JSON.stringify(Array.from({ length: 16 }, (_, i) => firstArm("other seed", i))), `dispatch order isn't seeded and alternated (${orders.join("")})`);
  check(n.cases.every((c) => fork("scan-n", c.case).offsetsMs.length === 2), "fork.json doesn't record the dispatch offsets");
  const origins = n.cases.flatMap((c) => Object.values(fork("scan-n", c.case).pageOrigin));
  check(new Set(origins).size === origins.length, "a case reused a page another case had loaded (no reload)");

  // ---- 8, 12. Invariants void the case and flag the run: a forced input mismatch, a stalled gateway, a dispatch limit, a stray picture.
  const one = (run, faults, cases = [L.tuning[1]]) => runAB(rig, { ...base, run, kind: "ab", mode: "scan", share: true, cases, faults });
  const mis = await one("fault-input", { input: (id, a, i) => (a === "B" ? { ...i, words: [...i.words, word("now", 900, 1000)] } : i) });
  check(/different inputs/.test(mis.rows[0].void ?? "") && mis.invariants.length && existsSync(runFile("fault-input", "invariants.jsonl")), `a forced input mismatch didn't void the case and flag the run (${mis.rows[0].void})`);
  // Five 60-ms stalls: what a starved gateway does, and more than p99 lets through.
  const stall = await one("fault-loop", { afterSend: async () => { for (let k = 0; k < 5; k++) process.kill(gw.pid, "SIGSTOP"), await sleep(60), process.kill(gw.pid, "SIGCONT"), await sleep(30); } });
  check(/event-loop p99/.test(stall.rows[0].void ?? ""), `a stalled gateway didn't void the case (${stall.rows[0].void}; p99 ${fork("fault-loop", L.tuning[1]).loopP99Ms} ms)`);
  writeFileSync(p.machine, JSON.stringify({ host: "check", slots: 2, dispatchLimitMs: 0 }));
  const lim = await one("fault-dispatch", {});
  writeFileSync(p.machine, JSON.stringify({ host: "check", slots: 2, dispatchLimitMs: 25 }));
  check(/dispatch offset/.test(lim.rows[0].void ?? ""), `a dispatch offset over machine.json's limit didn't void the case (${lim.rows[0].void})`);
  const stray = await one("fault-stray", {}, [L.stray]);
  check(/stray picture/.test(stray.rows[0].void ?? ""), `a picture drawn for an unchanged shape didn't void the case (${stray.rows[0].void})`);
  check(!mis.rows[0].void.includes("stray") && !lim.rows[0].void.includes("event-loop"), "an invariant voided a case it shouldn't have");
  // A timing trip voids its case only; the arms getting different things also voids the decision (and a V9 stops the loop).
  check(stall.invariants.length && stall.invariants.every((x) => x.timing) && lim.invariants.every((x) => x.timing) && mis.invariants.every((x) => !x.timing),
    `timing invariants aren't told apart: ${JSON.stringify([...stall.invariants, ...lim.invariants, ...mis.invariants].map((x) => [x.why.slice(0, 30), x.timing]))}`);

  // ---- 14. A D card: continuation forks through continueFrom, only ever a veto; G3 draws only H-gate cases.
  const asked = [];
  let lose = true;
  const contRow = (id, k) => ({ case: `${id}-c${k}`, cluster: id, affected: true, class: "D", s: lose ? -1 : 1, ttfc: [1000, 1000], ttd: [2000, 2000], work: [1, 1], usd: [0, 0], thought: [false, false], overuse: [false, false], pics: [[0, 0], [0, 0]], ask: "add", firstArm: k % 2 ? "B" : "A" });
  const continueFrom = async (id, b, sends) => (asked.push({ id, b, sends }), Array.from({ length: sends }, (_, k) => contRow(id, k)));
  // Top-ups come back as judged rows (run.ts sends, deposits and judges them live): winning ones, one session each.
  let tops = 0;
  const topUp = async (count) => Array.from({ length: count }, () => {
    const row = { ...contRow(`c-top-${tops}`, tops++), cluster: `top-${tops}`, s: 1 };
    // A continuation may start from a top-up case: its fork folder, as drive.ts writes one (a banked case's stands in).
    if (!existsSync(join(p.run("d-card"), "cases", row.case))) cpSync(join(p.run("d-card"), "cases", L.tuning[0]), join(p.run("d-card"), "cases", row.case), { recursive: true });
    return row;
  });
  const dSpec = { ...base, run: "d-card", kind: "ab", mode: "scan", share: true, cases: L.tuning, cls: "D", judge: canned("d-card", "B") };
  const dDecide = { card: card({ dialogue: true, classGuess: "D" }), heldout: [...L.gate, ...L.chart, L.tuning[0]], topUp, continueFrom };
  const d1 = await runAB(rig, dSpec, dDecide);
  check(d1.decision?.verdict === "revert" && d1.decision.vetoes.some((v) => /continuation/.test(v)), `losing continuation forks didn't veto the D card's keep (${d1.decision?.verdict}: ${d1.decision?.vetoes.join("; ")})`);
  check(asked.length === 20 && asked.every((a) => a.sends === 2 && a.b.after?.shapes && a.b.camera && a.b.run === "d-card"), `continueFrom was asked ${asked.length} times (want 20, 2 sends each, on B's after-scene and camera)`);
  check(d1.heldout?.length === L.gate.length && d1.heldout.every((x) => L.gate.includes(x.case)), `G3 drew ${d1.heldout?.map((x) => x.case).join(",")} (want only the H-gate cases)`);
  check(d1.rows.length === 32 && tops === 16, `a short bank wasn't topped up to look 32 (${d1.rows.length} rows, ${tops} top-ups)`);
  lose = false;
  const d2 = await runAB(rig, dSpec, dDecide); // a resume: every case is done, only the continuation differs
  check(d2.decision?.verdict === "keep" && d2.rows.length === 32, `winning continuation forks changed the keep (${d2.decision?.verdict})`);
  asked.length = 0;
  const d3 = await runAB(rig, { ...dSpec, run: "d-lose", judge: canned("d-lose", "A") }, dDecide);
  check(d3.decision?.verdict === "revert" && asked.length === 0, `a losing D card ran continuation forks (${asked.length}) or wasn't reverted (${d3.decision?.verdict})`);

  // ---- 6. A canned losing judge stops at look 16 (live on the fake API; identical calls from the bank).
  const before = await calls();
  const lost = await runAB(rig, { ...base, arms: { A: champ, B: arm({ "draw.sendMarks": 0 }) }, run: "g2-lose", kind: "ab", mode: "live", share: true, cached: q.cached, cases: q.affected.tuning, judge: canned("g2-lose", "A"), cls: "Q" }, { card: card() });
  const live = (await calls()) - before;
  check(lost.decision?.verdict === "revert" && lost.decision.counts.look === 16 && lost.rows.length === 16 && lost.decision.looks.length === 1, `a losing judge didn't stop at look 16 (${lost.decision?.verdict} at ${lost.decision?.counts.look}, ${lost.rows.length} rows: ${lost.decision?.reasons.join("; ")})`);
  check(live > 0 && live <= 32, `the live G2 run made ${live} calls (want its differing draw calls only, ≤ 32)`);

  // ---- 9, 10. A checkpoint: unshared, judged on every case, only B1's cases; its rows give the four 99% CR1 intervals.
  const b1 = [...L.chart, ...L.tuning.slice(0, 4)];
  for (const id of b1) cpSync(p.bankCase(id), join(p.history, "bench", "B1", id), { recursive: true });
  writeFileSync(join(p.history, "bench", "B1", "manifest.json"), JSON.stringify({ version: "check", files: {}, hash: "check" }));
  const ckBefore = await calls();
  const ck = await checkpointRun(rig, { run: "ck-0", anchor: champ, champion: champ, seed: "t15", judge: judging("ck-0", { seed: "t15", craft: "all" }) });
  const ckLines = readFileSync(p.calls, "utf8").split("\n").filter((l) => l.includes('"run":"ck-0"')).map((l) => JSON.parse(l)).filter((l) => /^(draw|picture|resolve|describe|camera)/.test(l.role));
  check(JSON.stringify(ck.rows.map((x) => x.case).sort()) === JSON.stringify([...b1].sort()), `the checkpoint ran ${ck.rows.map((x) => x.case).join(",")} (want B1's ${b1.join(",")})`);
  check(ckLines.length > 0 && ckLines.every((l) => l.shared === "-" && l.mode === "live"), `the checkpoint shared or cached a product call (${[...new Set(ckLines.map((l) => `${l.mode}/${l.shared}`))].join(", ")})`);
  // Every case went out first as a warm-up scan: every timed call took a process that had finished starting.
  const cold = ckLines.filter((l) => l.readyAtTake !== true && !/^jev-/.test(l.model)); // a Jev call takes no process
  check(!cold.length, `${cold.length} of the checkpoint's ${ckLines.length} product calls waited on a starting process (${cold.map((l) => `${l.arm} ${l.role} ${l.case}`).slice(0, 4).join(", ")})`);
  const warm = readFileSync(p.calls, "utf8").split("\n").filter((l) => l.includes('"run":"ck-0~warm"')).map((l) => JSON.parse(l));
  const unwarmed = ck.rows.filter((x) => !x.void && !warm.some((l) => l.case === x.case));
  check(warm.length && warm.every((l) => l.mode === "scan") && !unwarmed.length, `the checkpoint's warm-up sends weren't scans under ck-0~warm, one per case (unwarmed: ${unwarmed.map((x) => x.case).join(", ")})`);
  check(ck.rows.every((x) => x.void || (existsSync(join(caseDir("ck-0", x.case), "judge", "fidelity-1.json")) && existsSync(join(caseDir("ck-0", x.case), "judge", "craft.json")))), "a checkpoint case wasn't judged by fidelity and craft");
  check(ck.rows.filter((x) => !x.void).length >= 6, `the checkpoint voided ${ck.rows.filter((x) => x.void).map((x) => x.void).join("; ")}`);
  const a = aaPass(ck.rows);
  if (process.env.T15_DEBUG) for (const x of ck.rows) console.error(`ck ${x.case} s ${x.s} void ${x.void ?? "-"} identical ${fork("ck-0", x.case).identicalAfter} judge ${JSON.stringify(["fidelity-1.json", "fidelity-2.json"].map((f) => { try { return json(join(caseDir("ck-0", x.case), "judge", f)).winner; } catch { return "-"; } }))}`);
  const tests = Object.entries(a.tests);
  check(tests.length === 4 && tests.every(([, t]) => [t.est, t.lo, t.hi, t.halfWidth].every(Number.isFinite) && t.halfWidth > 0) && typeof a.pass === "boolean" && a.ci === 0.99,
    `the unshared A/A doesn't report four 99% CR1 intervals with half-widths (${JSON.stringify(a.tests)})`);
  console.error(`t15: unshared A/A ${a.pass ? "passes" : `fails ${a.failed.join(",")}`}: ${tests.map(([k, t]) => `${k} ${t.est.toFixed(3)} ±${t.halfWidth.toFixed(3)}`).join(", ")}; checkpoint ${(await calls()) - ckBefore} calls`);

  // ---- 0 real calls: every fake-API request is one of the gateway's calls; no page left its arm.
  const total = await calls();
  check(api.requests.length === total, `the fake API got ${api.requests.length} requests for the gateway's ${total} calls`);
  check(!rig.blocked.length, `a page requested ${rig.blocked.join(", ")}`);
  await L.close();
  check(chromeCount(join(p.home, "chrome")) === 0, "Chrome processes are left after close");
  finish();
}
