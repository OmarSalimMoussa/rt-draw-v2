// Eval HQ's home (§5.4, frozen measuring side): the pipeline at a glance (pull, intake, review, bank, loop, champion, prod),
// "Needs you" (attention.ts: what waits for the owner, each with a thread they write in and Claude answers through
// `rte note`, $RT_EVAL_HOME/notes/threads.jsonl outside git, read every 20 s), the loop (its status and the decisions
// with every case and call behind them), the benchmarks (quality against A0, checkpoint 0's champion, which never moves,
// each era of the yardstick charted apart; R1 on testers' sends; latency against A0 in the same run; cost and speed
// against v1; health), and the playgrounds. Everything comes from GET /api/eval/history (evals/pages/plugin.ts: the
// eval/history branch) and /api/eval/intake; the page holds no state and polls every 60 s, and again when its tab comes
// back. ?sample=1 draws the fake history in ./sample/ (its threads kept in memory). Rows written before 2026-10-26 may
// carry Q, anchor moves, chained ratios and debts: the page ignores them, and skips their "anchor" markers.
import { openModal } from "../../src/modal.ts";
import { $, PLAYGROUNDS } from "../../src/ui.ts";
import { LOOP } from "../loop/config.ts";
import type { Run } from "../loop/state.ts";
import type { BudgetRow, CheckpointRow, DecisionRow, EpochRow, HealthRow, Marker, ShipRow, SmokeRow } from "../loop/types.ts";
import { type Item, type Note, type Thread, chatId, isChat, needsYou, yourTurn } from "./attention.ts";
import { type Dot, type Frame, INK, type XY, frame, legend } from "./charts.ts";
import { hq } from "./hq.ts";

hq("home", "The eval's pipeline: testers' sends become cases you review, the loop tries changes on them and keeps what wins, and the champion waits for you to ship it. Read from the eval/history branch and the PGX's files; no model call.");

type Disk = { freeGb: number; weekGrowthGb: number; daysLeft: number | null; ownerGb: number; pauseGb: number };
type Status = { heartbeat?: Record<string, unknown>; state?: Record<string, unknown>; disk?: Disk; champion?: { sha: string; unshipped?: number; since?: "prod" | "master" }; now: number; error?: string };
/** GET /api/eval/prod: whether the last ship's address answers (empty before a ship with one). */
type ProdHealth = { url?: string; ok?: boolean; status?: number; error?: string };
/** What the overview takes of GET /api/eval/intake (evals/real/review.ts); absent where intake isn't served (the sample). */
type Intake = {
  lookDays: number; pull: Record<"live" | "local", { pulledAt?: string }>; states: Record<string, number>; bank: { driver: number; real: number }; cards: { state: string; admitAt?: string }[];
  /** Intake's last pass (real.ts IntakePass). */
  pass?: { at: string; failed: number; failedPasses: number };
};
/** Passes in a row with a failing stage before it's the owner's to look at: one is a box down or a page that timed out. */
const INTAKE_FAILS = 3;
type History = { source: string; files: Record<string, string | null>; status: Status };
type Data = ReturnType<typeof parse>;

