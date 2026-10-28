// T17's acceptance check: Eval HQ's home, the progress page, draws the sample history
// (copied into a temp RT_EVAL_HOME's history worktree and served by the real
// /api/eval/history) under the HQ header and the pipeline's overview, with its views
// and every panel at 1280 and 390 px, its owner steps, era and marker ticks, a band
// and line per era, hollow points and the slower-than-A0 ring where §5.4 puts them,
// the Loop view folded until a link to it opens it and its decisions a page at a time
// (a redraw keeps both), a decision row opens its cases and calls, and "Needs you" lists what waits for the
// owner (held first, the count in the tab title), sends his note, shows Claude's reply
// at the next poll with a half-typed answer kept, and resolves an item. One headless
// Chrome; every /api/* request goes through a counted stub to the pages server's
// endpoints. 0 model calls: there is no model endpoint and no stub for one.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t17-progress.mjs
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "vite";
import { openChrome } from "./cdp.mjs";
import { ROOT, check, fail, finish, tempHome } from "./lib.mjs";

const PORT = 5252; // this task's ports are 5250–5259
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (f, data) => (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, data));
const home = tempHome();

// ---- The product's index links no Eval HQ page: the owner's dev server doesn't serve their endpoints (only the record one).
const index = readFileSync(join(ROOT, "index.html"), "utf8");
check(!/href="\/evals\/(progress|label|review)\//.test(index) && /href="\/evals\/driver\/"/.test(index), "index.html links an Eval HQ page, or lost the driver's card");

// ---- The sample history in the worktree, plus what only a live loop writes.
const SAMPLE = join(ROOT, "evals/progress/sample");
mkdirSync(join(home, "history"));
// The sample's threads go where the page's go, notes/ (never history/, which is pushed).
for (const f of readdirSync(SAMPLE)) copyFileSync(join(SAMPLE, f), f === "threads.jsonl" ? (mkdirSync(join(home, "notes")), join(home, "notes", f)) : join(home, "history", f));
const rows = (f) => readFileSync(join(SAMPLE, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cks = rows("checkpoints.jsonl");
const epochs = rows("epochs.jsonl");
const at = (e) => epochs.find((x) => x.epoch === e).at;
put(join(home, "history/health.jsonl"), [{ at: at(2), kind: "calib", pass: true, detail: {} }, { at: at(12), kind: "canary", pass: true, detail: {} }].map((r) => JSON.stringify(r)).join("\n") + "\n");
put(join(home, "history/ships.jsonl"), `${JSON.stringify({ at: at(20), sha: "a".repeat(40), tag: "v2-aaaaaaaaaaaa" })}\n`);
put(join(home, "heartbeat.json"), JSON.stringify({ wall: Date.now(), mono: 1 }));
// Intake's last pass: its third in a row with a failing stage, which is the owner's to look at.
put(join(home, "real/intake.json"), JSON.stringify({ at: new Date(Date.now() - 600_000).toISOString(), failed: 2, failedPasses: 3 }));
put(join(home, "state.json"), JSON.stringify({ run: { status: "running", at: new Date().toISOString(), phase: "e21-h1 measuring", slot: 2 } }));

// The latest decision's raw run: two cases, a packet, three calls and their reply cache entries.
const dec = rows("decisions.jsonl").at(-1);
const run = join(home, "runs", dec.run);
put(join(run, "rows.jsonl"), ["c-b1-s01-1", "c-b1-s02-3"].map((c, i) => JSON.stringify({ case: c, cluster: "s01", affected: true, class: "R", s: i ? 0 : 1, ttfc: [2100, 1700], ttd: [6000, 5400], work: [3, 3], usd: [0.03, 0.03], thought: [false, false], overuse: [false, false], firstArm: "A" })).join("\n") + "\n");
put(join(run, "cases/c-b1-s01-1/judge/packet.json"), JSON.stringify({ case: "c-b1-s01-1", said: "make [ink 1] this the whole width", meant: "the story card spans the page", hedged: false, expectation: { should: [], mustNot: [] }, images: { before: "before-ink.jpg", left: "B/after.jpg", right: "A/after.jpg" }, changes: { left: ["resized 'Our story'"], right: ["camera moved"] }, positions: { left: "B", right: "A" } }));
const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const calls = [["A", "draw", "sonnet"], ["B", "draw", "sonnet"], ["-", "fidelity", "sonnet"]].map(([arm, role, model], i) => ({ at: at(20), run: dec.run, case: "c-b1-s01-1", arm, slot: 1, role, model, servedModel: "claude-sonnet-5-5-20261101", sdk: "0.3.299", reqHash: hashes[i], shared: "-", mode: "live", inTokens: 2, cacheRead: 680 + i, cacheWrite5m: 1900, cacheWrite1h: 0, outTokens: 390, thinkingTokens: 0, ms: 5000 + i, firstMs: 2900, waitMs: 12, retries: 0, listUsd: 0.01, token: 2 }));
put(join(home, "meter/calls.jsonl"), [...calls, { ...calls[0], case: "c-other" }].map((c) => JSON.stringify(c)).join("\n") + "\n");
hashes.forEach((h, i) => put(join(home, `cache/replies/${h}.json`), JSON.stringify({ request: { model: "sonnet", system: `SYSTEM PROMPT ${i}\nline two`, user: `the user message ${i}` }, reply: `shape(card, rect, 0 0 1280 300, "reply ${i}")`, offsets: [2900, 3100] })));

const server = await createServer({ root: ROOT, configFile: join(ROOT, "evals/pages.vite.config.ts"), cacheDir: join(home, "vite-cache"), logLevel: "error", clearScreen: false, server: { port: PORT, strictPort: true, host: "127.0.0.1", watch: null } });
await server.listen();
// The server's front page is Eval HQ's, not the repo's playground index.
const front = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
check(front.status === 302 && front.headers.get("location") === "/evals/progress/", `GET / on the pages server: ${front.status} ${front.headers.get("location")}`);
const proxy = ({ url, method, headers, body }) => {
  const u = new URL(url);
  const type = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, { method, headers: type ? { "content-type": type } : {}, body: method === "GET" ? undefined : body }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }));
};
const c = await openChrome({ width: 1280, height: 900, stubs: Object.fromEntries(["history", "file", "calls", "threads", "intake", "prod"].map((p) => [`/api/eval/${p}`, proxy])) });
const { page } = c;
await page.goto("about:blank");
const jpeg = await page.shot({ format: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 640, height: 400, scale: 1 } });
for (const f of ["cases/c-b1-s01-1/A/after.jpg", "cases/c-b1-s01-1/B/after.jpg"]) put(join(run, f), jpeg);
put(join(home, "bank/cases/c-b1-s01-1/before-ink.jpg"), jpeg);

