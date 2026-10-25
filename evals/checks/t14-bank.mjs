// T14's acceptance check: driver sessions, the bank, top-ups, G4 continuations and the fixture bake,
// through the real bridge pages in one headless Chrome and the gateway's Claude processes on the fake
// API. 0 real calls: fake tokens only, HTTPS_PROXY at a closed port, every fake-API request answered
// by a canned reply, and the fake API's request count equal to the gateways' attempts. Canned
// driver, drawing, picture and judge replies are served in call order (sessions run one at a time).
// Port 5310 (the arm server).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t14-bank.mjs
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const work = mkdtempSync(join(home, "t14-"));
const env = cleanEnv();
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);

const { createServer } = await import("vite");
const { startFakeApi } = await import("../mock/fake-api.ts");
const { gatewayStatus, spawnGateway } = await import("../loop/client.ts");
const { launchChrome } = await import("../loop/chrome.ts");
const { readMeter } = await import("../loop/meter.ts");
const { paths } = await import("../loop/paths.ts");
const { put } = await import("../loop/record.ts");
const D = await import("../loop/drive.ts");
const B = await import("../loop/bank.ts");
const { bake } = await import("../loop/bake.ts");
const { systemPrompt } = await import("../core/driver.ts");
const S = await import("../core/scenarios.ts");
const { SYSTEM: JUDGE_SYSTEM } = await import("../judge/prompts.ts");
const { stubReply } = await import("../loop/stubs.ts");
const { promptOf } = await import("../../src/core/prompts.ts");
const { DEFAULTS } = await import("../../src/core/tuning.ts");
const { SCREEN } = await import("../../src/core/board.ts");

const PORT = 5310;
const RUN = "t14";
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const p = paths();
const bankFile = (id, f) => join(p.bankCase(id), f);
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// ---- Canned replies, by the system prompt each role sends (fake-api.ts --replies), in call order.
const turn = (o) => JSON.stringify({ stop: false, ...o });
const look = (steps, sat, saw = "the page changed") => turn({ saw, satisfaction: sat, feeling: "hm", meant: "", steps });
const say = (words, meant, extra = {}) => turn({ meant, steps: [{ say: words }], ...extra });
const DRIVER = [
  // S1 (held-out first-timer, notion): V3 clamped and dropped, V4 a view step after a draw.
  turn({ meant: "a notes page with a sidebar of pages down the left", steps: [{ say: "a notes app... with my pages listed down the left" }, { draw: "box", box: [-30, 120, 200, 400] }, { draw: "tap", at: [1100, 300] }, { scroll: [0, 100] }] }),
  look([{ zoom: "out" }], 4, "a grey sidebar appeared"), // a rating given on a look turn
  say("now a big title along the top", "a big title at the top of the page"), // its pause-fix beat not done (V11)
  look([{ undo: true }], 2, "a title showed up"), // undo: 0 calls
  say("put a wide cover picture across the top instead", "a wide cover image across the top of the page"),
  // S3 (tuning first-timer, bakery): a picture that fails twice (V7, then V12 filled), a suspend (V10), a hedge (V5), a long meant (V6), unparseable twice (V1).
  say("a bakery page... with a red kite picture up top", "a box with a picture of a red kite near the top"),
  say("another kite right next to it", "a second red kite picture right of the first", { saw: "a kite", satisfaction: 5, feeling: "love it" }),
  say("and the title should say fresh bread", "maybe the title says Fresh Bread?", { saw: "a second box", satisfaction: 3, feeling: "the kite is missing" }),
  say("add a footer at the bottom", "a footer bar ".repeat(40), { saw: "a title", satisfaction: 4, feeling: "good" }),
  "Hmm, I'm not sure what to do next.",
  "Still thinking.",
  // S2 (held-out explorer on site:notion): then only looking around (V2).
  turn({ meant: "the sidebar turns dark grey", testing: "whether it finds the sidebar from a circle alone", steps: [{ say: "make this darker" }, { draw: "circle", around: [10, 40, 200, 500] }] }),
  ...[1, 2, 3, 4].map(() => look([{ scroll: [200, 0] }], 4, "the sidebar is dark now")),
  // The top-up's two fork sends, then G4's two continuation sends.
  say("add a little note in the corner", "a sticky note in the lower right corner"),
  say("make the note yellow", "the note is yellow", { saw: "a note", satisfaction: 4, feeling: "fine" }),
  say("take that extra box away", "the extra box goes away", { saw: "there's an extra box", satisfaction: 2, feeling: "hm" }),
  say("add a note in the corner", "a sticky note in the lower right", { saw: "still there", satisfaction: 3, feeling: "meh" }),
];
const NOTE = 'shape(note, rect, 900 600 300 120, "small yellow sticky note in the lower right corner", fill:#fff3bf)';
const KITE2 = 'shape(kite2, rect, 450 100 300 200, "second box with a red kite picture next to the first", fill:#ffffff)\ndrawing(kite2, "a red kite")';
const TITLE = 'shape(title, rect, 100 20 600 60, "title of the bakery page in big letters", fill:#ffffff)\ntext(title, "Fresh Bread", size:l)';
const DRAW = [
  'shape(side, rect, 20 40 240 700, "sidebar listing the pages of the notes workspace", fill:#f1f3f5)',
  'shape(title, rect, 300 40 600 80, "big bold title of the notes page at the top", fill:#ffffff)\ntext(title, "My notes", size:xl)',
  'shape(cover, rect, 280 20 700 160, "wide cover image strip across the top of the notes page", fill:#e7f5ff)',
  'shape(kite1, rect, 100 100 300 200, "box with a picture of a red kite flying", fill:#ffffff)\ndrawing(kite1, "a red kite")',
  KITE2, KITE2, TITLE, TITLE,
  'shape(footer, rect, 0 720 1280 80, "footer bar along the bottom with the bakery address", fill:#f1f3f5)',
  "shape(side, fill:#495057)",
  ...Array(30).fill(NOTE),
];
const SVG = stubReply("picture");
const replies = join(work, "replies");
mkdirSync(replies);
const can = (role, system, r) => writeFileSync(join(replies, `${role}.${sha12(system)}.${Array.isArray(r) ? "json" : "txt"}`), Array.isArray(r) ? JSON.stringify(r) : r);
can("driver", systemPrompt(), DRIVER);
can("draw", promptOf("draw", DEFAULTS).system(true, SCREEN.w, SCREEN.h, 0, SCREEN.w), DRAW);
can("draw-refs", promptOf("resolve", DEFAULTS).system, '{"refs": []}');
can("picture", promptOf("picture", DEFAULTS).system(DEFAULTS), [SVG, "!limit", "!limit", ...Array(40).fill(SVG)]);
// The expectation and the miss check share the judges' system prompt: one reply answers both.
can("judge", JUDGE_SYSTEM, '{"should": ["the page shows what they asked for"], "mustNot": ["other parts of the page change"], "met": "partly", "why": "canned miss check"}');

