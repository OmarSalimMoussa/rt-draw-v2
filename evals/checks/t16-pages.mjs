// T16's acceptance check: Eval HQ's endpoints on a temp RT_EVAL_HOME (the history from
// its worktree, else from `git show eval/history:` in a temp repo; run files never outside
// the home; labels appended; human sends recorded, on the owner's dev server too; intake's
// cards refused for what isn't one) and the labeling page driven by keyboard in one
// headless Chrome, every /api/* request passed through a counted stub to the real
// endpoints. 0 model calls: there is no model endpoint on this server, and the stubs
// answer only /api/eval/*. intake's cards themselves are t23's.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t16-pages.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "vite";
import { openChrome } from "./cdp.mjs";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const PORT = 5250; // this task's ports are 5250–5259
const GIT_PORT = 5251;
const DEV_PORT = 5252;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (f, text) => (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, text));
const lineCount = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const home = tempHome();
const { evalPages, HISTORY_FILES } = await import("../pages/plugin.ts");
const { recordApi } = await import("../pages/record.ts");
const vite = (root, port, configFile, plugins = [evalPages(root)]) =>
  createServer({ root, configFile: configFile ?? false, plugins: configFile ? [] : plugins, cacheDir: join(home, "vite-cache", String(port)), logLevel: "error", clearScreen: false, server: { port, strictPort: true, host: "127.0.0.1", watch: null } });
const server = await vite(ROOT, PORT, join(ROOT, "evals/pages.vite.config.ts"));
await server.listen();
const base = `http://127.0.0.1:${PORT}`;
const get = (path, b = base) => fetch(b + path);
const postJson = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---- The owner's dev server takes only the record endpoint (testers' cards stay on the PGX) and builds the driver and bridge.
const viteConfig = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
check(/plugins: \[[^\]]*recordApi\(\)/.test(viteConfig) && !viteConfig.includes("evalPages") && /\["driver", "bridge"\]/.test(viteConfig) && !/"label"|"progress"|"review"/.test(viteConfig),
  "vite.config.ts doesn't take recordApi() alone, or builds an Eval HQ page");
const pagesConfig = readFileSync(join(ROOT, "evals/pages.vite.config.ts"), "utf8");
check(/plugins: \[evalPages\(root\), noVoice\]/.test(pagesConfig), "evals/pages.vite.config.ts doesn't serve evalPages(root) with voice off");

// ---- /api/eval/history from the worktree: every §5.3 file as written, absent ones as null.
const fake = Object.fromEntries(HISTORY_FILES.map((f) => [f, f.endsWith(".jsonl") ? `${JSON.stringify({ file: f, n: 1 })}\n${JSON.stringify({ file: f, n: 2 })}\n` : f.endsWith(".json") ? JSON.stringify([{ file: f }]) : `# ${f}\n- [ ] one open item\n`]));
for (const [f, text] of Object.entries(fake)) put(join(home, "history", f), text);
put(join(home, "history", "ledger.md"), "# ledger\n");
let h = await (await get("/api/eval/history")).json();
check(h.source === "worktree", `history source is ${h.source}, not the worktree`);
for (const [f, text] of Object.entries(fake)) check(h.files?.[f] === text, `/api/eval/history's ${f} isn't the worktree's file`);
check(["epochs.jsonl", "decisions.jsonl", "checkpoints.jsonl", "budget.jsonl", "health.jsonl", "anchors.json", "eras.json", "markers.jsonl"].every((f) => HISTORY_FILES.includes(f)), "a §5.3 file is missing from HISTORY_FILES");
check(typeof h.status?.disk?.freeGb === "number" && "daysLeft" in h.status.disk, `no free disk / days left in the status: ${JSON.stringify(h.status)}`);
check((await (await get("/api/eval/history?f=ledger.md")).text()) === "# ledger\n", "?f=ledger.md isn't the ledger");
check((await get("/api/eval/history?f=../state.json")).status === 403, "?f=../state.json wasn't refused");