/** v1 per decision (§0): ~2 h; the eval doc as written: 75 min. */
const V1 = { minutes: [100, 140] };
const DOC = { minutes: 75 };
const GOAL_TTFC_MS = 1000;
const POLL_MS = 60_000;
/** The loop writes its heartbeat every 10 s; older than this, it isn't running. */
const STALE_MS = 60_000;
const GROUPS: [string, string, RegExp][] = [["product", "#1971c2", /^(draw|resolve|picture|camera|describe|product)/], ["judges", "#5f3dc4", /^(fidelity|craft|expectation|miss|canary|judge)/], ["agents", "#2b8a3e", /^(analyst|critic|engineer|agent)/], ["drivers", "#e8590c", /^(driver|probe)/]];
const TICK_GLYPH: Record<string, string> = { harness: "H", "served-model": "M", "owner-step": "O", era: "E", aa: "=", canary: "C", calib: "L", ready: "R" };
/** The markers drawn as plain ticks; eras get their own (eraStarts), an old row's "anchor" none. */
const PLAIN_MARKERS = ["harness", "served-model", "owner-step"];
const SLOW = "#c92a2a";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rowsOf = <T>(text?: string | null): T[] => (text ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const timeOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${(ms / 3_600_000).toFixed(1)} h ago`);

function parse(h: History) {
  const f = h.files;
  return {
    source: h.source, status: h.status,
    epochs: rowsOf<EpochRow>(f["epochs.jsonl"]), decisions: rowsOf<DecisionRow>(f["decisions.jsonl"]), checkpoints: rowsOf<CheckpointRow>(f["checkpoints.jsonl"]),
    budget: rowsOf<BudgetRow>(f["budget.jsonl"]), health: rowsOf<HealthRow>(f["health.jsonl"]), markers: rowsOf<Marker>(f["markers.jsonl"]),
    smokes: rowsOf<SmokeRow>(f["smoke.jsonl"]), ships: rowsOf<ShipRow>(f["ships.jsonl"]),
    /** Open owner-list items: unchecked markdown tasks. */
    ownerOpen: (f["owner-list.md"]?.match(/^\s*- \[ \]/gm) ?? []).length,
    ownerList: f["owner-list.md"] ?? "",
  };
}

async function sample(): Promise<History> {
  const raw = import.meta.glob("./sample/*", { query: "?raw", import: "default" });
  const files: Record<string, string> = {};
  for (const [path, load] of Object.entries(raw)) files[path.split("/").pop()!] = (await load()) as string;
  const now = Date.parse(rowsOf<EpochRow>(files["epochs.jsonl"]).at(-1)!.at) + 300_000;
  return { source: "sample", files, status: { now, heartbeat: { wall: now - 4000 }, state: { run: { status: "running", at: new Date(now - 60_000).toISOString(), phase: "e21-h1: deciding (latency, draw)", slot: 2 } }, disk: { freeGb: 84.2, weekGrowthGb: 16.9, daysLeft: 30.6, ownerGb: LOOP.diskOwnerGb, pauseGb: LOOP.diskPauseGb } } };
}

// ---- The x axis: epochs, with everything that has a time placed between them.

function xAxis(d: Data) {
  const pts = d.epochs.map((e) => [Date.parse(e.at), e.epoch] as const);
  const gap = pts.length > 1 ? (pts.at(-1)![0] - pts[0][0]) / (pts.length - 1) : 3_600_000;
  const at = (iso: string) => {
    const t = Date.parse(iso);
    if (!pts.length) return 0;
    if (t <= pts[0][0]) return pts[0][1] - Math.min(1, (pts[0][0] - t) / gap);
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) return pts[i - 1][1] + (t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
    return pts.at(-1)![1] + Math.min(0.5, (t - pts.at(-1)![0]) / gap);
  };
  const xs = [...pts.map((p) => p[1]), ...d.checkpoints.map((c) => at(c.at)), ...d.smokes.map((s) => at(s.at))];
  const range: [number, number] = [Math.min(0, ...xs) - 0.3, Math.max(1, ...xs) + 0.3];
  const ticks = d.epochs.map((e) => ({ at: e.epoch, label: `e${e.epoch}` }));
  return { at, range, ticks };
}

/** An owner step: a step on a line into his checkpoint. */
type Ev = { x: number; label: string };

function ownerSteps(d: Data, x: ReturnType<typeof xAxis>): Ev[] {
  const ck = (id?: string) => d.checkpoints.find((c) => c.id === id);
  return d.decisions.filter((o) => o.kind === "owner-step" && ck(o.checkpoint))
    .map((o) => ({ x: x.at(ck(o.checkpoint)!.at), label: d.markers.find((m) => m.kind === "owner-step" && m.ref === o.checkpoint)?.label ?? o.reasons[0] ?? "owner step" }))
    .sort((a, b) => a.x - b.x);
}

/**
 * Where each era starts: its "era" marker, else the first checkpoint whose era differs
 * from the one before (a history without era markers). A new judge or bench starts one.
 */
function eraStarts(d: Data, x: ReturnType<typeof xAxis>) {
  const at = new Map<number, { x: number; label: string }>();
  d.checkpoints.forEach((c, i) => i && c.era !== d.checkpoints[i - 1].era && at.set(c.era, { x: x.at(c.at), label: `era ${c.era} from ${c.id}` }));
  for (const m of d.markers.filter((m) => m.kind === "era")) at.set(m.era, { x: x.at(m.at), label: m.label });
  return [...at.values()];
}

/** Consecutive checkpoints of one era: eras aren't comparable, so no line or band joins two. */
const byEra = (cks: CheckpointRow[]) => cks.reduce<CheckpointRow[][]>((runs, c) => (runs.at(-1)?.[0].era === c.era ? runs.at(-1)!.push(c) : runs.push([c]), runs), []);

/**
 * A trend line through one era's trusted points, an owner step drawn in as a step
 * into his checkpoint. Only the main series labels the steps.
 */
function stepped(f: Frame, pts: Dot[], evs: Ev[], style: { color: string; width?: number; dash?: boolean; faint?: boolean; right?: boolean; data?: Record<string, string> }, annotate: boolean) {
  const path: XY[] = [];
  pts.forEach((p, i) => {
    const prev = pts[i - 1];
    if (prev) for (const e of evs.filter((e) => prev.x < e.x && e.x <= p.x)) {
      path.push([e.x, prev.y], [e.x, p.y]);
      if (annotate) f.step(e.x, prev.y, p.y, e.label, "owner", style.right);
    }
    path.push([p.x, p.y]);
  });
  f.line(path, { ...style, ids: pts.map((p) => p.id) });
}
/** One series over the trusted checkpoints, a line per era; a checkpoint where `get` has no value is left out. */
function series(f: Frame, cks: CheckpointRow[], x: ReturnType<typeof xAxis>, get: (c: CheckpointRow) => number | undefined, evs: Ev[], style: Parameters<typeof stepped>[3], annotate: boolean) {
  for (const run of byEra(cks)) stepped(f, run.flatMap((c) => { const y = get(c); return y === undefined ? [] : [{ x: x.at(c.at), y, id: c.id }]; }), evs, style, annotate);
}

/** Marker ticks along the x axis: harness tags, served models, owner steps, and each era's start. */
function ticks(f: Frame, d: Data, x: ReturnType<typeof xAxis>) {
  for (const m of d.markers.filter((m) => PLAIN_MARKERS.includes(m.kind))) f.tick(x.at(m.at), m.label, m.kind, TICK_GLYPH[m.kind]);
  for (const e of eraStarts(d, x)) f.tick(e.x, `${e.label} (charted apart from the era before)`, "era", TICK_GLYPH.era);
}
const voids = (host: HTMLElement, cks: CheckpointRow[]) => {
  const v = cks.filter((c) => c.trust === "void");
  if (v.length) host.insertAdjacentHTML("beforeend", `<div class="stat bad">void, not drawn: ${v.map((c) => `${esc(c.id)} (e${c.epoch})`).join(", ")}</div>`);
};
const card = (panel: string, wide = false) => {
  const c = document.createElement("section");
  c.className = `card${wide ? " wide" : ""}`;
  c.dataset.panel = panel;
  $("#panels").append(c);
  const chart = document.createElement("div");
  chart.className = "chart";
  c.append(chart);
  return chart;
};

// ---- Panels

function quality(d: Data, x: ReturnType<typeof xAxis>, evs: Ev[]) {
  const host = card("quality", true);
  const cks = d.checkpoints.filter((c) => c.trust !== "void");
  const all = cks.map((c) => c.share.all!).filter(Boolean);
  const smokes = d.smokes.filter((s) => s.share !== undefined);
  const f = frame(host, { title: "Quality: the champion's share against A0 (90% band), each era apart", height: 280, x: x.range, y: [Math.max(0, Math.min(0.4, ...all.map((s) => s.lo90), ...smokes.map((s) => s.share!)) - 0.04), Math.min(1, Math.max(0.6, ...all.map((s) => s.hi90), ...smokes.map((s) => s.share!)) + 0.06)], xTicks: x.ticks, yFormat: (v) => v.toFixed(2) });
  // The smoke is the champion against itself on 2 cases: a first point, never a trend.
  for (const s of smokes) f.point(x.at(s.at), s.share!, `smoke: B's share ${s.share!.toFixed(2)} on ${s.cases} cases`, { point: "smoke" });
  f.hline(0.5, "0.5: as good as A0");
  const trusted = cks.filter((c) => c.trust === "green");
  // The band per era: a new judge or bench measures differently, so nothing joins two eras.
  for (const run of byEra(trusted.filter((c) => c.share.all)))
    f.area(run.map((c) => [x.at(c.at), c.share.all!.hi90]), run.map((c) => [x.at(c.at), c.share.all!.lo90]), INK, { band: "share90", era: String(run[0].era) });
  const lines: [string, "all" | "heldout" | "tuning" | "human", string, number][] = [["all", "all", INK, 2.5], ["held-out (H-chart)", "heldout", "#1971c2", 1.5], ["tuning", "tuning", "#2b8a3e", 1.5], ["human (U1)", "human", "#e8590c", 1.5]];
  for (const [, key, color, width] of lines) series(f, trusted, x, (c) => c.share[key]?.share, evs, { color, width, data: { series: key } }, key === "all");
  f.dots(cks.filter((c) => c.share.all).map((c) => ({ x: x.at(c.at), y: c.share.all!.share, id: c.id, hollow: c.trust === "amber" })), INK);
  ticks(f, d, x);
  legend(host, [...lines.map(([l, , c]) => [l, c] as [string, string]), ["steps: owner steps", "#5f3dc4", true]]);
  host.insertAdjacentHTML("beforeend", `<div class="stat muted">Ticks: E a new era (a new judge or bench), charted apart from the one before; H harness, M served model, O owner step.</div>`);
  voids(host, d.checkpoints);
}

/** Bench R1 (testers' sends with gold) at each checkpoint, A0 against the champion: it reports and never decides. */
function realBench(d: Data, x: ReturnType<typeof xAxis>) {
  const host = card("real", true);
  const cks = d.checkpoints.filter((c) => c.trust !== "void" && c.real);
  const f = frame(host, { title: "R1, testers' sends with gold: the champion's share against A0, and the checks each passes", height: 240, x: x.range, y: [0, 1], xTicks: x.ticks, yFormat: (v) => v.toFixed(2) });
  f.hline(0.5, "0.5: as good as A0");
  type R = NonNullable<CheckpointRow["real"]>;
  const lines: [string, (r: R) => number | undefined, string, boolean?][] = [["share", (r) => r.share, INK], ["share on R-hold", (r) => r.shareHold, "#1971c2"], ["checks passed, champion", (r) => r.checks[1], "#2b8a3e", true], ["checks passed, A0", (r) => r.checks[0], "#868e96", true]];
  // R1 frozen again (new cases admitted) is another bench: no line joins two freezes.
  const freezes = cks.reduce<CheckpointRow[][]>((runs, c) => (runs.at(-1)?.[0].real!.hash === c.real!.hash ? runs.at(-1)!.push(c) : runs.push([c]), runs), []);
  for (const run of freezes) for (const [name, get, color, dash] of lines) {
    const pts = run.flatMap((c): XY[] => { const y = get(c.real!); return y === undefined || Number.isNaN(y) ? [] : [[x.at(c.at), y]]; });
    f.line(pts, { color, width: name === "share" ? 2.5 : 1.5, dash, data: { series: name } });
  }
  f.dots(cks.flatMap((c) => (c.real!.share === undefined ? [] : [{ x: x.at(c.at), y: c.real!.share, id: c.id, hollow: c.trust === "amber" }])), INK);
  ticks(f, d, x);
  legend(host, lines.map(([n, , c, dash]) => [n, c, dash]));
  const last = cks.at(-1);
  const r = last?.real;
  host.insertAdjacentHTML("beforeend", `<div class="stat muted">${r ? `At ${esc(last!.id)}: ${r.cases} cases (${r.void} void) of R1 ${esc(r.hash.slice(0, 12))}; every check passed on ${pct(r.casesPassing[1])} of cases for the champion, ${pct(r.casesPassing[0])} for A0.` : "No checkpoint has run R1 yet."} R1 reports beside every keep and never decides.</div>`);
}

