// T23's acceptance check: intake (evals/real/README.md) end to end on synthetic sessions. Pulls' snapshots → ingest
// (stable send keys) → splits (stored, never moved) → triage of new sends only and gold, through the gateway to the fake
// API → intake's pass on a fake rig (no Chrome): images, proposals as bank cases with their before images, drafted
// expectations and the champion's replay → the owner's verdicts and edits through Eval HQ's review data (review.ts) →
// admission after the look window → R1, and R1's scoring in realShadow. Canned replies are keyed by TRIAGE_SYSTEM's,
// GOLD_SYSTEM()'s and the judge's sha; the product's prompt builder runs in this process with its /api/model answered
// here. 0 real calls: fake tokens, HTTPS_PROXY at a closed port (the gateway's mockApi), the fake API's request count
// must equal the gateway's call count, and this process's fetch reaches nothing but loopback. No tester's data: every
// session here is invented.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t23-real.mjs
// Ports 5640–5641.
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
const C = await import("../real/cases.ts");
const V = await import("../real/review.ts");
const G = await import("../real/gold.ts");
const P = await import("../real/prompts.ts");
const SH = await import("../real/shadow.ts");
const { intake } = await import("../real/intake.ts");
const { buildPrompt } = await import("../../src/core/draw.ts");
const { DEFAULTS, tune } = await import("../../src/core/tuning.ts");
const { PROMPTS, DRAW_ADD } = await import("../../src/core/prompts.ts");
const { Scene } = await import("../../src/core/scene.ts");
const { runScript } = await import("../../src/core/ops.ts");
const { paths } = await import("../loop/paths.ts");
const { caseDir, runFile } = await import("../loop/record.ts");
const { RUBRIC, OWNER, expectationFor } = await import("../judge/judge.ts");
const { SYSTEM: JUDGE_SYSTEM } = await import("../judge/prompts.ts");
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

// ===== 1. The prompt round trip: sessions.ts reads back what the product's prompt builder writes today.
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