// ---- No worktree: `git show eval/history:<file>` in the repo the server serves (a temp repo here).
const repo = mkdtempSync(join(tmpdir(), "rt-eval-check-repo-"));
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { env: cleanEnv({ GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@example.invalid", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@example.invalid" }), stdio: "pipe" });
git("init", "-q");
git("checkout", "-q", "--orphan", "eval/history");
const onBranch = { "epochs.jsonl": '{"epoch":1,"from":"git"}\n', "eras.json": '[{"era":1}]' };
for (const [f, text] of Object.entries(onBranch)) put(join(repo, f), text);
git("add", "-A");
git("commit", "-q", "-m", "history");
tempHome(); // a home with no history/ worktree
const gitServer = await vite(repo, GIT_PORT);
await gitServer.listen();
h = await (await get("/api/eval/history", `http://127.0.0.1:${GIT_PORT}`)).json();
check(h.source === "git", `history source is ${h.source} without a worktree, not git`);
for (const [f, text] of Object.entries(onBranch)) check(h.files?.[f] === text, `git fallback: ${f} isn't the branch's file`);
check(h.files?.["decisions.jsonl"] === null, "git fallback: a file not on the branch isn't null");
await gitServer.close();
process.env.RT_EVAL_HOME = home;
process.env.RT_DATA_DIR = join(home, "data");

// ---- /api/eval/file: run files, the bank fallback and the reply cache; nothing outside the home.
put(join(home, "runs/r1/cases/c1/A/result.json"), '{"calls":[]}');
put(join(home, "bank/cases/c1/before-ink.txt"), "banked");
put(join(home, "cache/replies/abc.json"), '{"reply":"x"}');
put(join(home, "state.json"), '{"secret":"state"}');
const outside = join(dirname(home), `outside-${process.pid}.txt`);
writeFileSync(outside, "outside the home");
symlinkSync(outside, join(home, "runs/r1/link.txt"));
symlinkSync("/", join(home, "runs/r1/up"));
const served = async (q) => {
  const r = await get(`/api/eval/file?${q}`);
  return { status: r.status, text: await r.text() };
};
check((await served("run=r1&case=c1&f=A/result.json")).text === '{"calls":[]}', "a run's case file isn't served");
check((await served("run=r1&case=c1&f=before-ink.txt")).text === "banked", "a case's banked file isn't served through the run");
check((await served("f=cache/replies/abc.json")).text === '{"reply":"x"}', "a reply cache file isn't served");
for (const q of ["f=../" + outside.split("/").pop(), "f=/etc/passwd", "run=../../../../etc&f=passwd", "run=r1&case=..&f=state.json", "case=../../..&f=etc/passwd", "f=state.json", "run=r1&f=link.txt", "run=r1&f=up/etc/hostname", "f=runs/r1/../../state.json", "run=r1&f=%2e%2e/%2e%2e/state.json"]) {
  const r = await served(q);
  check(r.status === 403 && !/outside the home|secret|root:x/.test(r.text), `/api/eval/file?${q} wasn't refused (${r.status} ${r.text.slice(0, 60)})`);
}

// ---- Calibration pairs and labels: one POST appends exactly one line.
const { runScript } = await import("../../src/core/ops.ts");
const { asPage } = await import("../../src/core/board.ts");
const scene = runScript(asPage('shape(title, rect, 100 100 600 120, "the shop\'s title across the top")\ntext(title, "Toy shop")', "page", "Home")).scene.toJSON();
const packet = (id, left, right) => ({ case: id, said: `make [ink 1] this bigger (${id})`, meant: `the title of ${id} twice as big`, hedged: id === "c2", targetParts: id === "c1" ? "a toy shop: home, shop, cart" : undefined,
  expectation: { should: ["the title is bigger"], mustNot: ["nothing else moves"] }, images: { before: "before-ink.jpg", left: `${left}/after.jpg`, right: `${right}/after.jpg` },
  changes: { left: [`resized 'Toy shop' (${left})`], right: [`text changed in 'Toy shop' (${right})`] }, positions: { left, right } });