function latency(d: Data, x: ReturnType<typeof xAxis>, evs: Ev[]) {
  const host = card("latency", true);
  const cks = d.checkpoints.filter((c) => c.trust !== "void");
  type Line = [string, (c: CheckpointRow) => number | undefined, string, { dash?: boolean; faint?: boolean; right?: boolean }];
  const known = (v: number | undefined): v is number => v !== undefined && v > 0;
  const ok = (get: Line[1]) => (c: CheckpointRow) => (known(get(c)) ? get(c) : undefined);
  // Time to first drawing and render decide (LOOP-V2.md); TTFC and TTD stay, faint, for the points before them. The
  // right axis is the champion over A0 in the same run.
  const lines: Line[] = [
    ["first drawing p50", (c) => c.latency.champion.ttfdP50, INK, {}],
    ["first drawing p75", (c) => c.latency.champion.ttfdP75, INK, { dash: true }],
    ["A0 first drawing p50, same run", (c) => c.latency.anchor.ttfdP50, "#868e96", { faint: true }],
    ["TTFC p50 (before first drawing)", (c) => c.latency.champion.ttfcP50, "#adb5bd", { faint: true }],
    ["TTD p50 (reported)", (c) => c.latency.champion.ttdP50, "#74c0fc", { faint: true }],
    ["first drawing over A0, same run", (c) => c.latency.ratioTtfd?.est, "#5f3dc4", { dash: true, right: true }],
  ];
  const ms = [...cks.flatMap((c) => lines.filter((l) => !l[3].right).map(([, get]) => get(c))), ...d.smokes.flatMap((s) => [s.ttfdP50, s.ttfcP50])].filter(known);
  const ratios = cks.map((c) => c.latency.ratioTtfd?.est).filter(known);
  const f = frame(host, { title: "Latency: time to first drawing in ms (log), the champion over A0 in the same run on the right", height: 280, x: x.range, y: [Math.min(GOAL_TTFC_MS, ...ms) * 0.8, Math.max(...ms, 2000) * 1.25], log: true, y2: [0, Math.max(1.2, ...ratios.map((v) => v * 1.1))], xTicks: x.ticks, yFormat: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}`), y2Format: (v) => `×${v.toFixed(1)}` });
  f.hline(GOAL_TTFC_MS, "goal: first drawing 1.0 s (display only)", { goal: "ttfc" });
  // Laptop points are hollow too: only the PGX's latency is trusted.
  const trusted = cks.filter((c) => c.trust === "green" && c.machine !== "laptop");
  // Owner steps are labelled once, on first drawing's main line; the render chart steps the same way, unlabelled.
  const draw = (f: Frame, ls: Line[], label: boolean) => ls.forEach(([name, get, color, st], i) => series(f, trusted, x, ok(get), evs, { color, width: i ? 1.5 : 2.5, ...st, data: { series: name } }, label && i === 0));
  draw(f, lines, true);
  f.dots(cks.flatMap((c) => (known(c.latency.champion.ttfdP50) ? [{ x: x.at(c.at), y: c.latency.champion.ttfdP50, id: c.id, hollow: c.trust === "amber" || c.machine === "laptop" }] : [])), INK);
  for (const s of d.smokes) for (const [k, v] of [["first drawing", s.ttfdP50], ["TTFC", s.ttfcP50]] as const) if (v !== undefined) f.point(x.at(s.at), v, `smoke ${k} p50 ${(v / 1000).toFixed(1)} s`, { point: "smoke" });
  ticks(f, d, x);
  legend(host, lines.map(([n, , c, st]) => [n, c, st.dash]));

  // Render: the engine's time from an op landing to it on screen (one op's apply plus one frame), per send, measured idle
  // on both arms' boards; its median over the checkpoint's sends.
  const paint: Line[] = [
    ["render p50", (c) => c.latency.champion.renderP50, INK, {}],
    ["render p75", (c) => c.latency.champion.renderP75, INK, { dash: true }],
    ["A0 render p50, same run", (c) => c.latency.anchor.renderP50, "#868e96", { faint: true }],
    ["render over A0, same run", (c) => c.latency.ratioRender?.est, "#5f3dc4", { dash: true, right: true }],
  ];
  const rms = cks.flatMap((c) => paint.filter((l) => !l[3].right).map(([, get]) => get(c))).filter(known);
  const rr = cks.map((c) => c.latency.ratioRender?.est).filter(known);
  const g = frame(host, { title: "Render: an op's apply plus one frame, in ms, the champion over A0 on the right", height: 180, x: x.range, y: [0, Math.max(16, ...rms) * 1.2], y2: [0, Math.max(1.2, ...rr.map((v) => v * 1.1))], xTicks: x.ticks, yFormat: (v) => `${v}`, y2Format: (v) => `×${v.toFixed(1)}` });
  g.hline(16.7, "one frame at 60 Hz", { goal: "render" });
  if (rms.length) draw(g, paint, false);
  else host.insertAdjacentHTML("beforeend", `<div class="stat muted">No checkpoint has measured render yet.</div>`);
  legend(host, paint.map(([n, , c, st]) => [n, c, st.dash]));

  // The latency veto's test on each checkpoint's run: surely slower than A0 is a red ring on the metric it names (render
  // on the render chart, else first drawing), and a line under the charts.
  const slow = cks.filter((c) => c.latency.slower);
  for (const c of slow) {
    const onRender = /render/i.test(c.latency.slower!) && known(c.latency.champion.renderP50);
    const [chart, y] = onRender ? [g, c.latency.champion.renderP50!] : [f, c.latency.champion.ttfdP50];
    if (known(y)) chart.ring(x.at(c.at), y, "slower than A0", `${c.id}: surely slower than A0 on ${c.latency.slower}`, SLOW, { slower: c.id });
  }
  if (slow.length) host.insertAdjacentHTML("beforeend", `<div class="stat bad">Surely slower than A0: ${slow.map((c) => `${esc(c.id)} (e${c.epoch}) ${esc(c.latency.slower)}`).join("; ")}</div>`);
}

function cost(d: Data, x: ReturnType<typeof xAxis>) {
  const host = card("cost", true);
  const trio = document.createElement("div");
  trio.className = "trio";
  host.append(trio);
  // All three cells first, so each chart is drawn at its column's width.
  const [a, ...cells] = [0, 1, 2].map(() => trio.appendChild(document.createElement("div")));
  const groupOf = (role: string) => GROUPS.find(([, , re]) => re.test(role))?.[0] ?? "product";
  const byGroup = d.epochs.map((e) => Object.fromEntries(GROUPS.map(([g]) => [g, Object.entries(e.cost.byRole).filter(([r]) => groupOf(r) === g).reduce((a, [, v]) => a + v.usd, 0)])));
  const maxUsd = Math.max(1, ...d.epochs.map((e) => e.cost.listUsd), ...d.smokes.map((s) => s.listUsd));
  const maxMin = Math.max(1, ...d.epochs.map((e) => e.minutes.total), ...d.smokes.map((s) => s.minutes));
  const fa = frame(a, { title: "List $ per epoch by role group, minutes on the right", height: 230, x: x.range, y: [0, maxUsd * 1.15], y2: [0, maxMin * 1.15], xTicks: x.ticks, yFormat: (v) => `$${v}`, y2Format: (v) => `${v}m` });
  d.epochs.forEach((e, i) => {
    let y = 0;
    for (const [g, color] of GROUPS) {
      const v = byGroup[i][g];
      if (v > 0) fa.bar(e.epoch, y, (y += v), color, 0.6, { bar: g, epoch: String(e.epoch) });
    }
  });
  fa.line(d.epochs.map((e) => [e.epoch, e.minutes.total]), { color: INK, width: 1.5, dash: true, right: true, data: { series: "minutes" } });
  for (const s of d.smokes) fa.point(x.at(s.at), s.listUsd, `smoke $${s.listUsd.toFixed(2)}, ${s.calls} calls, ${s.minutes.toFixed(1)} min`, { point: "smoke" });
  legend(a, [...GROUPS.map(([g, c]) => [g, c] as [string, string]), ["minutes", INK, true]]);
  // Per decision: list $ (no v1 figure to set it against), and minutes against v1's ~2 h and the doc as written.
  const perDecision = (e: EpochRow) => Math.max(1, e.decisions.length);
  const usdPer = (e: EpochRow) => e.cost.listUsd / perDecision(e);
  const fu = frame(cells[0], { title: "List $ per decision", height: 230, x: x.range, y: [0, Math.max(2, ...d.epochs.map(usdPer)) * 1.1], xTicks: x.ticks, yFormat: (v) => `$${v}` });
  fu.line(d.epochs.map((e) => [e.epoch, usdPer(e)]), { color: INK, data: { series: "usd per decision" } });
  fu.dots(d.epochs.map((e) => ({ x: e.epoch, y: usdPer(e), id: `e${e.epoch}`, hollow: e.machine === "laptop" })), INK);
  const minPer = (e: EpochRow) => e.minutes.total / perDecision(e);
  const fm = frame(cells[1], { title: "Minutes per decision", height: 230, x: x.range, y: [0, Math.max(150, ...d.epochs.map(minPer)) * 1.05], xTicks: x.ticks, yFormat: (v) => `${v}` });
  fm.yband(V1.minutes[0], V1.minutes[1], "v1: ~120 min per decision", "#c92a2a", { band: "v1" });
  fm.point(x.range[0] + 0.3, DOC.minutes, `doc as written: ${DOC.minutes} min`, { point: "doc" });
  fm.line(d.epochs.map((e) => [e.epoch, minPer(e)]), { color: INK, data: { series: "minutes per decision" } });
  fm.dots(d.epochs.map((e) => ({ x: e.epoch, y: minPer(e), id: `e${e.epoch}`, hollow: e.machine === "laptop" })), INK);
  // Each token's weekly use as the server last read it (the whole account's, the owner's own use too), with the
  // loop's stop (LOOP.weekSevenDayMax) marked; a token the server never read says so. Decisions this week.
  const lastEpoch = d.epochs.at(-1);
  const stop = LOOP.weekSevenDayMax;
  const slots = [1, 2, 3].flatMap((s) => {
    const b = d.budget.filter((r) => r.slot === s).at(-1);
    const e = lastEpoch?.slots.find((x) => x.slot === s);
    if (!b && !e) return [];
    const used = b?.sevenDay ?? e?.sevenDay;
    const readAt = b?.sevenDay !== undefined ? b.sevenDayAt : e?.sevenDayAt;
    const status = b?.status ?? e?.status ?? "ok";
    const what = used === undefined ? "no reading yet" : `${pct(used)} of its weekly limit used, read ${readAt ? ago(d.status.now - readAt) : "at an unknown time"}`;
    const state = status === "weekly allowance" ? `parked, past the loop's ${pct(stop)}` : /^(ok|allowed)$/.test(status) ? `the loop stops at ${pct(stop)}` : status;
    const title = "The server's 7-day use counts the whole account, not only the loop's calls. The line marks where the loop stops.";
    return [`<span title="${esc(title)}">token ${s}: <span class="meter${(used ?? 0) > stop ? " over" : ""}"><span style="width:${Math.min(100, (used ?? 0) * 100)}%"></span><i style="left:${stop * 100}%"></i></span> ${esc(what)}; ${esc(state)}</span>`];
  });
  const weekAgo = d.status.now - 7 * 86_400_000;
  const thisWeek = d.decisions.filter((x) => x.kind === "card" && Date.parse(d.epochs.find((e) => e.epoch === x.epoch)?.at ?? "") > weekAgo).length;
  host.insertAdjacentHTML("beforeend", `<div class="strip stat">${slots.join("")}<span>decisions this week: ${thisWeek}</span></div>`);
}