// ===== 2. Ingest: a pull's snapshots (live: the box's /data; local: the laptop's .data) become sessions, each send
// keyed by its send-log id or the version it saved, so a later pull never moves a key.
const T0 = Date.parse("2026-10-23T10:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const snap = (src, stamp) => join(p.real, "raw", src, stamp);
const latest = (src, stamp) => put(join(p.real, "raw", src, "latest"), `${stamp}\n`);
const SVG3 = ['<circle cx="50" cy="50" r="40" fill="#ffd43b"/>', '<path d="M10 10 L90 90"/>', '<rect x="5" y="5" width="10" height="10"/>'].join("\n");
const P1 = await drawPrompt(B0, [], "add a duck", CAM);
const P2 = await drawPrompt(B1, [tap(1, 400, 360, 1000)], "make this bigger", CAM2, { yes: ["duck-body"] });
const P2zed = await drawPrompt(B1, [], "make this bigger", CAM);
const W3 = W("draw a cat next to the duck");
const K3 = { id: 7, points: [[760, 320, 900], [800, 330, 960], [840, 320, 1020]], t0: 900, t1: 1020 };
const PEOPLE = [{ id: "u-tess", email: "tess@example.test", owner: "own-tess" }, { id: "u-zed", email: "zed@example.test", owner: "own-zed" }, { id: "u-kit", email: "kit@example.test", owner: "own-kit" }];
const TESS_SENDS = [
  { id: "s3", project: "p1", at: at(110), label: "draw a cat next to the duck", spoken: true, kind: "send", camera: CAM, words: W3, strokes: [K3], enterAtMs: 2400, before: B1n, beforeVersion: 3, afterVersion: 4, status: "done", landed: 2 },
  { id: "s4", project: "p1", at: at(150), label: "zoom out", spoken: false, kind: "send", camera: CAM, words: "zoom out", strokes: [], enterAtMs: 0, before: B4, beforeVersion: 4, afterVersion: 4, status: "done", landed: 0 },
];
/** The box's /data at a pull: tess's project (and kit's, from the second pull). */
function liveSnapshot(dir, o = {}) {
  put(join(dir, "access", "access.json"), { people: PEOPLE });
  lines(join(dir, "access", "feedback.jsonl"), [
    { at: T0 + 200_000, person: "u-tess", text: "the duck is just boxes", project: { id: "p1", version: 1 } },
    { at: T0 + 201_000, person: "u-tess", text: "another project", project: { id: "p9" } },
    { at: T0 + 202_000, person: "u-zed", text: "not their project", project: { id: "p1" } },
  ]);
  put(join(dir, "app", "owners", "own-tess", "index.json"), [{ id: "p1", name: "Synthetic zoo" }, { id: "p-empty", name: "Nothing yet" }]);
  lines(join(dir, "app", "owners", "own-tess", "p1.ndjson"), [
    { n: 2, doc: B2, at: T0 + 60_000, label: "make this bigger" },
    { n: 1, doc: B1, at: T0 + 20_000, label: "add a duck" },
    "not json: a torn last write",
    { n: 3, doc: B1, at: T0 + 80_000, label: "Restored V1" },
    { n: 4, doc: B4, at: T0 + 115_000, label: "draw a cat next to the duck" },
  ]);
  lines(join(dir, "app", "sends", "own-tess", "p1.ndjson"), [...TESS_SENDS, ...(o.tessMore ?? [])]);
  const calls = [
    { at: at(18), from: "draw", who: "u-tess", ms: 3000, user: P1, reply: DUCK },
    // Every picture prompt variant the product has: sessions.ts reads each one's subject and box.
    ...PROMPTS.picture.map((v, i) => ({ at: at(18.5 + i * 0.1), from: "picture", who: "u-tess", ms: 900, user: v.user(`yellow duck ${i}`, 200 + i, 160 + i, DEFAULTS), reply: SVG3 })),
    { at: at(18.9), from: "picture", who: "u-zed", ms: 900, user: PROMPTS.picture[0].user("someone else's cat", 90, 90, DEFAULTS), reply: SVG3 },
    { at: at(57), from: "resolve", who: "u-tess", ms: 300, user: "which shape", reply: "{}" },
    { at: at(58), from: "draw", who: "u-tess", ms: 4000, user: P2, reply: "shape(duck-body, 260 280 280 170)" },
    // Another person's call for the same words, later: live sessions take only their person's calls.
    { at: at(59), from: "draw", who: "u-zed", ms: 2000, user: P2zed, reply: "shape(duck-body, 0 0 10 10)" },
  ];
  if (o.kit) {
    put(join(dir, "app", "owners", "own-kit", "index.json"), [{ id: "t1", name: "Kit's garden" }]);
    lines(join(dir, "app", "owners", "own-kit", "t1.ndjson"), [{ n: 1, doc: B6, at: T0 + 600_000, label: "draw a tree" }]);
    lines(join(dir, "app", "sends", "own-kit", "t1.ndjson"), [
      { id: "k1", project: "t1", at: at(598), label: "draw a tree", spoken: false, kind: "send", camera: CAM, words: "draw a tree", strokes: [], enterAtMs: 0, before: B0, beforeVersion: 0, afterVersion: 1, status: "done", landed: 1 },
      { id: "k2", project: "t1", at: at(640), label: "zoom in", spoken: false, kind: "send", camera: CAM, words: "zoom in", strokes: [], enterAtMs: 0, before: B6, beforeVersion: 1, afterVersion: 1, status: "done", landed: 0 },
    ]);
  }
  lines(join(dir, "model-calls.jsonl"), calls);
}
const B6 = board(B0, `shape(tree-box, rect, 500 300 120 200, "a green box for the tree", fill:#b2f2bb)`);
liveSnapshot(snap("live", "20261024T120000Z"));
latest("live", "20261024T120000Z");
{
  const local = snap("local", "20261024T120000Z");
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
  latest("local", "20261024T120000Z");
}
const LIVE = `live-${sha("live:own-tess").slice(0, 8)}-p1`;
const KIT = `live-${sha("live:own-kit").slice(0, 8)}-t1`;
const Q1 = `local-${sha("local:own-me").slice(0, 8)}-q1`;
const Q0 = `local-${sha("local:own-me").slice(0, 8)}-q0`;
const TESS = `p-${sha("own-tess").slice(0, 8)}`, KITP = `p-${sha("own-kit").slice(0, 8)}`;
const k = (sid, send) => `${sid}#${send}`;
const said = R.ingestAll();
check(js(said) === js([{ source: "live", sessions: 1, sends: 4 }, { source: "local", sessions: 2, sends: 3 }]), `ingest said: ${js(said)}`);
const sessionsNow = () => Object.fromEntries(R.readSessions().map((x) => [x.s.id, x]));
let ss = sessionsNow();
check(js(Object.keys(ss).sort()) === js([LIVE, Q0, Q1].sort()), `ingest made sessions ${Object.keys(ss).join(", ")} (want ${LIVE}, ${Q0}, ${Q1}; a project with no versions and no sends is none)`);
let L = ss[LIVE], Q = ss[Q1];
if (!L || !Q) fail("ingest didn't make the synthetic sessions");
{
  const x = L.s.sends;
  check(js(x.map((y) => y.key)) === js([k(LIVE, "v1"), k(LIVE, "v2"), k(LIVE, "s3"), k(LIVE, "s4")]), `live keys: ${x.map((y) => y.key).join(", ")} (want the version a rebuilt send saved, a logged send's own id)`);
  check(js(x.map((y) => y.replay)) === js(["typed", "ink", "exact", "exact"]), `live replay modes: ${x.map((y) => y.replay).join(", ")} (want typed, ink, exact, exact)`);
  check(L.s.person === TESS && L.s.admin === false && L.s.source === "live" && L.s.project.name === "Synthetic zoo", `live session's person/admin/source: ${js({ person: L.s.person, admin: L.s.admin })}`);
  check(L.s.restores.length === 1 && L.s.restores[0].version === 3 && L.s.feedback.length === 1 && L.s.feedback[0].text === "the duck is just boxes" && L.s.feedback[0].version === 1,
    `restores ${js(L.s.restores)}, feedback ${js(L.s.feedback)} (want one restore, and only this person's feedback on this project)`);
  const want1 = PROMPTS.picture.map((_, i) => ({ subject: `yellow duck ${i}`, w: 200 + i, h: 160 + i, elements: 3 }));
  check(x[0].words === "add a duck" && js(x[0].camera) === js(CAM) && x[0].before === 0 && x[0].after === 1 && x[0].reply === DUCK && x[0].at === at(15),
    `send 1 (rebuilt, typed): ${js({ words: x[0].words, camera: x[0].camera, before: x[0].before, after: x[0].after, at: x[0].at })}`);
  check(js(x[0].pictures) === js(want1), `send 1's pictures (one per picture prompt variant, no one else's): ${js(x[0].pictures)}`);
  check(x[1].words === "make this [ink 1] bigger" && js(x[1].marks) === js(["[ink 1] tap on duck-body"]) && x[1].refs === "duck-body" && js(x[1].camera) === js(CAM2) && x[1].strokes.length === 0,
    `send 2 (rebuilt, ink): ${js({ words: x[1].words, marks: x[1].marks, refs: x[1].refs, camera: x[1].camera })}`);
  check(js(x[2].words) === js(W3) && js(x[2].strokes) === js([K3]) && x[2].enterAtMs === 2400 && x[2].before === 3 && x[2].after === 4 && x[2].label === "draw a cat next to the duck",
    `send 3 (exact): ${js({ before: x[2].before, after: x[2].after, enterAtMs: x[2].enterAtMs })}`);
  check(S.beforeOf(L.dir, x[2]).shapes.some((s) => s.id === "note-1") && !json(join(L.dir, "v3.json")).shapes.some((s) => s.id === "note-1"), "a logged send's before isn't its own board (before-<send id>.json)");
  check(x[3].before === 4 && x[3].after === 4 && x[3].words === "zoom out" && x[3].status === "done", `send 4 (exact, nothing landed): ${js({ before: x[3].before, after: x[3].after })}`);
  check(["v0.json", "v1.json", "v2.json", "v3.json", "v4.json", "before-s3.json", "before-s4.json", "session.json"].every((f) => existsSync(join(L.dir, f))), `the live session's files: ${readdirSync(L.dir).join(", ")}`);
  check(!readFileSync(join(L.dir, "session.json"), "utf8").includes("@example.test"), "session.json carries an email");
  check(Q.s.admin === true && Q.s.sends.length === 2 && Q.s.sends.every((y) => y.replay === "typed") && js(Q.s.sends.map((y) => y.key)) === js([k(Q1, "v1"), k(Q1, "v2")]),
    `local session: admin ${Q.s.admin}, sends ${js(Q.s.sends.map((y) => [y.replay, y.key]))}`);
  check(ss[Q0]?.s.sends[0]?.words === "say hello" && ss[Q0].s.sends[0].replay === "typed" && ss[Q0].s.sends[0].camera === undefined, "a version with no drawing call isn't rebuilt from its label");
  check(js(R.chosen().map((c) => c.s.id)) === js([LIVE, Q1]), `chosen: ${R.chosen().map((c) => c.s.id).join(", ")} (a local session before ${R.REAL_SINCE} is left out)`);
  // An old positional before file, and the same snapshot again: the files a session no longer has go, nothing else moves.
  writeFileSync(join(L.dir, "before-3.json"), "{}");
  R.ingestAll();
  check(!existsSync(join(L.dir, "before-3.json")) && existsSync(join(L.dir, "before-s3.json")) && js(sessionsNow()[LIVE].s) === js(L.s), "ingesting the same snapshot again changed the session, or kept a before file no send has");
}

// ---- What ingest must not get wrong with the loop's knobs off, on a snapshot of its own (its own out dir): ink with
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
  put(join(raw2, "access", "access.json"), { people: [{ id: "u-kat", email: "kat@example.test", owner: "own-kat" }] });
  put(join(raw2, "app", "owners", "own-kat", "index.json"), [{ id: "k1", name: "Knobs off" }]);
  lines(join(raw2, "app", "owners", "own-kat", "k1.ndjson"), [
    { n: 1, doc: B1, at: T0 + 20_000, label: "add a duck" },
    { n: 2, doc: B2, at: T0 + 60_000, label: "make this bigger" },
    { n: 3, doc: B4, at: T0 + 120_000, label: "draw a cat next to the duck" },
  ]);
  // From version 2: a stopped send on the board as saved, then (after a hand edit adding a note) the send that landed.
  lines(join(raw2, "app", "sends", "own-kat", "k1.ndjson"), [
    { id: "k-stop", project: "k1", at: at(100), label: "draw a cat", spoken: false, kind: "send", camera: CAM, words: "draw a cat", strokes: [], enterAtMs: 0, before: B2, beforeVersion: 2, afterVersion: 2, status: "stopped", landed: 0 },
    { id: "k-cat", project: "k1", at: at(110), label: "draw a cat next to the duck", spoken: false, kind: "send", camera: CAM, words: "draw a cat next to the duck", strokes: [], enterAtMs: 0, before: B1n, beforeVersion: 2, afterVersion: 3, status: "done", landed: 2 },
  ]);
  lines(join(raw2, "model-calls.jsonl"), [
    { at: at(18), from: "draw", who: "u-kat", ms: 3000, user: P1, reply: DUCK },
    { at: at(58), from: "draw", who: "u-kat", ms: 4000, user: noMarks, reply: "shape(duck-body, 260 280 280 170)" },
  ]);
  const [kk] = S.ingest(raw2, "live", out2);
  const x = kk?.sends ?? [];
  const dir2 = join(out2, kk?.id ?? "none");
  check(js(x.map((y) => [y.replay, y.status ?? ""])) === js([["typed", ""], ["ink", ""], ["exact", "stopped"], ["exact", "done"]]) && /\[ink 1\]/.test(x[1]?.words ?? ""),
    `ingest with draw.sendMarks off: ${js(x.map((y) => [y.replay, y.words]))} (want send 2 "ink": its ink shows only as [ink 1])`);
  check(x.length === 4 && x[2].key.endsWith("#k-stop") && x[3].key.endsWith("#k-cat") && !S.beforeOf(dir2, x[2]).shapes.some((s) => s.id === "note-1") && S.beforeOf(dir2, x[3]).shapes.some((s) => s.id === "note-1"),
    "two logged sends from one version don't each keep their own before board");
}