const PANELS = ["status", "decisions", "quality", "real", "latency", "health", "cost", "playgrounds"];
const CHARTS = ["quality", "latency", "health", "cost"];
const waitFor = async (expr, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await page.eval(expr)) return;
  fail(`timed out waiting for ${what}`);
};
// The trusted checkpoints in runs of one era: a line (and a band) per era with two points or more.
const eraRuns = cks.filter((x) => x.trust === "green").reduce((runs, x) => (runs.at(-1)?.era === x.era ? runs.at(-1).ids.push(x.id) : runs.push({ era: x.era, ids: [x.id] }), runs), []).filter((r) => r.ids.length > 1).map((r) => r.ids.join(" "));
const slower = cks.filter((x) => x.latency.slower);
// What the page drew, read off the data-* attributes charts.ts puts on every mark.
const READ = `(() => {
  const P = (n) => document.querySelector('[data-panel="' + n + '"]');
  const n = (p, sel) => P(p)?.querySelectorAll(sel).length ?? 0;
  const strayHollow = [...document.querySelectorAll("svg")].flatMap((svg) => {
    const joined = new Set([...svg.querySelectorAll("[data-ids]")].flatMap((g) => g.dataset.ids.split(" ")));
    return [...svg.querySelectorAll("[data-hollow]")].map((h) => h.dataset.id).filter((id) => joined.has(id));
  });
  return {
    panels: [...document.querySelectorAll("[data-panel]")].map((p) => p.dataset.panel),
    drawn: ${JSON.stringify(CHARTS)}.map((p) => n(p, "svg path")),
    nav: [...document.querySelectorAll("header.bar nav a")].map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")]),
    views: [...document.querySelectorAll("#panels > .view")].map((v) => v.id),
    stages: [...document.querySelectorAll("#overview .stage-link")].map((a) => a.innerText.replace(/\\s+/g, " ").trim()),
    playgrounds: [...(P("playgrounds")?.querySelectorAll("[data-list] a") ?? [])].map((a) => a.getAttribute("href")),
    scroll: document.documentElement.scrollWidth - innerWidth,
    wideSvg: [...document.querySelectorAll("[data-panel] svg")].filter((s) => s.getBoundingClientRect().right > s.closest("[data-panel]").getBoundingClientRect().right + 1).length,
    steps: Object.fromEntries(["quality", "latency"].map((p) => [p, [n(p, '[data-step="owner"]'), n(p, "[data-step]")]])),
    ticks: Object.fromEntries(["quality", "latency"].map((p) => [p, ["harness", "served-model", "owner-step", "era", "anchor"].map((k) => n(p, '[data-tick="' + k + '"]'))])),
    healthTicks: ["aa", "canary", "calib"].map((k) => n("health", '[data-tick="' + k + '"]')),
    mainIds: [...(P("quality")?.querySelectorAll('[data-series="all"]') ?? [])].map((g) => g.dataset.ids),
    bands: n("quality", '[data-band="share90"]'),
    debt: document.querySelectorAll("[data-debt]").length,
    slower: [[...(P("latency")?.querySelectorAll("[data-slower]") ?? [])].map((g) => g.dataset.slower), P("latency")?.textContent ?? ""],
    hollow: [n("quality", "[data-hollow]"), n("latency", "[data-hollow]")],
    strayHollow,
    cost: [n("cost", '[data-band="v1"]'), n("cost", '[data-point="doc"]'), P("cost")?.textContent ?? ""],
    status: P("status")?.textContent ?? "",
    qualityTitle: P("quality")?.querySelector("h2")?.textContent ?? "",
    decisions: n("decisions", "tr[data-decision]"),
    loop: [document.getElementById("loop")?.open, document.querySelector("#loop > summary")?.innerText.replace(/\\s+/g, " ").trim() ?? ""],
    pager: [...(P("decisions")?.querySelector(".pager")?.children ?? [])].map((c) => c.textContent).join(" "),
  };
})()`;
const PAGE = 20; // DECISIONS_PAGE in main.ts
const decided = rows("decisions.jsonl").length;
const verify = (w) => {
  const r = got[w];
  check(JSON.stringify(r.panels) === JSON.stringify(PANELS), `${w} px: panels ${r.panels}`);
  check(r.drawn.every((k) => k > 0), `${w} px: a chart panel drew nothing (${r.drawn})`);
  check(JSON.stringify(r.nav.map((a) => a[0])) === JSON.stringify(["Needs you", "Intake and review", "Loop", "Benchmarks", "Judge", "Playgrounds"]) && r.nav.every((a) => a[1].startsWith("/evals/") && a[2] === null),
    `${w} px: the HQ header's views ${JSON.stringify(r.nav)}`);
  check(JSON.stringify(r.views) === JSON.stringify(["loop", "benchmarks", "playgrounds"]), `${w} px: the page's view headings ${JSON.stringify(r.views)}`);
  // No pull yet (intake's endpoint on an empty real/): every stage still shows, in the pipeline's order.
  check(JSON.stringify(r.stages.map((x) => x.split(" ")[0])) === JSON.stringify(["Pull", "Intake", "Review", "Bank", "Loop", "Prod"]) && /^Pull live never local never · 0 new sends/.test(r.stages[0]) && /^Intake 0 being labeled last pass 10 min ago, 2 failed · 0 skipped/.test(r.stages[1]) && /^Loop running/.test(r.stages[4]) && /^Prod v2-aaaaaaaaaaaa shipped/.test(r.stages[5]),
    `${w} px: the overview reads ${JSON.stringify(r.stages)}`);
  check(r.playgrounds.length === 17 && r.playgrounds.every((h) => /^http:\/\/localhost:5173\/playgrounds\/[a-z]+\/$/.test(h)), `${w} px: the playgrounds' links ${JSON.stringify(r.playgrounds.slice(0, 3))}`);
  check(r.scroll <= 0 && r.wideSvg === 0, `${w} px: horizontal scroll (${r.scroll} px over, ${r.wideSvg} charts wider than their card)`);
  // The one owner step, on each panel's main line, and no other step (no anchor moves or era bridges now).
  check(JSON.stringify(r.steps) === JSON.stringify({ quality: [1, 1], latency: [1, 1] }), `${w} px: steps (owner, all) ${JSON.stringify(r.steps)}`);
  // 2 harness tags, 1 served model, 1 owner step, 2 era starts; no anchor ticks.
  check(Object.values(r.ticks).every((t) => JSON.stringify(t) === "[2,1,1,2,0]"), `${w} px: marker ticks (harness, served-model, owner-step, era, anchor) ${JSON.stringify(r.ticks)}`);
  check(r.healthTicks.every((k) => k === 1), `${w} px: health ticks (A/A, canary, calibration) ${r.healthTicks}`);
  check(JSON.stringify(r.mainIds) === JSON.stringify(eraRuns), `${w} px: the share line isn't one line per era through its trusted checkpoints (${JSON.stringify(r.mainIds)}, wanted ${JSON.stringify(eraRuns)})`);
  check(r.bands === eraRuns.length, `${w} px: ${r.bands} share bands for ${eraRuns.length} eras`);
  check(r.debt === 0, `${w} px: ${r.debt} debt bands drawn`);
  check(slower.length > 0 && JSON.stringify(r.slower[0]) === JSON.stringify(slower.map((x) => x.id)) && slower.every((x) => r.slower[1].includes(x.latency.slower)), `${w} px: the slower-than-A0 mark: rings on ${JSON.stringify(r.slower[0])}, wanted ${JSON.stringify(slower.map((x) => x.id))} with its text`);
  check(r.hollow[0] >= 1 && r.hollow[1] >= 3 && !r.strayHollow.length, `${w} px: hollow points ${r.hollow}, joined by a trend line: ${r.strayHollow}`);
  check(r.cost[0] === 1 && r.cost[1] === 1 && /List \$ per decision/.test(r.cost[2]) && /Minutes per decision/.test(r.cost[2]) && /v1: ~120 min per decision/.test(r.cost[2]) && /doc as written: 75 min/.test(r.cost[2]), `${w} px: the cost panel's per-decision charts, v1's band or the doc-as-written point (${r.cost[0]} bands, ${r.cost[1]} points)`);
  check(!/window per decision|estimated from list/.test(r.cost[2]), `${w} px: the cost panel still shows a five-hour-window share or a list-$ weekly estimate`);
  check(/running/.test(r.status) && /\d+ GB free/.test(r.status) && /~\d+ days left|days left: plenty/.test(r.status) && /owner list: 5 open/.test(r.status) && /token 2/.test(r.status), `${w} px: status strip reads "${r.status.replace(/\s+/g, " ").trim()}"`);
  check(/against A0/.test(r.qualityTitle) && !/anchor/.test(r.qualityTitle), `${w} px: the quality title reads "${r.qualityTitle}", not against A0`);
  check(r.decisions === Math.min(PAGE, decided) && r.pager === `newer 1–${PAGE} of ${decided} older`, `${w} px: ${r.decisions} decision rows, pager "${r.pager}"`);
  check(r.loop[0] === false && r.loop[1] === `Loop running · ${decided} decisions`, `${w} px: the Loop view ${r.loop[0] ? "open" : "folded"} at first, its summary "${r.loop[1]}"`);
};
const got = {};
await page.goto(`http://127.0.0.1:${PORT}/evals/progress/`);
await waitFor(`document.querySelectorAll("[data-panel] svg").length >= 7 && !!document.querySelector("tr[data-decision]")`, "the panels at 1280 px");
got[1280] = await page.eval(READ);
verify(1280);
await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await waitFor(`innerWidth === 390 && [...document.querySelectorAll("[data-panel] svg")].every((s) => s.getBoundingClientRect().width <= 390)`, "the redraw at 390 px");
await sleep(200);
got[390] = await page.eval(READ);
verify(390);