function decisions(d: Data) {
  const host = card("decisions", true);
  const comp = (r: DecisionRow) => (r.kind === "owner-step" ? "<b>owner step</b>" : esc(r.card?.component ?? "-"));
  const trustColor = { green: "ok", amber: "", void: "bad" };
  // Keyed by place, not id: a card decided again (rte decide --card) has a row per run under one id.
  const rows = [...d.decisions].map((r, i) => [r, i] as const).reverse().map(([r, i]) => {
    const n = r.counts.wins + r.counts.losses + r.counts.ties;
    return `<tr data-decision="${esc(r.id)}" data-i="${i}"><td>e${r.epoch}</td><td>${comp(r)}<div class="muted">${esc(r.card?.change ?? r.reasons[0] ?? "")}</div></td><td>${r.goal}</td><td>${r.class}</td><td>${r.verdict}</td><td class="${trustColor[r.trust]}">${r.trust}</td><td>${n}</td><td>${r.looks.at(-1)?.z.toFixed(2) ?? "-"}</td><td>×${(r.latency.ttfd ?? r.latency.ttfc).est.toFixed(2)}${r.latency.render ? ` · ×${r.latency.render.est.toFixed(2)}` : ""}</td><td>${r.real?.share === undefined ? "-" : r.real.share.toFixed(2)}</td><td>$${r.cost.listUsd.toFixed(2)}</td><td>${r.minutes}</td><td><a href="/api/eval/history?f=ledger.md" target="_blank" rel="noopener">ledger</a></td></tr>`;
  });
  host.innerHTML = `<h2>Decisions, latest first</h2><div class="scroll"><table class="marks"><thead><tr><th>epoch</th><th>component</th><th>goal</th><th>class</th><th>verdict</th><th>trust</th><th>cases</th><th>last Z</th><th>first drawing · render</th><th title="R1 at a keep: the candidate's share against the champion on testers' sends (reported, never deciding)">R1</th><th>$</th><th>min</th><th></th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="13" class="muted">No decisions yet.</td></tr>'}</tbody></table></div>`;
  host.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-decision]");
    if (tr && !(e.target as HTMLElement).closest("a")) void drill(d.decisions[Number(tr.dataset.i)]);
  });
}