// ===== 3. Splits: stored once per person and never moved. tess was placed before (as R1 had her); the owner tunes.
put(join(p.real, "splits.json"), { [TESS]: "tune" });
check(js(C.assignSplits()) === js(["owner"]) && js(C.splits()) === js({ [TESS]: "tune", owner: "tune" }), `splits after the first pull: ${js(C.splits())} (want the owner placed, tess as stored)`);

// ===== 4. Labeling: images (stubbed), triage of the sends that can become cases, and gold, through the gateway.
let shots = 0;
const stubShot = async () => (shots++, JPEG);
const made = (await R.renderSession(L, stubShot)) + (await R.renderSession(Q, stubShot));
const img = (x) => json(join(x.dir, "img", "index.json"));
check(made > 0 && made === shots && L.s.sends.every((y) => img(L)[y.key]?.before && img(L)[y.key]?.after) && Q.s.sends.every((y) => img(Q)[y.key]) && R.rendered(L), `render (stubbed) made ${made} images, index ${js(Object.keys(img(L)))}`);
check((await R.renderSession(L, stubShot)) === 0, "a second render shot again what it had");

const state = () => Object.fromEntries(C.cards().map((c) => [c.key, c.skip ? `skipped: ${c.skip}` : c.state]));
{
  const s0 = state();
  check(s0[k(LIVE, "v2")] === "skipped: its ink was lost (sent before the send log)" && s0[k(Q1, "v1")] === "skipped: a repeat of an earlier send" && [k(LIVE, "v1"), k(LIVE, "s3"), k(LIVE, "s4"), k(Q1, "v2")].every((x) => s0[x] === "pulled") && !(k(Q0, "v1") in s0),
    `cards before triage: ${js(s0)} (want the ink-lost send and the owner's repeat of tess's first send skipped, the rest pulled)`);
}
const fence = (o) => `Here is my read.\n\`\`\`json\n${js(o)}\n\`\`\``;
const TRIAGE = [
  // tess's session: sends 1, 3 and 4 (send 2's ink is lost: it can't become a case, so triage isn't asked).
  fence({ sends: [
    { n: 1, meant: "one yellow duck", landed: "no", categories: ["boxy-subject"], evidence: "built from a round, a circle and a box", gold: true },
    { n: 3, meant: "a cat beside the duck", landed: "no", categories: ["boxy-subject"], evidence: "two grey boxes", gold: true },
    { n: 4, meant: "see the whole board", landed: "yes", categories: [], evidence: "it zoomed out", gold: true },
  ] }),
  // The owner's session: send 2 only (send 1 repeats tess's).
  js({ sends: [{ n: 2, meant: "a pond under the duck", landed: "maybe", categories: ["squashed-picture"], evidence: "a flat box", gold: true }] }),
  // The second pull: kit's session.
  js({ sends: [
    { n: 1, meant: "a tree", landed: "no", categories: ["boxy-subject"], evidence: "a green box", gold: true },
    { n: 2, meant: "a closer look", landed: "yes", categories: [], evidence: "it zoomed in", gold: false },
  ] }),
  // The third pull: tess's new send only.
  js({ sends: [{ n: 5, meant: "the cat a little smaller", landed: "yes", categories: [], evidence: "it shrank", gold: false }] }),
];
const pic = (els) => els.join("\n");
const goldReply = ({ ops, pictures = {}, rubric, checks, why = "They meant it. This does it." }) =>
  [`<ops>\n${ops.join("\n")}\n</ops>`, ...Object.entries(pictures).map(([id, els]) => `<picture id="${id}">\n${pic(els)}\n</picture>`), `<rubric>${js(rubric)}</rubric>`, `<checks>${js(checks)}</checks>`, `<why>${why}</why>`].join("\n");
