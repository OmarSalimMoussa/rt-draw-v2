// T11's acceptance check: the change list and work count, V12's before-scene fill, a banked
// case and an A/B run case written in full, the per-case metrics, and remetric. 0 model calls,
// no network: synthetic scenes, a hand-written reply cache file and meter lines in a temp RT_EVAL_HOME.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t11-record.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const { sceneDiff, nameOf } = await import("../core/diff.ts");
const rec = await import("../loop/record.ts");
const { caseMetrics, meterOf, rowOf, appendRow, readRows } = await import("../loop/metrics.ts");
const { remetric } = await import("../loop/remetric.ts");
const { paths } = await import("../loop/paths.ts");
const { needsPicture } = await import("../../src/core/picture.ts");
const p = paths();

const clone = (x) => JSON.parse(JSON.stringify(x));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const files = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile());

// ---- Synthetic scenes (ids that never appear in any text, so a leaked id would show)
const sh = (id, kind, [x, y, w, h], description, o = {}) => ({ id, kind, box: { x, y, w, h }, description, style: {}, ...o });
const PIC = (subject, w, h, r = "8") => ({ subject, w, h, els: [{ tag: "circle", attrs: { cx: "10", cy: "10", r, fill: "#ffcc00" } }], done: true });
const BEFORE = {
  width: 1280, height: 800, groups: {},
  shapes: [
    sh("zq0", "frame", [0, 0, 1280, 800], "the home page of a toy shop", { text: { words: "Home" } }),
    sh("zq1", "rect", [40, 40, 600, 80], "the shop's headline across the top", { text: { words: "Tiny Toys for Big Smiles Every Day" } }),
    sh("zq2", "round", [40, 200, 300, 300], "round photo of the owner, a smiling clown", { drawing: "a smiling clown", picture: PIC("a smiling clown", 270, 270) }),
    sh("zq3", "pill", [400, 220, 200, 60], "the buy button under the headline", { text: { words: "Buy now" } }),
    sh("zq4", "rect", [380, 300, 300, 200], "a product card with a teddy bear"),
    sh("zq5", "arrow", [100, 600, 300, 0], "arrow from the photo to the card"),
    sh("zq8", "rect", [40, 700, 400, 40], "a small footer note"),
  ],
};
const CAM = { x: 0, y: 0, w: 1280, h: 800 };
const VOCAB = /^(added (rect|round|circle|pill|line|arrow) '.+'|removed '.+'|moved '.+'|resized '.+'|recoloured '.+'|text changed in '.+'|picture added in '.+'|new page '.+'|camera moved|\+\d+ more changes)$/;
const clean = (items) => items.every((x) => VOCAB.test(x) && !/zq\d/.test(x) && !/\b(shape|text|drawing|layer|move|group|remove|camera)\(/.test(x));

// ---- sceneDiff: every kind of change, in the frozen vocabulary
{
  const after = clone(BEFORE);
  const at = (id) => after.shapes.find((s) => s.id === id);
  at("zq1").text.words = "Tiny Toys for Big Smiles";
  at("zq2").drawing = "a clown with balloons";
  at("zq2").picture = PIC("a clown with balloons", 270, 270);
  at("zq3").box.x += 50;
  at("zq4").box.w = 350;
  at("zq5").style.stroke = "#e03131";
  after.shapes = after.shapes.filter((s) => s.id !== "zq8");
  after.shapes.push(sh("zq6", "rect", [700, 40, 500, 120], "a promise to deliver within a day", { text: { words: "x".repeat(80) } }));
  after.shapes.push(sh("zq7", "frame", [1400, 0, 1280, 800], "the about page of the toy shop", { text: { words: "About" } }));
  const d = sceneDiff(BEFORE, after, [CAM, { ...CAM, x: 600 }]);
  const want = [
    "text changed in 'Tiny Toys for Big…'", "picture added in 'round photo of the…'", "moved 'Buy now'", "resized 'a product card with…'",
    "recoloured 'arrow from the photo…'", "added rect 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'", "new page 'About'",
    "removed 'a small footer note'", "camera moved",
  ];
  check(same(d.changes, want), `sceneDiff's change list is ${JSON.stringify(d.changes)}`);
  check(clean(d.changes), "a change item is outside the vocabulary or names an id or op");
  // 8 shapes changed + 1 picture on them + (24 + 80 + 5) text characters / 40
  check(Math.abs(d.work - (8 + 1 + 109 / 40)) < 1e-9 && !d.empty, `work is ${d.work}, want ${8 + 1 + 109 / 40}`);
  check(same(d.changed.sort(), ["zq1", "zq2", "zq3", "zq4", "zq5", "zq6", "zq7", "zq8"]), `changed ids ${d.changed}`);
  check(nameOf(BEFORE.shapes[1]) === "Tiny Toys for Big…" && nameOf(BEFORE.shapes[4]) === "a product card with…" && nameOf(BEFORE.shapes[3]) === "Buy now", "names aren't visible text or the first 4 description words");
}
{
  // More than 12 items: 11 of them, then "+N more changes".
  const after = clone(BEFORE);
  for (let i = 0; i < 20; i++) after.shapes.push(sh(`zq${100 + i}`, "circle", [i * 50, 520, 40, 40], `dot number ${i} in a row of dots`));
  const d = sceneDiff(BEFORE, after);
  check(d.changes.length === 12 && d.changes.at(-1) === "+9 more changes" && clean(d.changes), `20 changes list as ${JSON.stringify(d.changes)}`);
}
{
  // Not visible: a description edit. Camera only: listed, but no work. Both empty.
  const after = clone(BEFORE);
  after.shapes[4].description = "a product card with a brown teddy bear";
  const d = sceneDiff(BEFORE, after);
  check(!d.changes.length && d.work === 0 && d.empty, `a description-only edit counts: ${JSON.stringify(d)}`);
  const cam = sceneDiff(BEFORE, clone(BEFORE), [CAM, { ...CAM, w: 2560, h: 1600 }]);
  check(same(cam.changes, ["camera moved"]) && cam.empty, `a camera-only send: ${JSON.stringify(cam)}`);
  check(!sceneDiff(BEFORE, clone(BEFORE), [CAM, { ...CAM, x: 0.4 }]).changes.length, "a sub-pixel camera glide reads as a move");
  // Layer order: the card sent behind the page it overlaps is the one moved.
  const back = clone(BEFORE);
  back.shapes.unshift(...back.shapes.splice(4, 1));
  check(same(sceneDiff(BEFORE, back).changes, ["moved 'a product card with…'"]), `a layer change lists ${JSON.stringify(sceneDiff(BEFORE, back).changes)}`);
  // A picture finishing on a shape the send didn't touch is no change: metrics count it as a stray.
  const half = clone(BEFORE);
  half.shapes[2].picture.done = false;
  const filled = sceneDiff(half, BEFORE);
  check(!filled.changes.length && same(filled.pictured, ["zq2"]) && !filled.changed.length, `a picture-only fill: ${JSON.stringify(filled)}`);
}

// ---- checkBefore (V12)
const replyFile = (h, body) => (mkdirSync(dirname(p.reply(h)), { recursive: true }), writeFileSync(p.reply(h), JSON.stringify(body)));
const DOODLE = '<circle cx="10" cy="10" r="8" fill="#ffcc00"/>\n<rect x="2" y="2" width="5" height="5" fill="#222222"/>';
replyFile("r-ok", { request: { model: "sonnet" }, reply: DOODLE, offsets: [40, 90] });
replyFile("r-err", { request: { model: "sonnet" }, reply: DOODLE, error: "aborted" }); // whole elements, but the call failed
const recorded = (h, subject) => ({ role: "picture", ordinal: 0, subject, reqHash: h, cacheFile: `${h}.json`, offsets: [40, 90] });
{
  const needy = clone(BEFORE);
  delete needy.shapes[2].picture;
  const ok = rec.checkBefore(needy, [recorded("r-err", "a smiling clown"), recorded("r-ok", "a smiling clown"), recorded("r-ok", "a dog")]);
  const zq2 = ok.scene?.shapes[2];
  check(same(ok.filled, ["zq2"]) && zq2?.picture?.done && zq2.picture.els.length === 2 && !needsPicture(zq2) && zq2.picture.w === 270, `V12 doesn't fill from the completed reply: ${JSON.stringify(ok).slice(0, 300)}`);
  check(!needy.shapes[2].picture, "checkBefore changed the scene it was given");
  check(/V12/.test(rec.checkBefore(needy, [recorded("r-err", "a smiling clown")]).refused ?? ""), "V12 accepts a reply that never completed");
  check(/V12/.test(rec.checkBefore(needy, [recorded("r-ok", "a dog")]).refused ?? ""), "V12 fills from another subject's reply");
  check(same(rec.checkBefore(BEFORE, []), { scene: BEFORE, filled: [] }), "a before-scene that needs nothing isn't passed through");
}

// ---- A banked case: every §3.2 file, done last, images stored once
const jpg = (n) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, n + 1, n + 2, 0xff, 0xd9]);
const CASE = "c-b1-s07-3";
{
  const info = { id: CASE, set: "tuning", scenario: "t-bakery-typ-03", persona: "first-timer", style: "typical", target: "bakery", start: "blank", ask: "add", seed: 7, originSession: "b1-s07", send: 3, championSha: "abc123", tuningId: "t0", harnessTag: "eval-harness-1", configId: "cfg", recordedAt: "2026-10-16T10:00:00Z", hedged: false, beatDone: false, flags: ["filled"] };
  const caseFiles = {
    "case.json": info,
    "input.json": { camera: CAM, words: [{ word: "this", t0: 0, t1: 200 }], strokes: [], enterAtMs: 2400, inputHash: "ih1" },
    "before.scene.json": BEFORE,
    "before-ink.jpg": jpg(1), "driver-before.jpg": jpg(2), "driver-now.jpg": jpg(2),
    "driver.json": { raw: "{}", turn: { intent: "x", steps: [] }, retries: 0, dropped: [], reqHash: "d1" },
    "meant.json": { meant: "a bigger headline", hedged: false },
    "expectation.json": { judgeId: "j1", should: ["the headline is bigger"], mustNot: ["the photo moves"] },
    "miss.json": { judgeId: "j1", met: "partly", why: "bigger, but the photo moved" },
    "champion-after.jpg": jpg(3), "champion.json": { opsFailed: 0, picsFailed: 0, empty: false },
    "replies.json": [recorded("r-ok", "a smiling clown")],
    "readings.json": { marks: [{ n: 1, kind: "circle", how: "around", targets: ["zq1"] }] },
  };
  rec.writeCase(CASE, caseFiles);
  let refused = false;
  try { rec.caseDone(CASE, { last: false }); } catch { refused = true; }
  check(refused && !rec.isDone(p.bankCase(CASE)), "a banked case is marked done before its rating (from the next turn) is written");
  rec.writeCase(CASE, { "rating.json": { satisfaction: 3, saw: "the headline grew", feeling: "fine" } });
  rec.caseDone(CASE, { last: false });
  const dir = p.bankCase(CASE);
  const want = ["case.json", "input.json", "before.scene.json", "before-ink.jpg", "driver-before.jpg", "driver-now.jpg", "driver.json", "meant.json", "rating.json", "expectation.json", "miss.json", "champion-after.jpg", "champion.json", "replies.json", "readings.json", "done"];
  check(same(files(dir).sort(), [...want].sort()), `the banked case holds ${files(dir).sort()}`);
  const doneAt = statSync(join(dir, "done")).mtimeMs;
  check(files(dir).every((f) => statSync(join(dir, f)).mtimeMs <= doneAt), "a banked case file is newer than its done marker");
  check(statSync(join(dir, "driver-before.jpg")).ino === statSync(join(dir, "driver-now.jpg")).ino && statSync(p.blob(sha(jpg(2)))).nlink === 3, "two identical images aren't one blob");
  check(readdirSync(dirname(p.blob("x"))).length === 3, `blobs: ${readdirSync(dirname(p.blob("x")))}`);
  check(JSON.parse(readFileSync(join(dir, "miss.json"), "utf8")).met === "partly" && JSON.parse(readFileSync(join(dir, "case.json"), "utf8")).flags.includes("filled"), "miss.json or the filled flag didn't round-trip");
  // A session's last send has no next turn, so no rating.
  rec.writeCase("c-b1-s07-5", { ...caseFiles, "case.json": { ...info, id: "c-b1-s07-5", send: 5 } });
  rec.caseDone("c-b1-s07-5", { last: true });
  check(rec.isDone(p.bankCase("c-b1-s07-5")) && !existsSync(join(p.bankCase("c-b1-s07-5"), "rating.json")), "a last send can't be marked done without a rating");
}