// ---- The Loop view: the overview's link opens it; older and newer page its decisions; a redraw keeps the fold and the page.
const LOOP = `(() => { const P = document.querySelector('[data-panel="decisions"]'); return { open: document.getElementById("loop").open, rows: P.querySelectorAll("tr[data-decision]").length,
  pager: [...P.querySelector(".pager").children].map((c) => c.textContent).join(" "), newer: P.querySelector('[data-page="-1"]').disabled, older: P.querySelector('[data-page="1"]').disabled }; })()`;
const pages = Math.ceil(decided / PAGE);
check(pages > 2, `the sample's ${decided} decisions make ${pages} pages, too few to page through`);
await page.eval(`document.querySelector('#overview a[href="#loop"]').click()`);
await waitFor(`document.getElementById("loop").open`, "the Loop view opened by the overview's Loop stage");
for (let i = 1; i < pages; i++) await page.eval(`document.querySelector('[data-panel="decisions"] [data-page="1"]').click()`);
let l = await page.eval(LOOP);
const lastFrom = PAGE * (pages - 1) + 1;
check(l.rows === decided - lastFrom + 1 && l.pager === `newer ${lastFrom}–${decided} of ${decided} older` && !l.newer && l.older, `the last page of decisions: ${JSON.stringify(l)}`);
await page.eval(`document.querySelector('[data-panel="decisions"] [data-page="-1"]').click()`);
await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(200);
l = await page.eval(LOOP);
check(l.open && l.rows === PAGE && l.pager === `newer ${lastFrom - PAGE}–${lastFrom - 1} of ${decided} older` && !l.newer && !l.older, `the Loop view after a redraw: ${JSON.stringify(l)}`);
for (let i = 2; i < pages; i++) await page.eval(`document.querySelector('[data-panel="decisions"] [data-page="-1"]').click()`);
check((await page.eval(LOOP)).pager.startsWith("newer 1–"), "back on the first page of decisions");