// ---- The fake API, a gateway on it, the arm server (its /api/model forwarded to the gateway in use), one Chrome.
const tokens = join(work, "tokens.env");
writeFileSync(tokens, `${[1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-t14-fake-${randomBytes(6).toString("hex")}`).join("\n")}\n`);
chmodSync(tokens, 0o600);
const api = await startFakeApi({ replies });
const gw = await spawnGateway({ home, tokens, mockApi: api.url });
let target = gw.url;
const forward = {
  name: "t14-forward",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith("/api/model")) return next();
      const body = [];
      for await (const c of req) body.push(c);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k === "content-type" || k.startsWith("x-rt-")));
      const r = await fetch(`${target}/api/model`, { method: "POST", headers, body: Buffer.concat(body) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      for await (const c of r.body) res.write(c);
      res.end();
    });
  },
};
const vite = await createServer({
  root: ROOT, configFile: false, envDir: mkdtempSync(join(work, "env-")), cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error", plugins: [forward],
  server: { host: "127.0.0.1", port: PORT, strictPort: true, watch: null, hmr: false },
});
await vite.listen();
const origin = `http://127.0.0.1:${PORT}`;
const blocked = [];
const chrome = await launchChrome({ dir: join(work, "chrome"), onBlocked: (url) => blocked.push(url) });
const pageLog = [];
async function page(arm) {
  const pg = await chrome.newPage(origin, { run: RUN, case: "-", arm, slot: 0 });
  await pg.goto(`${origin}/evals/bridge/?sha=c0ffee`);
  // What each page did, to show every case starts from a reloaded page.
  const [reload, evaluate] = [pg.reload, pg.eval];
  pg.reload = () => (pageLog.push({ arm, ev: "reload" }), reload());
  pg.eval = (x) => (x.startsWith("rtEval.send(") && pageLog.push({ arm, ev: "send", case: pg.labels.case }), evaluate(x));
  return pg;
}
const A = await page("A");
const Bp = await page("B");