const PAIRS = [
  { id: "p0", run: "calib1", case: "c0", question: "fidelity", subset: "aa" },
  { id: "p1", run: "calib1", case: "c1", question: "fidelity", subset: "aa" },
  { id: "p2", run: "calib1", case: "c2", question: "fidelity", subset: "repeat", swap: true },
  { id: "p3", run: "calib1", case: "c3", question: "fidelity", subset: "contrast" },
  { id: "p4", run: "calib1", case: "c1", question: "craft", subset: "aa" },
];
const positions = { c0: ["A", "B"], c1: ["B", "A"], c2: ["A", "B"], c3: ["B", "A"] };
for (const [c, [l, r]] of Object.entries(positions)) put(join(home, `runs/calib1/cases/${c}/judge/packet.json`), JSON.stringify(packet(c, l, r)));
put(join(home, "labels/pairs.json"), JSON.stringify(PAIRS));
const labels = join(home, "labels/labels.jsonl");
const pairs0 = await (await get("/api/eval/pairs")).json();
check(pairs0.pairs?.length === 5 && pairs0.pairs.at(-1).question === "craft", `GET /api/eval/pairs gave ${JSON.stringify(pairs0).slice(0, 120)}`);
check(!JSON.stringify(pairs0).match(/"positions"|"subset"|"aa"|"repeat"|"contrast"/), "the pairs sent to the page carry positions or subsets");
const r0 = await (await postJson("/api/eval/label", { pair: "p0", question: "fidelity", side: "right", strength: "clear", ms: 1234 })).json();
check(lineCount(labels) === 1, `one POST /api/eval/label wrote ${lineCount(labels)} lines`);
const l0 = JSON.parse(readFileSync(labels, "utf8").split("\n")[0]);
check(l0.id === r0.id && l0.label === "B" && l0.side === "right" && l0.strength === "clear" && l0.question === "fidelity" && l0.ms === 1234 && l0.packet === "runs/calib1/cases/c0/judge/packet.json" && l0.at, `the label line is ${JSON.stringify(l0)}`);
check((await postJson("/api/eval/label", { pair: "p0", question: "craft", side: "left", strength: "clear" })).status === 400 && lineCount(labels) === 1, "a label with the wrong question was written");
// The illustrations round: a label set of its own (labels/illustrations/), the calibration's untouched; an unknown set is refused.
put(join(home, "labels/illustrations/pairs.json"), JSON.stringify([{ id: "i0", run: "calib1", case: "c3", question: "fidelity", subset: "illustrations" }]));
const ilLabels = join(home, "labels/illustrations/labels.jsonl");
const ip = await (await get("/api/eval/pairs?set=illustrations")).json();
check(ip.pairs?.length === 1 && ip.pairs[0].id === "i0" && ip.progress.clearGoal === 30 && ip.progress.craftGoal === 15 && ip.progress.labelled === 0, `GET /api/eval/pairs?set=illustrations gave ${JSON.stringify(ip).slice(0, 160)}`);
const ir = await postJson("/api/eval/label", { pair: "i0", question: "fidelity", side: "left", strength: "clear", ms: 800, set: "illustrations" });
check(ir.status === 200 && lineCount(ilLabels) === 1 && JSON.parse(readFileSync(ilLabels, "utf8")).label === "B" && lineCount(labels) === 1, `an illustrations label went to ${lineCount(ilLabels)} / ${lineCount(labels)} lines`);
check((await postJson("/api/eval/label", { pair: "p0", question: "fidelity", side: "left", strength: "clear", set: "illustrations" })).status === 404, "a calibration pair was labelled in the illustrations set");
await postJson("/api/eval/label", { undo: true, set: "illustrations" });
check(lineCount(ilLabels) === 2 && lineCount(labels) === 1 && (await (await get("/api/eval/pairs?set=illustrations")).json()).pairs.length === 1, "undo in the illustrations set didn't stay in it");
check((await get("/api/eval/pairs?set=../labels")).status === 404 && (await postJson("/api/eval/label", { pair: "p0", question: "fidelity", side: "left", set: "nope" })).status === 404 && lineCount(labels) === 1, "an unknown label set wasn't refused");