function health(d: Data, x: ReturnType<typeof xAxis>) {
  const host = card("health", true);
  const cks = d.checkpoints.filter((c) => c.trust !== "void");
  const f = frame(host, { title: "Health per checkpoint", height: 240, x: x.range, y: [0, 1], xTicks: x.ticks, yFormat: (v) => pct(v) });
  const mean = (r: Record<string, number>) => Object.values(r).reduce((a, v) => a + v, 0) / Math.max(1, Object.values(r).length);
  const lines: [string, (h: CheckpointRow["health"]) => number, string, boolean?][] = [["void", (h) => h.voidPct, "#c92a2a"], ["flip", (h) => h.flipPct, "#e8590c"], ["hedge", (h) => h.hedgePct, "#f08c00", true], ["beat compliance", (h) => h.beatCompliance, "#2b8a3e"], ["thinking (mean of roles)", (h) => mean(h.thinking), "#5f3dc4", true], ["cold starts", (h) => h.coldShare, "#1971c2"], ["PSI median", (h) => h.psiMedian, "#868e96", true]];
  for (const [name, get, color, dash] of lines) f.line(cks.map((c) => [x.at(c.at), get(c.health)]), { color, width: 1.5, dash, data: { series: name } });
  for (const c of cks.filter((c) => c.aa)) f.tick(x.at(c.at), `A/A ${c.aa!.pass ? "passed" : "failed"} (${c.id})`, "aa", TICK_GLYPH.aa);
  for (const h of d.health.filter((h) => h.kind !== "aa")) f.tick(x.at(h.at), `${h.kind} ${h.pass ? "passed" : "failed"}`, h.kind, TICK_GLYPH[h.kind]);
  legend(host, lines.map(([n, , c, dash]) => [n, c, dash]));
  const last = cks.at(-1)?.health;
  host.insertAdjacentHTML("beforeend", `<div class="stat muted">Ticks: = A/A, C canary, L calibration, R readiness.${last ? ` Latest thinking share by role: ${Object.entries(last.thinking).map(([r, v]) => `${esc(r)} ${pct(v)}`).join(", ")}.` : ""}</div>`);
}

/** The loop as state.json says it is, unless its heartbeat says otherwise: one that died without a word (a kill, an OOM, a reboot) still says running. */
function loopNow(s: Status) {
  const hb = timeOf(s.heartbeat?.wall ?? s.heartbeat?.at);
  const age = Number.isNaN(hb) ? undefined : s.now - hb;
  const st = (s.state?.run ?? {}) as Partial<Run>;
  const running = age !== undefined && age < STALE_MS;
  const said = st.status ?? (running ? "running" : "stopped");
  const state = running || said === "stopped" ? `${said}${st.code ? ` (${st.code})` : ""}` : "stopped (no heartbeat)";
  return { st, age, state };
}