let crashed;
try {
  // Planted faults: a clock jump during one send (V10), a dispatch limit no fork can meet until the second top-up send (V9).
  const realNow = Date.now;
  const hook = (id, attempt) => {
    Date.now = realNow;
    if (id === "c-b1-s02-3" && attempt === 1) {
      let n = 0;
      Date.now = () => realNow() + (n++ ? 15_000 : 0);
    }
    if (id === "c-u1-s01-2") put(p.machine, { dispatchLimitMs: 25 });
  };
  const ctx = { run: RUN, arms: { A: { sha: "c0ffee", tuningId: "default" }, B: { sha: "beef", tuningId: "default" } }, harnessTag: "eval-harness-t14", hook };

  // ---- A 3-session bank: two held-out sessions (the explorer listed first) and a tuning one.
  const S1 = { id: "g-notion-typ-k1", set: "heldout-gate", persona: "first-timer", style: "typical", target: "notion", start: "blank", sends: 3, seed: 101 };
  const S2 = { id: "g-site-notion-poi-k2", set: "heldout-gate", persona: "explorer", style: "pointer", start: "site:notion", sends: 2, seed: 201 };
  const S3 = { id: "t-bakery-typ-k3", set: "tuning", persona: "first-timer", style: "typical", target: "bakery", start: "blank", sends: 5, seed: 301 };
  const built = await B.buildBank(ctx, [{ A }], { bank: "b1", sets: [{ set: "heldout-gate", sessions: [S2, S1] }, { set: "tuning", sessions: [S3] }] });
  const marker = (n) => json(join(p.home, "bank", "sessions", `b1-s0${n}.json`));
  check(marker(1).scenario === S1.id && marker(2).scenario === S3.id && marker(3).scenario === S2.id, "first-timers didn't run first");
  check(json(join(p.home, "bank", "gates.json")).fails.length && built.fails.length, "the gates weren't computed (a 3-session bank fails coverage)");
  // A refused bank is used by nothing after it until accepted; a bigger rebuild keeps every session's number (only new ones run).
  check(/failed §2\.3/.test(B.bankRefuses() ?? "") && B.acceptBank().length && !B.bankRefuses(), "a refused bank isn't refused downstream, or accepting it doesn't clear that");
  const numbers = (t) => new Map(B.sessionsOf([{ set: "tuning", sessions: t }, { set: "heldout-gate", sessions: 2 }, { set: "heldout-chart", sessions: 2 }]).map((x) => [x.s.id, x.n]));
  const [small, big] = [numbers(8), numbers(12)];
  check([...small].every(([id, n]) => big.get(id) === n) && new Set(big.values()).size === big.size, "a rebuild with more tuning sessions renumbers sessions");
  const DONE = ["c-b1-s01-1", "c-b1-s01-2", "c-b1-s01-3", "c-b1-s02-1", "c-b1-s02-3", "c-b1-s03-1"];
  const doneNow = readdirSync(p.bankCases).filter((d) => existsSync(join(p.bankCases, d, "done"))).sort();
  check(JSON.stringify(doneNow) === JSON.stringify(DONE), `banked cases ${doneNow.join(" ")}`);
  const FILES = ["case.json", "input.json", "before.scene.json", "before-ink.jpg", "driver-before.jpg", "driver-now.jpg", "driver.json", "meant.json", "expectation.json", "miss.json", "champion-after.jpg", "champion.json", "replies.json", "readings.json"];
  const LAST = new Set(["c-b1-s01-3"]);
  for (const id of DONE) {
    const missing = [...FILES, ...(LAST.has(id) ? [] : ["rating.json"])].filter((f) => !existsSync(bankFile(id, f)));
    check(!missing.length, `${id} lacks ${missing.join(", ")}`);
    if (LAST.has(id)) check(!existsSync(bankFile(id, "rating.json")), `${id}, a session's last send, has a rating`);
    check(json(bankFile(id, "miss.json")).met === "partly" && json(bankFile(id, "expectation.json")).should.length, `${id}: no canned expectation or miss check`);
    const c = json(bankFile(id, "champion.json"));
    check(!c.opsFailed && !c.picsFailed, `${id}: a harness event counted as a product failure (${JSON.stringify(c)})`);
  }
  check(json(bankFile("c-b1-s01-1", "rating.json")).satisfaction === 4 && json(bankFile("c-b1-s03-1", "rating.json")).satisfaction === 4, "a rating given on a look turn isn't on the send it rates");
  check(json(bankFile("c-b1-s02-1", "rating.json")).satisfaction === 5 && json(bankFile("c-b1-s01-2", "rating.json")).satisfaction === 2, "ratings aren't from the next turn");
  check(json(bankFile("c-b1-s01-1", "replies.json")).some((r) => r.role === "draw" && r.cacheFile), "replies.json lacks the champion's drawing reply");

  // The held-out site: S1's page after send 3, the start S2's case began from.
  const site = p.resume("notion");
  check(existsSync(site) && JSON.stringify(json(bankFile("c-b1-s03-1", "before.scene.json"))) === JSON.stringify(json(site)), "S2 didn't start on the site:notion page S1 saved");
  check(json(site).shapes.some((s) => s.id === "cover"), "the saved page isn't the first-timer's page after send 3");

  // Undo: S1's third case starts from the scene before its second (restored by the harness), and its only product calls are its
  // send's: the drawing call and its resolver (Jev's by default, with the add hint), no picture redrawn by the restore.
  check(JSON.stringify(json(bankFile("c-b1-s01-3", "before.scene.json"))) === JSON.stringify(json(bankFile("c-b1-s01-2", "before.scene.json"))), "undo didn't restore the previous scene");
  const meter = () => readMeter(p.calls).filter((l) => "mode" in l);
  const of = (id) => meter().filter((l) => l.case === id);
  const s13 = of("c-b1-s01-3");
  check(s13.filter((l) => l.role === "driver").length === 2 && s13.filter((l) => l.arm).every((l) => ["draw", "draw-refs", "draw-refs-jev", "draw-add", "draw-think"].includes(l.role)) && s13.filter((l) => l.role === "draw").length === 1,
    `the undo case's calls: ${s13.map((l) => l.role).join(", ")}`);

  // V-events, from the sessions' files.
  const d11 = json(bankFile("c-b1-s01-1", "driver.json"));
  check(d11.clamped === 1 && d11.dropped.length === 2 && json(bankFile("c-b1-s01-1", "case.json")).flags.join() === "clamped,dropped", `V3/V4 not recorded: ${JSON.stringify({ clamped: d11.clamped, dropped: d11.dropped })}`);
  check(json(join(p.bankCases, "c-b1-s02-2.void", "void.json")).why.startsWith("V7"), "V7: the twice-failed picture send isn't void");
  const c23 = json(bankFile("c-b1-s02-3", "case.json"));
  check(c23.flags.includes("filled") && c23.hedged && json(bankFile("c-b1-s02-3", "meant.json")).hedged, `V12 filled / V5 hedged not on the case: ${JSON.stringify(c23)}`);
  const kite2 = json(bankFile("c-b1-s02-3", "before.scene.json")).shapes.find((s) => s.id === "kite2");
  check(kite2?.picture?.done && kite2.picture.els.length, "the failed picture wasn't filled from the recorded reply");
  check(!of("c-b1-s02-3").some((l) => l.role === "picture"), "the filled case redrew its picture");
  check(of("c-b1-s02-3").filter((l) => l.role === "draw").length === 2, "the suspended send wasn't replayed once (V10)");
  check(json(join(p.bankCases, "c-b1-s02-4.void", "void.json")).why.startsWith("V6"), "V6: the 480-character meant isn't void");
  check(/^V1/.test(marker(2).ended) && /^V2/.test(marker(3).ended), `sessions ended ${marker(2).ended} / ${marker(3).ended}`);

  // ---- V8 (a saved page that doesn't round-trip) and V12 (a start that still needs a picture): refused, 0 calls.
  const page0 = { id: "page", kind: "frame", box: { x: 0, y: 0, w: 1280, h: 800 }, description: "the Home page, the one page of this site so far", style: {}, text: { words: "Home" } };
  const box = (id, x, extra = {}) => ({ id, kind: "rect", box: { x, y: 100, w: 200, h: 100 }, description: `a box called ${id} on the page`, style: {}, ...extra });
  put(p.resume("dentist"), { v: 1, width: 1280, height: 800, shapes: [page0, box("dup", 100), box("dup", 400)], groups: {} });
  put(p.resume("repo"), { v: 1, width: 1280, height: 800, shapes: [page0, box("logo", 100, { drawing: "a cat" })], groups: {} });
  const fresh1 = (target, seed) => ({ id: `f-${target}-k`, set: "fresh", persona: "first-timer", style: "typical", target, start: `resume:${target}`, sends: 1, seed });
  const before0 = meter().length;
  const v8 = await D.driveSession(ctx, fresh1("dentist", 401), { A }, { bank: "b2", session: 1, deposit: true });
  const v12 = await D.driveSession(ctx, fresh1("repo", 501), { A }, { bank: "b2", session: 2, deposit: true });
  check(v8.ended === "V8" && v12.ended === "V12" && meter().length === before0 && !readdirSync(p.bankCases).some((d) => d.startsWith("c-b2")), `V8/V12 starts: ${v8.ended} / ${v12.ended}`);

  // ---- A top-up: live fork sends continuing on A; the first breaks the dispatch limit (V9), the second is deposited.
  put(p.machine, { dispatchLimitMs: 0 });
  const tops = await B.topUp(ctx, [{ A, B: Bp }], 2, 1);
  check(tops.join() === "c-u1-s01-1,c-u1-s01-2", `top-up cases ${tops.join(", ")}`);
  check(existsSync(bankFile("c-u1-s01-2", "done")) && existsSync(join(p.bankCases, "c-u1-s01-1.void")), "the fork point wasn't deposited (or the V9 one was)");
  const runCase = (id, ...f) => join(p.run(RUN), "cases", id, ...f);
  check(["A/result.json", "B/after.scene.json", "A/after.jpg", "fork.json", "done"].every((f) => existsSync(runCase("c-u1-s01-2", f))), "the fork's arms aren't in the run");
  check(json(runCase("c-u1-s01-2", "fork.json")).order.length === 2 && existsSync(join(p.run(RUN), "cases", "c-u1-s01-1.void", "void.json")), "fork.json or the voided fork missing");

  // ---- G4: two sends continuing on B's result of S1's second case, each forked to both arms from the same scene.
  const origin2 = "c-b1-s01-2";
  const b2 = json(bankFile(origin2, "before.scene.json"));
  const bAfter = { ...b2, shapes: [...b2.shapes, box("bonly", 900, { description: "an extra box only arm B drew on the page" })] };
  const reqs0 = api.requests.length;
  const k = await D.continueFrom(ctx, { A, B: Bp }, origin2, { after: bAfter, camera: json(bankFile(origin2, "input.json")).camera }, 2);
  check(k.cases.join() === `${origin2}-k1,${origin2}-k2`, `continuation cases ${k.cases.join(", ")}`);
  const k1 = json(runCase(`${origin2}-k1`, "before.scene.json"));
  check(k1.shapes.some((s) => s.id === "bonly"), "the continuation didn't start on B's result");
  check(JSON.stringify(json(runCase(`${origin2}-k2`, "before.scene.json"))) === JSON.stringify(json(runCase(`${origin2}-k1`, "B", "after.scene.json"))), "the second continuation send isn't on B's result of the first");
  for (const c of k.cases) check(["A/result.json", "B/result.json", "fork.json", "input.json", "meant.json", "done"].every((f) => existsSync(runCase(c, f))), `${c} isn't a forked run case`);
  const contDriver = api.requests.slice(reqs0).find((r) => r.role === "driver");
  check(contDriver?.firstUser.includes("Your sends so far:") && contDriver.firstUser.includes("a notes page with a sidebar of pages down the left") && contDriver.firstUser.includes("2. You said"),
    "the continuation driver's history wasn't rebuilt from the origin session");

  // ---- Every case started from a reloaded bridge page; every V-event is a harness event.
  for (const arm of ["A", "B"]) {
    const log = pageLog.filter((x) => x.arm === arm);
    const bad = log.filter((x, i) => x.ev === "send" && !log.slice(0, i).reverse().find((y) => y.ev === "send" || y.ev === "reload")?.ev.startsWith("reload"));
    check(log.some((x) => x.ev === "send") && !bad.length, `arm ${arm}: sends without a reload before them (${bad.map((x) => x.case).join(", ")})`);
  }
  const events = readFileSync(join(p.run(RUN), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const vs = new Set(events.map((e) => e.v));
  const missingV = Array.from({ length: 12 }, (_, i) => `V${i + 1}`).filter((v) => !vs.has(v));
  check(!missingV.length, `no harness event for ${missingV.join(", ")}`);

  // ---- The fixture bake: grid covered on the gateway; then a capped gateway stops it.
  const full = await bake(A, ["clowns", "grid"]);
  const gridKey = Object.keys(full.pictures).find((key) => key.startsWith("avatar|person with curly hair|"));
  check(!full.missing.length && Object.keys(full.pictures).length === 9 && gridKey && existsSync(join(p.out, "pictures.json")), `bake: missing ${full.missing.join(", ")}`);
  check(json(join(p.out, "pictures.json"))[gridKey]?.els.length, "out/pictures.json lacks grid's doodle");
  const home2 = mkdtempSync(join(work, "capped-"));
  const capped = await spawnGateway({ home: home2, tokens, mockApi: api.url, cap: 2 });
  target = capped.url;
  const part = await bake(A, ["clowns", "grid"]);
  const st = await gatewayStatus(capped.url);
  check(part.stopped && st.calls === 2 && st.capReached && part.missing.includes(gridKey) && Object.keys(part.pictures).length === 2, `the bake didn't stop at the cap: ${JSON.stringify({ stopped: part.stopped, calls: st.calls, pictures: Object.keys(part.pictures).length })}`);
  await capped.close();

  // ---- 0 real calls: every fake-API request was one of the gateways' attempts, each answered by a canned reply.
  const attempts = (file) => readMeter(file).filter((l) => l.mode === "live" && l.shared !== "follower").reduce((n, l) => n + 1 + (l.retries ?? 0), 0);
  const want = attempts(p.calls) + attempts(paths(home2).calls);
  check(api.requests.length === want, `the fake API got ${api.requests.length} requests for ${want} gateway attempts`);
  check(!api.requests.some((r) => r.role === "?"), `requests no canned reply answered: ${api.requests.filter((r) => r.role === "?").length}`);
  check(!blocked.length, `Chrome blocked ${blocked.join(", ")}`);
} catch (err) {
  crashed = err;
} finally {
  await chrome.close();
  await gw.close();
  await vite.close();
  await api.close();
}
if (crashed) fail(`crashed: ${crashed?.stack ?? crashed}`);

// ---- The gates on a crafted full bank: the planned one passes, the same with every fifth meant hedged is refused.
const home3 = mkdtempSync(join(work, "gates-"));
const p3 = paths(home3);
const planned = [...S.TUNING, ...S.HELDOUT_GATE, ...S.HELDOUT_CHART].flatMap((s, i) => S.plan(s).map((x) => ({ s, x, id: `c-g-s${i + 1}-${x.send}` })));
const write = (c, hedged) => {
  const dir = p3.bankCase(c.id);
  put(join(dir, "case.json"), { id: c.id, set: c.s.set, scenario: c.s.id, persona: c.s.persona, style: c.s.style, start: c.s.start, ...(c.x.beat ? { beat: c.x.beat.id } : {}), ask: c.x.ask, seed: c.s.seed,
    originSession: `g-s${c.s.id}`, send: c.x.send, championSha: "c0ffee", tuningId: "default", harnessTag: "h", configId: "c", recordedAt: "2026-10-16T00:00:00Z", hedged, beatDone: true, flags: [] });
  put(join(dir, "driver.json"), { raw: "{}", turn: { meant: "m", steps: [{ say: "so this one" }], stop: false, hedged }, retries: 0, dropped: [], clamped: 0, reqHash: "h", view: { x: 0, y: 0, w: 1280, h: 800 }, looks: [] });
  put(join(dir, "readings.json"), { marks: [] });
  put(join(dir, "done"), "x\n");
};
planned.forEach((c) => write(c, false));
const clean = B.bankGates(p3);
check(clean.cases === 224 && !clean.fails.length, `the planned bank fails its gates: ${clean.fails.join("; ")}`);
planned.forEach((c, i) => i % 5 === 0 && write(c, true));
check(B.bankGates(p3).fails.some((f) => f.startsWith("hedged")), "a bank with 20% hedged meant isn't refused");
finish();
