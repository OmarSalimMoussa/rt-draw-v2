// T12's acceptance check: the judges' packets, prompts, order handling, judgeId, calibration and
// canary. The math in-process; every judge call through the gateway on the fake API (0 real calls:
// fake tokens only, HTTPS_PROXY at a closed port, and each fake API's request count must equal its
// gateway's call count). Two fakes: one replying in a planned order (cases judged one at a time),
// one replying "left" to everything (a position-biased judge, so any order of calls works).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t12-judge.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const work = mkdtempSync(join(tmpdir(), "rt-t12-"));
const env = cleanEnv();
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);
const tokens = join(work, "tokens.env");
writeFileSync(tokens, `RT_EVAL_TOKEN_1=sk-ant-oat01-fake-t12-${randomBytes(6).toString("hex")}\n`);
chmodSync(tokens, 0o600);

const { startFakeApi } = await import("../mock/fake-api.ts");
const { gatewayStatus, spawnGateway } = await import("../loop/client.ts");
const { LOOP } = await import("../loop/config.ts");
const rec = await import("../loop/record.ts");
const { inkGroups } = await import("../bridge/ink.ts");
const { targetOf, PERSONAS } = await import("../core/personas.ts");
const P = await import("../judge/prompts.ts");
const K = await import("../judge/packet.ts");
const J = await import("../judge/judge.ts");
const C = await import("../judge/calibrate.ts");
const N = await import("../judge/canary.ts");

const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const SERVED = "claude-sonnet-5-5-fake";
// Strings that must never reach a judge: the commit, the tuning, `testing`, the driver's rating, personas, models, arms.
const SHA = `deadbeef${randomBytes(4).toString("hex")}`;
const TUNING = `tun-${randomBytes(4).toString("hex")}`;
const TESTING = `TESTSECRET-${randomBytes(4).toString("hex")}`;
const RATING = `RATINGSECRET-${randomBytes(4).toString("hex")}`;
const LEAKS = [SHA, TUNING, TESTING, RATING, ...PERSONAS.flatMap((p) => [p.id, p.name]), "sonnet", "haiku", "opus", "claude-", "after.jpg", "positions", "tuning", "commit"];
const ARMISH = { test: (t) => /\barms?\b/i.test(t) || /\b[AB]\/|"[AB]"/.test(t) };

// ---- Case files (written the way record.ts writes them; nothing here calls a model)
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const CAM = { x: 0, y: 0, w: 1280, h: 800 };
const word = (w, t0, t1) => ({ word: w, t0, t1 });
const stroke = (id, x, y, t0, t1) => ({ id, points: [[x, y, t0], [x + 30, y + 10, (t0 + t1) / 2], [x + 60, y, t1]], t0, t1 });
const scene = (n, tag) => ({ v: 1, width: 1280, height: 800, groups: {}, shapes: Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, kind: "rect", box: { x: i * 60, y: 0, w: 50, h: 40 }, description: `box ${i}`, style: {} })) });
const BEFORE = scene(3, "zb");
const CHANGES = { A: ["resized 'Our story'"], B: ["text changed in 'Clowns.com'"] };
const exp = (id) => ({ judgeId: J.judgeId("expectation", SERVED), should: [`the ${id} title is bigger`], mustNot: ["the photo moves"] });
const meantOf = (id) => `the ${id} title twice as big`;

function bankCase(id, o = {}) {
  rec.writeCase(id, {
    "case.json": { id, set: "tuning", scenario: "t1", persona: o.persona ?? "explorer", style: "typical", ...(o.target ? { target: o.target } : {}), start: "toyshop-home", ask: "resize", seed: 7, originSession: "s1", send: 1,
      championSha: SHA, tuningId: TUNING, harnessTag: "eval-harness-1", configId: "cfg", recordedAt: "2026-10-16T00:00:00Z", hedged: !!o.hedged, beatDone: true, flags: [] },
    "input.json": { camera: CAM, words: o.words ?? [word("make", 100, 300), word("this", 350, 500), word("bigger", 550, 800)], strokes: o.strokes ?? [stroke(1, 100, 100, 380, 600)], enterAtMs: 1500, inputHash: "h" },
    "meant.json": { meant: meantOf(id), testing: TESTING, hedged: !!o.hedged },
    "rating.json": { satisfaction: 2, saw: RATING, feeling: RATING },
    "readings.json": { marks: [{ n: 1, kind: "circle", how: "PRODUCT-LINK", targets: ["zb0"] }], refs: [{ phrase: "PRODUCT-LINK this", ids: ["zb0"] }] },
    "before.scene.json": BEFORE, "before-ink.jpg": JPEG, "champion-after.jpg": JPEG,
    ...(o.expectation === false ? {} : { "expectation.json": exp(id) }),
  });
}
function runCase(run, id, o = {}) {
  for (const arm of ["A", "B"]) {
    const d = join(rec.caseDir(run, id), arm);
    rec.putImage(join(d, "after.jpg"), JPEG);
    rec.put(join(d, "after.scene.json"), scene(o.shapes?.[arm] ?? 4, `z${arm}`));
    rec.put(join(d, "changes.json"), o.changes?.[arm] ?? CHANGES[arm]);
  }
}
const judgeFile = (run, id, f) => join(rec.caseDir(run, id), "judge", f);
const judged = (winner, confidence, positions, variant = 1) => ({ winner, confidence, why: "stored", positions, judgeId: "j-stored", variant });
const V = (winner, confidence) => JSON.stringify({ winner, confidence, why: `${winner} at ${confidence}` });
const pickOf = (pos, w) => (w === "tie" ? "tie" : pos[w]);
const score = (a) => (a === "tie" ? 0 : a === "B" ? 1 : -1);
/** The first n ids `${prefix}<i>` that `want` takes: cases picked by the seeded audit and craft draws. */
const ids = (prefix, n, want) => {
  const out = [];
  for (let i = 0; out.length < n; i++) if (want(`${prefix}${i}`)) out.push(`${prefix}${i}`);
  return out;
};
const isAudit = (seed, id) => J.draw(seed, "audit", id) < LOOP.auditShare;

