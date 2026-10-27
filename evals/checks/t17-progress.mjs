// T17's acceptance check: the progress page draws the sample history (copied into a
// temp RT_EVAL_HOME's history worktree and served by the real /api/eval/history)
// with all 6 panels at 1280 and 390 px, its owner steps, era and marker ticks, a band
// and line per era, hollow points and the slower-than-A0 ring where §5.4 puts them,
// and a decision row opens its cases and calls. One headless
// Chrome; every /api/* request goes through a counted stub to the pages server's
// endpoints. 0 model calls: there is no model endpoint and no stub for one.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t17-progress.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "vite";
import { openChrome } from "./cdp.mjs";
import { ROOT, check, fail, finish, tempHome } from "./lib.mjs";

const PORT = 5252; // this task's ports are 5250–5259
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (f, data) => (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, data));
const home = tempHome();

// ---- index.html gains only the two cards, under Evals.
const cur = readFileSync(join(ROOT, "index.html"), "utf8").split("\n");
const base = execFileSync("git", ["-C", ROOT, "show", "master:index.html"], { encoding: "utf8" }).split("\n");
const added = cur.filter((l) => !base.includes(l));
const evals = cur.findIndex((l) => />Evals</.test(l));
const cardAt = (href) => cur.findIndex((l) => l.includes(`<a class="card" href="${href}">`));
check(base.every((l) => cur.includes(l)), "index.html lost or changed a line of master's");
check(added.every((l) => /href="\/evals\/(progress|label)\/"/.test(l)) && added.length <= 2, `index.html gained more than the two cards: ${added.length} lines`);
check(evals >= 0 && cardAt("/evals/progress/") > evals && cardAt("/evals/label/") > evals, "the Progress and Labels cards aren't under the Evals heading");

// ---- The sample history in the worktree, plus what only a live loop writes.
const SAMPLE = join(ROOT, "evals/progress/sample");
mkdirSync(join(home, "history"));
for (const f of readdirSync(SAMPLE)) copyFileSync(join(SAMPLE, f), join(home, "history", f));
const rows = (f) => readFileSync(join(SAMPLE, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cks = rows("checkpoints.jsonl");
const epochs = rows("epochs.jsonl");
const at = (e) => epochs.find((x) => x.epoch === e).at;
put(join(home, "history/health.jsonl"), [{ at: at(2), kind: "calib", pass: true, detail: {} }, { at: at(12), kind: "canary", pass: true, detail: {} }].map((r) => JSON.stringify(r)).join("\n") + "\n");
put(join(home, "history/owner-list.md"), "# Owner list\n\n- [ ] e19-h2: patch to src/core/render.ts\n- [x] done one\n- [ ] craft not calibrated yet\n");
put(join(home, "heartbeat.json"), JSON.stringify({ wall: Date.now(), mono: 1 }));
put(join(home, "state.json"), JSON.stringify({ status: "running", phase: "e21-h1 measuring", slot: 2 }));

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
const proxy = ({ url, method, body }) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, { method, body: method === "GET" ? undefined : body }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }));
};
const c = await openChrome({ width: 1280, height: 900, stubs: Object.fromEntries(["history", "file", "calls"].map((p) => [`/api/eval/${p}`, proxy])) });
const { page } = c;
await page.goto("about:blank");
const jpeg = await page.shot({ format: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 640, height: 400, scale: 1 } });
for (const f of ["cases/c-b1-s01-1/A/after.jpg", "cases/c-b1-s01-1/B/after.jpg"]) put(join(run, f), jpeg);
put(join(home, "bank/cases/c-b1-s01-1/before-ink.jpg"), jpeg);

const PANELS = ["status", "quality", "latency", "health", "cost", "decisions"];
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
    drawn: ${JSON.stringify(PANELS.slice(1, 5))}.map((p) => n(p, "svg path")),
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
  };
})()`;
const verify = (w) => {
  const r = got[w];
  check(JSON.stringify(r.panels) === JSON.stringify(PANELS), `${w} px: panels ${r.panels}`);
  check(r.drawn.every((k) => k > 0), `${w} px: a chart panel drew nothing (${r.drawn})`);
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
  check(/running/.test(r.status) && /\d+ GB free/.test(r.status) && /~\d+ days left|days left: plenty/.test(r.status) && /owner list: 2 open/.test(r.status) && /token 2/.test(r.status), `${w} px: status strip reads "${r.status.replace(/\s+/g, " ").trim()}"`);
  check(/against A0/.test(r.qualityTitle) && !/anchor/.test(r.qualityTitle), `${w} px: the quality title reads "${r.qualityTitle}", not against A0`);
  check(r.decisions === rows("decisions.jsonl").length, `${w} px: ${r.decisions} decision rows`);
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

// ---- A decision row opens its run's cases, a case its packet and every call, a call its exact request and reply.
await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(200);
await page.eval(`document.querySelector('tr[data-decision="${dec.id}"] td').click()`);
await waitFor(`document.querySelectorAll("[data-cases] button[data-case]").length === 2`, "the decision's cases");
await page.eval(`document.querySelector('[data-cases] button[data-case="c-b1-s01-1"]').click()`);
await waitFor(`document.querySelectorAll("[data-calls] tr[data-call]").length === 3 && document.querySelectorAll("[data-shown] img").length === 3 && [...document.querySelectorAll("[data-shown] img")].every((i) => i.complete && i.naturalWidth === 640)`, "the case's packet images and calls");
const callsText = await page.eval(`document.querySelector("[data-calls]").innerText`);
check(/fidelity/.test(callsText) && /claude-sonnet-5-5-20261101/.test(callsText) && /5002/.test(callsText) && /682/.test(callsText) && /1900/.test(callsText), "the calls table lacks role, served id, ms or cache numbers");
await page.eval(`document.querySelector('[data-calls] tr[data-call="2"]').click()`);
await waitFor(`/SYSTEM PROMPT 2/.test(document.querySelector("[data-call-detail]")?.innerText ?? "") && /reply 2/.test(document.querySelector("[data-call-detail]").innerText)`, "the call's request and reply");

const n = c.counts();
check(n.seen === n.stubbed && n["/api/eval/history"] >= 1 && n["/api/eval/calls"] === 1 && !n["/api/model"], `seen ${n.seen} != stubbed ${n.stubbed}: ${JSON.stringify(n)}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await server.close();
finish();