const DUCK_PIC = ['<ellipse cx="150" cy="170" rx="130" ry="70" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>', '<circle cx="240" cy="80" r="50" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>', '<path d="M285 80 L315 90 L285 100 Z" fill="#f08c00" stroke="#1e1e1e" stroke-width="2"/>', '<circle cx="250" cy="70" r="6" fill="#1e1e1e"/>'];
const TREE_PIC = ['<rect x="90" y="120" width="20" height="80" fill="#8d5524"/>', '<circle cx="100" cy="80" r="60" fill="#40c057" stroke="#1e1e1e" stroke-width="3"/>'];
const L1_RUBRIC = { should: ["one duck that reads as a rubber duck", "the duck is yellow", "the duck sits on the Home page"], mustNot: ["a duck built from separate boxes and circles", "red ink colors in the drawing"] };
const GOLD = [
  // tess #v1: one drawing; a text() for a shape that isn't there and a picture with no drawing() are problems; camera() is
  // not. Of its checks, a malformed one and a bad color are dropped on reading, and page-filled (gold fails it) by ownChecks.
  goldReply({
    ops: [`shape(duck, rect, 380 240 320 260, "one yellow rubber duck drawn as a single picture", fill:none, stroke:none)`, `drawing(duck, "a yellow rubber duck")`, `text(ghost, "nobody")`, "camera(0 0 1280 800)"],
    pictures: { duck: DUCK_PIC, ghost: ['<circle cx="5" cy="5" r="4" fill="#000"/>'] }, rubric: L1_RUBRIC,
    checks: [{ type: "single-picture", words: ["duck"] }, { type: "no-parts", words: ["duck"] }, { type: "page-filled", page: "page", min: 5 }, { type: "bogus" }, { type: "no-color", color: "red" }],
  }),
  // tess #s3, first try: unreadable.
  "I couldn't work out what to draw here.",
  // The owner's #v2.
  goldReply({ ops: ["remove(pond-box)", `shape(pond, round, 260 440 360 110, "a calm blue pond under the duck", fill:#a5d8ff)`], rubric: { should: ["a blue pond under the duck"], mustNot: ["the duck moves"] }, checks: [] }),
  // tess #s3, the retry.
  goldReply({ ops: [`shape(cat, rect, 680 230 240 220, "a grey cat sitting next to the duck, one picture", fill:none, stroke:none)`, `drawing(cat, "a grey cat sitting")`],
    pictures: { cat: ['<ellipse cx="120" cy="150" rx="90" ry="60" fill="#ced4da" stroke="#1e1e1e" stroke-width="3"/>', '<circle cx="120" cy="70" r="45" fill="#ced4da" stroke="#1e1e1e" stroke-width="3"/>', '<path d="M90 40 L100 10 L110 35 M130 35 L140 10 L150 40" stroke="#1e1e1e" fill="none"/>'] },
    rubric: { should: ["a cat that reads as a cat next to the duck"], mustNot: ["the cat built from boxes"] }, checks: [{ type: "single-picture", words: ["cat"] }, { type: "no-color", color: "#e03131" }] }),
  // kit #k1, in the second pull's intake.
  goldReply({ ops: [`shape(tree, rect, 480 260 200 260, "one green tree drawn as a single picture", fill:none, stroke:none)`, `drawing(tree, "a leafy green tree")`], pictures: { tree: TREE_PIC },
    rubric: { should: ["one tree that reads as a tree"], mustNot: ["a tree built from boxes"] }, checks: [{ type: "single-picture", words: ["tree"] }] }),
  // kit #k1 redrawn (--regold).
  goldReply({ ops: [`shape(tree, rect, 460 240 240 300, "one tall green tree drawn as a single picture", fill:none, stroke:none)`, `drawing(tree, "a tall leafy tree")`], pictures: { tree: TREE_PIC },
    rubric: { should: ["one tall tree that reads as a tree", "the tree is green"], mustNot: ["a tree built from boxes"] }, checks: [{ type: "single-picture", words: ["tree"] }] }),
];
const replies = join(work, "replies");
mkdirSync(replies);
writeFileSync(join(replies, `real-triage.${sha12(P.TRIAGE_SYSTEM)}.json`), js(TRIAGE));
writeFileSync(join(replies, `real-gold.${sha12(P.GOLD_SYSTEM())}.json`), js(GOLD));
// The expectation judge, for a case gold drew nothing for.
writeFileSync(join(replies, `judge.${sha12(JUDGE_SYSTEM)}.txt`), js({ should: ["the board shows what they asked for"], mustNot: ["the rest of the board changes"] }));
const api = await startFakeApi({ port: 5641, replies });
const tokens = join(work, "tokens.env");
writeFileSync(tokens, [1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-fake-t23-${n}-${randomBytes(6).toString("hex")}`).join("\n") + "\n");
chmodSync(tokens, 0o600);
const gw = await spawnGateway({ home, port: 5640, tokens, mockApi: api.url });
const reqs = () => api.requests.filter((r) => r.path.endsWith("/v1/messages"));
let gated = 0;
const gate = async () => void gated++;
const pulledKeys = (sid) => C.cards().filter((c) => c.state === "pulled" && c.ss.s.id === sid).map((c) => c.key);

// ---- Triage: the sends that can become cases, each judged once.
check((await R.triageSession(L, pulledKeys(LIVE), "real-triage-t23", gate)) === 3 && gated === 1, "triage of tess's session didn't judge its 3 sends in one call behind the gate");
const rowsOf = (dir) => json(join(dir, "triage.json")).sends;
{
  const tr = rowsOf(L.dir);
  check(js(tr.map((r) => [r.key, r.landed, r.gold])) === js([[k(LIVE, "v1"), "no", true], [k(LIVE, "s3"), "no", true], [k(LIVE, "s4"), "yes", false]]) && tr.every((r) => r.prompt === sha12(P.TRIAGE_SYSTEM) && r.at) && tr[0].meant === "one yellow duck",
    `triage.json: ${js(tr.map((r) => [r.key, r.landed, r.gold]))} (rows by key; a send that landed gets no gold)`);
  const r0 = reqs()[0];
  check(reqs().length === 1 && r0.role === "real-triage" && r0.images === 6 && /opus/.test(r0.model) && r0.effort === "high" && r0.firstUser.includes(`Session ${LIVE}`) && r0.firstUser.includes("Judge sends 1, 3 to 4 only") && !r0.firstUser.includes("@example.test"),
    `the triage request: ${js({ n: reqs().length, role: r0?.role, images: r0?.images, model: r0?.model, effort: r0?.effort })}`);
  check((await R.triageSession(L, pulledKeys(LIVE), "real-triage-t23b", gate)) === 0 && reqs().length === 1, "a triaged send was asked again");
}
check((await R.triageSession(Q, pulledKeys(Q1), "real-triage-t23", gate)) === 1 && rowsOf(Q.dir)[0].key === k(Q1, "v2") && rowsOf(Q.dir)[0].landed === "no", `the owner's triage: ${js(rowsOf(Q.dir))} (one send; an unknown landed reads as no)`);

// ---- Gold: every miss triage marked, never an ink-lost send; an unreadable one is drawn again once.
const want = (o) => R.wantGold(o).map((c) => c.x.key);
check(js(want()) === js([k(LIVE, "v1"), k(LIVE, "s3"), k(Q1, "v2")]), `wantGold before any gold: ${want().join(", ")}`);
const goldRun = async (run, o) => {
  const out = [];
  for (const c of R.wantGold(o)) out.push(await R.goldSend(c, run, gate));
  return out;
};
const g1 = await goldRun("real-gold-t23-1");
const gDir = (key) => join(p.real, "gold", key.replace("#", "-"));
const gl1 = R.goldOf(k(LIVE, "v1"));
{
  check(gl1 && !gl1.error && gl1.attempts === 1 && gl1.prompt === sha12(P.GOLD_SYSTEM()) && gl1.meant === "one yellow duck" && existsSync(join(gDir(k(LIVE, "v1")), "reply.txt")) && !("n" in gl1) && !("batch" in gl1),
    `gold.json for ${k(LIVE, "v1")}: ${js({ error: gl1?.error, attempts: gl1?.attempts })}`);
  check(js(gl1.gold.checks) === js([{ type: "single-picture", words: ["duck"] }, { type: "no-parts", words: ["duck"] }]) && gl1.problems.some((q) => /^check left out, gold fails it: .*page-filled/.test(q)),
    `gold's own failing check isn't dropped (checks ${js(gl1.gold.checks)}, problems ${js(gl1.problems)})`);
  check(gl1.problems.some((q) => /^text\(ghost/.test(q)) && gl1.problems.some((q) => /picture for ghost, which has no drawing/.test(q)) && !gl1.problems.some((q) => /camera\(/.test(q)), `gold's problems: ${js(gl1.problems)}`);
  const scene = json(join(gDir(k(LIVE, "v1")), "gold.scene.json"));
  const duck = scene.shapes.find((s) => s.id === "duck");
  check(duck?.picture?.done && duck.picture.els.length === 4 && duck.picture.subject === "a yellow rubber duck" && scene.shapes.length === B0.shapes.length + 1, `applyGold's board: ${js(duck?.picture?.els?.length)} picture elements, ${scene.shapes.length} shapes`);
  check(gl1.appChecks.length === 2 && gl1.appChecks.every((r) => !r.pass) && gl1.goldChecks.every((r) => r.pass), `free checks on the app's result ${js(gl1.appChecks.map((r) => r.pass))} and on gold ${js(gl1.goldChecks.map((r) => r.pass))}`);
  const gr = reqs().filter((r) => r.role === "real-gold");
  check(gr.length === 3 && gr[0].images === 2 && /opus/.test(gr[0].model) && gr[0].effort === "high" && gr[0].firstUser.includes("What they meant: one yellow duck") && gr[0].firstUser.includes(G.boardOps(B0)),
    `the gold requests: ${gr.length}, first ${js({ images: gr[0]?.images, model: gr[0]?.model })}`);
  const gl3 = R.goldOf(k(LIVE, "s3"));
  check(g1.length === 3 && gl3?.error === "no <ops>" && !gl3.gold && gl3.attempts === 1, `an unreadable gold reply: ${js(gl3)}`);
}
check(js(want()) === js([k(LIVE, "s3")]), `wantGold after the first run: ${want().join(", ")} (want only the unreadable one)`);
await goldRun("real-gold-t23-2");
{
  const gl3 = R.goldOf(k(LIVE, "s3"));
  check(gl3.gold && !gl3.error && gl3.attempts === 2 && gl3.goldChecks.every((r) => r.pass) && gl3.appChecks.map((r) => r.pass).join() === "false,true" && json(join(gDir(k(LIVE, "s3")), "gold.scene.json")).shapes.some((s) => s.id === "note-1"),
    `the retried gold: ${js({ attempts: gl3.attempts, error: gl3.error, app: gl3.appChecks?.map((r) => r.pass) })} (built on the send's own before board)`);
}
check(want().length === 0 && js(want({ regold: true })) === js([k(LIVE, "v1"), k(LIVE, "s3"), k(Q1, "v2")]), `wantGold with every miss drawn: ${want().join(", ")}; --regold: ${want({ regold: true }).join(", ")}`);
{
  const before = shots;
  check((await R.shootGold(stubShot)) === 3 && shots - before === 3 && existsSync(join(gDir(k(LIVE, "v1")), "gold.jpg")), "shootGold didn't shoot each gold board once");
  const g = readFileSync(join(gDir(k(LIVE, "v1")), "gold.json"), "utf8");
  check(R.rebuildGold() === 0 && readFileSync(join(gDir(k(LIVE, "v1")), "gold.json"), "utf8") === g && existsSync(join(gDir(k(LIVE, "v1")), "gold.jpg")), "rebuildGold rewrote a gold case gold.ts builds the same");
  const f = join(gDir(k(LIVE, "v1")), "gold.scene.json");
  writeFileSync(f, js(B0));
  check(R.rebuildGold() === 1 && !existsSync(join(gDir(k(LIVE, "v1")), "gold.jpg")) && json(f).shapes.some((s) => s.id === "duck"), "rebuildGold didn't rebuild a changed board and drop its image");
  await R.shootGold(stubShot);
}
check(Object.values(state()).filter((x) => x === "labeled").length === 4, `cards after labeling: ${js(state())} (want 4 labeled, waiting for their proposal)`);

// ===== 5. Intake's pass on a fake rig: proposals (bank cases), their before images, a drafted expectation, the replay.
/** Each R1 or bank case's result per arm, by case id (the fake page's send answers it); a blank board otherwise. */
const results = {};
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
        if (expr.startsWith("rtEval.showInk(")) return undefined;
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
      const key = `${slot}|${arm}`;
      if (!tabs.has(key)) tabs.set(key, open(slot, arm));
      return tabs.get(key);
    },
    async close() {},
  };
}
const said2 = [];
const fakeRte = { say: (l) => said2.push(l), withRig: async (g, _trees, f) => f(fakeRig(g)) };
// The loop's clone with a champion (intake replays new cases on it) and a history branch (R1's record).
// A tree is the commit's files, the clone's evals/ and its node_modules (trees.ts); the fake rig serves none of them.
put(join(p.repo, "package-lock.json"), '{ "name": "t23", "lockfileVersion": 3 }\n');
put(join(p.repo, ".gitignore"), "node_modules\n");
put(join(p.repo, "evals", "README.md"), "t23\n");
mkdirSync(join(p.repo, "node_modules"), { recursive: true });
execFileSync("git", ["init", "-q", "-b", "master", p.repo]);
execFileSync("git", ["-C", p.repo, "add", "-A"]);
execFileSync("git", ["-C", p.repo, "-c", "user.name=t23", "-c", "user.email=t23@localhost", "commit", "-q", "-m", "the champion"]);
execFileSync("git", ["-C", p.repo, "branch", "loop/champion"]);
// The load gate waits for a quiet machine so timings compare; a fake rig times nothing, and other checks may be running.
const loadGate = { loadMax: LOOP.loadMax, psiMax: LOOP.psiMax };
Object.assign(LOOP, { loadMax: Infinity, psiMax: Infinity });
const calls0 = reqs().length;
check((await intake(fakeRte, gw.url)) === 0, `intake's first pass failed: ${said2.filter((l) => /failed/.test(l)).join("; ")}`);
const byKey = () => Object.fromEntries(C.cards().map((c) => [c.key, c]));
let cs = byKey();
const bankOf = (key) => cs[key]?.bank;
{
  const ids = [k(LIVE, "v1"), k(LIVE, "s3"), k(LIVE, "s4"), k(Q1, "v2")].map(bankOf);
  const info = (id) => json(join(p.realBank, id, "case.json"));
  check(ids.every((id) => /^c-r-[0-9a-f]{12}$/.test(id ?? "") && existsSync(join(p.realBank, id, "replies.json")) && readFileSync(join(p.realBank, id, "before-ink.jpg")).equals(JPEG) && info(id).proposedAt && info(id).recordedRun && !existsSync(join(p.realBank, id, "done"))),
    `the proposals: ${js(ids)} (want 4 bank cases, each shot, replayed and proposed, none admitted)`);
  check([k(LIVE, "v1"), k(LIVE, "s3"), k(LIVE, "s4"), k(Q1, "v2")].every((x) => cs[x].state === "proposed" && cs[x].admitAt) && info(bankOf(k(LIVE, "s3"))).key === k(LIVE, "s3") && info(bankOf(k(LIVE, "s3"))).set === "real",
    `cards after the first pass: ${js(state())}`);
  const exp = (key) => json(join(p.realBank, bankOf(key), "expectation.json"));
  check(exp(k(LIVE, "v1")).judgeId === RUBRIC && js(exp(k(LIVE, "v1")).should) === js(L1_RUBRIC.should) && exp(k(LIVE, "s4")).judgeId !== RUBRIC && js(exp(k(LIVE, "s4")).should) === js(["the board shows what they asked for"]),
    "a proposal's expectation isn't gold's rubric (a miss), or the judge's draft (a send gold drew nothing for)");
  check(reqs().length - calls0 === 1 && reqs().at(-1).role === "judge", `intake's first pass made ${reqs().length - calls0} calls (want 1: the drafted expectation; triage and gold were done)`);
  check(!existsSync(join(p.real, "bench", "R1")), "R1 was frozen with nothing admitted");
  const leak = said2.find((l) => /duck|cat|pond|zoo|tess/i.test(l));
  check(!leak, `intake's log carries a tester's words: ${leak}`);
}

// ===== 6. Review: Eval HQ's data (review.ts), the owner's verdicts and edits, and admission.
{
  const v = V.intakeView();
  check(v.states.proposed === 4 && v.states.skipped === 2 && v.skipped["a repeat of an earlier send"] === 1 && v.cards.length === 4 && v.pull.live.pulledAt === undefined && v.bank.real === 0,
    `intakeView: ${js({ states: v.states, skipped: v.skipped, cards: v.cards.length, bank: v.bank })}`);
  const c = V.cardView(k(LIVE, "s3"));
  check(c && c.state === "proposed" && c.images.before && c.images.then && c.images.champion && c.images.gold && c.meant.now === "a cat beside the duck" && c.expectation.from === "gold" && c.gold.checks.length === 2 && c.gold.checks.every((x) => x.then && x.now && x.gold) && c.send.n === 3 && c.previous?.said,
    `cardView: ${js({ state: c?.state, images: c?.images, from: c?.expectation?.from, checks: c?.gold?.checks?.length })}`);
  check(V.cardImage(k(LIVE, "s3"), "champion")?.startsWith(join(p.real, "runs")) && V.cardImage(k(LIVE, "s3"), "../../etc/passwd") === undefined && V.cardImage("nobody#1", "before") === undefined, "cardImage serves outside a card's own images");
}
const review = (b) => V.postReview(b);
check(review({ key: "nobody#1", verdict: "approve" }).error && review({ key: k(LIVE, "v1"), verdict: "maybe" }).error && review({ key: k(LIVE, "s3"), verdict: "reject" }).error && review({ key: k(LIVE, "v1") }).error,
  "postReview took a verdict for no card, an unknown verdict, a rejection without a reason, or nothing");
const EDIT = { should: ["exactly one rubber duck, as one picture"], mustNot: ["boxes for a duck"] };
check(!review({ key: k(LIVE, "v1"), verdict: "approve", meant: "a single yellow rubber duck", expectation: EDIT }).error && !review({ key: k(Q1, "v2"), note: "check the pond's edge" }).error && !review({ key: k(LIVE, "s3"), verdict: "reject", reason: "expectation", note: "the cat floats" }).error,
  "postReview refused an approval with edits, a note, or a rejection with a reason");
{
  const r = C.reviews();
  check(r.get(k(LIVE, "v1")).verdict === "approve" && r.get(k(LIVE, "v1")).edits.meant === "a single yellow rubber duck" && r.get(k(Q1, "v2")).note === "check the pond's edge" && !r.get(k(Q1, "v2")).verdict && r.get(k(LIVE, "s3")).reason === "expectation",
    `reviews(): ${js([...r])}`);
  // A later approval without edits keeps the edits standing.
  review({ key: k(LIVE, "v1"), verdict: "approve" });
  check(C.reviews().get(k(LIVE, "v1")).edits.meant === "a single yellow rubber duck" && js(C.reviews().get(k(LIVE, "v1")).edits.expectation) === js(EDIT), "an approval without edits took the earlier edits back");
}
{
  const a = C.admit();
  cs = byKey();
  const d = (key) => existsSync(join(p.realBank, bankOf(key), "done"));
  check(a.admitted === 1 && d(k(LIVE, "v1")) && !d(k(LIVE, "s3")) && !d(k(Q1, "v2")) && cs[k(LIVE, "s3")].state === "rejected", `admit() after the verdicts: ${js(a)}, ${js(state())} (want the approved one in, the rejected one out, the rest waiting)`);
  const e = json(join(p.realBank, bankOf(k(LIVE, "v1")), "expectation.json")), m = json(join(p.realBank, bankOf(k(LIVE, "v1")), "meant.json"));
  check(e.judgeId === OWNER && js(e.should) === js(EDIT.should) && m.meant === "a single yellow rubber duck", `the owner's edits aren't pinned in the bank case: ${js({ e, m })}`);
  const n0 = reqs().length;
  const got = await expectationFor(bankOf(k(LIVE, "v1")), "real-t23-expect");
  check(got.judgeId === OWNER && reqs().length === n0, "the judge re-made the owner's pinned expectation");
  // The look window: a card proposed 3 days ago joins, unless rejected.
  const f = join(p.realBank, bankOf(k(Q1, "v2")), "case.json");
  put(f, { ...json(f), proposedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  check(C.admit().admitted === 1 && d(k(Q1, "v2")) && byKey()[k(Q1, "v2")].state === "admitted" && !d(k(LIVE, "s4")), "a card past its look window wasn't admitted, or one inside it was");
  check(V.intakeView().bank.real === 2, "the bank's real count isn't its admitted cases");
}

// ===== 7. R1: every admitted card with gold, its labels the card's, split as splits.json says.
const r1 = join(p.real, "bench", "R1");
const r1ids = () => (existsSync(r1) ? readdirSync(r1).filter((d) => statSync(join(r1, d)).isDirectory()).sort() : []);
const manifestOf = (root) => {
  const files = {};
  if (!existsSync(root)) return { files, hash: "none" };
  for (const id of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort()) for (const f of readdirSync(join(root, id)).sort()) files[`${id}/${f}`] = sha(readFileSync(join(root, id, f)));
  return { files, hash: sha(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n")) };
};
check(SH.r1Cases().length === 0 && (await SH.realShadow(undefined, { run: "real-shadow-none", arms: {}, seed: "t23" })) === undefined, "realShadow ran without a frozen R1");
const f1 = C.freezeR1();
const idV1 = bankOf(k(LIVE, "v1")), idQ2 = bankOf(k(Q1, "v2"));
{
  check(f1 && f1.cases === 2 && f1.tune === 2 && f1.hold === 0 && js(r1ids()) === js([idV1, idQ2].sort()), `the first freeze: ${js(f1)}, R1 ${r1ids().join(", ")} (want the two admitted cards with gold, by their case ids)`);
  const m = maybe(join(r1, "manifest.json")) ?? {};
  check(m.version === "R1" && m.hash === f1.hash && m.hash === manifestOf(r1).hash, "manifest.json isn't the hash over R1's files");
  const files = ["before-ink.jpg", "before.scene.json", "case.json", "checks.json", "input.json", "meant.json", "rubric.json"];
  check(r1ids().every((id) => js(readdirSync(join(r1, id)).sort()) === js(files)), `a case's files: ${js(readdirSync(join(r1, idV1)).sort())}`);
  const c1 = json(join(r1, idV1, "case.json"));
  check(c1.set === "real" && c1.split === "tune" && c1.originSession === TESS && c1.key === k(LIVE, "v1") && js(json(join(r1, idV1, "rubric.json"))) === js(EDIT) && json(join(r1, idV1, "meant.json")).meant === "a single yellow rubber duck",
    `R1's case for the edited card: ${js({ c1, rubric: json(join(r1, idV1, "rubric.json")) })} (want its pinned labels)`);
  check(js(json(join(r1, idV1, "checks.json"))) === js(gl1.gold.checks) && json(join(r1, idQ2, "checks.json")).length === 0, "checks.json isn't gold's");
  const hist = readFileSync(join(p.history, "bench", "R1.json"), "utf8");
  const h = JSON.parse(hist);
  check(h.hash === f1.hash && h.cases === 2 && js(Object.keys(h.splits).sort()) === js(r1ids()) && !/duck|cat|pond|zoo|tess|example\.test|s3|#/i.test(hist), `history's bench/R1.json: ${hist.slice(0, 300)}`);
}
check(C.freezeR1() === undefined && maybe(join(r1, "manifest.json")).hash === f1.hash, "freezing the same cards again changed R1");
// Rejected after it joined: out of the bank (retired) and out of R1; taken back, in again.
review({ key: k(Q1, "v2"), verdict: "reject", reason: "fixed" });
check(C.admit().retired === 1 && !existsSync(join(p.realBank, idQ2, "done")) && C.freezeR1()?.cases === 1 && !r1ids().includes(idQ2), "a rejection after admission didn't retire the case from the bank and R1");
review({ key: k(Q1, "v2"), verdict: "approve" });
check(C.admit().admitted === 1 && C.freezeR1()?.hash === f1.hash, "approved again, the case didn't come back as it was");
// An edit taken back: the expectation is gold's rubric again.
review({ key: k(LIVE, "v1"), verdict: "approve", expectation: null });
C.admit();
check(json(join(p.realBank, idV1, "expectation.json")).judgeId === RUBRIC && js(json(join(p.realBank, idV1, "expectation.json")).should) === js(L1_RUBRIC.should), "an edit taken back didn't give the card gold's rubric again");
review({ key: k(LIVE, "v1"), verdict: "approve", expectation: EDIT });
C.admit();

// ===== 8. The second pull: a new tester (kit), placed once, on R-hold: their cards reach R1 only, through gold.
liveSnapshot(snap("live", "20261025T120000Z"), { kit: true });
latest("live", "20261025T120000Z");
said2.length = 0;
const calls1 = reqs().length;
check((await intake(fakeRte, gw.url)) === 0, `intake's second pass failed: ${said2.filter((l) => /failed/.test(l)).join("; ")}`);
cs = byKey();
check(js(C.splits()) === js({ [TESS]: "tune", owner: "tune", [KITP]: "hold" }) && said2.some((l) => l === "intake: 1 new people: 0 tune, 1 R-hold"), `splits after kit's first pull: ${js(C.splits())}`);
check(cs[k(KIT, "k1")].state === "proposed" && cs[k(KIT, "k1")].split === "hold" && !cs[k(KIT, "k1")].bank && R.goldOf(k(KIT, "k1")).proposedAt && /^skipped: R-hold/.test(state()[k(KIT, "k2")]),
  `kit's cards: ${js({ k1: state()[k(KIT, "k1")], k2: state()[k(KIT, "k2")] })} (want the miss proposed for R1 only, the zoom skipped)`);
check(reqs().length - calls1 === 2 && reqs().slice(calls1).map((r) => r.role).join() === "real-triage,real-gold", `the second pass's calls: ${reqs().slice(calls1).map((r) => r.role).join()} (want one triage of kit's session, one gold)`);
check(js(rowsOf(L.dir).map((r) => r.key)) === js([k(LIVE, "v1"), k(LIVE, "s3"), k(LIVE, "s4")]), "the second pull triaged tess's sends again");

// ===== 9. The third pull: one new send in tess's session; only it is triaged, and it joins the bank's proposals.
const tessRows = readFileSync(join(L.dir, "triage.json"), "utf8");
liveSnapshot(snap("live", "20261026T120000Z"), {
  kit: true,
  tessMore: [{ id: "s5", project: "p1", at: at(700), label: "make the cat smaller", spoken: false, kind: "send", camera: CAM, words: "make the cat smaller", strokes: [], enterAtMs: 0, before: B4, beforeVersion: 4, afterVersion: 4, status: "done", landed: 0 }],
});
latest("live", "20261026T120000Z");
const calls2 = reqs().length;
check((await intake(fakeRte, gw.url)) === 0, "intake's third pass failed");
cs = byKey();
{
  const asked = reqs().slice(calls2);
  check(asked.map((r) => r.role).join() === "real-triage,judge" && asked[0].firstUser.includes("Judge send 5 only") && asked[0].images === 2, `the third pass's calls: ${asked.map((r) => [r.role, r.images]).join("; ")} (want one triage of the new send, one drafted expectation)`);
  const rows = rowsOf(L.dir);
  check(rows.length === 4 && rows[3].key === k(LIVE, "s5") && js(rows.slice(0, 3)) === js(JSON.parse(tessRows).sends), "the earlier sends' triage rows changed when a new send came");
  check(cs[k(LIVE, "s5")].state === "proposed" && existsSync(join(p.realBank, bankOf(k(LIVE, "s5")), "replies.json")) && js(Object.keys(sessionsNow()[LIVE].s.sends.map((x) => x.key))) && sessionsNow()[LIVE].s.sends.slice(0, 4).every((x, i) => x.key === L.s.sends[i].key),
    "the new send isn't proposed, or the earlier sends' keys moved");
}

// ---- --regold: only gold without a verdict is redrawn (kit's), keeping its look window.
{
  const judged = new Set([...C.reviews()].filter(([, r]) => r.verdict).map(([key]) => key));
  check(js(want({ regold: true, judged })) === js([k(KIT, "k1")]), `--regold with verdicts given: ${want({ regold: true, judged }).join(", ")}`);
  const was = R.goldOf(k(KIT, "k1"));
  await goldRun("real-gold-t23-3", { regold: true, judged });
  const now = R.goldOf(k(KIT, "k1"));
  check(now.at !== was.at && now.proposedAt === was.proposedAt && js(now.gold.rubric.should) !== js(was.gold.rubric.should) && !existsSync(join(gDir(k(KIT, "k1")), "gold.jpg")), `the redrawn gold: ${js({ proposedAt: now.proposedAt === was.proposedAt })}`);
  await R.shootGold(stubShot);
}
// kit approved: R1 gains an R-hold case, and the bank never sees kit.
review({ key: k(KIT, "k1"), verdict: "approve" });
C.admit();
const f2 = C.freezeR1();
const idK1 = byKey()[k(KIT, "k1")].id;
check(f2 && f2.cases === 3 && f2.hold === 1 && js(f2.people) === js({ tune: 2, hold: 1 }) && r1ids().includes(idK1) && !existsSync(join(p.realBank, idK1)), `R1 with kit: ${js(f2)}`);

// ===== 10. realShadow's scoring on the fake rig: each arm's result is a board this check picks. Arm A: gold's board
// everywhere. Arm B: the app's boxy duck on the duck (fails both checks), gold's on the tree (passes), and the pond has
// no checks: it counts neither as passing nor failing.
const goldScene = (key) => json(join(gDir(key), "gold.scene.json"));
Object.assign(results, { [idV1]: { A: goldScene(k(LIVE, "v1")), B: B1 }, [idK1]: { A: goldScene(k(KIT, "k1")), B: goldScene(k(KIT, "k1")) }, [idQ2]: { A: goldScene(k(Q1, "v2")), B: B5 } });
/** A judge that always prefers B, written the way judge.ts writes a verdict. */
const preferB = (run) => ({
  async judgeCase(id, positions) {
    put(join(caseDir(run, id), "judge", "fidelity-1.json"), { winner: positions.left === "B" ? "left" : "right", confidence: 3, why: "canned", positions, judgeId: "canned" });
  },
  flips: () => ({ audited: 0, flipped: 0 }),
});
const RUN = "real-shadow-t23";
const arm = { sha: "fake", tree: "fake-tree" };
const sh = await SH.realShadow(fakeRig(gw.url), { run: RUN, arms: { A: arm, B: arm }, seed: "t23", judge: preferB(RUN) });
Object.assign(LOOP, loadGate);
check(sh && sh.cases === 3 && sh.void === 0 && sh.lost === 0 && sh.hash === f2.hash, `realShadow's run: ${js(sh)} (want 3 cases, none void or lost)`);
check(sh && js(sh.casesPassing) === js([1, 0.5]) && js(sh.checks) === js([1, 1 / 3]), `realShadow's scores: casesPassing ${js(sh?.casesPassing)}, checks ${js(sh?.checks)} (want cases [1, 1/2], checks [1, 1/3]: a case with no checks counts for neither arm)`);
check(sh && sh.share === 1 && sh.shareHold === 1, `realShadow's judge share: ${sh?.share}, R-hold ${sh?.shareHold}`);
{
  const e = json(join(caseDir(RUN, idV1), "expectation.json"));
  check(e.judgeId === RUBRIC && js(e.should) === js(EDIT.should), `R1's expectation isn't the card's rubric: ${js(e)}`);
}
check(existsSync(runFile(RUN, "real.json")) && runFile(RUN, "real.json").startsWith(join(p.real, "runs")) && !existsSync(join(p.home, "runs", RUN)), `real.json isn't under real/runs: ${runFile(RUN, "real.json")}`);
check(!unexpected.length, `the fake rig's page was asked what it doesn't answer: ${js(unexpected)}`);

// ===== 11. Real sends in the bank: decisions take admitted ones only, as set "real"; a decision run's files, calls and
// images for one stay under real/, its rows keep error codes only, and no digest shows it.
{
  const { banked } = await import("../loop/rte.ts");
  const { missSection } = await import("../optimizer/digest.ts");
  const { bankedScenes } = await import("../optimizer/gates.ts");
  const { appendRow } = await import("../loop/metrics.ts");
  const { storeImages, writeReply } = await import("../loop/cache.ts");
  const admitted = C.cards().filter((c) => c.state === "admitted" && c.bank).map((c) => c.bank).sort();
  check(js(banked(["real"])) === js(admitted) && admitted.length === 2 && banked(["tuning", "fresh"]).length === 0 && !existsSync(p.bankCases) && bankedScenes().filter((f) => f.startsWith(`${p.realBank}/`)).length === admitted.length,
    `banked real cases: ${js(banked(["real"]))} (want the admitted ones: ${js(admitted)})`);
  // Ids are keyed by a secret under real/: a plain hash of a blank board's words would let anyone check a guess.
  const plainId = (id) => {
    const input = json(join(p.realBank, id, "input.json")), before = json(join(p.realBank, id, "before.scene.json"));
    const words = typeof input.words === "string" ? input.words : input.words.map((w) => w.word).join(" ");
    return sha(js([words, input.strokes.map((s) => s.points), before.shapes])).slice(0, 12);
  };
  check((statSync(join(p.real, "bank.key")).mode & 0o777) === 0o600 && admitted.every((id) => id.slice(4) !== plainId(id)), "a real case's id is the plain hash of its input, or the key isn't mode 600");
  // A case a sync voided (V8) is skipped, never proposed again.
  const gone = bankOf(k(LIVE, "s4"));
  renameSync(join(p.realBank, gone), join(p.realBank, `${gone}.void`));
  check(state()[k(LIVE, "s4")] === "skipped: its bank case was voided by a sync" && !C.writeProposals().includes(gone) && !existsSync(join(p.realBank, gone)), "a voided case came back as a proposal");
  // A board still waiting for a picture: both arms would draw it (V12), so the send is no case.
  const x = Q.s.sends[1], f = join(Q.dir, `v${x.before}.json`), was = readFileSync(f, "utf8"), b = JSON.parse(was);
  b.shapes[0] = { ...b.shapes[0], drawing: "a rubber duck", picture: undefined };
  writeFileSync(f, js(b));
  check(/^skipped: its board still waits for a picture/.test(state()[k(Q1, "v2")]), `a board waiting for a picture: ${state()[k(Q1, "v2")]}`);
  writeFileSync(f, was);
  const DEC = "2026-10-28T00-00-e1-h1-ab", rid = admitted[0];
  check(caseDir(DEC, rid).startsWith(join(p.real, "runs", DEC)) && !caseDir(DEC, "c-b1-s01-1").startsWith(p.real), `a decision run's real case folder: ${caseDir(DEC, rid)}`);
  const req = { model: "m", system: "", user: "draw a cat next to the duck", images: [], effort: "low", thinking: "auto" };
  const file = writeReply(p, { reqHash: "t23-req", run: DEC, role: "draw", at: "", request: req, text: "the duck is just boxes", chunks: [], doneMs: 0, stats: {} }, false, rid);
  const [im] = storeImages(p, [`data:image/jpeg;base64,${randomBytes(64).toString("base64")}`], DEC, rid);
  check(file.startsWith(join(p.real, "cache")) && existsSync(p.blob(im, true)) && !existsSync(p.blob(im)), `a real case's call and image in a decision run: ${file}, image under real/ ${existsSync(p.blob(im, true))}`);
  appendRow(DEC, { case: rid, cluster: "r-1", void: "V7: a judge call failed twice (the duck is just boxes)", lost: { arm: "B", why: "page error: draw a cat next to the duck" } });
  const row = readFileSync(runFile(DEC, "rows.jsonl"), "utf8");
  check(/"void":"V7"/.test(row) && /"why":"failed"/.test(row), `a real case's row keeps its words: ${row.slice(0, 200)}`);
  const s1 = missSection("champ");
  check(s1.includes(`Also measured: ${admitted.length} real sends`) && !admitted.some((id) => s1.includes(id)) && !/duck|cat/i.test(s1), `the digest shows a real send, or not its count: ${s1.slice(0, 400)}`);
}

// ---- Privacy: testers' words, project names and emails stay under real/ (runs/, cache/, the meter and history are shown or
// exported; the Claude processes' config dir is scanned too).
const leaks = [];
const SECRETS = ["Synthetic zoo", "Kit's garden", "tess@example.test", "draw a cat next to the duck", "the duck is just boxes", "rubber duck", "draw a tree"];
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
const st = await gatewayStatus(gw.url);
check(product.calls.every((c) => String(c.model).startsWith("jev")) && st.calls === reqs().length && reqs().every((r) => ["real-triage", "real-gold", "judge"].includes(r.role)), `a model call left the fakes (the fake API got ${reqs().length}, the gateway made ${st.calls})`);

await gw.close();
await api.close();
rmSync(work, { recursive: true, force: true });
console.error(`t23: ${((Date.now() - started) / 1000).toFixed(1)} s, ${reqs().length} fake API calls, R1 ${f2.hash.slice(0, 12)}`);
finish();