// ===== Pure parts (0 calls)

// ---- Positions: exactly balanced on every even prefix, seeded, and a top-up never moves a judged case.
const many = Array.from({ length: 100 }, (_, i) => `p${i}`);
const pos = J.positionsFor(many, "seed-a");
const bLeft = (n) => many.slice(0, n).filter((id) => pos.get(id).left === "B").length;
check([2, 16, 32, 48, 80, 100].every((n) => bLeft(n) === n / 2), `positions aren't balanced exactly: B left on ${[16, 32, 48, 80, 100].map(bLeft)}`);
check(many.every((id) => new Set(Object.values(pos.get(id))).size === 2), "a case got the same arm on both sides");
const prefix = J.positionsFor(many.slice(0, 33), "seed-a");
check(many.slice(0, 33).every((id) => prefix.get(id).left === pos.get(id).left), "positions of earlier cases changed when cases were added");
const other = J.positionsFor(many, "seed-b");
check(many.some((id) => other.get(id).left !== pos.get(id).left) && J.positionsFor(many, "seed-a").get("p7").left === pos.get("p7").left, "positions aren't seeded");
const draws = Array.from({ length: 4000 }, (_, i) => `d${i}`);
const auditShare = draws.filter((id) => isAudit("s", id)).length / draws.length;
check(Math.abs(auditShare - 0.2) < 0.03, `seeded audit ${auditShare} (want 0.2)`);

// ---- The flip fallback: > 30% after 16 audited, never before.
check(!J.bothOrders(15, 15) && J.bothOrders(16, 5) && !J.bothOrders(16, 4) && !J.bothOrders(20, 6) && J.bothOrders(20, 7), "the flip-rate fallback isn't > 30% after 16 audited cases");