// ---- /api/eval/record and /api/eval/human: the owner's sends under human/, meant written back.
const sendBody = { input: "make the title bigger", strokes: [{ id: 1, points: [[120, 160, 0], [300, 170, 40], [520, 150, 80]], t0: 0, t1: 80 }], scene, view: { x: 0, y: -60, w: 1280, h: 800 }, at: 1760000000000 };
const rec = await (await postJson("/api/eval/record", sendBody)).json();
const files = readdirSync(join(home, "human"));
check(files.length === 1 && files[0] === `${rec.id}.json`, `POST /api/eval/record wrote ${JSON.stringify(files)}`);
const stored = JSON.parse(readFileSync(join(home, "human", files[0]), "utf8"));
check(stored.input === sendBody.input && JSON.stringify(stored.scene) === JSON.stringify(scene) && stored.view.y === -60 && stored.strokes.length === 1, "the recorded send isn't what was posted");
check((await postJson("/api/eval/record", { strokes: [] })).status === 400 && readdirSync(join(home, "human")).length === 1, "a send without input or scene was recorded");
// The owner's dev server answers the draw playground's ?record=1 the same, and nothing else of Eval HQ.
const devServer = await vite(ROOT, DEV_PORT, undefined, [recordApi()]);
await devServer.listen();
const dev = `http://127.0.0.1:${DEV_PORT}`;
const devRec = await (await fetch(`${dev}/api/eval/record`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sendBody) })).json();
check(/^h-/.test(devRec.id ?? "") && readdirSync(join(home, "human")).length === 2, `the dev server's POST /api/eval/record gave ${JSON.stringify(devRec)}`);
for (const path of ["/api/eval/intake", "/api/eval/history", "/api/eval/human"]) {
  const r = await fetch(dev + path);
  check(!(r.headers.get("content-type") ?? "").includes("application/json"), `the dev server answers ${path}`);
}
await devServer.close();
rmSync(join(home, "human", `${devRec.id}.json`), { force: true });

// ---- Intake's endpoints with no pull yet: an empty queue, and nothing served or written for what isn't a card.
const iv = await (await get("/api/eval/intake")).json();
check(iv.lookDays === 2 && iv.cards?.length === 0 && Object.keys(iv.states).length === 0 && iv.bank?.real === 0 && "meaning" in iv.reasons, `GET /api/eval/intake with no pull: ${JSON.stringify(iv).slice(0, 200)}`);
check((await get("/api/eval/card?key=nobody%231")).status === 404 && (await get("/api/eval/card-image?key=nobody%231&which=before")).status === 404 && (await get("/api/eval/card-image?key=x&which=..%2F..%2Fstate.json")).status === 404, "a card or image that isn't one was served");
check((await postJson("/api/eval/verdict", { key: "nobody#1", verdict: "approve" })).status === 400 && (await postJson("/api/eval/verdict", {})).status === 400, "a verdict on no card was taken");