function status(d: Data) {
  const host = card("status", true);
  const s = d.status;
  const { st, age, state } = loopNow(s);
  const slot = st.slot ?? d.epochs.at(-1)?.slots.find((x) => x.status === "active")?.slot;
  const use = d.epochs.at(-1)?.slots.find((x) => x.slot === slot);
  const disk = s.disk;
  host.innerHTML = `<div class="strip"><b>${esc(state)}</b>${st.why ? `<span>${esc(st.why)}</span>` : ""}${st.until ? `<span>until ${esc(st.until.slice(11, 16))} UTC</span>` : ""}<span>phase: ${esc(st.phase ?? "-")}</span>
    <span>token ${slot ?? "-"}${use ? `: 5-hour ${use.fiveHour !== undefined ? pct(use.fiveHour) : "?"}, 7-day ${use.sevenDay !== undefined ? pct(use.sevenDay) : "?"}` : ""}</span>
    <span>heartbeat ${age === undefined ? "none" : ago(age)}</span><span>owner list: ${d.ownerOpen} open</span>
    <span class="${disk && disk.freeGb < disk.ownerGb ? "bad" : ""}">${disk ? `disk ${disk.freeGb.toFixed(0)} GB free · ${disk.daysLeft === null || disk.daysLeft > 365 ? "days left: plenty" : `~${disk.daysLeft.toFixed(0)} days left`} (to the ${disk.pauseGb} GB pause at last week's ${disk.weekGrowthGb.toFixed(1)} GB)` : "free disk: unknown here"}</span>
    <span class="muted">history: ${esc(d.source)}${s.error ? ` · ${esc(s.error)}` : ""}</span></div>`;
}

// ---- A decision's cases and every call behind them (the eval's call inspector)

const fileUrl = (q: Record<string, string>) => `/api/eval/file?${new URLSearchParams(q)}`;
const getJson = async (url: string) => {
  const r = await fetch(url);
  return r.ok ? r.json() : undefined;
};

/** A reply-cache entry, whatever its fields: text as text, image hashes as their blobs, the rest nested. */
function entryHtml(v: unknown, key = ""): string {
  if (typeof v === "string") {
    if (/^[0-9a-f]{64}$/.test(v) && /image/i.test(key)) return `<img src="${fileUrl({ f: `cache/blobs/${v}.jpg` })}" alt="${esc(key)}">`;
    return v.length > 80 || v.includes("\n") ? `<pre class="log" style="background:#faf9f6;padding:6px;border-radius:6px">${esc(v)}</pre>` : esc(v);
  }
  if (Array.isArray(v)) return v.map((x) => entryHtml(x, key)).join(" ");
  if (v && typeof v === "object") return `<table class="marks">${Object.entries(v).map(([k, x]) => `<tr><th>${esc(k)}</th><td>${entryHtml(x, k)}</td></tr>`).join("")}</table>`;
  return esc(v);
}

async function drill(dec: DecisionRow) {
  const m = openModal(`${dec.id}: ${dec.card?.change ?? dec.reasons[0] ?? ""}`);
  m.body.innerHTML = `<div class="drill"><div data-cases><p class="muted">Loading the run's cases…</p></div><div data-shown><p class="muted">Pick a case.</p></div></div>`;
  const list = m.body.querySelector<HTMLElement>("[data-cases]")!;
  const one = m.body.querySelector<HTMLElement>("[data-shown]")!;
  const r = await fetch(fileUrl({ run: dec.run, f: "rows.jsonl" }));
  if (!r.ok) return void (list.innerHTML = `<p class="muted">No raw run ${esc(dec.run)} on this machine: raw runs stay where they ran.</p>`);
  const rows = rowsOf<{ case: string; s: number; ttfc: [number, number]; ttfd?: [number, number]; void?: string }>(await r.text());
  list.innerHTML = `<div class="stat">${rows.length} cases in ${esc(dec.run)}</div>${rows.map((x) => `<button data-case="${esc(x.case)}" style="display:block;width:100%;text-align:left;margin:3px 0;font-size:12px"><b>${esc(x.case)}</b><br><span class="muted">${x.void ? `void: ${esc(x.void)}` : x.s > 0 ? "B better" : x.s < 0 ? "A better" : "tie"} · ${x.ttfd ? "first drawing" : "TTFC"} ${(x.ttfd ?? x.ttfc)?.map((v) => Math.round(v)).join(" / ") ?? "-"} ms</span></button>`).join("")}`;
  list.addEventListener("click", async (e) => {
    const kase = (e.target as HTMLElement).closest<HTMLElement>("[data-case]")?.dataset.case;
    if (!kase) return;
    one.innerHTML = '<p class="muted">Loading…</p>';
    const [packet, calls] = await Promise.all([getJson(fileUrl({ run: dec.run, case: kase, f: "judge/packet.json" })), getJson(`/api/eval/calls?${new URLSearchParams({ run: dec.run, case: kase })}`)]);
    const shot = (label: string, f?: string) => (f ? `<figure style="margin:0"><figcaption class="stat">${esc(label)}</figcaption><img src="${fileUrl({ run: dec.run, case: kase, f })}" alt="${esc(label)}"></figure>` : "");
    const head = packet
      ? `<p><b>said</b> ${esc(packet.said)}<br><b>meant</b> ${esc(packet.meant)}</p><div class="shots">${shot("before, with ink", packet.images.before)}${shot(`left (${packet.positions.left}): ${packet.changes.left.join("; ")}`, packet.images.left)}${shot(`right (${packet.positions.right}): ${packet.changes.right.join("; ")}`, packet.images.right)}</div>`
      : '<p class="muted">Not judged (no packet).</p>';
    const rowsHtml = ((calls ?? []) as Record<string, any>[]).map((c, i) => `<tr data-call="${i}"><td>${esc(c.arm ?? "-")}</td><td>${esc(c.role)}</td><td>${esc(c.model)}</td><td>${esc(c.servedModel ?? "-")}</td><td>${c.ms}</td><td>${c.firstMs ?? "-"}</td><td>${c.waitMs ?? "-"}</td><td>${c.cacheRead}</td><td>${(c.cacheWrite5m ?? 0) + (c.cacheWrite1h ?? 0)}${c.cacheWrite1h ? ` (1h ${c.cacheWrite1h}!)` : ""}</td><td>${c.thinkingTokens}</td><td>${esc(c.mode)}/${esc(c.shared)}</td></tr>`);
    one.innerHTML = `${head}<h3 style="margin:10px 0 4px">Every call of the case</h3><div class="scroll"><table class="marks" data-calls><thead><tr><th>arm</th><th>role</th><th>model</th><th>served</th><th>ms</th><th>first text</th><th>wait</th><th>cache read</th><th>cache write</th><th>thinking</th><th>mode</th></tr></thead><tbody>${rowsHtml.join("") || '<tr><td colspan="11" class="muted">No calls logged for this case.</td></tr>'}</tbody></table></div><div data-call-detail></div>`;
    one.querySelector("[data-calls]")!.addEventListener("click", async (ev) => {
      const i = (ev.target as HTMLElement).closest<HTMLElement>("tr[data-call]")?.dataset.call;
      if (i === undefined) return;
      const c = calls[Number(i)];
      const entry = await getJson(fileUrl({ f: `cache/replies/${c.reqHash}.json` }));
      one.querySelector("[data-call-detail]")!.innerHTML = `<h3 style="margin:10px 0 4px">${esc(c.role)} · exactly what was sent and what came back</h3>${entry ? entryHtml(entry) : `<p class="muted">Not in the reply cache (${esc(c.reqHash)}).</p>`}`;
    });
  });
}

// ---- Needs you: what waits for the owner, newest first, each with its thread

const NOTES_MS = 20_000;
const TITLE = document.title;
const SAMPLE = new URLSearchParams(location.search).has("sample");
const VERDICT: Record<DecisionRow["verdict"], string> = { keep: "kept", revert: "reverted", void: "void", owner: "held" };
let notes: Note[] = [];
let sampleNotes: Note[] | undefined;
let notesError: string | undefined;
let sendError: string | undefined;
/** What he is typing and which forms are open: a redraw (a reply landing) keeps both, and the caret. */
const drafts = new Map<string, string>();
const opened = new Set<string>();
let settledOpen = false;

const now = () => (SAMPLE && data ? data.status.now : Date.now());
const noteHtml = (n: Note) =>
  `<div class="note ${n.who}"><span class="stat muted">${n.who === "owner" ? "you" : "Claude"}, ${ago(Math.max(0, now() - Date.parse(n.at)))}${n.resolved === true ? " · resolved" : n.resolved === false ? " · reopened" : ""}</span>${n.text ? `<div class="text">${esc(n.text)}</div>` : ""}</div>`;
const turnChip = (t?: Thread) => (!t?.last ? "" : t.last.who === "claude" ? '<span class="chip reply">Claude replied</span>' : '<span class="chip">waiting for Claude</span>');
const form = (key: string, resolvable: boolean) =>
  `<div data-form="${esc(key)}"${opened.has(key) || drafts.get(key) ? "" : " hidden"}><textarea data-key="${esc(key)}" rows="3" placeholder="${key === "new" ? "A side chat with Claude, about anything" : "Your answer or comment; Claude replies here"} (Ctrl+Enter sends)">${esc(drafts.get(key) ?? "")}</textarea>` +
  `<div class="row"><button class="primary" data-to="${esc(key)}">Send</button>${resolvable ? `<button data-to="${esc(key)}" data-and-resolve>Send and resolve</button>` : ""}</div></div>`;
const acts = (key: string, links = "") => `<div class="row acts">${links}<button data-open="${esc(key)}">answer</button><button data-resolve="${esc(key)}">resolve</button></div>`;

function itemHtml(it: Item) {
  const d = it.decision;
  const link = (f: string, label: string) => `<a href="/api/eval/history?f=${encodeURIComponent(f)}" target="_blank" rel="noopener">${label}</a>`;
  const links = d ? `<button data-drill="${esc(d.id)}">cases and calls</button>${link("ledger.md", "ledger")}${d.kind === "card" && d.verdict !== "keep" ? link(`tried/${d.id}.patch`, "patch") : ""}` : "";
  const state = it.held ? '<span class="chip held">held for your call</span>' : d ? `<span class="chip">${VERDICT[d.verdict]}</span>` : it.notice ? '<span class="chip">notice</span>' : "";
  const meta = [d?.card?.component, d?.goal === "owner" ? undefined : d?.goal, it.date].filter(Boolean).join(" · ");
  return `<li class="item${it.held ? " held" : ""}${it.turn ? "" : " answered"}" data-item="${esc(it.id)}"><div class="row">${state}${it.notice ? "" : `<b>${esc(it.id)}</b>`}<span class="muted">${esc(meta)}</span>` +
    `${it.since ? `<span class="chip">re-decided since: ${VERDICT[it.since.verdict]} (${esc(it.since.id)})</span>` : ""}${turnChip(it.thread)}</div>` +
    `<p class="what"${d?.card ? ` title="${esc(d.card.change)}"` : ""}>${esc(it.what)}</p>${it.why.length ? `<ul class="why">${it.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}` +
    `${(it.thread?.notes ?? []).map(noteHtml).join("")}${acts(it.id, links)}${form(it.id, true)}</li>`;
}
const chatHtml = (t: Thread) =>
  `<li class="item${t.last?.who === "owner" ? " answered" : ""}" data-item="${esc(t.id)}"><div class="row"><span class="chip">side chat</span><span class="muted">${esc(t.id)}</span>${turnChip(t)}</div>${t.notes.map(noteHtml).join("")}${acts(t.id)}${form(t.id, true)}</li>`;

/** What the pipeline itself waits on the owner for: a loop stopped for them, and cards waiting for their look. */
function pipelineNeeds(): string[] {
  const out: string[] = [];
  const st = (data?.status.state?.run ?? {}) as Partial<Run>;
  if (st.status === "stopped" && st.code && st.code !== "asked" && st.code !== "done")
    out.push(`<li class="item held"><p class="what">The loop stopped (${esc(st.code)})</p><p class="why">${esc(st.why ?? "")} Once it's dealt with, <code>bin/rte run</code> on the PGX starts it again.</p></li>`);
  const proposed = intakeData?.cards.filter((c) => c.state === "proposed") ?? [];
  if (proposed.length) {
    // When each joins the bank unless rejected, a count per day.
    const byDay = new Map<string, number>();
    for (const c of [...proposed].sort((a, b) => (a.admitAt ?? "").localeCompare(b.admitAt ?? ""))) byDay.set(day(c.admitAt), (byDay.get(day(c.admitAt)) ?? 0) + 1);
    const joins = [...byDay].map(([d, k]) => `${k} join${k > 1 ? "" : "s"} ${d || "when looked at"}`).join(", ");
    out.push(`<li class="item"><p class="what">${proposed.length} card${proposed.length > 1 ? "s wait" : " waits"} for your look</p><p class="why">${esc(joins)}, unless you reject ${proposed.length > 1 ? "them" : "it"}. <a href="/evals/review/">Intake and review</a></p></li>`);
  }
  const pass = intakeData?.pass;
  if (pass && pass.failedPasses >= INTAKE_FAILS)
    out.push(`<li class="item"><p class="what">Intake failed in ${pass.failedPasses} passes in a row</p><p class="why">${pass.failed} of its steps failed in the last one, ${ago(now() - Date.parse(pass.at))}. Each pass tries them again; <code>real/logs/intake.log</code> on the PGX says why.</p></li>`);
  if (intakeError) out.push(`<li class="item"><p class="what">Eval HQ can't read intake</p><p class="why">${esc(intakeError)}. Cards waiting for you aren't counted here until it can.</p></li>`);
  return out;
}

function needs() {
  if (!data) return;
  const host = $("#needs");
  const n = needsYou(data.ownerList, data.decisions, notes);
  const pipe = pipelineNeeds();
  const count = yourTurn(n) + pipe.length;
  document.title = count ? `(${count}) ${TITLE}` : TITLE;
  const held = n.items.filter((x) => x.held).length;
  const answered = n.items.filter((x) => !x.turn).length + n.chats.filter((t) => t.last?.who === "owner").length;
  const replies = [...n.items.map((x) => x.thread), ...n.chats].filter((t) => t?.last?.who === "claude").length;
  const parts = [held && `${held} held for your call`, n.items.length - held && `${n.items.length - held} on the owner list`, replies && `${replies} answered by Claude`, answered && `${answered} waiting for Claude`];
  const active = document.activeElement;
  const caret = active instanceof HTMLTextAreaElement && host.contains(active) ? { key: active.dataset.key!, at: [active.selectionStart, active.selectionEnd] as const } : undefined;
  const quiet = !n.items.length && !n.chats.length && !pipe.length;
  const settled = [...n.settled.map((x) => [x.id, x.what] as const), ...n.closed.map((t) => [t.id, t.last?.text ?? ""] as const)];
  host.hidden = false;
  host.classList.toggle("quiet", quiet);
  host.innerHTML = `<div class="row"><h2>${quiet ? "Nothing needs you" : "Needs you"}${count ? ` <span class="badge" data-count>${count}</span>` : ""}</h2><span class="muted">${parts.filter(Boolean).join(" · ")}</span><span class="grow"></span><button data-open="new">New side chat</button></div>` +
    `<p class="muted blurb">Everything that waits for you: decisions the loop holds for your call, the owner list, cards waiting for your look, a stop that's yours. Answer in an item's thread and Claude replies there; resolve settles it.</p>${form("new", false)}` +
    `${pipe.length ? `<ol data-pipeline>${pipe.join("")}</ol>` : ""}${n.items.length ? `<ol data-items>${n.items.map(itemHtml).join("")}</ol>` : ""}${n.chats.length ? `<h3>Side chats</h3><ol data-chats>${n.chats.map(chatHtml).join("")}</ol>` : ""}` +
    `${settled.length ? `<details${settledOpen ? " open" : ""}><summary class="muted">Resolved here (${settled.length})${n.settled.length ? ": owner-list.md keeps them open until Claude ticks them there" : ""}</summary><ol>${settled.map(([id, what]) => `<li class="row"><b>${esc(id)}</b><span class="muted">${esc(what.slice(0, 140))}</span><button data-resolve="${esc(id)}" data-reopen>reopen</button></li>`).join("")}</ol></details>` : ""}` +
    `${notesError || sendError ? `<div class="stat bad">${esc(sendError ? `Not sent: ${sendError}` : `Threads unavailable here: ${notesError}`)}</div>` : ""}`;
  if (caret) {
    const t = host.querySelector<HTMLTextAreaElement>(`textarea[data-key="${CSS.escape(caret.key)}"]`);
    t?.focus();
    t?.setSelectionRange(...caret.at);
  }
}

/** The owner's note: to the pages server, or (?sample) to the sample's threads in memory. */
async function post(b: { thread?: string; text: string; resolved?: boolean }) {
  if (SAMPLE) {
    const thread = b.thread ?? chatId(new Date(now() + (sampleNotes ?? []).length * 1000));
    return void (sampleNotes ??= []).push({ at: new Date(now()).toISOString(), thread, ...(isChat(thread) ? {} : { item: thread }), who: "owner", text: b.text, ...(b.resolved === undefined ? {} : { resolved: b.resolved }) });
  }
  const r = await fetch("/api/eval/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
}
let busy = false;
async function send(key: string, resolved?: boolean) {
  const text = (drafts.get(key) ?? "").trim();
  if (busy || (!text && resolved === undefined)) return;
  busy = true;
  try {
    await post({ ...(key === "new" ? {} : { thread: key }), text, ...(resolved === undefined ? {} : { resolved }) });
    drafts.delete(key);
    opened.delete(key);
    sendError = undefined;
  } catch (err) {
    sendError = (err as Error).message;
  }
  busy = false;
  await pollNotes();
}

let notesTimer: ReturnType<typeof setTimeout> | undefined;
async function pollNotes() {
  clearTimeout(notesTimer);
  try {
    if (SAMPLE) notes = [...(sampleNotes ?? [])];
    else {
      const r = await fetch("/api/eval/threads");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      notes = j.notes;
    }
    notesError = undefined;
  } catch (err) {
    notesError = (err as Error).message;
  }
  needs();
  notesTimer = setTimeout(pollNotes, NOTES_MS);
}

{
  const host = $("#needs");
  host.addEventListener("input", (e) => {
    const t = e.target as HTMLTextAreaElement;
    if (t.dataset.key) drafts.set(t.dataset.key, t.value);
  });
  host.addEventListener("keydown", (e) => {
    const key = (e.target as HTMLElement).dataset.key;
    if (key && e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.preventDefault(), void send(key);
  });
  host.addEventListener("toggle", (e) => e.target instanceof HTMLDetailsElement && (settledOpen = e.target.open), true);
  host.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    const { open, to, resolve, drill: id } = b?.dataset ?? {};
    if (open !== undefined) {
      const f = host.querySelector<HTMLElement>(`[data-form="${CSS.escape(open)}"]`)!;
      f.hidden = !f.hidden;
      if (f.hidden) opened.delete(open);
      else opened.add(open), f.querySelector("textarea")!.focus();
    } else if (to !== undefined) void send(to, b!.dataset.andResolve !== undefined || undefined);
    else if (resolve !== undefined) void send(resolve, b!.dataset.reopen === undefined);
    else if (id !== undefined) {
      const d = data?.decisions.findLast((x) => x.id === id);
      if (d) void drill(d);
    }
  });
  // Back on the tab: the replies and the pipeline now, not at the next poll.
  window.addEventListener("focus", () => void refresh().then(pollNotes));
}

// ---- The pipeline at a glance, and the playgrounds

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "");
function overview(d: Data, i?: Intake) {
  const host = $("#overview");
  const loop = loopNow(d.status);
  const champ = { unshipped: d.status.champion?.unshipped, since: d.status.champion?.since ?? "master" };
  const n = (k: string) => i?.states[k] ?? 0;
  const next = i?.cards.filter((c) => c.state === "proposed").map((c) => c.admitAt ?? "").sort()[0];
  // Each pull apart: the laptop's every 30 min must not hide a live pull that stopped.
  const pulled = (at?: string) => (at ? ago(now() - Date.parse(at)) : "never");
  const stage = (name: string, href: string, main: string, sub: string) => `<a class="stage-link" href="${href}"><span class="muted">${name}</span><b>${esc(main)}</b><span class="muted">${esc(sub)}</span></a>`;
  host.innerHTML = `<div class="pipeline">${[
    i ? stage("Pull", "/evals/review/", `live ${pulled(i.pull.live.pulledAt)}`, `local ${pulled(i.pull.local.pulledAt)} · ${n("pulled")} new sends`) : "",
    i ? stage("Intake", "/evals/review/?state=labeled", `${n("labeled")} being labeled`, [i.pass && `last pass ${ago(now() - Date.parse(i.pass.at))}${i.pass.failed ? `, ${i.pass.failed} failed` : ""}`, `${n("skipped")} skipped`].filter(Boolean).join(" · ")) : "",
    i ? stage("Review", "/evals/review/", `${n("proposed")} waiting for you`, next ? `next joins ${day(next)}` : "none waiting") : "",
    i ? stage("Bank", "/evals/review/?state=admitted", `${i.bank.driver} driver · ${i.bank.real} real`, "cases decisions measure") : "",
    intakeError ? stage("Intake", "/evals/review/", "can't be read", intakeError) : "",
    stage("Loop", "#loop", loop.state, loop.st.phase ?? loop.st.why ?? ""),
    d.status.champion ? stage("Champion", "#loop", d.status.champion.sha.slice(0, 7), champ.unshipped === undefined ? "" : `${champ.unshipped} keep${champ.unshipped === 1 ? "" : "s"} not on ${champ.since}`) : "",
    d.ships.length ? stage("Prod", "#loop", d.ships.at(-1)!.tag, [prodHealth?.url && (prodHealth.ok ? "health ok" : `down: ${prodHealth.error ?? `HTTP ${prodHealth.status}`}`), `shipped ${day(d.ships.at(-1)!.at)}`].filter(Boolean).join(" · ")) : "",
  ].join("")}</div>`;
}