// ---- A decision row opens its run's cases, a case its packet and every call, a call its exact request and reply.
await page.eval(`document.querySelector('tr[data-decision="${dec.id}"] td').click()`);
await waitFor(`document.querySelectorAll("[data-cases] button[data-case]").length === 2`, "the decision's cases");
await page.eval(`document.querySelector('[data-cases] button[data-case="c-b1-s01-1"]').click()`);
await waitFor(`document.querySelectorAll("[data-calls] tr[data-call]").length === 3 && document.querySelectorAll("[data-shown] img").length === 3 && [...document.querySelectorAll("[data-shown] img")].every((i) => i.complete && i.naturalWidth === 640)`, "the case's packet images and calls");
const callsText = await page.eval(`document.querySelector("[data-calls]").innerText`);
check(/fidelity/.test(callsText) && /claude-sonnet-5-5-20261101/.test(callsText) && /5002/.test(callsText) && /682/.test(callsText) && /1900/.test(callsText), "the calls table lacks role, served id, ms or cache numbers");
await page.eval(`document.querySelector('[data-calls] tr[data-call="2"]').click()`);
await waitFor(`/SYSTEM PROMPT 2/.test(document.querySelector("[data-call-detail]")?.innerText ?? "") && /reply 2/.test(document.querySelector("[data-call-detail]").innerText)`, "the call's request and reply");

