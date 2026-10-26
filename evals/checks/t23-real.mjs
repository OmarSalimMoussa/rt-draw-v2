// T23's acceptance check: the real-use pipeline (evals/real/README.md) end to end on synthetic sessions: a
// pull's raw snapshot → ingest → render (stubbed: no Chrome) → triage → gold → review → freeze → R1's
// scoring in realShadow (on a fake rig: no Chrome). Triage and gold go through the gateway to the fake API,
// canned replies keyed by TRIAGE_SYSTEM's and GOLD_SYSTEM()'s sha; the product's prompt builder runs in this
// process with its /api/model answered here. 0 real calls: fake tokens, HTTPS_PROXY at a closed port (the
// gateway's mockApi), the fake API's request count must equal the gateway's call count, and this process's
// fetch reaches nothing but loopback. No tester's data: every session here is invented.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t23-real.mjs
// Ports 5640–5642.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalOnly, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const started = Date.now();
const home = tempHome();
const work = mkdtempSync(join(tmpdir(), "rt-t23-"));
const env = cleanEnv();
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);

const sha = (s) => createHash("sha256").update(s).digest("hex");
const sha12 = (s) => sha(s).slice(0, 12);
const js = JSON.stringify;
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const maybe = (f) => (existsSync(f) ? json(f) : undefined);
const put = (f, v) => (mkdirSync(join(f, ".."), { recursive: true }), writeFileSync(f, typeof v === "string" ? v : `${js(v)}\n`));
const lines = (f, rows) => put(f, rows.map((r) => (typeof r === "string" ? r : js(r))).join("\n") + "\n");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

// ---- This process: the product's code needs a window, and its model calls (/api/model) are answered here, never sent.
globalThis.window = new EventTarget();
globalThis.location = { pathname: "/t23" };
const realFetch = globalThis.fetch;
/** The in-process product model: Jev says yes to the ids in `yes` and to the add question when `add`. */
const product = { yes: new Set(), add: false, calls: [] };
globalThis.fetch = async (url, init) => {
  if (url === "/api/model") {
    const b = JSON.parse(init?.body ?? "{}");
    if (b.user === undefined) return new Response(js({ warming: 0 }));
    product.calls.push({ model: b.model, from: b.from });
    let text = '{"refs": []}';
    if (String(b.model).startsWith("jev")) {
      const q = JSON.parse(b.user).questions ?? {};
      text = js(Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: product.yes.has(k) || (k === "add" && product.add) ? 0.95 : 0.02 }])));
    }
    return new Response(`${js({ text })}\n${js({ done: true, model: b.model, ms: 1 })}\n`);
  }
  assertLocalOnly(String(url));
  return realFetch(url, init);
};

const S = await import("../real/sessions.ts");
const R = await import("../real/real.ts");
const G = await import("../real/gold.ts");
const P = await import("../real/prompts.ts");
const SH = await import("../real/shadow.ts");
const { buildPrompt } = await import("../../src/core/draw.ts");
const { DEFAULTS, tune } = await import("../../src/core/tuning.ts");
const { PROMPTS, DRAW_ADD } = await import("../../src/core/prompts.ts");
const { Scene } = await import("../../src/core/scene.ts");
const { runScript } = await import("../../src/core/ops.ts");
const { paths } = await import("../loop/paths.ts");
const { caseDir, runFile } = await import("../loop/record.ts");
const { RUBRIC } = await import("../judge/judge.ts");
const { LOOP } = await import("../loop/config.ts");
const { startFakeApi } = await import("../mock/fake-api.ts");
const { spawnGateway, gatewayStatus } = await import("../loop/client.ts");
const p = paths();

// ---- Synthetic boards (the product's own ops on its blank board)
const board = (from, ops) => {
  const { scene, errors } = runScript(ops, Scene.fromJSON(structuredClone(from)));
  if (errors.length) fail(`a synthetic board didn't build: ${errors.map((e) => `${e.line}: ${e.error}`).join("; ")}`);
  return scene.toJSON();
};
const B0 = S.blankBoard();
const DUCK = [
  `shape(duck-body, round, 300 300 200 120, "the duck's round yellow body", fill:#ffd43b)`,
  `shape(duck-head, circle, 460 250 80 80, "the duck's yellow head", fill:#ffd43b)`,
  `shape(duck-beak, rect, 530 280 30 14, "the duck's orange beak", fill:#f08c00)`,
].join("\n");
const B1 = board(B0, DUCK); // the app's boxy duck
const B2 = board(B1, "shape(duck-body, 260 280 280 170)");
const B1n = board(B1, `shape(note-1, rect, 900 100 200 80, "a sticky note the person had open", fill:#fff3bf)`); // on screen, in no version
const B4 = board(B1n, [`shape(cat-body, rect, 700 300 160 120, "the cat's grey body", fill:#ced4da)`, `shape(cat-head, circle, 820 240 80 80, "the cat's grey head", fill:#ced4da)`].join("\n"));
const B5 = board(B1, `shape(pond-box, rect, 280 440 300 80, "a flat blue box for the pond", fill:#a5d8ff)`);
const CAM = { x: 0, y: 0, w: 1280, h: 800 };
const CAM2 = { x: -200, y: 40, w: 1440, h: 900 };
const tap = (id, x, y, t) => ({ id, points: [[x, y, t], [x + 1, y + 1, t + 40]], t0: t, t1: t + 40 });
const loop = (id, cx, cy, r, t) => {
  const pts = Array.from({ length: 25 }, (_, i) => [cx + r * Math.cos((i / 24) * 2 * Math.PI), cy + r * Math.sin((i / 24) * 2 * Math.PI), t + i * 20]);
  return { id, points: pts, t0: t, t1: t + 480 };
};
const W = (s, t = 100) => s.split(" ").map((word, i) => ({ word, t0: t + i * 250, t1: t + i * 250 + 200 }));

// The product's drawing prompt (its screenshots need a DOM, so they're off: they only add images and a Pictures part).
const PROMPT_T = tune({ "draw.sendScreenshot": 0 });
const drawPrompt = async (scene, strokes, words, camera, o = {}) => {
  product.yes = new Set(o.yes ?? []);
  product.add = !!o.add;
  return (await buildPrompt(Scene.fromJSON(structuredClone(scene)), strokes, words, PROMPT_T, undefined, camera)).user;
};