/** Each product playground and what it's for, under the step of a send it feeds, in a send's order. */
const PLAYGROUND_USE: [string, [string, string][]][] = [
  ["what the person gives", [
    ["speech", "words with their times: a spoken send's input"],
    ["ink", "strokes with their times, the ink a case replays on the person's clock"],
  ]],
  ["reading the ink", [
    ["hittest", "what a stroke touches or encloses: the first reading of the ink"],
    ["marks", "each mark's reading (a loop, an arrow, a tap), as the drawing model is told it"],
    ["link", "ink tied to the words said while drawing it: a send's [ink n] markers"],
    ["describe", "shape descriptions good enough for \"that button\": what words are resolved against"],
  ]],
  ["working out what was meant", [
    ["resolve", "words and ink to the shapes they mean: the resolver, and Jev's guess"],
    ["router", "the fast lane or the full one, per send"],
    ["board", "which pictures of the board are worth a model's look"],
    ["shot", "the screenshot the drawing model gets"],
    ["coords", "how the model writes places on the board"],
  ]],
  ["drawing", [
    ["draw", "the product's send end to end; ?record=1 records your sends for U1, the Judge view's \"your sends\""],
    ["ops", "the drawing model's op lines, applied as they stream: the engine every arm runs"],
    ["tidy", "the tidy pass after the ops: sizes, edges and gaps evened out"],
    ["picture", "a few words to a doodle: the picture model gold is drawn against"],
    ["camera", "camera moves the way a person means them"],
  ]],
  ["on screen", [["render", "the board's renderer: what render time measures"]]],
];
function playgrounds() {
  const host = card("playgrounds", true);
  let origin = "http://localhost:5173";
  try {
    origin = localStorage.getItem("hq.dev") ?? origin;
  } catch {} // no storage here: the default
  const names = new Map<string, string>(PLAYGROUNDS);
  const list = () => PLAYGROUND_USE.map(([step, ps]) => `<li><b>${esc(step)}</b><ul>${ps.map(([p, use]) => `<li><a href="${esc(origin)}/playgrounds/${p}/" target="_blank" rel="noopener">${esc(names.get(p) ?? p)}</a> <span class="muted">${esc(use)}</span></li>`).join("")}</ul></li>`).join("");
  host.innerHTML = `<h2>The product's playgrounds</h2><p class="muted">Each tries one part of a send by hand. They open on the laptop's dev server (npm run dev), where the product's model API runs: <label>at <input data-origin value="${esc(origin)}" size="28"></label></p><ul data-list>${list()}</ul>`;
  host.querySelector<HTMLInputElement>("[data-origin]")!.addEventListener("change", (e) => {
    origin = (e.target as HTMLInputElement).value.replace(/\/$/, "");
    try {
      localStorage.setItem("hq.dev", origin);
    } catch {} // kept for this view only
    host.querySelector("[data-list]")!.innerHTML = list();
  });
}