// ---- The labeling page, by keyboard: 3 fidelity pairs (clear, undo, slight, tie) and one craft question.
const asked = [];
const proxy = ({ url, method, body }) => {
  if (url.includes("/api/eval/label")) asked.push(JSON.parse(body));
  const u = new URL(url);
  return fetch(base + u.pathname + u.search, { method, body: method === "GET" ? undefined : body, headers: { "content-type": "application/json" } }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }));
};
const c = await openChrome({ width: 1280, height: 900, stubs: Object.fromEntries(["pairs", "label", "file", "human"].map((p) => [`/api/eval/${p}`, proxy])) });
const { page } = c;
// Distinct JPEG screens for the packets, taken from this Chrome before the page loads.
const shot = async (color) => (await page.eval(`document.body.style.background = "${color}"`), page.shot({ format: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 640, height: 400, scale: 1 } }));
await page.goto("about:blank");
for (const cs of Object.keys(positions)) {
  put(join(home, `bank/cases/${cs}/before-ink.jpg`), await shot("#ffe8cc"));
  put(join(home, `runs/calib1/cases/${cs}/A/after.jpg`), await shot("#d3f9d8"));
  put(join(home, `runs/calib1/cases/${cs}/B/after.jpg`), await shot("#d0ebff"));
}
// Count every browser-storage write the page could make.
await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__writes = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (...a) { window.__writes++; return set.apply(this, a); }; const open = indexedDB.open.bind(indexedDB); indexedDB.open = (...a) => (window.__writes++, open(...a));" });
await page.goto(`${base}/evals/label/`);
const shown = async (want) => {
  for (let i = 0; i < 100; i++) {
    const at = await page.eval(`(() => { const p = document.querySelector("[data-pair]"); return p ? p.dataset.pair + ":" + p.dataset.question : document.querySelector("#pairs h2")?.textContent ?? ""; })()`);
    if (at === want) return true;
    await sleep(50);
  }
  return false;
};
const key = async (k) => {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k });
};
// 2 labels p1, u takes it back (p1 again), then 1 / w / 3 and q on the craft pass.
const steps = [["p1:fidelity", "2"], ["p2:fidelity", "u"], ["p1:fidelity", "1"], ["p2:fidelity", "w"], ["p3:fidelity", "3"], ["p4:craft", "q"], ["All labelled", ""]];
for (const [want, k] of steps) {
  if (!(await shown(want))) fail(`the labeling page didn't show ${want} (shows ${await page.eval('document.querySelector("#pairs").innerText.slice(0, 80)')})`);
  if (want === "p1:fidelity" && k === "2") {
    let view;
    for (let i = 0; i < 40 && !(view?.imgs.length === 3 && view.imgs.every(Boolean)); i++, await sleep(50)) view = await page.eval(`({ text: document.querySelector("#pairs").innerText, imgs: [...document.querySelectorAll("#pairs img")].map((i) => i.complete && i.naturalWidth) })`);
    check(/make \[ink 1\] this bigger \(c1\)/.test(view.text) && /twice as big/.test(view.text) && /a toy shop/.test(view.text) && /resized 'Toy shop' \(B\)/.test(view.text), "a fidelity pair doesn't show said, meant, the target note and the change lists");
    check(view.imgs.length === 3 && view.imgs.every((w) => w === 640), `a fidelity pair's images didn't load: ${view.imgs}`);
    check(!/\bA\b|\bB\b/.test(view.text.replace(/\((A|B)\)/g, "")), "the page names an arm");
  }
  if (want === "p4:craft") {
    const view = await page.eval(`({ text: document.querySelector("#pairs").innerText, imgs: document.querySelectorAll("#pairs img").length })`);
    check(view.imgs === 2 && !/bigger|twice|Toy shop'/.test(view.text) && /better wireframe/.test(view.text), "the craft pass shows more than the two screens");
  }
  if (k) await key(k);
}
const posts = asked.filter((b) => !b.undo);
check(asked.length === 6 && asked[1].undo === true, `the page sent ${asked.length} label POSTs (want 5 labels and an undo)`);
check(posts.every((b) => "question" in b && "strength" in b && b.ms >= 0), `a label POST lacks question or strength: ${JSON.stringify(posts)}`);
check(JSON.stringify(posts.map((b) => [b.pair, b.question, b.side, b.strength])) === JSON.stringify([["p1", "fidelity", "right", "clear"], ["p1", "fidelity", "left", "clear"], ["p2", "fidelity", "right", "slight"], ["p3", "fidelity", "tie", null], ["p4", "craft", "left", "slight"]]), `the keys sent ${JSON.stringify(posts.map((b) => [b.pair, b.side, b.strength]))}`);
const { standingLabels } = await import("../pages/plugin.ts");
const standing = standingLabels(labels).map((l) => [l.pair, l.question, l.label, l.strength]);
// p1: left is B; p2 is swapped, so its right is the packet's left (A); p4 (craft on c1): left is B.
check(JSON.stringify(standing) === JSON.stringify([["p0", "fidelity", "B", "clear"], ["p1", "fidelity", "B", "clear"], ["p2", "fidelity", "A", "slight"], ["p3", "fidelity", "tie", null], ["p4", "craft", "B", "slight"]]), `the standing labels are ${JSON.stringify(standing)}`);
check(lineCount(labels) === 7, `labels.jsonl has ${lineCount(labels)} lines (want 1 + 5 labels + 1 undo, nothing removed)`);

// ---- A craft pair where a screen left the change: each side shows its framed shot, as the craft judge sees them.
put(join(home, "runs/calib1/cases/c4/judge/packet.json"), JSON.stringify({ ...packet("c4", "A", "B"), images: { before: "before-ink.jpg", left: "A/after.jpg", right: "B/after.jpg", leftChanged: "A/changed.jpg", rightChanged: "B/changed.jpg" } }));
put(join(home, "labels/pairs.json"), JSON.stringify([...PAIRS, { id: "p5", run: "calib1", case: "c4", question: "craft", subset: "aa", swap: true }]));
const framedCraft = (await (await get("/api/eval/pairs")).json()).pairs.find((p) => p.id === "p5");
check(framedCraft?.left.image.endsWith("f=B%2Fchanged.jpg") && framedCraft.right.image.endsWith("f=A%2Fchanged.jpg") && framedCraft.left.framed && !framedCraft.left.changes && !framedCraft.said, `a framed craft pair shows ${JSON.stringify(framedCraft)}`);

// ---- "Your sends": the recorded send drawn with its ink; meant saved to the server.
await page.eval(`document.querySelector('[data-tab="sends"]').click()`);
let sendView;
for (let i = 0; i < 100 && !sendView?.paths; i++) {
  await sleep(50);
  sendView = await page.eval(`(() => { const s = document.querySelector("#sends .send"); return s && { text: s.innerText, paths: s.querySelectorAll("svg path").length, drawn: s.querySelector("svg").textContent }; })()`);
}
check(sendView?.paths > 0 && /Toy shop/.test(sendView.drawn) && /typed: make the title bigger/.test(sendView.text), `"your sends" didn't draw the send: ${JSON.stringify(sendView)}`);
await page.eval(`(() => { const i = document.querySelector("#sends input"); i.value = "the title twice as big"; document.querySelector("#sends [data-save]").click(); })()`);
let meant;
for (let i = 0; i < 100 && !meant; i++) {
  await sleep(50);
  meant = JSON.parse(readFileSync(join(home, "human", files[0]), "utf8")).meant;
}
check(meant === "the title twice as big", `meant wasn't written to the send (${meant})`);
const listed = await (await get("/api/eval/human")).json();
check(listed.length === 1 && listed[0].meant === "the title twice as big", "GET /api/eval/human doesn't list the send with its meant");

// ---- Nothing in the browser, every /api/* request stubbed, no page errors, no Chrome left.
const storage = await page.eval(`(async () => ({ writes: window.__writes, local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length, cookie: document.cookie }))()`);
check(storage.writes === 0 && storage.local === 0 && storage.session === 0 && storage.idb === 0 && !storage.cookie, `the page stored something in the browser: ${JSON.stringify(storage)}`);
const n = c.counts();
check(n.seen === n.stubbed && n.stubbed > 0 && !n["/api/model"], `seen ${n.seen} != stubbed ${n.stubbed}: ${JSON.stringify(n)}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await server.close();
finish();