// ---- said: [ink n] at the word being said when mark n started (marks numbered as the image numbers them).
const W = [word("um", 100, 250), word("this", 300, 500), word("one", 550, 700), word("make", 1500, 1650), word("it", 1700, 1800), word("the", 1850, 1950), word("whole", 2000, 2250), word("width", 2300, 2600)];
// A dot before any word; a loop during "this"; two strokes 100 ms and 20 px apart during "width" (one mark).
const S = [stroke(5, 900, 300, 2400, 2500), stroke(2, 100, 100, 320, 480), stroke(9, 500, 500, 0, 40), stroke(6, 920, 310, 2600, 2700)];
check(inkGroups(S).length === 3, `the ink fixture makes ${inkGroups(S).length} marks, want 3`);
const said = K.said(W, S);
check(said === "[ink 1] um this [ink 2] one make it the whole width [ink 3]", `said: ${said}`);
check(K.said("make this bigger", S) === "make this bigger [ink 1] [ink 2] [ink 3]", `a typed said: ${K.said("make this bigger", S)}`);
check(K.said([], S) === "[ink 1] [ink 2] [ink 3]" && K.said(W, []) === W.map((w) => w.word).join(" "), "said without words or without ink");
// N12: built by harness code, not by the product's linking step.
const packetSrc = readFileSync(join(ROOT, "evals/judge/packet.ts"), "utf8");
const productImports = packetSrc.split("\n").filter((l) => /from "\.\.\/\.\.\/src\//.test(l));
check(productImports.length > 0 && productImports.every((l) => l.startsWith("import type")), `packet.ts imports product code: ${productImports}`);

// ---- judgeId: stable (in another process too), and it changes with the served model, the variant and the role.
const id1 = J.judgeId("fidelity", SERVED);
const childId = execFileSync(process.execPath, ["--import", join(ROOT, "evals/loop/node-hooks.mjs"), "--input-type=module", "-e",
  `const J = await import(${JSON.stringify(join(ROOT, "evals/judge/judge.ts"))}); console.log(J.judgeId("fidelity", ${JSON.stringify(SERVED)}));`], { env: cleanEnv(), encoding: "utf8" }).trim();
check(id1 === J.judgeId("fidelity", SERVED) && id1 === childId, `judgeId isn't stable: ${id1} / ${childId}`);
check(id1 !== J.judgeId("fidelity", "claude-sonnet-5-5-20261101"), "judgeId doesn't change with the served model");
check(id1 !== J.judgeId("fidelity", SERVED, 2) && J.judgeId("craft", SERVED) !== J.judgeId("craft", SERVED, 2), "judgeId doesn't change with the prompt variant");
check(new Set(["expectation", "fidelity", "craft", "miss"].map((r) => J.judgeId(r, SERVED))).size === 4, "two roles share a judgeId");
check(J.judgeId("expectation", SERVED) === J.judgeId("expectation", SERVED, 2), "a fidelity variant switch would re-make every expectation");

// ---- No session judge; both variants frozen for fidelity and craft.
check(![...Object.keys(P), ...Object.keys(J)].some((k) => /session/i.test(k)), "there is a session judge");
check(P.fidelity[1] && P.fidelity[2] && P.craft[1] && P.craft[2] && P.fidelity[1] !== P.fidelity[2], "fidelity and craft don't have two frozen variants");
for (const v of [1, 2]) check(!/«said»|«meant»|«changes»/.test(P.craft[v]()), `craft variant ${v} carries words`);

// ---- Calibration math (§4.5) on synthetic labels.
const row = (label, judge, strength = "clear", o = {}) => ({ pair: `x${Math.random()}`, question: "fidelity", label, strength, judge, ...o });
const rows = (agree, n, o = {}) => Array.from({ length: n }, (_, i) => row("A", i < agree ? "A" : "B", "clear", o));
const reps = (same, n) => Array.from({ length: n }, (_, i) => (i < same ? ["A", "A"] : ["A", "B"]));
const goodSelf = reps(6, 8); // the owner agrees with himself on 75%: the bar is 0.65
const F = (r, rp = goodSelf) => C.scoreFidelity(r, rp);
check(F(rows(47, 60)).pass && !F(rows(46, 60)).pass, "fidelity isn't ≥ 47 of 60 clear");
check(F([...rows(46, 58), row("A", "tie"), row("A", "tie")]).pass && !F([...rows(46, 59), row("A", "tie")]).pass, "a judge tie doesn't count 0.5");
check(F([...rows(47, 60), ...rows(0, 10)]).clear.n === 60 && F([...rows(47, 60), ...rows(0, 10)]).rules.clear, "more than 60 clear labels aren't cut to the first 60");
check(F(rows(32, 40)).pass && !F(rows(31, 40)).pass && F(rows(31, 39)).more && !F(rows(39, 39)).pass, "the 78% on ≥ 40 clear rule, or 'more' below 40");
const slight = (agree, n) => Array.from({ length: n }, (_, i) => row("A", i < agree ? "A" : "B", "slight"));
// 50 clear at 80%, plus slight labels: all decisive 0.65 passes the 0.65 bar, 0.64 doesn't.
check(F([...rows(40, 50), ...slight(25, 50)]).rules.self && F([...rows(40, 50), ...slight(25, 50)]).decisive.share === 0.65, "agreement on all decisive labels ≥ self − 0.10 fails at the bar");
check(!F([...rows(40, 50), ...slight(24, 50)]).rules.self && F([...rows(40, 50), ...slight(24, 50)]).rules.clear, "decisive agreement below self − 0.10 passes");
check(F([...rows(40, 50), ...slight(25, 50)]).slight.n === 50 && F([...rows(40, 50), ...slight(25, 50)]).clear.n === 50, "slight labels aren't kept apart from clear ones");
check(!F(rows(60, 60), []).rules.self, "the self-agreement bar passes with no repeats labelled");
const probes = (judgeBig, ownerBig, n = 10) => Array.from({ length: n }, (_, i) => row(i < ownerBig ? "B" : "A", i < judgeBig ? "B" : "A", "slight", { bigger: "B", subset: "more" }));
check(F([...rows(56, 60), ...probes(6, 5)]).rules.probes && !F([...rows(56, 60), ...probes(7, 5)]).rules.probes, "the did-more probe rule isn't ≤ 10 points over the owner");
// Craft labels include ties (a tie label agrees with a judge tie); the disagreeing ones are decisive and opposite.
const crow = (agree, n) => Array.from({ length: n }, (_, i) => { const l = i < agree && i % 3 === 0 ? "tie" : "A"; return { ...row(l, i < agree ? l : "B"), question: "craft" }; });
check(C.scoreCraft(crow(22, 30)).pass && !C.scoreCraft(crow(21, 30)).pass, "craft isn't ≥ 22 of 30");
check(C.agreement("tie", "A") === 0.5 && C.agreement("A", "tie") === 0.5 && C.agreement("A", "B") === 0 && C.agreement("tie", "tie") === 1, "agreement scoring");
const detail = (judgeBig, ownerBig) => Array.from({ length: 10 }, (_, i) => ({ ...row(i < ownerBig ? "B" : "A", i < judgeBig ? "B" : "A"), question: "craft", bigger: "B", subset: "detail" }));
check(C.scoreCraft([...detail(6, 5), ...crow(20, 20)]).rules.probes && !C.scoreCraft([...detail(7, 5), ...crow(20, 20)]).rules.probes, "the more-detail probe rule isn't ≤ 10 points over the owner");
check(C.scoreCraft(crow(19, 19)).more && !C.scoreCraft(crow(20, 20)).more, "craft with too few labels isn't 'more'");
const ok = { pass: true, more: false }, bad = { pass: false, more: false }, few = { pass: false, more: true };
check(C.outcomeOf(1, bad, ok) === "variant-2" && C.outcomeOf(1, ok, bad) === "variant-2" && C.outcomeOf(2, bad, ok) === "stop" && C.outcomeOf(2, ok, bad) === "pass-no-craft" && C.outcomeOf(2, ok, ok) === "pass" && C.outcomeOf(1, few, ok) === "more",
  "only a second fidelity failure reports 'stop'");

// ---- Canary alarm math: ≤ 16 of 20.
check(N.canaryAlarm(16, 20) && !N.canaryAlarm(17, 20) && N.canaryAlarm(3, 4) && !N.canaryAlarm(4, 4), "the canary alarm isn't ≤ 16 of 20");

// ===== Through the fake API, part 1: replies in a planned order, cases judged one at a time.
const R1 = "r1-ab", S1 = "seed-1", R2 = "r2-craft", S2 = "seed-2", BANK = "bank-run";
const plain = (seed) => (id) => !isAudit(seed, id);
const [n1, n2, n3, n6, b1] = ids("n", 5, plain(S1));
const [n4] = ids("q", 1, (id) => isAudit(S1, id));
const audits = ids("a", 15, (id) => isAudit(S1, id));
const [n5] = ids("k", 1, (id) => !isAudit(S2, id));
const r1Cases = [n1, n2, n3, n4, n6, ...audits, b1];
const r1Pos = J.positionsFor(r1Cases, S1);
for (const id of r1Cases) {
  bankCase(id);
  runCase(R1, id);
}
bankCase(n5);
runCase(R2, n5);
// k1: a hedged first-timer with a bakery in mind, words and ink, no expectation yet.
bankCase("k1", { persona: "first-timer", target: "bakery", hedged: true, expectation: false, words: W, strokes: S });
bankCase("k2");
bankCase("k3");

const plan = [
  '{"should": ["the bakery name is bigger"], "mustNot": ["the bread photo moves"]}', // k1's expectation
  V("left", 3), // n1: decisive at confidence 3, not audited → one order
  V("left", 1), V("left", 2), // n2: confidence 1 → a second order, which disagrees (same side, other arm) → tie
  V("tie", 1), // n3: a tie, never re-judged
  V("right", 2), V("left", 3), // n4: audited → a second order that agrees
  "I think the left one is better.", // n6: unreadable → a low-confidence tie
  V("left", 3), V("left", 3), // n5 (craft "all"): fidelity and craft at once
  '{"met": "yes", "why": "did it"}', '{"met": "partly", "why": "bigger, but the photo moved"}', '{"met": "no", "why": "nothing changed"}', // miss checks
];
const dir1 = join(work, "replies-1");
mkdirSync(dir1);
writeFileSync(join(dir1, `judge.${sha12(P.SYSTEM)}.json`), JSON.stringify(plan));
const api1 = await startFakeApi({ replies: dir1 });
const gw1 = await spawnGateway({ home, port: 5282, tokens, mockApi: api1.url });
const up1 = () => api1.requests.length;
const reqs1 = (s) => api1.requests.filter((r) => r.firstUser.includes(s));

// ---- The expectation: once per case, the before image and the step only; reused after.
const e1 = await J.expectationFor("k1", BANK);
const k1Said = K.said(W, S);
const er = reqs1(meantOf("k1"))[0];
check(up1() === 1 && e1.should[0] === "the bakery name is bigger" && e1.judgeId === J.judgeId("expectation", SERVED), `expectation: ${up1()} calls, ${JSON.stringify(e1)}`);
check(er && er.images === 1 && er.effort === "high" && er.model === "claude-sonnet-5-5" && er.firstUser.includes(`They said: "${k1Said}"`) && er.firstUser.includes("they were unsure") && er.firstUser.includes(targetOf("bakery").parts),
  `the expectation request lacks the said, the unsure flag or the target parts, or isn't Sonnet high with one image: ${er?.firstUser.slice(0, 300)}`);
check(json(join(home, "bank", "cases", "k1", "expectation.json")).judgeId === e1.judgeId, "expectation.json isn't in the banked case");
await J.expectationFor("k1", BANK);
check(up1() === 1, "a current expectation was asked again");
check(J.lastServed() === SERVED, `the served model id wasn't read from the call: ${J.lastServed()}`);

// ---- Order handling on one run.
const j1 = J.judging(R1, { seed: S1, craft: "none" });
const verdicts = {};
for (const id of [n1, n2, n3, n4, n6]) verdicts[id] = await j1.judgeCase(id, r1Pos.get(id));
const has2 = (id) => existsSync(judgeFile(R1, id, "fidelity-2.json"));
check(up1() === 8, `order handling made ${up1() - 1} calls, want 7`);
check(!has2(n1) && verdicts[n1].s === score(r1Pos.get(n1).left), `n1 (left at 3): second order ${has2(n1)}, s ${verdicts[n1].s}`);
check(has2(n2) && verdicts[n2].s === 0, `n2 (left at 1, then left): orders that disagree aren't a tie (s ${verdicts[n2].s})`);
check(!has2(n3) && verdicts[n3].s === 0, "a tie was re-judged");
check(has2(n4) && verdicts[n4].s === score(r1Pos.get(n4).right) && JSON.stringify(j1.flips()) === JSON.stringify({ audited: 1, flipped: 0 }), `n4 (audited, orders agree): s ${verdicts[n4].s}, flips ${JSON.stringify(j1.flips())}`);
check(!has2(n6) && verdicts[n6].s === 0 && verdicts[n6].first.why.startsWith("unreadable reply") && verdicts[n6].first.confidence === 1, "an unreadable verdict isn't a low-confidence tie");
const [o1, o2] = reqs1(meantOf(n2));
const posN2 = r1Pos.get(n2);
check(o1?.firstUser.includes(`Left changed: ${CHANGES[posN2.left][0]}. Right changed: ${CHANGES[posN2.right][0]}`) && o2?.firstUser.includes(`Left changed: ${CHANGES[posN2.right][0]}. Right changed: ${CHANGES[posN2.left][0]}`),
  "the second order doesn't swap the sides");
check(o1?.firstUser.includes(`should the ${n2} title is bigger`) && o2?.firstUser.includes(`should the ${n2} title is bigger`) && o1.images === 3 && o2.images === 3, "both orders don't carry the same expectation and three images");
const f2 = json(judgeFile(R1, n2, "fidelity-2.json"));
check(f2.positions.left === posN2.right && f2.judgeId === J.judgeId("fidelity", SERVED) && f2.variant === 1, `fidelity-2.json: ${JSON.stringify(f2)}`);
// Packets: the harness's said, the positions stored, nothing of arm, commit, tuning, model, persona, rating or testing.
const pk = json(judgeFile(R1, n1, "packet.json"));
const { positions: pkPos, images: pkImages, ...pkRest } = pk;
check(JSON.stringify(pkPos) === JSON.stringify(r1Pos.get(n1)) && pkImages.left === `${r1Pos.get(n1).left}/after.jpg` && pkImages.before === "before-ink.jpg", `packet positions or images: ${JSON.stringify(pk)}`);
check(pk.said === K.said(json(join(home, "bank", "cases", n1, "input.json")).words, json(join(home, "bank", "cases", n1, "input.json")).strokes) && !JSON.stringify(pk).includes("PRODUCT-LINK"), `the packet's said isn't the harness's: ${pk.said}`);
const pkText = JSON.stringify(pkRest);
check(!LEAKS.some((s) => pkText.includes(s)) && !ARMISH.test(pkText), `a packet leaks: ${pkText}`);

// ---- Craft on a craft-goal run: the two after images, no words; fidelity alongside.
const j2 = J.judging(R2, { seed: S2, craft: "all" });
const v5 = await j2.judgeCase(n5, { left: "B", right: "A" });
const craftReq = api1.requests.find((r) => r.firstUser.includes("better wireframe"));
check(up1() === 10 && v5.sCraft === 1 && v5.s === 1 && existsSync(judgeFile(R2, n5, "craft.json")), `craft-goal case: ${up1() - 8} calls, s ${v5.s}, sCraft ${v5.sCraft}`);
check(craftReq && craftReq.images === 2 && ![meantOf(n5), "make", "this", "bigger", "Our story", "Clowns.com", "should"].some((w) => craftReq.firstUser.toLowerCase().includes(w.toLowerCase())), `the craft request carries words: ${craftReq?.firstUser}`);

// ---- The miss check: once per banked case, yes / partly / no.
const ms = [];
for (const k of ["k1", "k2", "k3"]) ms.push(await J.missCheck(k, BANK, ["resized 'Our story'"]));
check(ms.map((m) => m.met).join() === "yes,partly,no" && json(join(home, "bank", "cases", "k2", "miss.json")).met === "partly" && ms[0].judgeId === J.judgeId("miss", SERVED), `miss checks: ${JSON.stringify(ms)}`);
const mr = reqs1(meantOf("k1")).at(-1);
check(mr?.images === 2 && mr.firstUser.includes("What changed: resized 'Our story'") && mr.firstUser.includes("should the bakery name is bigger"), "the miss check doesn't carry the champion's changes and the expectation");
await J.missCheck("k1", BANK, ["resized 'Our story'"]);
check(up1() === 13, `the miss checks made ${up1() - 10} calls, want 3 (a current one is reused)`);
const s1 = await gatewayStatus(gw1.url);
check(up1() === s1.calls && api1.requests.every((r) => r.role === "judge"), `fake API 1 got ${up1()} requests, its gateway made ${s1.calls} calls`);
await gw1.close();

// ===== Part 2: a judge that always says "left" at confidence 2 (calls in any order).
const dir2 = join(work, "replies-2");
mkdirSync(dir2);
writeFileSync(join(dir2, `judge.${sha12(P.SYSTEM)}.txt`), V("left", 2));
const api2 = await startFakeApi({ replies: dir2 });
const gw2 = await spawnGateway({ home, port: 5283, tokens, mockApi: api2.url });
const up2 = () => api2.requests.length;

// ---- The flip fallback: every audited case flips (left both times); after 16 audited the run goes to both orders.
await Promise.all(audits.slice(0, 14).map((id) => j1.judgeCase(id, r1Pos.get(id))));
check(up2() === 28 && !j1.both() && JSON.stringify(j1.flips()) === JSON.stringify({ audited: 15, flipped: 14 }), `after 15 audited: ${up2()} calls, both ${j1.both()}, flips ${JSON.stringify(j1.flips())}`);
await j1.judgeCase(audits[14], r1Pos.get(audits[14]));
const log = existsSync(rec.runFile(R1, "judging.jsonl")) ? readFileSync(rec.runFile(R1, "judging.jsonl"), "utf8") : "";
check(j1.both() && JSON.stringify(j1.flips()) === JSON.stringify({ audited: 16, flipped: 15 }) && /"both":true/.test(log), `after 16 audited at 94% flips: both ${j1.both()}, log ${log}`);
const vb = await j1.judgeCase(b1, r1Pos.get(b1));
check(up2() === 32 && has2(b1) && vb.s === 0, `in both orders a confident, unaudited verdict didn't get a second order (${up2() - 30} calls)`);
// A resumed run rebuilds its counts from its done cases (0 calls).
for (const id of r1Cases) rec.put(join(rec.caseDir(R1, id), "done"), "x\n");
const again = J.judging(R1, { seed: S1, craft: "none" });
check(again.both() && JSON.stringify(again.flips()) === JSON.stringify({ audited: 16, flipped: 15 }) && up2() === 32, `a resumed run's flips: ${JSON.stringify(again.flips())}, both ${again.both()}`);

// ---- Craft when a screen left the change: the two framed shots in the packet's order, not one arm's new page against the other's old one.
const pk5 = json(judgeFile(R2, n5, "packet.json"));
const shot = (a) => Buffer.concat([JPEG, Buffer.from(`framed ${a}`)]);
for (const a of ["A", "B"]) writeFileSync(join(rec.caseDir(R2, n5), a, "changed.jpg"), shot(a));
const sent = async (p) => (await J.craftCall(R2, p, 1), api2.requests.at(-1).imageSha);
const framedSent = await sent({ ...pk5, images: { ...pk5.images, leftChanged: `${pk5.positions.left}/changed.jpg`, rightChanged: `${pk5.positions.right}/changed.jpg` } });
check(JSON.stringify(framedSent) === JSON.stringify([pk5.positions.left, pk5.positions.right].map((a) => sha12(shot(a).toString("base64")))), `craft on a framed packet sent ${JSON.stringify(framedSent)}, not the two framed shots`);
// Without frames (part 1's craft call on the same packet), the after screens.
check(JSON.stringify(craftReq.imageSha) === JSON.stringify([pk5.images.left, pk5.images.right].map((f) => sha12(readFileSync(join(rec.caseDir(R2, n5), f)).toString("base64")))), `craft without frames sent ${JSON.stringify(craftReq.imageSha)}, not the after screens`);

// ---- Calibration end to end: checkpoint 0's A/A (44 cases), a contrast run (4), probes, labels, variant 1 then 2.
const SC = "seed-calib", AA = "cp0", CON = "contrast";
const aaIds = Array.from({ length: 44 }, (_, i) => `c-aa-${i}`), conIds = Array.from({ length: 4 }, (_, i) => `c-con-${i}`);
for (const [run, list] of [[AA, aaIds], [CON, conIds]]) {
  const ps = J.positionsFor(list, SC);
  list.forEach((id, i) => {
    bankCase(id);
    const more = run === AA && i < 14, busy = run === AA && i >= 20 && i < 30;
    runCase(run, id, { changes: more ? { A: CHANGES.A, B: ["added box 'x'", "added box 'y'", "removed 'z'"] } : undefined, shapes: busy ? { A: 4, B: 9 } : undefined });
    K.writePacket(run, id, ps.get(id), exp(id));
    rec.put(judgeFile(run, id, "fidelity-1.json"), judged("left", 3, ps.get(id)));
    if (run === AA) rec.put(judgeFile(run, id, "craft.json"), judged("left", 3, ps.get(id)));
  });
}
const captures = [];
const u0 = up2();
const pairs = await C.assemble({ aa: AA, contrast: CON, seed: SC, capture: async (sc, cam) => (captures.push({ sc, cam }), JPEG) });
const fid = pairs.filter((p) => p.question === "fidelity"), craftPairs = pairs.filter((p) => p.question === "craft");
const firsts = fid.filter((p) => !p.swap), repeats = fid.filter((p) => p.swap);
const nothing = firsts.filter((p) => p.subset === "nothing");
const probeAudits = nothing.filter((p) => isAudit(SC, p.case)).length;
check(json(join(home, "labels", "pairs.json")).length === pairs.length, "pairs.json isn't written");
check(firsts.length === 56 && repeats.length === LOOP.calib.repeats && nothing.length === C.CALIB.nothing && firsts.filter((p) => p.subset === "more").length === C.CALIB.more,
  `label set: ${firsts.length} pairs, ${repeats.length} repeats, ${nothing.length} did-nothing, ${firsts.filter((p) => p.subset === "more").length} did-more`);
check(firsts.filter((p) => p.subset === "aa").length === 44 - 12 + 0 && firsts.filter((p) => p.subset === "contrast").length === 4, "A/A and contrast pairs");
check(repeats.every((r) => { const i = fid.findIndex((p) => p.id === r.id.replace(/:r$/, "")); return i >= 0 && i < C.CALIB.repeatGap + LOOP.calib.repeats && fid.indexOf(r) - i >= C.CALIB.repeatGap; }), "repeats aren't shown again well after their first showing");
check(craftPairs.length === 48 && craftPairs.slice(0, 10).every((p) => p.subset === "detail") && craftPairs.slice(10).every((p) => p.subset === "aa" || p.subset === "contrast"), "craft pairs don't lead with the 10 more-detail probes");
check(captures.length === 8 && captures.every((c) => JSON.stringify(c.sc) === JSON.stringify(BEFORE) && JSON.stringify(c.cam) === JSON.stringify(CAM)), "the did-nothing sides aren't the before-scene at the before camera");
const probe = nothing[0];
const probePk = json(judgeFile(C.CALIB.probeRun, probe.case, "packet.json"));
const nothingSide = probePk.positions.left === "B" ? "left" : "right";
check(probePk.changes[nothingSide].length === 0 && json(join(rec.caseDir(C.CALIB.probeRun, probe.case), "B", "after.scene.json")).shapes.length === BEFORE.shapes.length && existsSync(judgeFile(C.CALIB.probeRun, probe.case, "fidelity-1.json")),
  "a did-nothing probe's packet or verdict");
check(up2() - u0 === 8 + probeAudits + 4, `assemble made ${up2() - u0} calls, want ${8 + probeAudits + 4} (8 probes, ${probeAudits} audits, 4 contrast craft)`);
// A top-up ("more"): a contrast case judged since goes after the fidelity pairs; every pair already there keeps its id and place.
const pairsBefore = readFileSync(join(home, "labels", "pairs.json"), "utf8");
const extra = "c-con-extra", extraPos = J.positionsFor([extra], SC).get(extra);
bankCase(extra);
runCase(CON, extra);
K.writePacket(CON, extra, extraPos, exp(extra));
rec.put(judgeFile(CON, extra, "fidelity-1.json"), judged("left", 3, extraPos));
const added = C.topUpContrast(CON), topped = json(join(home, "labels", "pairs.json"));
check(added.length === 1 && added[0].id === `f:${CON}:${extra}` && topped.findIndex((p) => p.id === added[0].id) === fid.length && JSON.stringify(topped.filter((p) => p.id !== added[0].id)) === JSON.stringify(pairs),
  `the top-up moved a pair or added the wrong ones: ${JSON.stringify(added)}`);
check(C.topUpContrast(CON).length === 0, "a second top-up added the same pair again");
writeFileSync(join(home, "labels", "pairs.json"), pairsBefore);
rmSync(rec.caseDir(CON, extra), { recursive: true });
// The owner's labels: the first 20 fidelity pairs against the judge, the rest with it; every 7th slight; repeats as first given; 30 craft labels with the judge.
const judgeArm = (p) => { const f1 = json(judgeFile(p.run, p.case, "fidelity-1.json")); const f2p = judgeFile(p.run, p.case, "fidelity-2.json"); return J.combined(f1, existsSync(f2p) ? json(f2p) : undefined); };
const labels = [];
const label = (p, arm, strength) => labels.push({ id: `l${labels.length}`, pair: p.id, packet: `runs/${p.run}/cases/${p.case}/judge/packet.json`, subset: p.subset, question: p.question, side: "left", label: arm, strength, ms: 900, at: new Date(Date.now() + labels.length).toISOString() });
const given = new Map();
firsts.forEach((p, i) => {
  const left = json(judgeFile(p.run, p.case, "packet.json")).positions.left;
  const arm = i < 20 ? (left === "A" ? "B" : "A") : left;
  given.set(p.id, arm);
  label(p, arm, i % 7 === 6 ? "slight" : "clear");
});
for (const r of repeats) label(r, given.get(r.id.replace(/:r$/, "")), "clear");
for (const p of craftPairs.slice(0, 30)) label(p, json(judgeFile(p.run, p.case, "packet.json")).positions.left, "clear");
mkdirSync(join(home, "labels"), { recursive: true });
writeFileSync(join(home, "labels", "labels.jsonl"), labels.map((l) => JSON.stringify(l)).join("\n") + "\n");
const u1 = up2();
const c1 = await C.checkCalibration(1);
check(c1.outcome === "variant-2" && !c1.fidelity.pass && c1.craft.pass && c1.use.fidelity === null && c1.use.craft === 1 && up2() === u1, `variant 1: ${c1.outcome}, use ${JSON.stringify(c1.use)}, ${up2() - u1} calls (want 0)`);
check(c1.fidelity.slight.n === 8 && c1.fidelity.clear.n === 48 && c1.fidelity.self.n === 8 && c1.fidelity.self.share === 1 && c1.fidelity.bySubset.nothing?.n === 8, `variant 1 detail: ${JSON.stringify({ clear: c1.fidelity.clear, slight: c1.fidelity.slight, self: c1.fidelity.self })}`);
check(J.variants().fidelity === 1 && J.variants().craftCalibrated, "calibration.json's use isn't what judge.ts reads");
// Variant 2 re-judges only fidelity (craft passed on 1). A killed re-judge left most verdicts in judge/v2/: 6 are left to ask.
const fresh = firsts.slice(0, 6);
for (const p of firsts.slice(6)) rec.put(judgeFile(p.run, p.case, "v2/fidelity-1.json"), judged("left", 3, json(judgeFile(p.run, p.case, "packet.json")).positions, 2));
const c2 = await C.checkCalibration(2);
const v2reqs = api2.requests.slice(u1);
check(c2.outcome === "stop" && c2.use.fidelity === null && c2.use.craft === 1 && up2() - u1 === 6 && v2reqs.every((r) => r.firstUser.includes("First, for each side separately")), `variant 2: ${c2.outcome}, ${up2() - u1} calls (want 6 fidelity v2)`);
check(fresh.every((p) => { const j = json(judgeFile(p.run, p.case, "v2/fidelity-1.json")); return j.variant === 2 && j.judgeId === J.judgeId("fidelity", SERVED, 2); }) && json(judgeFile(fresh[0].run, fresh[0].case, "fidelity-1.json")).variant === 1,
  "variant 2's verdicts aren't in judge/v2/ with their own judgeId, or replaced the run's own");
check(json(J.calibrationFile()).checks.length === 2 && c2.health.kind === "calib" && !c2.health.pass, "calibration.json or its health row");

// ---- The canary, in a home of its own: 24 stable packets; 4 of the 20 picked now go the other way, so 16 agree.
const home2 = tempHome();
const ST = "old-run", SK = "seed-canary";
const stIds = Array.from({ length: 24 }, (_, i) => `c-st-${i}`);
const stPos = J.positionsFor(stIds, SK);
const stable = (id, w) => {
  rec.put(judgeFile(ST, id, "fidelity-1.json"), judged(w, 3, stPos.get(id)));
  rec.put(judgeFile(ST, id, "fidelity-2.json"), judged(w === "left" ? "right" : "left", 3, J.swap(stPos.get(id))));
};
for (const id of stIds) {
  bankCase(id);
  runCase(ST, id);
  K.writePacket(ST, id, stPos.get(id), exp(id));
  stable(id, "left");
}
const order = N.stablePackets(SK);
check(order.length === 24 && order.every((k) => k.arm === stPos.get(k.case).left), `stable packets: ${order.length}`);
for (const k of order.slice(0, 4)) stable(k.case, "right");
const u2 = up2();
const hc = await N.runCanary(SK);
const cl = readFileSync(join(home2, "history", "judge", "canary.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
check(up2() - u2 === 24 && hc.detail.agree === 16 && hc.detail.n === 20 && hc.detail.alarm && hc.detail.confirm?.n === 4 && hc.detail.confirm.agree === 4 && !hc.detail.confirm.confirmed && hc.pass,
  `canary: ${up2() - u2} calls, ${JSON.stringify(hc.detail)}`);
check(cl.length === 2 && cl[0].kind === "set" && cl[0].packets.length === 20 && cl[1].judgeId === J.judgeId("fidelity", SERVED), "canary.jsonl's set and run lines");
check(!N.canaryDue(SERVED) && N.canaryDue("claude-sonnet-5-5-20261101") && N.canaryDue(SERVED, Date.now() + N.CANARY_EVERY_MS), "canaryDue isn't weekly and on a served-model change");

// ---- Nothing a judge was sent names an arm, commit, tuning, model, persona, rating or `testing`; the fakes saw only the gateways' calls.
const all = [...api1.requests, ...api2.requests];
const leaked = all.filter((r) => LEAKS.some((s) => r.firstUser.includes(s)) || ARMISH.test(r.firstUser));
check(!leaked.length, `a judge request leaks: ${leaked[0]?.firstUser.slice(0, 400)}`);
check(all.every((r) => r.effort === "high" && r.model === "claude-sonnet-5-5" && r.ttls.every((t) => t === "5m")), "a judge call isn't Sonnet at high effort on the 5-minute cache");
const s2 = await gatewayStatus(gw2.url);
check(up2() === s2.calls && api2.requests.every((r) => r.role === "judge"), `fake API 2 got ${up2()} requests, its gateway made ${s2.calls} calls`);
check(existsSync(join(home, "history", "judge", "ids.json")) && Object.keys(json(join(home, "history", "judge", "ids.json"))).includes(J.judgeId("fidelity", SERVED, 2)), "ids.json doesn't hold the judgeIds seen");
await gw2.close();
await Promise.all([api1.close(), api2.close()]);
if (!existsSync(join(home, "meter", "calls.jsonl"))) fail("no meter file");

// The framed view (packet version 2): an edit off the final screen is framed for both arms, on the screen's shape.
const D = await import("../core/diff.ts");
const PR = await import("../judge/prompts.ts");
const cart = { v: 1, width: 4000, height: 2000, groups: {}, shapes: [{ id: "row", kind: "rect", box: { x: 2000, y: 1200, w: 300, h: 40 } }, { id: "home", kind: "frame", box: { x: 0, y: 0, w: 1280, h: 800 } }] };
const gone = { ...cart, shapes: cart.shapes.filter((x) => x.id !== "row") };
const f = D.changeFrame(cart, [gone, cart], 1.6);
const homeView = { x: 0, y: -60, w: 1280, h: 800 };
const within = (b, v) => b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h;
check(f && within({ x: 2000, y: 1200, w: 300, h: 40 }, f) && Math.abs(f.w / f.h - 1.6) < 1e-9 && D.changeFrame(cart, [cart], 1.6) === undefined, `the change frame is wrong: ${JSON.stringify(f)}`);
const bigger = { ...cart, shapes: cart.shapes.map((x) => (x.id === "home" ? { ...x, box: { ...x.box, h: 900 } } : x)) };
check(D.hidden(cart, gone, homeView) && !D.hidden(cart, bigger, homeView) && !D.hidden(cart, cart, homeView), "hidden() misses an edit off the screen, or flags one that's partly on it (a page grown past the screen)");
const step = { said: "delete this", meant: "the row is gone", hedged: false };
check(PR.fidelity[1](step, { should: [], mustNot: [] }, { left: [], right: [] }, true).includes("framed on the part of the board that changed") && !PR.fidelity[1](step, { should: [], mustNot: [] }, { left: [], right: [] }).includes("framed"), "the fidelity prompt doesn't name the framed images, or names them when there are none");
finish();