/** A view's heading in the page: its anchor, and one sentence on what its stage does and what it needs of the owner. */
function view(id: string, title: string, blurb: string) {
  const h = document.createElement("div");
  h.className = "wide view";
  h.id = id;
  h.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(blurb)}</p>`;
  $("#panels").append(h);
}

// ---- Load, draw, poll

let data: Data | undefined;
let intakeData: Intake | undefined;
let intakeError: string | undefined;
let prodHealth: ProdHealth | undefined;
function draw() {
  if (!data) return;
  $("#panels").replaceChildren();
  overview(data, intakeData);
  const x = xAxis(data);
  const evs = ownerSteps(data, x);
  view("loop", "Loop", "The loop tries changes the analyst and critic propose, measures each against the champion on the bank's cases, and keeps what is faster with nothing worse. It needs you only for what it holds (Needs you).");
  status(data);
  decisions(data);
  view("benchmarks", "Benchmarks", "Every few keeps a checkpoint measures the champion against A0 on the frozen benches: B1 (the driver's held-out and tuning cases), U1 (your recorded sends) and R1 (testers' sends with gold). They only report: a champion surely slower than A0, or overfitting, comes to you in Needs you.");
  quality(data, x, evs);
  realBench(data, x);
  latency(data, x, evs);
  health(data, x);
  cost(data, x);
  view("playgrounds", "Playgrounds", "The product's parts one at a time, under the step of a send each feeds, for trying a change by hand before the loop measures it. Nothing here waits for you.");
  playgrounds();
}

/** GET /api/eval/prod, or nothing where it isn't served (the sample). */
async function readProd(): Promise<ProdHealth | undefined> {
  if (SAMPLE) return undefined;
  const r = await fetch("/api/eval/prod").catch(() => undefined);
  return r?.ok ? ((await r.json()) as ProdHealth) : undefined;
}

/** GET /api/eval/intake: absent (404) where intake isn't served, as on the laptop; any other failure is said. */
async function readIntake() {
  intakeError = undefined;
  if (SAMPLE) return undefined;
  const r = await fetch("/api/eval/intake").catch((err: Error) => ((intakeError = err.message), undefined));
  if (r?.ok) return (await r.json()) as Intake;
  if (r && r.status !== 404) intakeError = (await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`;
  return undefined;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let first = true;
async function refresh() {
  clearTimeout(timer);
  try {
    const h: History = SAMPLE ? await sample() : await (await fetch("/api/eval/history")).json();
    if (SAMPLE) sampleNotes ??= rowsOf<Note>(h.files["threads.jsonl"]);
    [intakeData, prodHealth] = await Promise.all([readIntake(), readProd()]);
    data = parse(h);
    draw();
    needs();
    // The views are drawn after the page loaded, so the browser never found #loop and the like: go there now.
    if (first && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    first = false;
  } catch (err) {
    $("#panels").innerHTML = `<section class="card wide" data-panel="status"><h2>Can't read the eval history</h2><p class="muted">${esc((err as Error).message)}</p></section>`;
  }
  // Always again: a stopped loop's page still has intake's cards and the next start to show.
  timer = setTimeout(refresh, POLL_MS);
}

let resizing = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => draw());
});
void document.fonts.load("15px Excalifont").then(refresh, refresh).then(pollNotes);