// ---- An A/B run case: every §3.3 file, the metrics, rows, remetric
const RUN = "2026-10-16T10-00-e1-h1-ab";
const run = (id) => rec.runFile(RUN, ...id.split("/"));
const result = (o = {}) => ({
  ops: [{ line: "text(zq1, \"Tiny Toys\")", ok: true, ms: 900 }, { line: "bad(", ok: false, error: "no op", ms: 950 }],
  reply: "text(zq1, \"Tiny Toys\")", pics: { drawn: 0, failed: [], ms: 0 }, stopReasons: ["end_turn"],
  calls: [
    { role: "draw-refs", reqHash: "rq0", shared: "leader", mode: "live", ms: 3400, firstMs: 3000, waitMs: 10, readyAtTake: true, thinkingTokens: 0 },
    { role: "draw", reqHash: "rq1", shared: "leader", mode: "live", ms: 5000, firstMs: 2900, waitMs: 5, readyAtTake: true, thinkingTokens: 0 },
  ],
  ...o,
});
const timing = (o = {}) => ({ enterAt: 1000, ttfcMs: 4100, ttdMs: 5600, ttloMs: 5400, renders: 9, longTasksMs: 0, quiescedAt: 7100, heapMb: 40, gatewayLoopP99Ms: 3, ...o });
const afterA = clone(BEFORE);
afterA.shapes[1].text.words = "Tiny Toys";
const afterB = clone(afterA);
afterA.shapes.push(sh("zq9", "rect", [700, 300, 200, 200], "a teddy bear sticker", { drawing: "a teddy bear", picture: PIC("a teddy bear", 180, 180) }));
afterB.shapes[2].picture = PIC("a smiling clown", 270, 270, "9"); // a redraw of a shape the send never touched
{
  rec.writeRun({ id: RUN, kind: "ab", arms: { A: { sha: "aaa", tuningId: "t0", tree: "h1" }, B: { sha: "bbb", tuningId: "t1", tree: "h1" } }, configId: "cfg", harnessTag: "eval-harness-1", judgeId: "j1", machine: "laptop", slots: 2, load: { load1: 0.3 }, meter: { calls: 4 } });
  const cid = CASE;
  rec.writeArm(RUN, cid, "A", { "result.json": result({ pics: { drawn: 1, failed: [], ms: 2000 } }), "timing.json": timing(), "spans.json": [], "after.scene.json": afterA, "after.jpg": jpg(9) }, BEFORE, [CAM, CAM]);
  rec.writeArm(RUN, cid, "B", {
    "result.json": result({ pics: { drawn: 1, failed: [], ms: 2500 }, calls: [...result().calls.map((c) => ({ ...c, shared: "follower" })), { role: "picture", reqHash: "rq2", shared: "-", mode: "live", ms: 2400, thinkingTokens: 0 }] }),
    "timing.json": timing({ ttfcMs: 4300, heapMb: 52, gatewayLoopP99Ms: 7 }), "spans.json": [{ name: "send", traceId: "t", spanId: "s", startMs: 0, endMs: 5 }], "after.scene.json": afterB, "after.jpg": jpg(9),
  }, BEFORE, [CAM, { ...CAM, x: 300 }]);
  let refused = false;
  try { rec.runCaseDone(RUN, cid); } catch { refused = true; }
  check(refused, "a run case is marked done without fork.json");
  rec.put(run(`cases/${cid}/fork.json`), { order: ["B", "A"], offsetsMs: [0, 3], sharedReqs: ["rq0", "rq1"], identicalAfter: false });
  const pos = (left, right, winner, confidence = 2) => ({ winner, confidence, why: "x", positions: { left, right }, judgeId: "j1" });
  rec.put(run(`cases/${cid}/judge/packet.json`), { case: cid, said: "this [ink 1] bigger", meant: "a bigger headline", hedged: false, expectation: { should: [], mustNot: [] }, images: { before: "before-ink.jpg", left: "B/after.jpg", right: "A/after.jpg" }, changes: { left: [], right: [] }, positions: { left: "B", right: "A" } });
  rec.put(run(`cases/${cid}/judge/fidelity-1.json`), pos("B", "A", "left", 1));
  rec.put(run(`cases/${cid}/judge/fidelity-2.json`), pos("A", "B", "right"));
  rec.put(run(`cases/${cid}/judge/craft.json`), pos("A", "B", "tie"));
  rec.runCaseDone(RUN, cid);
  rec.appendLine(run("load.ndjson"), { at: 1, load1: 0.3, psiCpu: 0.01, psiMemory: 0 });
  // The gateway's lines: B's follower calls cost nothing upstream but are charged at the leader's price; judges and other runs don't count.
  const line = (o) => JSON.stringify({ at: "t", run: RUN, case: cid, slot: 1, model: "sonnet", sdk: "x", mode: "live", inTokens: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, outTokens: 10, thinkingTokens: 0, ms: 1, retries: 0, token: 1, ...o });
  mkdirSync(dirname(p.calls), { recursive: true });
  writeFileSync(p.calls, [
    line({ arm: "A", role: "draw-refs", reqHash: "rq0", shared: "leader", listUsd: 0.004 }), line({ arm: "B", role: "draw-refs", reqHash: "rq0", shared: "follower", listUsd: 0 }),
    line({ arm: "A", role: "draw", reqHash: "rq1", shared: "leader", listUsd: 0.01 }), line({ arm: "B", role: "draw", reqHash: "rq1", shared: "follower", listUsd: 0 }),
    line({ arm: "B", role: "picture", reqHash: "rq2", shared: "-", listUsd: 0.006 }), line({ role: "judge", reqHash: "j", shared: "-", listUsd: 0.05 }),
    line({ run: "another-run", arm: "A", role: "draw", reqHash: "rq1", shared: "leader", listUsd: 1 }),
  ].join("\n") + "\n");
  const calls = meterOf(RUN);
  const m = caseMetrics(RUN, cid, calls);
  check(Math.abs(m.A.usd - 0.014) < 1e-12 && Math.abs(m.B.usd - 0.02) < 1e-12, `product $ per arm: A ${m.A.usd} B ${m.B.usd}, want 0.014 and 0.02`);
  check(m.A.strayPictures === 0 && m.B.strayPictures === 1 && m.strayPictures === 1, `strayPictures A ${m.A.strayPictures} B ${m.B.strayPictures}`);
  check(m.heapMb === 52 && m.gatewayLoopP99Ms === 7, `per-case heapMb ${m.heapMb}, gatewayLoopP99Ms ${m.gatewayLoopP99Ms}`);
  check(m.A.ttfc === 4100 && m.B.ttd === 5600 && m.A.resolverMs === 3400 && m.A.firstTextMs === 2900 && m.B.picturesMs === 2500 && m.A.opsFailed === 1 && m.B.picsDrawn === 1, `timing and call metrics: ${JSON.stringify(m.A)}`);
  check(m.A.work === 3 + 9 / 40 && m.B.work === 1 + 9 / 40, `work A ${m.A.work} B ${m.B.work}`);
  const changes = JSON.parse(readFileSync(run(`cases/${cid}/B/changes.json`), "utf8"));
  check(same(changes, ["text changed in 'Tiny Toys'", "camera moved"]), `B's changes.json is ${JSON.stringify(changes)}`);
  const facts = { case: cid, cluster: "b1-s07", affected: true, class: "Q", overuse: [false, true], ask: "retext", firstArm: "B" };
  const row = rowOf(RUN, facts, calls);
  check(row.s === 1 && row.sCraft === 0 && same(row.ttfc, [4100, 4300]) && same(row.pics, [[1, 0], [1, 0]]) && same(row.overuse, [false, true]), `row ${JSON.stringify(row)}`);
  appendRow(RUN, row);
  appendRow(RUN, rowOf(RUN, { ...facts, case: "c-b1-s08-1", beat: "undo", firstArm: "A", void: "invariant: dispatch offset 31 ms" }, calls));
  rec.put(run("verdict.json"), { verdict: "revert", reasons: ["Rule F at look 16"], goal: "fidelity", class: "Q", looks: [], vetoes: [], configId: "cfg" });
  rec.put(run("digest.md"), "# candidate-loss digest\n");
  const wantRun = ["run.json", "load.ndjson", "rows.jsonl", "verdict.json", "digest.md", `cases/${cid}/fork.json`, `cases/${cid}/done`,
    ...["packet", "fidelity-1", "fidelity-2", "craft"].map((f) => `cases/${cid}/judge/${f}.json`),
    ...["A", "B"].flatMap((a) => ["result.json", "timing.json", "spans.json", "after.scene.json", "after.jpg", "changes.json"].map((f) => `cases/${cid}/${a}/${f}`))];
  check(same(files(p.run(RUN)).sort(), wantRun.sort()), `the run holds ${files(p.run(RUN)).sort()}`);
  const doneAt = statSync(run(`cases/${cid}/done`)).mtimeMs;
  check(files(rec.caseDir(RUN, cid)).every((f) => statSync(join(rec.caseDir(RUN, cid), f)).mtimeMs <= doneAt), "a run case file is newer than its done marker");
  check(statSync(run(`cases/${cid}/A/after.jpg`)).ino === statSync(run(`cases/${cid}/B/after.jpg`)).ino, "identical after images aren't stored once");
  check(readRows(RUN).length === 2 && readRows(RUN)[1].void, "rows.jsonl doesn't read back both rows");
}