// ---- Needs you: held first, then newest first; the count in the title; a note sent, Claude's reply at the next poll.
const notesFile = join(home, "notes/threads.jsonl");
const noteLines = () => readFileSync(notesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const NEEDS = `(() => ({ items: [...document.querySelectorAll("#needs [data-items] > li")].map((l) => [l.dataset.item, l.classList.contains("held")]), chats: document.querySelectorAll("#needs [data-chats] > li").length,
  title: document.title, badge: document.querySelector("#needs [data-count]")?.textContent, first: document.body.querySelector(".needs-wrap, main") === document.querySelector(".needs-wrap"),
  settled: document.querySelector("#needs details")?.textContent ?? "", pipeline: document.querySelector("#needs [data-pipeline]")?.innerText ?? "", ck07: document.querySelector('#needs [data-item="ck-07"]')?.innerText ?? "" }))()`;
let nv = await page.eval(NEEDS);
const DRY = "2026-10-20-dry-well-6-reverts-in-a-row-on-draw";
check(JSON.stringify(nv.items) === JSON.stringify([["e19-h3", true], ["ck-07", false], ["ck-05", false], [DRY, false]]) && nv.chats === 1 && nv.first, `Needs you lists ${JSON.stringify(nv.items)} and ${nv.chats} side chats${nv.first ? "" : ", not above the panels"}`);
check(/^Intake failed in 3 passes in a row\n+2 of its steps failed in the last one, 10 min ago\./.test(nv.pipeline), `Needs you's intake item reads ${JSON.stringify(nv.pipeline)}`);
check(nv.title.startsWith("(6) ") && nv.badge === "6" && /e15-h3/.test(nv.settled), `the count reads "${nv.title}" / ${nv.badge}, or e15-h3 isn't under resolved (${nv.settled})`);
const type = (key, text) => page.eval(`(() => { document.querySelector('#needs [data-open="${key}"]').click(); const t = document.querySelector('#needs textarea[data-key="${key}"]'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const before = noteLines().length;
await type("ck-07", "Is the slowdown real?");
await page.eval(`document.querySelector('#needs [data-to="ck-07"]').click()`);
await waitFor(`document.title.startsWith("(5) ") && /waiting for Claude/.test(document.querySelector('#needs [data-item="ck-07"]').innerText)`, "the owner's note on ck-07");
const sent = noteLines().at(-1);
check(noteLines().length === before + 1 && sent.thread === "ck-07" && sent.who === "owner" && sent.text === "Is the slowdown real?", `the page wrote ${JSON.stringify(sent)}`);
// Half an answer on ck-05 while Claude replies on ck-07: the reply lands at the 20 s poll, the draft and caret stay.
await type("ck-05", "half an answer");
await page.eval(`document.querySelector('#needs textarea[data-key="ck-05"]').focus()`);
const { addNote } = await import("../pages/plugin.ts");
addNote({ thread: "ck-07", who: "claude", text: "Real: the next card scopes the new layer to the shapes touched." });
await waitFor(`/the next card scopes the new layer/.test(document.querySelector('#needs [data-item="ck-07"]').innerText)`, "Claude's reply without a reload", 25_000);
nv = await page.eval(NEEDS);
const kept = await page.eval(`({ v: document.querySelector('#needs textarea[data-key="ck-05"]').value, focus: document.activeElement?.dataset.key })`);
check(nv.title.startsWith("(6) ") && /Claude replied/.test(nv.ck07) && kept.v === "half an answer" && kept.focus === "ck-05", `after Claude's reply: "${nv.title}", draft ${JSON.stringify(kept)}`);
await page.eval(`document.querySelector('#needs [data-resolve="ck-05"]').click()`);
await waitFor(`!document.querySelector('#needs [data-items] [data-item="ck-05"]') && /ck-05/.test(document.querySelector("#needs details").textContent)`, "ck-05 resolved");
check(noteLines().at(-1).resolved === true && noteLines().at(-1).text === "half an answer" && (await page.eval("document.title")).startsWith("(5) "), `resolving ck-05 wrote ${JSON.stringify(noteLines().at(-1))}`);

const n = c.counts();
check(n.seen === n.stubbed && n["/api/eval/history"] >= 1 && n["/api/eval/calls"] === 1 && n["/api/eval/threads"] >= 4 && !n["/api/model"], `seen ${n.seen} != stubbed ${n.stubbed}: ${JSON.stringify(n)}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await server.close();
finish();