// ===== 2. The prompt round trip: sessions.ts reads back what the product's prompt builder writes today.
{
  const typed = S.readPrompt(await drawPrompt(B0, [], "add a duck", CAM));
  check(typed.request === "add a duck" && js(typed.camera) === js(CAM) && typed.marks.length === 0 && typed.refs === undefined, `readPrompt on a typed send without ink: ${js(typed)}`);
  const inked = S.readPrompt(await drawPrompt(B1, [tap(1, 400, 360, 1000)], "make this bigger", CAM2, { yes: ["duck-body"] }));
  check(inked.request === "make this [ink 1] bigger" && js(inked.camera) === js(CAM2) && js(inked.marks) === js(["[ink 1] tap on duck-body"]) && inked.refs === "duck-body",
    `readPrompt on a typed send with a tap: ${js(inked)}`);
  // Spoken words, two marks, and the add hint's line after the request (Jev says yes): the request stops at its own part.
  const spokenUser = await drawPrompt(B1, [tap(1, 400, 360, 300), loop(2, 500, 290, 70, 1400)], W("make this bigger and put that on top"), CAM, { yes: ["duck-body", "duck-head"], add: true });
  const spoken = S.readPrompt(spokenUser);
  check(spokenUser.includes(DRAW_ADD.line) && !spoken.request.includes(DRAW_ADD.line) && S.normal(spoken.request) === "make this bigger and put that on top" && (spoken.request.match(/\[ink \d\]/g) ?? []).length === 2,
    `readPrompt on spoken words with the add hint's line: request ${js(spoken.request)}`);
  check(spoken.marks.length === 2 && spoken.marks[0].startsWith("[ink 1] tap on duck-body") && spoken.marks[1].startsWith("[ink 2] ") && /duck-body/.test(spoken.refs ?? "") && /duck-head/.test(spoken.refs ?? ""),
    `readPrompt's marks and references on two marks: ${js({ marks: spoken.marks, refs: spoken.refs })}`);
  check(S.sameSend("make this bigger and put that on top", spoken.request) && S.sameSend("(drawing only)", S.readPrompt(await drawPrompt(B1, [tap(1, 400, 360, 0)], "", CAM, { yes: ["duck-body"] })).request),
    "sameSend doesn't match a version's label to its drawing call's request (words, or ink alone)");
  check(product.calls.length > 0 && product.calls.every((c) => String(c.model).startsWith("jev")), `the prompt builder's model calls weren't all answered in this process: ${js(product.calls)}`);
}