// ---- remetric, and nothing ever deleted
const contents = () => new Set(files(home).map((f) => sha(readFileSync(join(home, f)))));
const kept = contents();
{
  const rows = run("rows.jsonl");
  const first = readFileSync(rows, "utf8");
  const r1 = remetric(RUN);
  check(!r1.changed && readFileSync(rows, "utf8") === first && !existsSync(`${rows}.void`), "remetric over a finished run doesn't reproduce rows.jsonl byte for byte");
  // Metric inputs fixed after the run (a timing, a second judge order that now disagrees): the old
  // files and the old rows are kept as *.void.
  rec.put(run(`cases/${CASE}/B/timing.json`), timing({ ttfcMs: 4500, heapMb: 52, gatewayLoopP99Ms: 7 }));
  rec.put(run(`cases/${CASE}/judge/fidelity-2.json`), { winner: "left", confidence: 2, why: "x", positions: { left: "A", right: "B" }, judgeId: "j1" });
  const r2 = remetric(RUN);
  const [fixed, voidRow] = readRows(RUN);
  check(r2.changed && readFileSync(`${rows}.void`, "utf8") === first && fixed.ttfc[1] === 4500 && fixed.s === 0 && voidRow.void, `remetric after a change doesn't rewrite the rows and void the old ones: ${JSON.stringify(fixed)}`);
  rec.putImage(run(`cases/${CASE}/A/after.jpg`), jpg(20));
  check(readFileSync(run(`cases/${CASE}/A/after.jpg`)).equals(jpg(20)) && readFileSync(run(`cases/${CASE}/A/after.jpg.void`)).equals(jpg(9)), "a replaced image isn't relinked with the old one kept as *.void");
  check(existsSync(run(`cases/${CASE}/B/timing.json.void`)), "a replaced timing.json isn't kept as *.void");
  rec.put(run("digest.md"), "# candidate-loss digest\n");
  check(!existsSync(run("digest.md.void")), "writing the same content again makes a void");
  rec.put(join(rec.caseDir(RUN, "c-b1-s09-2"), "fork.json"), { order: ["A", "B"] });
  const voided = rec.voidCase(rec.caseDir(RUN, "c-b1-s09-2"), "transport: 529");
  check(voided.endsWith("c-b1-s09-2.void") && !existsSync(rec.caseDir(RUN, "c-b1-s09-2")) && JSON.parse(readFileSync(join(voided, "void.json"), "utf8")).why === "transport: 529", "a voided case isn't renamed *.void with its reason");
  rec.put(join(rec.caseDir(RUN, "c-b1-s09-2"), "fork.json"), { order: ["B", "A"] });
  check(rec.voidCase(rec.caseDir(RUN, "c-b1-s09-2"), "again").endsWith("c-b1-s09-2.void.2"), "a second void of the same case overwrites the first");
  const now = contents();
  check([...kept].every((h) => now.has(h)), "a file's content disappeared: something was deleted or overwritten");
}

finish();