// ===== 1. Ingest: a pull's raw snapshot (live: the box's /data; local: the laptop's .data) becomes sessions.
const T0 = Date.parse("2026-10-23T10:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const STAMP = "20261024-120000";
const raw = join(p.real, "raw", STAMP);
const SVG3 = ['<circle cx="50" cy="50" r="40" fill="#ffd43b"/>', '<path d="M10 10 L90 90"/>', '<rect x="5" y="5" width="10" height="10"/>'].join("\n");
const P1 = await drawPrompt(B0, [], "add a duck", CAM);
const P2 = await drawPrompt(B1, [tap(1, 400, 360, 1000)], "make this bigger", CAM2, { yes: ["duck-body"] });
const P2zed = await drawPrompt(B1, [], "make this bigger", CAM);
const W3 = W("draw a cat next to the duck");
const K3 = { id: 7, points: [[760, 320, 900], [800, 330, 960], [840, 320, 1020]], t0: 900, t1: 1020 };
{
  const live = join(raw, "live");
  put(join(live, "access", "access.json"), { people: [{ id: "u-tess", email: "tess@example.test", owner: "own-tess" }, { id: "u-zed", email: "zed@example.test", owner: "own-zed" }] });
  lines(join(live, "access", "feedback.jsonl"), [
    { at: T0 + 200_000, person: "u-tess", text: "the duck is just boxes", project: { id: "p1", version: 1 } },
    { at: T0 + 201_000, person: "u-tess", text: "another project", project: { id: "p9" } },
    { at: T0 + 202_000, person: "u-zed", text: "not their project", project: { id: "p1" } },
  ]);
  put(join(live, "app", "owners", "own-tess", "index.json"), [{ id: "p1", name: "Synthetic zoo" }, { id: "p-empty", name: "Nothing yet" }]);
  lines(join(live, "app", "owners", "own-tess", "p1.ndjson"), [
    { n: 2, doc: B2, at: T0 + 60_000, label: "make this bigger" },
    { n: 1, doc: B1, at: T0 + 20_000, label: "add a duck" },
    "not json: a torn last write",
    { n: 3, doc: B1, at: T0 + 80_000, label: "Restored V1" },
    { n: 4, doc: B4, at: T0 + 115_000, label: "draw a cat next to the duck" },
  ]);
  lines(join(live, "app", "sends", "own-tess", "p1.ndjson"), [
    { id: "s3", project: "p1", at: at(110), label: "draw a cat next to the duck", spoken: true, kind: "send", camera: CAM, words: W3, strokes: [K3], enterAtMs: 2400, before: B1n, beforeVersion: 3, afterVersion: 4, status: "done", landed: 2 },
    { id: "s4", project: "p1", at: at(150), label: "zoom out", spoken: false, kind: "send", camera: CAM, words: "zoom out", strokes: [], enterAtMs: 0, before: B4, beforeVersion: 4, afterVersion: 4, status: "done", landed: 0 },
  ]);
  lines(join(live, "model-calls.jsonl"), [
    { at: at(18), from: "draw", who: "u-tess", ms: 3000, user: P1, reply: DUCK },
    // Every picture prompt variant the product has: sessions.ts reads each one's subject and box.
    ...PROMPTS.picture.map((v, i) => ({ at: at(18.5 + i * 0.1), from: "picture", who: "u-tess", ms: 900, user: v.user(`yellow duck ${i}`, 200 + i, 160 + i, DEFAULTS), reply: SVG3 })),
    { at: at(18.9), from: "picture", who: "u-zed", ms: 900, user: PROMPTS.picture[0].user("someone else's cat", 90, 90, DEFAULTS), reply: SVG3 },
    { at: at(57), from: "resolve", who: "u-tess", ms: 300, user: "which shape", reply: "{}" },
    { at: at(58), from: "draw", who: "u-tess", ms: 4000, user: P2, reply: "shape(duck-body, 260 280 280 170)" },
    // Another person's call for the same words, later: live sessions take only their person's calls.
    { at: at(59), from: "draw", who: "u-zed", ms: 2000, user: P2zed, reply: "shape(duck-body, 0 0 10 10)" },
  ]);
  const local = join(raw, "local");
  put(join(local, "app", "owners", "own-me", "index.json"), [{ id: "q1", name: "Owner duck" }, { id: "q0", name: "Old test" }]);
  lines(join(local, "app", "owners", "own-me", "q1.ndjson"), [
    { n: 1, doc: B1, at: T0 + 300_000, label: "add a duck" },
    { n: 2, doc: B5, at: T0 + 400_000, label: "add a pond under the duck" },
  ]);
  lines(join(local, "app", "owners", "own-me", "q0.ndjson"), [{ n: 1, doc: board(B0, `shape(hi, rect, 100 100 300 60, "a hello line at the top of the page")`), at: Date.parse("2026-10-01T09:00:00Z"), label: "say hello" }]);
  lines(join(local, "model-calls.jsonl"), [
    { at: at(298), from: "draw", ms: 2000, user: P1, reply: DUCK },
    { at: at(398), from: "draw", ms: 2000, user: await drawPrompt(B1, [], "add a pond under the duck", CAM), reply: "shape(pond-box, rect, 280 440 300 80, \"a flat blue box for the pond\")" },
  ]);
  put(join(p.real, "raw", "latest"), `${STAMP}\n`);
}
const LIVE = `live-${sha("live:own-tess").slice(0, 8)}-p1`;
const Q1 = `local-${sha("local:own-me").slice(0, 8)}-q1`;
const Q0 = `local-${sha("local:own-me").slice(0, 8)}-q0`;
const SINCE = "2026-10-22";
const said = R.ingestStep();
check(said.length === 2 && /^live: 1 sessions, 4 sends \(1 sessions by testers\)$/.test(said[0]) && /^local: 2 sessions, 3 sends \(0 sessions by testers\)$/.test(said[1]), `ingest said: ${js(said)}`);
const all = R.readSessions();
const ss = Object.fromEntries(all.map((x) => [x.s.id, x]));
check(js(Object.keys(ss).sort()) === js([LIVE, Q0, Q1].sort()), `ingest made sessions ${Object.keys(ss).join(", ")} (want ${LIVE}, ${Q0}, ${Q1}; a project with no versions and no sends is none)`);
const L = ss[LIVE], Q = ss[Q1];
if (!L || !Q) fail("ingest didn't make the synthetic sessions");
{
  const x = L.s.sends;
  check(x.length === 4 && x.every((y, i) => y.key === `${LIVE}#${i + 1}`), `live keys: ${x.map((y) => y.key).join(", ")}`);
  check(js(x.map((y) => y.replay)) === js(["typed", "ink", "exact", "exact"]), `live replay modes: ${x.map((y) => y.replay).join(", ")} (want typed, ink, exact, exact)`);
  check(L.s.person === `p-${sha("own-tess").slice(0, 8)}` && L.s.admin === false && L.s.source === "live" && L.s.project.name === "Synthetic zoo", `live session's person/admin/source: ${js({ person: L.s.person, admin: L.s.admin })}`);
  check(L.s.restores.length === 1 && L.s.restores[0].version === 3 && L.s.feedback.length === 1 && L.s.feedback[0].text === "the duck is just boxes" && L.s.feedback[0].version === 1,
    `restores ${js(L.s.restores)}, feedback ${js(L.s.feedback)} (want one restore, and only this person's feedback on this project)`);
  // Send 1: rebuilt from its version and the drawing call's prompt; typed words replay as typed.
  const want1 = PROMPTS.picture.map((_, i) => ({ subject: `yellow duck ${i}`, w: 200 + i, h: 160 + i, elements: 3 }));
  check(x[0].words === "add a duck" && js(x[0].camera) === js(CAM) && x[0].before === 0 && x[0].after === 1 && x[0].reply === DUCK && x[0].at === at(15),
    `send 1 (rebuilt, typed): ${js({ words: x[0].words, camera: x[0].camera, before: x[0].before, after: x[0].after, at: x[0].at })}`);
  check(js(x[0].pictures) === js(want1), `send 1's pictures (one per picture prompt variant, no one else's): ${js(x[0].pictures)}`);
  // Send 2: its ink is lost, only the product's reading of it survives; the tester's own call, not another person's.
  check(x[1].words === "make this [ink 1] bigger" && js(x[1].marks) === js(["[ink 1] tap on duck-body"]) && x[1].refs === "duck-body" && js(x[1].camera) === js(CAM2) && x[1].strokes.length === 0,
    `send 2 (rebuilt, ink): ${js({ words: x[1].words, marks: x[1].marks, refs: x[1].refs, camera: x[1].camera })}`);
  // Send 3: from the send log, exact, with its own before board (a note no version holds).
  check(js(x[2].words) === js(W3) && js(x[2].strokes) === js([K3]) && x[2].enterAtMs === 2400 && x[2].before === 3 && x[2].after === 4 && x[2].label === "draw a cat next to the duck",
    `send 3 (exact): ${js({ before: x[2].before, after: x[2].after, enterAtMs: x[2].enterAtMs })}`);
  check(S.beforeOf(L.dir, x[2]).shapes.some((s) => s.id === "note-1") && !json(join(L.dir, "v3.json")).shapes.some((s) => s.id === "note-1"), "an exact send's before isn't its own board (before-<n>.json)");
  // Send 4: logged, changed nothing.
  check(x[3].before === 4 && x[3].after === 4 && x[3].words === "zoom out" && x[3].status === "done", `send 4 (exact, nothing landed): ${js({ before: x[3].before, after: x[3].after })}`);
  check(["v0.json", "v1.json", "v2.json", "v3.json", "v4.json", "before-3.json", "before-4.json", "session.json"].every((f) => existsSync(join(L.dir, f))), `the live session's files: ${readdirSync(L.dir).join(", ")}`);
  check(!readFileSync(join(L.dir, "session.json"), "utf8").includes("@example.test"), "session.json carries an email");
  check(Q.s.admin === true && Q.s.sends.length === 2 && Q.s.sends.every((y) => y.replay === "typed") && Q.s.sends[0].words === "add a duck" && Q.s.sends[1].words === "add a pond under the duck",
    `local session: admin ${Q.s.admin}, sends ${js(Q.s.sends.map((y) => [y.replay, y.words]))}`);
  check(ss[Q0]?.s.sends[0]?.words === "say hello" && ss[Q0].s.sends[0].replay === "typed" && ss[Q0].s.sends[0].camera === undefined, "a version with no drawing call isn't rebuilt from its label");
  const chosen = R.chosen(SINCE).map((c) => c.s.id);
  check(js(chosen) === js([LIVE, Q1]), `chosen since ${SINCE}: ${chosen.join(", ")} (a local session before it is left out)`);
}

// ---- What ingest must not get wrong with the loop's knobs off, on a second snapshot (its own out dir): ink with
// draw.sendMarks off shows only as [ink n] in the words, so the send stays "ink" (no strokes: it can't replay); two
// logged sends from one version (a stop, then a send after a hand edit) each keep their own before board; and the
// references resolve.speculate off writes a line per phrase are read.
{
  const promptWith = async (knobs, scene, strokes, words, camera, yes) => {
    product.yes = new Set(yes);
    product.add = false;
    return (await buildPrompt(Scene.fromJSON(structuredClone(scene)), strokes, words, tune({ "draw.sendScreenshot": 0, ...knobs }), undefined, camera)).user;
  };
  const noMarks = await promptWith({ "draw.sendMarks": 0 }, B1, [tap(1, 400, 360, 1000)], "make this bigger", CAM, ["duck-body"]);
  const noSpec = S.readPrompt(await promptWith({ "resolve.speculate": 0 }, B1, [tap(1, 400, 360, 1000)], "make this bigger", CAM, ["duck-body"]));
  check(/duck-body/.test(noSpec.refs ?? ""), `readPrompt lost the references resolve.speculate off writes: ${js(noSpec.refs)}`);
  const raw2 = join(work, "raw2"), out2 = join(work, "out2");
  put(join(raw2, "access", "access.json"), { people: [{ id: "u-kit", email: "kit@example.test", owner: "own-kit" }] });
  put(join(raw2, "app", "owners", "own-kit", "index.json"), [{ id: "k1", name: "Knobs off" }]);
  lines(join(raw2, "app", "owners", "own-kit", "k1.ndjson"), [
    { n: 1, doc: B1, at: T0 + 20_000, label: "add a duck" },
    { n: 2, doc: B2, at: T0 + 60_000, label: "make this bigger" },
    { n: 3, doc: B4, at: T0 + 120_000, label: "draw a cat next to the duck" },
  ]);
  // From version 2: a stopped send on the board as saved, then (after a hand edit adding a note) the send that landed.
  lines(join(raw2, "app", "sends", "own-kit", "k1.ndjson"), [
    { id: "k-stop", project: "k1", at: at(100), label: "draw a cat", spoken: false, kind: "send", camera: CAM, words: "draw a cat", strokes: [], enterAtMs: 0, before: B2, beforeVersion: 2, afterVersion: 2, status: "stopped", landed: 0 },
    { id: "k-cat", project: "k1", at: at(110), label: "draw a cat next to the duck", spoken: false, kind: "send", camera: CAM, words: "draw a cat next to the duck", strokes: [], enterAtMs: 0, before: B1n, beforeVersion: 2, afterVersion: 3, status: "done", landed: 2 },
  ]);
  lines(join(raw2, "model-calls.jsonl"), [
    { at: at(18), from: "draw", who: "u-kit", ms: 3000, user: P1, reply: DUCK },
    { at: at(58), from: "draw", who: "u-kit", ms: 4000, user: noMarks, reply: "shape(duck-body, 260 280 280 170)" },
  ]);
  const [k] = S.ingest(raw2, "live", out2);
  const x = k?.sends ?? [];
  const dir2 = join(out2, k?.id ?? "none");
  check(js(x.map((y) => [y.replay, y.status ?? ""])) === js([["typed", ""], ["ink", ""], ["exact", "stopped"], ["exact", "done"]]) && /\[ink 1\]/.test(x[1]?.words ?? ""),
    `ingest with draw.sendMarks off: ${js(x.map((y) => [y.replay, y.words]))} (want send 2 "ink": its ink shows only as [ink 1])`);
  check(x.length === 4 && !S.beforeOf(dir2, x[2]).shapes.some((s) => s.id === "note-1") && S.beforeOf(dir2, x[3]).shapes.some((s) => s.id === "note-1"),
    "two logged sends from one version don't each keep their own before board");
}

// ---- Render, stubbed (no Chrome): each send's before and after, framed, through a Shot that answers a JPEG.
let shots = 0;
const stubShot = async () => (shots++, JPEG);
const made = (await R.renderSession(L.dir, L.s, stubShot)) + (await R.renderSession(Q.dir, Q.s, stubShot));
const img = (x) => json(join(x.dir, "img", "index.json"));
check(made > 0 && made === shots && L.s.sends.every((y) => img(L)[y.key]?.before && img(L)[y.key]?.after) && Q.s.sends.every((y) => img(Q)[y.key]), `render (stubbed) made ${made} images, index ${js(Object.keys(img(L)))}`);
check((await R.renderSession(L.dir, L.s, stubShot)) === 0, "a second render shot again what it had");

// ===== 3. Triage and gold through the gateway on the fake API.
const fence = (o) => `Here is my read.\n\`\`\`json\n${js(o)}\n\`\`\``;
const TRIAGE = [
  fence({ sends: [
    { n: 1, meant: "one yellow duck", landed: "no", categories: ["boxy-subject"], evidence: "built from a round, a circle and a box", gold: true },
    { n: 2, meant: "the duck bigger", landed: "partly", categories: ["missing-part"], evidence: "only the body grew", gold: true },
    { n: 3, meant: "a cat beside the duck", landed: "no", categories: ["boxy-subject"], evidence: "two grey boxes", gold: true },
    { n: 4, meant: "see the whole board", landed: "yes", categories: [], evidence: "it zoomed out", gold: true },
  ] }),
  js({ sends: [
    { n: 1, meant: "a duck", landed: "no", categories: ["boxy-subject"], evidence: "boxes", gold: true },
    { n: 2, meant: "a pond under the duck", landed: "maybe", categories: ["squashed-picture"], evidence: "a flat box", gold: true },
  ] }),
];
const pic = (els) => els.join("\n");
const goldReply = ({ ops, pictures = {}, rubric, checks, why = "They meant it. This does it." }) =>
  [`<ops>\n${ops.join("\n")}\n</ops>`, ...Object.entries(pictures).map(([id, els]) => `<picture id="${id}">\n${pic(els)}\n</picture>`), `<rubric>${js(rubric)}</rubric>`, `<checks>${js(checks)}</checks>`, `<why>${why}</why>`].join("\n");
const DUCK_PIC = ['<ellipse cx="150" cy="170" rx="130" ry="70" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>', '<circle cx="240" cy="80" r="50" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>', '<path d="M285 80 L315 90 L285 100 Z" fill="#f08c00" stroke="#1e1e1e" stroke-width="2"/>', '<circle cx="250" cy="70" r="6" fill="#1e1e1e"/>'];
const L1_RUBRIC = { should: ["one duck that reads as a rubber duck", "the duck is yellow", "the duck sits on the Home page"], mustNot: ["a duck built from separate boxes and circles", "red ink colors in the drawing"] };
const GOLD = [
  // L#1: one drawing; a text() for a shape that isn't there and a picture with no drawing() are problems; camera() is not.
  // Of its checks, a malformed one and a bad color are dropped on reading, and page-filled (gold fails it) by ownChecks.
  goldReply({
    ops: [`shape(duck, rect, 380 240 320 260, "one yellow rubber duck drawn as a single picture", fill:none, stroke:none)`, `drawing(duck, "a yellow rubber duck")`, `text(ghost, "nobody")`, "camera(0 0 1280 800)"],
    pictures: { duck: DUCK_PIC, ghost: ['<circle cx="5" cy="5" r="4" fill="#000"/>'] }, rubric: L1_RUBRIC,
    checks: [{ type: "single-picture", words: ["duck"] }, { type: "no-parts", words: ["duck"] }, { type: "page-filled", page: "page", min: 5 }, { type: "bogus" }, { type: "no-color", color: "red" }],
  }),
  // L#3, first try: unreadable.
  "I couldn't work out what to draw here.",
  // Q#1 and Q#2.
  goldReply({ ops: [`shape(duck2, rect, 400 260 300 240, "one yellow duck as a single picture", fill:none, stroke:none)`, `drawing(duck2, "a yellow duck")`], pictures: { duck2: DUCK_PIC.slice(0, 3) },
    rubric: { should: ["one duck"], mustNot: ["boxes for a duck"] }, checks: [{ type: "single-picture", words: ["duck"] }] }),
  goldReply({ ops: ["remove(pond-box)", `shape(pond, round, 260 440 360 110, "a calm blue pond under the duck", fill:#a5d8ff)`], rubric: { should: ["a blue pond under the duck"], mustNot: ["the duck moves"] }, checks: [] }),
  // L#3, the retry.
  goldReply({ ops: [`shape(cat, rect, 680 230 240 220, "a grey cat sitting next to the duck, one picture", fill:none, stroke:none)`, `drawing(cat, "a grey cat sitting")`],
    pictures: { cat: ['<ellipse cx="120" cy="150" rx="90" ry="60" fill="#ced4da" stroke="#1e1e1e" stroke-width="3"/>', '<circle cx="120" cy="70" r="45" fill="#ced4da" stroke="#1e1e1e" stroke-width="3"/>', '<path d="M90 40 L100 10 L110 35 M130 35 L140 10 L150 40" stroke="#1e1e1e" fill="none"/>'] },
    rubric: { should: ["a cat that reads as a cat next to the duck"], mustNot: ["the cat built from boxes"] }, checks: [{ type: "single-picture", words: ["cat"] }, { type: "no-color", color: "#e03131" }] }),
  // Q#2 redrawn (--regold): the pond elsewhere, still no checks.
  goldReply({ ops: ["remove(pond-box)", `shape(pond, round, 240 460 400 100, "a wide blue pond under the duck", fill:#74c0fc)`], rubric: { should: ["a blue pond under the duck", "the pond is wider than the duck"], mustNot: ["the duck moves"] }, checks: [] }),
];
const replies = join(work, "replies");
mkdirSync(replies);
writeFileSync(join(replies, `real-triage.${sha12(P.TRIAGE_SYSTEM)}.json`), js(TRIAGE));
writeFileSync(join(replies, `real-gold.${sha12(P.GOLD_SYSTEM())}.json`), js(GOLD));
const api = await startFakeApi({ port: 5641, replies });
const tokens = join(work, "tokens.env");
writeFileSync(tokens, [1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-fake-t23-${n}-${randomBytes(6).toString("hex")}`).join("\n") + "\n");
chmodSync(tokens, 0o600);
const gw = await spawnGateway({ home, port: 5640, tokens, mockApi: api.url });
const reqs = () => api.requests.filter((r) => r.path.endsWith("/v1/messages"));

// ---- Triage
const tL = await R.triageSession(L.dir, L.s, "real-triage-t23");
const tr = json(join(L.dir, "triage.json"));
check(tL !== "kept" && tr.prompt === sha(P.TRIAGE_SYSTEM) && tr.sends.length === 4 && js(tr.sends.map((r) => r.gold)) === js([true, true, true, false]) && tr.sends[0].meant === "one yellow duck" && js(tr.sends[2].categories) === js(["boxy-subject"]),
  `triage.json: ${js(tr.sends?.map((r) => [r.n, r.landed, r.gold]))} (a send that landed gets no gold)`);
const r0 = reqs()[0];
check(reqs().length === 1 && r0.role === "real-triage" && r0.images === 8 && /opus/.test(r0.model) && r0.effort === "high" && r0.firstUser.includes(`Session ${LIVE}`) && r0.firstUser.includes("Judge every send.") && !r0.firstUser.includes("@example.test"),
  `the triage request: ${js({ n: reqs().length, role: r0?.role, images: r0?.images, model: r0?.model, effort: r0?.effort })}`);
check((await R.triageSession(L.dir, L.s, "real-triage-t23b")) === "kept" && reqs().length === 1, "a current triage was asked again");
const tQ = await R.triageSession(Q.dir, Q.s, "real-triage-t23");
check(tQ !== "kept" && tQ.sends[1].landed === "no" && tQ.sends.every((r) => r.gold), `local triage: ${js(tQ.sends?.map((r) => [r.landed, r.gold]))} (an unknown landed reads as no)`);

// ---- Gold: batch 1
const sendHash = (x) => sha(js([x.words, x.strokes, x.at]));
const key = (sid, n) => `${sid}#${n}`;
const want = (regold = false) => R.wantGold(SINCE, undefined, regold).map((c) => c.x.key);
check(js(want()) === js([key(LIVE, 1), key(LIVE, 3), key(Q1, 1), key(Q1, 2)]), `wantGold before any gold: ${want().join(", ")} (want no ink-only send, no landed send)`);
check(R.nextBatch() === 1, `the first gold run's batch is ${R.nextBatch()}`);
const goldRun = async (run, regold = false) => {
  const batch = R.nextBatch();
  const out = [];
  for (const c of R.wantGold(SINCE, undefined, regold)) out.push(await R.goldSend(c, run, batch));
  return out;
};
const g1 = await goldRun("real-gold-t23-1");
const gDir = (k) => join(p.real, "gold", k.replace("#", "-"));
const gl1 = R.goldOf(key(LIVE, 1));
{
  const x = L.s.sends[0];
  check(gl1 && !gl1.error && gl1.batch === 1 && gl1.sendHash === sendHash(x) && gl1.prompt === sha(P.GOLD_SYSTEM()) && gl1.meant === "one yellow duck" && existsSync(join(gDir(key(LIVE, 1)), "reply.txt")),
    `gold.json for ${key(LIVE, 1)}: ${js({ error: gl1?.error, batch: gl1?.batch, sendHash: gl1?.sendHash === sendHash(x) })}`);
  check(js(gl1.gold.checks) === js([{ type: "single-picture", words: ["duck"] }, { type: "no-parts", words: ["duck"] }]) && gl1.problems.some((q) => /^check left out, gold fails it: .*page-filled/.test(q)),
    `gold's own failing check isn't dropped (checks ${js(gl1.gold.checks)}, problems ${js(gl1.problems)})`);
  check(gl1.problems.some((q) => /^text\(ghost/.test(q)) && gl1.problems.some((q) => /picture for ghost, which has no drawing/.test(q)) && !gl1.problems.some((q) => /camera\(/.test(q)), `gold's problems: ${js(gl1.problems)}`);
  const scene = json(join(gDir(key(LIVE, 1)), "gold.scene.json"));
  const duck = scene.shapes.find((s) => s.id === "duck");
  check(duck?.picture?.done && duck.picture.els.length === 4 && duck.picture.subject === "a yellow rubber duck" && scene.shapes.length === B0.shapes.length + 1, `applyGold's board: ${js(duck?.picture?.els?.length)} picture elements, ${scene.shapes.length} shapes`);
  check(gl1.appChecks.length === 2 && gl1.appChecks.every((r) => !r.pass) && gl1.goldChecks.every((r) => r.pass), `free checks on the app's result ${js(gl1.appChecks.map((r) => r.pass))} and on gold ${js(gl1.goldChecks.map((r) => r.pass))}`);
  const gr = reqs().filter((r) => r.role === "real-gold");
  check(gr.length === 4 && gr[0].images === 2 && /opus/.test(gr[0].model) && gr[0].effort === "high" && gr[0].firstUser.includes("What they meant: one yellow duck") && gr[0].firstUser.includes(G.boardOps(B0)),
    `the gold requests: ${gr.length}, first ${js({ images: gr[0]?.images, model: gr[0]?.model })}`);
  const gl3 = R.goldOf(key(LIVE, 3));
  check(g1.length === 4 && gl3?.error === "no <ops>" && !gl3.gold && gl3.batch === 1 && gl3.sendHash === sendHash(L.s.sends[2]), `an unreadable gold reply: ${js(gl3)}`);
}
// The next run: only the failed one again (a send with gold isn't redrawn; an ink-only send never gets any), even with a
// verdict on the failed gold, which isn't the retried gold's.
put(join(p.real, "review", "verdicts.jsonl"), `${js({ key: key(LIVE, 3), verdict: "approve", at: new Date().toISOString() })}\n`);
check(js(want()) === js([key(LIVE, 3)]), `wantGold after batch 1: ${want().join(", ")} (want only the failed one)`);
const g2 = await goldRun("real-gold-t23-2");
const gl3 = R.goldOf(key(LIVE, 3));
check(g2.length === 1 && gl3.gold && !gl3.error && gl3.batch === 2 && !R.goldCases().find((g) => g.key === key(LIVE, 3)).verdict && gl3.goldChecks.every((r) => r.pass) && gl3.appChecks.map((r) => r.pass).join() === "false,true",
  `the retried gold: ${js({ batch: gl3.batch, error: gl3.error, app: gl3.appChecks?.map((r) => r.pass) })}`);
check(gl3.gold && R.goldOf(key(LIVE, 3)).sendHash === sendHash(L.s.sends[2]) && json(join(gDir(key(LIVE, 3)), "gold.scene.json")).shapes.some((s) => s.id === "note-1"), "an exact send's gold isn't built on its own before board");
check(want().length === 0, `wantGold with every send drawn: ${want().join(", ")}`);
check(js(want(true)) === js([key(LIVE, 1), key(LIVE, 3), key(Q1, 1), key(Q1, 2)]), `wantGold --regold before any review: ${want(true).join(", ")}`);

// ---- Render's gold half, stubbed: gold boards rebuilt from their replies (0 calls), and shot.
{
  const before = shots;
  check((await R.shootGold(stubShot)) === 4 && shots - before === 4 && existsSync(join(gDir(key(LIVE, 1)), "gold.jpg")), "shootGold didn't shoot each gold board once");
  check(R.rebuildGold() === 0 && existsSync(join(gDir(key(LIVE, 1)), "gold.jpg")), "rebuildGold changed a board gold.ts would build the same");
  const f = join(gDir(key(LIVE, 1)), "gold.scene.json");
  writeFileSync(f, js(B0));
  check(R.rebuildGold() === 1 && !existsSync(join(gDir(key(LIVE, 1)), "gold.jpg")) && json(f).shapes.some((s) => s.id === "duck"), "rebuildGold didn't rebuild a changed board and drop its image");
  await R.shootGold(stubShot);
}

// ===== 4. Review: the server's verdicts, and which gold goes in.
const reviewUrl = await R.serveReview("127.0.0.1", 5642);
const post = async (path, body) => {
  const res = await fetch(`${reviewUrl}${path.slice(1)}`, { method: "POST", headers: { "content-type": "application/json" }, body: js(body) });
  return res.status;
};
const acc = (k) => {
  const g = R.goldCases().find((x) => x.key === k);
  return g ? R.accepted(g) : undefined;
};
check([key(LIVE, 1), key(Q1, 1), key(Q1, 2)].every((k) => acc(k) === false) && acc(key(LIVE, 3)) === true, `before any verdict: batch 1 ${[key(LIVE, 1), key(Q1, 1), key(Q1, 2)].map(acc)}, batch 2 ${acc(key(LIVE, 3))} (want batch 1 out, later batches in)`);
check((await post("/api/verdict", { key: "nobody#1", verdict: "approve" })) === 400 && (await post("/api/verdict", { key: key(LIVE, 1), verdict: "maybe" })) === 400 && (await post("/api/note", { key: key(LIVE, 1) })) === 400, "the review server took a verdict for no gold, an unknown verdict or a note without text");
check((await post("/api/verdict", { key: key(LIVE, 1), verdict: "approve" })) === 200 && acc(key(LIVE, 1)) === true, "an approved batch-1 case isn't accepted");
check((await post("/api/note", { key: key(Q1, 1), note: "check the beak" })) === 200 && acc(key(Q1, 1)) === false && R.goldCases().find((x) => x.key === key(Q1, 1)).note === "check the beak", "a note alone counted as a verdict, or wasn't kept");
check((await post("/api/verdict", { key: key(Q1, 1), verdict: "approve" })) === 200 && acc(key(Q1, 1)) === true && R.goldCases().find((x) => x.key === key(Q1, 1)).note === "check the beak", "a verdict without a note lost the note");
check((await post("/api/verdict", { key: key(LIVE, 3), verdict: "reject", note: "the cat floats" })) === 200 && acc(key(LIVE, 3)) === false, "a rejected later-batch case is still accepted");
check((await post("/api/verdict", { key: key(LIVE, 3), verdict: "approve" })) === 200 && acc(key(LIVE, 3)) === true, "the latest verdict doesn't win");
check(!R.accepted({ batch: 2, error: "no <ops>", problems: [] }) && !R.accepted({ batch: 3, error: "x", gold: gl3.gold, verdict: { verdict: "approve" } }) && R.accepted({ batch: 1, gold: gl3.gold, verdict: { verdict: "approve" } }), "accepted() takes failed gold");
{
  const page = await fetch(reviewUrl);
  const html = await page.text();
  const imgName = img(L)[key(LIVE, 1)].before;
  const okImg = await fetch(`${reviewUrl}sessions/${LIVE}/img/${imgName}`);
  const notJpg = await fetch(`${reviewUrl}sessions/${LIVE}/session.json`);
  const escape = await fetch(`${reviewUrl}..%2F..%2F..%2Fetc%2Fhostname.jpg`);
  check(page.status === 200 && html.includes(`data-key="${key(LIVE, 3)}"`) && html.includes("batch 2") && okImg.status === 200 && notJpg.status === 404 && escape.status === 404,
    `the review page or its file serving: page ${page.status}, image ${okImg.status}, session.json ${notJpg.status}, escape ${escape.status}`);
}
// --regold redraws every unreviewed one, never one the owner has looked at.
check(js(want(true)) === js([key(Q1, 2)]), `wantGold --regold after review: ${want(true).join(", ")} (want only the unreviewed one)`);
writeFileSync(join(gDir(key(Q1, 2)), "gold.jpg"), JPEG);
const q2old = R.goldOf(key(Q1, 2));
const g3 = await goldRun("real-gold-t23-3", true);
const q2 = R.goldOf(key(Q1, 2));
check(g3.length === 1 && q2.batch === 1 && acc(key(Q1, 2)) === false && q2.at !== q2old.at && js(q2.gold.rubric.should) !== js(q2old.gold.rubric.should) && !existsSync(join(gDir(key(Q1, 2)), "gold.jpg")) && q2.gold.checks.length === 0,
  `the redrawn gold: ${js({ batch: q2.batch, should: q2.gold?.rubric.should, jpg: existsSync(join(gDir(key(Q1, 2)), "gold.jpg")) })}`);
await R.shootGold(stubShot);
// A redrawn batch-1 case is still batch 1: out until the owner approves it.
check((await post("/api/verdict", { key: key(Q1, 2), verdict: "approve" })) === 200 && acc(key(Q1, 2)) === true, "the review server refused a verdict, or an approved redrawn case isn't accepted");
const st = await gatewayStatus(gw.url);
check(reqs().length === 8 && st.calls === reqs().length && reqs().every((r) => r.role === "real-triage" || r.role === "real-gold"), `the fake API got ${reqs().length} requests (roles ${[...new Set(reqs().map((r) => r.role))]}), the gateway made ${st.calls} calls (want 8)`);

// ===== 5. Freeze: R1 from accepted gold that replays.
// Older gold (no sendHash) for the ink-only send, and gold drawn for a send a later pull moved under send 4's key.
const plant = (k, n, o) => put(join(gDir(k), "gold.json"), { ...gl3, key: k, n, batch: 2, ...o });
const { sendHash: _, ...noHash } = gl3;
put(join(gDir(key(LIVE, 2)), "gold.json"), { ...noHash, key: key(LIVE, 2), n: 2, batch: 2 });
plant(key(LIVE, 4), 4, { sendHash: sendHash(L.s.sends[2]) });
execFileSync("git", ["init", "-q", p.repo]); // the loop's clone: freeze records R1 on its history branch
const r1 = join(p.real, "bench", "R1");
const manifestOf = (root) => {
  const files = {};
  if (!existsSync(root)) return { files, hash: "none" };
  for (const id of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort()) for (const f of readdirSync(join(root, id)).sort()) files[`${id}/${f}`] = sha(readFileSync(join(root, id, f)));
  return { files, hash: sha(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n")) };
};
check(SH.r1Cases().length === 0 && (await SH.realShadow(undefined, { run: "real-shadow-none", arms: {}, seed: "t23" })) === undefined, "realShadow ran without a frozen R1");
const f1 = R.freezeReal();
const id1 = key(LIVE, 1).replace("#", "-"), id3 = key(LIVE, 3).replace("#", "-"), idQ2 = key(Q1, 2).replace("#", "-");
const r1ids = () => (existsSync(r1) ? readdirSync(r1).filter((d) => statSync(join(r1, d)).isDirectory()).sort() : []);
check(js(r1ids()) === js([id1, id3, idQ2].sort()), `R1's cases: ${r1ids().join(", ")} (want ${[id1, id3, idQ2].join(", ")})`);
check(f1.cases === 3 && f1.merged === 1 && f1.inkWaiting === 1 && f1.moved === 1 && f1.tune === 1 && f1.hold === 2 && js(f1.people) === js({ tune: 1, hold: 1 }), `freeze's counts: ${js(f1)} (want 3 cases, 1 merged, 1 ink-waiting, 1 moved; the owner tunes, the tester holds)`);
{
  const m = maybe(join(r1, "manifest.json")) ?? {};
  const again = manifestOf(r1);
  check(m.version === "R1" && m.hash === f1.hash && m.hash === again.hash && js(m.files) === js(again.files), "manifest.json isn't the hash over R1's files");
  const want = ["before-ink.jpg", "before.scene.json", "case.json", "checks.json", "input.json", "meant.json", "rubric.json"];
  check(r1ids().every((id) => js(readdirSync(join(r1, id)).sort()) === js(want)), `a case's files: ${js(readdirSync(join(r1, id1)).sort())}`);
  const c1 = json(join(r1, id1, "case.json")), cq = json(join(r1, idQ2, "case.json")), c3 = json(join(r1, id3, "case.json"));
  check(c1.set === "real" && c1.split === "hold" && c1.originSession === L.s.person && c1.replay === "typed" && cq.split === "tune" && cq.originSession === "owner" && cq.admin === true && c3.replay === "exact" && c3.send === 3,
    `case.json: ${js({ c1: [c1.split, c1.originSession, c1.replay], cq: [cq.split, cq.originSession] })}`);
  const i1 = json(join(r1, id1, "input.json")), i3 = json(join(r1, id3, "input.json"));
  check(i1.words === "add a duck" && i1.strokes.length === 0 && js(i3.words) === js(W3) && js(i3.strokes) === js([K3]) && i3.enterAtMs === 2400 && i3.inputHash === sha(js([i3.camera, i3.words, i3.strokes])),
    `input.json: ${js({ i1: i1.words, i3: i3.enterAtMs })}`);
  check(js(json(join(r1, id1, "rubric.json"))) === js(L1_RUBRIC) && js(json(join(r1, id1, "checks.json"))) === js(gl1.gold.checks) && json(join(r1, idQ2, "checks.json")).length === 0, "rubric.json or checks.json isn't gold's");
  check(json(join(r1, id3, "before.scene.json")).shapes.some((s) => s.id === "note-1"), "an exact case's before.scene.json isn't its own before board");
  const hist = readFileSync(join(p.history, "bench", "R1.json"), "utf8");
  const h = JSON.parse(hist);
  check(h.hash === f1.hash && h.cases === 3 && js(Object.keys(h.splits).sort()) === js(r1ids()) && !/duck|cat|pond|zoo|tess|example\.test/i.test(hist), `history's bench/R1.json: ${hist.slice(0, 300)}`);
}
check(R.freezeReal().hash === f1.hash, "freezing the same gold again gave another hash");
// A loop holding the lock: refused, R1 as it was.
writeFileSync(p.lock, `${process.pid}\n`);
let locked;
try {
  R.freezeReal();
} catch (e) {
  locked = e;
}
rmSync(p.lock);
check(/loop\.lock is held/.test(locked?.message ?? "") && maybe(join(r1, "manifest.json"))?.hash === f1.hash && manifestOf(r1).hash === f1.hash && !existsSync(`${r1}.next`), `freeze under the lock: ${locked?.message ?? "not refused"}`);
// A failure part way (the last case's image gone, after the first cases are written): the last R1 stays whole.
await post("/api/verdict", { key: key(LIVE, 3), verdict: "reject" });
const qImg = join(Q.dir, "img", img(Q)[key(Q1, 2)].before);
renameSync(qImg, `${qImg}.away`);
let broke;
try {
  R.freezeReal();
} catch (e) {
  broke = e;
}
check(broke && maybe(join(r1, "manifest.json"))?.hash === f1.hash && manifestOf(r1).hash === f1.hash && js(r1ids()) === js([id1, id3, idQ2].sort()), `a freeze that failed part way (${broke?.message?.split("\n")[0] ?? "it didn't fail"}) changed R1`);
check(existsSync(join(`${r1}.next`, id1, "case.json")), "the failed freeze hadn't got part way (nothing was built aside)");
renameSync(`${qImg}.away`, qImg);
const f2 = R.freezeReal();
check(f2.cases === 2 && !r1ids().includes(id3) && f2.hash !== f1.hash && !existsSync(`${r1}.next`), `the freeze after a rejection: ${js(f2)}, R1 ${r1ids().join(", ")}`);
await post("/api/verdict", { key: key(LIVE, 3), verdict: "approve" });
const f3 = R.freezeReal();
check(f3.hash === f1.hash && f3.cases === 3, `the same accepted gold froze to another hash (${f3.hash.slice(0, 12)} vs ${f1.hash.slice(0, 12)})`);

// ===== 6. realShadow's scoring on a fake rig (no Chrome): each arm's result is a board this check picks.
// Arm A: gold's board everywhere. Arm B: the app's boxy duck on L#1 (fails both checks), gold's board on L#3 (passes),
// and the pond case has no checks: it must count neither as passing nor failing.
const goldScene = (k) => json(join(gDir(k), "gold.scene.json"));
const results = { [id1]: { A: goldScene(key(LIVE, 1)), B: B1 }, [id3]: { A: goldScene(key(LIVE, 3)), B: goldScene(key(LIVE, 3)) }, [idQ2]: { A: goldScene(key(Q1, 2)), B: B5 } };
const unexpected = [];
function fakeRig(gateway) {
  const tabs = new Map();
  const open = (slot, arm) => {
    const page = {
      labels: { run: "-", case: "-", arm, slot },
      async send(method) {
        return method === "Page.captureScreenshot" ? { data: JPEG.toString("base64") } : {};
      },
      async goto() {}, async reload() {}, on() {}, async close() {},
      async eval(expr) {
        if (expr.includes("window.rtEval ? r()")) return undefined;
        if (expr === "performance.timeOrigin") return 1_000_000;
        if (expr.startsWith("rtEval.load(")) return { sceneHash: "same-board" };
        if (expr.startsWith("rtEval.send(")) {
          const after = results[page.labels.case]?.[arm] ?? B0;
          return { ops: [{ line: "shape(x)", ok: true, ms: 10 }], reply: "shape(x)", camera: CAM, after, timing: { enterAt: 100, ttfcMs: 300, ttfdMs: 350, ttdMs: 900, renders: 3, longTasksMs: 0, heapMb: 40 }, spans: [] };
        }
        if (expr.startsWith("rtEval.engine(")) return { applyMs: 2, paintMs: 3, ops: 1, applied: 1, board: "b", other: { applyMs: 2, paintMs: 3, ops: 1, applied: 1, board: "b" } };
        if (expr.startsWith("rtEval.setView(")) return undefined;
        if (expr.includes("getBoundingClientRect()") && expr.startsWith("(({ x, y, width, height })")) return { x: 0, y: 0, width: 1280, height: 800 };
        if (expr.includes("querySelectorAll")) return false;
        if (expr.startsWith("crypto.subtle.digest")) return `svg-${page.labels.case}-${arm}`;
        unexpected.push(expr.slice(0, 80));
        return undefined;
      },
    };
    return { page, errors: [] };
  };
  return {
    gateway, slots: 1, blocked: [],
    async tab(slot, arm) {
      const k = `${slot}|${arm}`;
      if (!tabs.has(k)) tabs.set(k, open(slot, arm));
      return tabs.get(k);
    },
    async close() {},
  };
}
/** A judge that always prefers B, written the way judge.ts writes a verdict. */
const preferB = (run) => ({
  async judgeCase(id, positions) {
    put(join(caseDir(run, id), "judge", "fidelity-1.json"), { winner: positions.left === "B" ? "left" : "right", confidence: 3, why: "canned", positions, judgeId: "canned" });
  },
  flips: () => ({ audited: 0, flipped: 0 }),
});
// The load gate waits for a quiet machine so timings compare; a fake rig times nothing, and other checks may be running.
const gate = { loadMax: LOOP.loadMax, psiMax: LOOP.psiMax };
Object.assign(LOOP, { loadMax: Infinity, psiMax: Infinity });
const RUN = "real-shadow-t23";
const arm = { sha: "fake", tree: "fake-tree" };
const sh = await SH.realShadow(fakeRig(gw.url), { run: RUN, arms: { A: arm, B: arm }, seed: "t23", judge: preferB(RUN) });
Object.assign(LOOP, gate);
check(sh && sh.cases === 3 && sh.void === 0 && sh.lost === 0 && sh.hash === f1.hash, `realShadow's run: ${js(sh)} (want 3 cases, none void or lost)`);
check(sh && js(sh.casesPassing) === js([1, 0.5]) && js(sh.checks) === js([1, 0.5]), `realShadow's scores: casesPassing ${js(sh?.casesPassing)}, checks ${js(sh?.checks)} (want [1, 0.5] each: a case with no checks counts for neither arm)`);
check(sh && sh.share === 1 && sh.shareHold === 1, `realShadow's judge share: ${sh?.share}, R-hold ${sh?.shareHold}`);
for (const [id, k] of [[id1, key(LIVE, 1)], [id3, key(LIVE, 3)], [idQ2, key(Q1, 2)]]) {
  const e = json(join(caseDir(RUN, id), "expectation.json"));
  const g = R.goldOf(k).gold.rubric;
  check(e.judgeId === RUBRIC && js(e.should) === js(g.should) && js(e.mustNot) === js(g.mustNot), `${id}'s expectation.json isn't gold's whole rubric: ${js(e)}`);
}
check(existsSync(runFile(RUN, "real.json")) && runFile(RUN, "real.json").startsWith(join(p.real, "runs")) && !existsSync(join(p.home, "runs", RUN)), `real.json isn't under real/runs: ${runFile(RUN, "real.json")}`);
check(!unexpected.length, `the fake rig's page was asked what it doesn't answer: ${js(unexpected)}`);

// ---- Privacy: testers' words, project names and emails stay under real/ (runs/, cache/, the meter and history are shown or
// exported; the Claude processes' config dir is scanned too).
const leaks = [];
const SECRETS = ["Synthetic zoo", "tess@example.test", "draw a cat next to the duck", "the duck is just boxes", "rubber duck"];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (full !== p.real && f !== ".git") walk(full);
    } else if (st.size < 5_000_000) {
      const text = readFileSync(full, "latin1");
      for (const s of SECRETS) if (text.includes(s)) leaks.push(`${full.slice(p.home.length + 1)}: ${s}`);
    }
  }
};
walk(p.home);
check(!leaks.length, `testers' data outside real/: ${leaks.slice(0, 5).join("; ")}`);
check(product.calls.every((c) => String(c.model).startsWith("jev")) && (await gatewayStatus(gw.url)).calls === reqs().length, "a model call left the fakes");

await gw.close();
await api.close();
rmSync(work, { recursive: true, force: true });
console.error(`t23: ${((Date.now() - started) / 1000).toFixed(1)} s, ${reqs().length} fake API calls, R1 ${f1.hash.slice(0, 12)}`);
finish();
