// The eval's progress page (§5.4, frozen measuring side): quality against the
// current anchor, the chained index Q, latency, cost and speed against v1, the
// decisions with every case and call behind them, health, and the loop's status.
// Everything comes from GET /api/eval/history (evals/pages/plugin.ts: the
// eval/history branch); the page holds no state and polls every 60 s while the
// loop's heartbeat is fresh. ?sample=1 draws the fake history in ./sample/.
import { openModal } from "../../src/modal.ts";
import { $, shell } from "../../src/ui.ts";
import { LOOP } from "../loop/config.ts";
import type { BudgetRow, CheckpointRow, DecisionRow, EpochRow, Era, HealthRow, Lat, Marker } from "../loop/types.ts";
import { type Dot, type Frame, INK, type XY, frame, legend } from "./charts.ts";

shell("", "Eval progress: what the loop kept and reverted, quality against a frozen anchor on cases no decision sees, latency, and what it cost against v1. Read from the eval/history branch; no model call.");

type Anchor = { id: string; sha: string; Q: number; latency?: Lat };
type Disk = { freeGb: number; weekGrowthGb: number; daysLeft: number | null; ownerGb: number; pauseGb: number };
type Status = { heartbeat?: Record<string, unknown>; state?: Record<string, unknown>; disk?: Disk; now: number; error?: string };
type History = { source: string; files: Record<string, string | null>; status: Status };
type Data = ReturnType<typeof parse>;

/** v1 per decision (§0): ~2 h and 25–33% of a five-hour window; the eval doc as written: 75 min and 13.7%. */
const V1 = { minutes: [100, 140], window: [0.25, 0.33] };
const DOC = { minutes: 75, window: 0.137 };
const GOAL_TTFC_MS = 1000;
const POLL_MS = 60_000;
/** The loop writes its heartbeat every 10 s; older than this, it isn't running. */
const STALE_MS = 60_000;
const GROUPS: [string, string, RegExp][] = [["product", "#1971c2", /^(draw|resolve|picture|camera|describe|product)/], ["judges", "#5f3dc4", /^(fidelity|craft|expectation|miss|canary|judge)/], ["agents", "#2b8a3e", /^(analyst|critic|engineer|agent)/], ["drivers", "#e8590c", /^(driver|probe)/]];
const TICK_GLYPH: Record<string, string> = { harness: "H", "served-model": "M", "owner-step": "O", anchor: "A", aa: "=", canary: "C", calib: "L", ready: "R" };

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rowsOf = <T>(text?: string | null): T[] => (text ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const logit = (p: number) => Math.log(Math.min(0.95, Math.max(0.05, p)) / (1 - Math.min(0.95, Math.max(0.05, p))));
const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const timeOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${(ms / 3_600_000).toFixed(1)} h ago`);

function parse(h: History) {
  const f = h.files;
  const json = <T>(name: string): T[] => (f[name] ? JSON.parse(f[name]!) : []);
  return {
    source: h.source, status: h.status,
    epochs: rowsOf<EpochRow>(f["epochs.jsonl"]), decisions: rowsOf<DecisionRow>(f["decisions.jsonl"]), checkpoints: rowsOf<CheckpointRow>(f["checkpoints.jsonl"]),
    budget: rowsOf<BudgetRow>(f["budget.jsonl"]), health: rowsOf<HealthRow>(f["health.jsonl"]), markers: rowsOf<Marker>(f["markers.jsonl"]),
    anchors: json<Anchor>("anchors.json"), eras: json<Era>("eras.json"),
    /** Open owner-list items: unchecked markdown tasks. */
    ownerOpen: (f["owner-list.md"]?.match(/^\s*- \[ \]/gm) ?? []).length,
  };
}

async function sample(): Promise<History> {
  const raw = import.meta.glob("./sample/*", { query: "?raw", import: "default" });
  const files: Record<string, string> = {};
  for (const [path, load] of Object.entries(raw)) files[path.split("/").pop()!] = (await load()) as string;
  const now = Date.parse(rowsOf<EpochRow>(files["epochs.jsonl"]).at(-1)!.at) + 300_000;
  return { source: "sample", files, status: { now, heartbeat: { wall: now - 4000 }, state: { status: "running", phase: "e21-h1 measuring, look 32", slot: 2 }, disk: { freeGb: 84.2, weekGrowthGb: 16.9, daysLeft: 30.6, ownerGb: LOOP.diskOwnerGb, pauseGb: LOOP.diskPauseGb } } };
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
  const xs = [...pts.map((p) => p[1]), ...d.checkpoints.map((c) => at(c.at))];
  const range: [number, number] = [Math.min(0, ...xs) - 0.3, Math.max(1, ...xs) + 0.3];
  const ticks = d.epochs.map((e) => ({ at: e.epoch, label: `e${e.epoch}` }));
  return { at, range, ticks };
}

/** A step event on a line: an era's bridge, an anchor move after its checkpoint, an owner step into his checkpoint. */
type Ev = { x: number; kind: "era" | "anchor" | "owner"; label: string; after: boolean; era?: Era };

function events(d: Data, x: ReturnType<typeof xAxis>): Ev[] {
  const ck = (id?: string) => d.checkpoints.find((c) => c.id === id);
  const evs: Ev[] = [];
  for (const e of d.eras.filter((e) => e.era > 1)) evs.push({ x: x.at(e.from), kind: "era", label: `era ${e.era}: ${e.why} changed${e.bridge ? ", bridged" : ""}`, after: false, era: e });
  for (const c of d.checkpoints.filter((c) => c.anchorMoved)) evs.push({ x: x.at(c.at), kind: "anchor", label: `anchor ${d.anchors[d.anchors.findIndex((a) => a.sha === c.champion)]?.id ?? "moved"}`, after: true });
  for (const o of d.decisions.filter((o) => o.kind === "owner-step" && ck(o.checkpoint)))
    evs.push({ x: x.at(ck(o.checkpoint)!.at), kind: "owner", label: d.markers.find((m) => m.kind === "owner-step" && m.ref === o.checkpoint)?.label ?? o.reasons[0] ?? "owner step", after: false });
  return evs.sort((a, b) => a.x - b.x);
}

/**
 * A continuous trend line through the trusted points with each step drawn in: at an
 * era change the last value moves to its bridged value, at an anchor move a share
 * starts again at 0.5, an owner step is a step into his checkpoint. Only the main
 * series labels the steps.
 */
function stepped(f: Frame, pts: Dot[], evs: Ev[], map: (e: Ev, y: number) => number | undefined, style: { color: string; width?: number; dash?: boolean; faint?: boolean; right?: boolean; data?: Record<string, string> }, annotate: boolean) {
  const path: XY[] = [];
  const stepAt = (e: Ev, y: number, to: number) => {
    path.push([e.x, y], [e.x, to]);
    if (annotate) f.step(e.x, y, to, e.label, e.kind, style.right);
    return to;
  };
  pts.forEach((p, i) => {
    const prev = pts[i - 1];
    if (prev) {
      let y = prev.y;
      for (const e of evs.filter((e) => (e.after ? prev.x <= e.x && e.x < p.x : prev.x < e.x && e.x <= p.x))) {
        const to = e.kind === "owner" ? p.y : map(e, y);
        if (to !== undefined) y = stepAt(e, y, to);
      }
    }
    path.push([p.x, p.y]);
  });
  // A step after the last point (an anchor move at the latest checkpoint).
  const last = pts.at(-1);
  if (last) for (const e of evs.filter((e) => e.after && e.x >= last.x)) map(e, last.y) !== undefined && stepAt(e, last.y, map(e, last.y)!);
  f.line(path, { ...style, ids: pts.map((p) => p.id) });
}

/** Marker ticks (harness tags, served models, owner steps, anchor moves) along the x axis. */
const ticks = (f: Frame, d: Data, x: ReturnType<typeof xAxis>) => d.markers.forEach((m) => f.tick(x.at(m.at), m.label, m.kind, TICK_GLYPH[m.kind]));
/** Shades every stretch from a checkpoint in debt to the next checkpoint. */
function debt(f: Frame, cks: CheckpointRow[], x: ReturnType<typeof xAxis>, on: (c: CheckpointRow) => boolean, label: string, kind: string) {
  cks.forEach((c, i) => {
    if (!on(c) || (i && on(cks[i - 1]))) return; // one band per stretch in debt
    const end = cks.findIndex((n, j) => j > i && !on(n));
    f.xband(x.at(c.at), end > 0 ? x.at(cks[end].at) : x.range[1], label, "#c92a2a", { debt: kind });
  });
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
  const f = frame(host, { title: "Quality: the champion's share against the current anchor (90% band)", height: 280, x: x.range, y: [Math.max(0, Math.min(0.4, ...all.map((s) => s.lo90)) - 0.04), Math.min(1, Math.max(0.6, ...all.map((s) => s.hi90)) + 0.06)], xTicks: x.ticks, yFormat: (v) => v.toFixed(2) });
  f.hline(0.5, "0.5: as good as the anchor");
  debt(f, cks, x, (c) => c.quality.debt, "quality debt", "quality");
  const toAnchor = (e: Ev, y: number) => (e.kind === "anchor" ? 0.5 : e.era?.bridge ? sigmoid(logit(y) + e.era.bridge.step.Q) : y);
  const trusted = cks.filter((c) => c.trust === "green");
  // The band in runs between anchor moves, where shares are against the same anchor.
  let run: CheckpointRow[] = [];
  const flush = () => (f.area(run.map((c) => [x.at(c.at), c.share.all!.hi90]), run.map((c) => [x.at(c.at), c.share.all!.lo90]), INK, { band: "share90" }), (run = []));
  for (const c of trusted) {
    if (c.share.all) run.push(c);
    if (c.anchorMoved) flush();
  }
  flush();
  const series: [string, "all" | "heldout" | "tuning" | "human", string, number][] = [["all", "all", INK, 2.5], ["held-out (H-chart)", "heldout", "#1971c2", 1.5], ["tuning", "tuning", "#2b8a3e", 1.5], ["human (U1)", "human", "#e8590c", 1.5]];
  for (const [, key, color, width] of series) {
    const pts = trusted.filter((c) => c.share[key]).map((c) => ({ x: x.at(c.at), y: c.share[key]!.share, id: c.id }));
    stepped(f, pts, evs, toAnchor, { color, width, data: { series: key } }, key === "all");
  }
  f.dots(cks.filter((c) => c.share.all).map((c) => ({ x: x.at(c.at), y: c.share.all!.share, id: c.id, hollow: c.trust === "amber" })), INK);
  ticks(f, d, x);
  legend(host, [...series.map(([l, , c]) => [l, c] as [string, string]), ["steps: era bridges, anchor moves, owner steps", "#5f3dc4", true]]);
  voids(host, d.checkpoints);
}

function chainedQ(d: Data, x: ReturnType<typeof xAxis>, evs: Ev[]) {
  const host = card("q");
  const cks = d.checkpoints.filter((c) => c.trust !== "void");
  const qs = cks.flatMap((c) => [c.Q.lo90, c.Q.hi90]);
  const f = frame(host, { title: "Chained quality index Q (chained, not additive)", height: 240, x: x.range, y: [Math.min(0, ...qs) - 0.2, Math.max(1, ...qs) + 0.2], xTicks: x.ticks, yFormat: (v) => v.toFixed(1) });
  const trusted = cks.filter((c) => c.trust === "green");
  f.area(trusted.map((c) => [x.at(c.at), c.Q.hi90]), trusted.map((c) => [x.at(c.at), c.Q.lo90]), "#5f3dc4", { band: "q90" });
  // Q chains through anchor moves, so only eras and owner steps step it.
  stepped(f, trusted.map((c) => ({ x: x.at(c.at), y: c.Q.value, id: c.id })), evs, (e, y) => (e.kind === "anchor" ? undefined : e.era?.bridge ? y + e.era.bridge.step.Q : y), { color: "#5f3dc4", data: { series: "Q" } }, true);
  f.dots(cks.map((c) => ({ x: x.at(c.at), y: c.Q.value, id: c.id, hollow: c.trust === "amber" })), "#5f3dc4");
  ticks(f, d, x);
  host.insertAdjacentHTML("beforeend", `<div class="stat muted">Q = Q(anchor) + logit(share), log-odds against A0. Anchors: ${d.anchors.map((a) => `${esc(a.id)} Q ${a.Q.toFixed(2)}`).join(" · ") || "-"}</div>`);
}

function latency(d: Data, x: ReturnType<typeof xAxis>, evs: Ev[]) {
  const host = card("latency", true);
  const cks = d.checkpoints.filter((c) => c.trust !== "void");
  const ms = cks.flatMap((c) => [c.latency.champion.ttfcP50, c.latency.champion.ttfcP75, c.latency.champion.ttdP50, c.latency.anchor.ttfcP50]);
  const ratios = cks.map((c) => c.latency.chainedTtfc);
  const f = frame(host, { title: "Latency: TTFC and TTD in ms (log), chained TTFC ratio against A0 on the right", height: 280, x: x.range, y: [Math.min(GOAL_TTFC_MS, ...ms) * 0.8, Math.max(...ms, 2000) * 1.25], log: true, y2: [0, Math.max(1.2, ...ratios)], xTicks: x.ticks, yFormat: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}`), y2Format: (v) => `×${v.toFixed(1)}` });
  f.hline(GOAL_TTFC_MS, "goal: TTFC 1.0 s (display only)", { goal: "ttfc" });
  debt(f, cks, x, (c) => c.latency.debt, "latency debt", "latency");
  // Laptop points are hollow too: only the PGX's latency is trusted.
  const trusted = cks.filter((c) => c.trust === "green" && c.machine !== "laptop");
  const step = (k: "ttfc" | "ttd") => (e: Ev, y: number) => (e.kind === "anchor" ? undefined : e.era?.bridge ? y * e.era.bridge.step[k] : y);
  const lines: [string, (c: CheckpointRow) => number, string, "ttfc" | "ttd", { dash?: boolean; faint?: boolean; right?: boolean }][] = [
    ["TTFC p50", (c) => c.latency.champion.ttfcP50, INK, "ttfc", {}],
    ["TTFC p75", (c) => c.latency.champion.ttfcP75, INK, "ttfc", { dash: true }],
    ["TTD p50", (c) => c.latency.champion.ttdP50, "#1971c2", "ttd", {}],
    ["anchor TTFC p50, same run", (c) => c.latency.anchor.ttfcP50, "#868e96", "ttfc", { faint: true }],
    ["chained TTFC ratio vs A0", (c) => c.latency.chainedTtfc, "#5f3dc4", "ttfc", { dash: true, right: true }],
  ];
  lines.forEach(([name, get, color, k, s], i) => stepped(f, trusted.map((c) => ({ x: x.at(c.at), y: get(c), id: c.id })), evs, step(k), { color, width: i ? 1.5 : 2.5, ...s, data: { series: name } }, i === 0));
  f.dots(cks.map((c) => ({ x: x.at(c.at), y: c.latency.champion.ttfcP50, id: c.id, hollow: c.trust === "amber" || c.machine === "laptop" })), INK);
  ticks(f, d, x);
  legend(host, lines.map(([n, , c, , s]) => [n, c, s.dash]));
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
  const maxUsd = Math.max(1, ...d.epochs.map((e) => e.cost.listUsd));
  const maxMin = Math.max(1, ...d.epochs.map((e) => e.minutes.total));
  const fa = frame(a, { title: "List $ per epoch by role group, minutes on the right", height: 230, x: x.range, y: [0, maxUsd * 1.15], y2: [0, maxMin * 1.15], xTicks: x.ticks, yFormat: (v) => `$${v}`, y2Format: (v) => `${v}m` });
  d.epochs.forEach((e, i) => {
    let y = 0;
    for (const [g, color] of GROUPS) {
      const v = byGroup[i][g];
      if (v > 0) fa.bar(e.epoch, y, (y += v), color, 0.6, { bar: g, epoch: String(e.epoch) });
    }
  });
  fa.line(d.epochs.map((e) => [e.epoch, e.minutes.total]), { color: INK, width: 1.5, dash: true, right: true, data: { series: "minutes" } });
  legend(a, [...GROUPS.map(([g, c]) => [g, c] as [string, string]), ["minutes", INK, true]]);
  const perDecision = (e: EpochRow) => Math.max(1, e.decisions.length);
  const perDecisionCharts = [
    ["% of a five-hour window per decision", (e: EpochRow) => e.cost.windowShare / perDecision(e), V1.window, DOC.window, (v: number) => pct(v), 0.4],
    ["Minutes per decision", (e: EpochRow) => e.minutes.total / perDecision(e), V1.minutes, DOC.minutes, (v: number) => `${v}`, 150],
  ] as const;
  for (const [i, [title, get, band, doc, fmt, max]] of perDecisionCharts.entries()) {
    const c = cells[i];
    const f = frame(c, { title, height: 230, x: x.range, y: [0, Math.max(max, ...d.epochs.map(get)) * 1.05], xTicks: x.ticks, yFormat: fmt });
    f.yband(band[0], band[1], "v1: ~120 min and 25–33% of a window per decision", "#c92a2a", { band: "v1" });
    f.point(x.range[0] + 0.3, doc, `doc as written: 75 min, 13.7%`, { point: "doc" });
    f.line(d.epochs.map((e) => [e.epoch, get(e)]), { color: INK, data: { series: title } });
    f.dots(d.epochs.map((e) => ({ x: e.epoch, y: get(e), id: `e${e.epoch}`, hollow: e.machine === "laptop" })), INK);
  }
  // Trailing-week use per token against its allowance (§6.7), and decisions this week.
  const lastEpoch = d.epochs.at(-1);
  const slots = [1, 2, 3].map((s) => {
    const b = d.budget.filter((r) => r.slot === s).at(-1);
    const e = lastEpoch?.slots.find((x) => x.slot === s);
    const seven = b?.sevenDay ?? e?.sevenDay;
    const share = seven !== undefined ? seven / LOOP.weekSevenDayMax : b ? b.usd7d / (LOOP.weekWindowsPerToken * b.windowUsd) : undefined;
    return `<span>token ${s}: <span class="meter"><span style="width:${Math.min(100, (share ?? 0) * 100)}%"></span></span> ${share === undefined ? "no data" : `${pct(share)} of its week${seven !== undefined ? ` (7-day ${pct(seven)} of ${pct(LOOP.weekSevenDayMax)})` : ""}`}</span>`;
  });
  const weekAgo = d.status.now - 7 * 86_400_000;
  const thisWeek = d.decisions.filter((x) => x.kind === "card" && Date.parse(d.epochs.find((e) => e.epoch === x.epoch)?.at ?? "") > weekAgo).length;
  host.insertAdjacentHTML("beforeend", `<div class="strip stat">${slots.join("")}<span>decisions this week: ${thisWeek}</span></div>`);
}

function decisions(d: Data) {
  const host = card("decisions", true);
  const comp = (r: DecisionRow) => (r.kind === "owner-step" ? "<b>owner step</b>" : esc(r.card?.component ?? "-"));
  const trustColor = { green: "ok", amber: "", void: "bad" };
  const rows = [...d.decisions].reverse().map((r) => {
    const n = r.counts.wins + r.counts.losses + r.counts.ties;
    return `<tr data-decision="${esc(r.id)}"><td>e${r.epoch}</td><td>${comp(r)}<div class="muted">${esc(r.card?.change ?? r.reasons[0] ?? "")}</div></td><td>${r.goal}</td><td>${r.class}</td><td>${r.verdict}</td><td class="${trustColor[r.trust]}">${r.trust}</td><td>${n}</td><td>${r.looks.at(-1)?.z.toFixed(2) ?? "-"}</td><td>×${r.latency.ttfc.est.toFixed(2)}</td><td>$${r.cost.listUsd.toFixed(2)}</td><td>${r.minutes}</td><td><a href="/api/eval/history?f=ledger.md" target="_blank" rel="noopener">ledger</a></td></tr>`;
  });
  host.innerHTML = `<h2>Decisions, latest first</h2><div class="scroll"><table class="marks"><thead><tr><th>epoch</th><th>component</th><th>goal</th><th>class</th><th>verdict</th><th>trust</th><th>cases</th><th>last Z</th><th>TTFC</th><th>$</th><th>min</th><th></th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="12" class="muted">No decisions yet.</td></tr>'}</tbody></table></div>`;
  host.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-decision]");
    if (tr && !(e.target as HTMLElement).closest("a")) void drill(d.decisions.find((r) => r.id === tr.dataset.decision)!);
  });
}

function health(d: Data, x: ReturnType<typeof xAxis>) {
  const host = card("health");
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

function status(d: Data) {
  const host = card("status", true);
  const s = d.status;
  const hb = timeOf(s.heartbeat?.wall ?? s.heartbeat?.at);
  const age = Number.isNaN(hb) ? undefined : s.now - hb;
  const st = s.state ?? {};
  const running = age !== undefined && age < STALE_MS;
  const said = String(st.status ?? (running ? "running" : "stopped"));
  const state = running ? said : said === "running" ? "stopped (no heartbeat)" : said;
  const slot = Number(st.slot) || d.epochs.at(-1)?.slots.find((x) => x.status === "active")?.slot;
  const use = d.epochs.at(-1)?.slots.find((x) => x.slot === slot);
  const disk = s.disk;
  host.innerHTML = `<div class="strip"><b>${esc(state)}</b>${st.why ? `<span>${esc(st.why)}</span>` : ""}<span>phase: ${esc(st.phase ?? "-")}</span>
    <span>token ${slot ?? "-"}${use ? `: 5-hour ${use.fiveHour !== undefined ? pct(use.fiveHour) : "?"}, 7-day ${use.sevenDay !== undefined ? pct(use.sevenDay) : "?"}` : ""}</span>
    <span>heartbeat ${age === undefined ? "none" : ago(age)}</span><span>owner list: ${d.ownerOpen} open</span>
    <span class="${disk && disk.freeGb < disk.ownerGb ? "bad" : ""}">${disk ? `disk ${disk.freeGb.toFixed(0)} GB free · ${disk.daysLeft === null ? "no growth last week, days left: plenty" : `~${disk.daysLeft.toFixed(0)} days left`} (to the ${disk.pauseGb} GB pause at last week's ${disk.weekGrowthGb.toFixed(1)} GB)` : "free disk: unknown here"}</span>
    <span class="muted">history: ${esc(d.source)}${s.error ? ` · ${esc(s.error)}` : ""}</span></div>`;
  return running;
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
  const rows = rowsOf<{ case: string; s: number; ttfc: [number, number]; void?: string }>(await r.text());
  list.innerHTML = `<div class="stat">${rows.length} cases in ${esc(dec.run)}</div>${rows.map((x) => `<button data-case="${esc(x.case)}" style="display:block;width:100%;text-align:left;margin:3px 0;font-size:12px"><b>${esc(x.case)}</b><br><span class="muted">${x.void ? `void: ${esc(x.void)}` : x.s > 0 ? "B better" : x.s < 0 ? "A better" : "tie"} · TTFC ${x.ttfc?.map((v) => Math.round(v)).join(" / ") ?? "-"} ms</span></button>`).join("")}`;
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

// ---- Load, draw, poll

let data: Data | undefined;
function draw() {
  if (!data) return;
  $("#panels").replaceChildren();
  const x = xAxis(data);
  const evs = events(data, x);
  const running = status(data);
  // Q and health are the half-width pair, side by side on a wide screen.
  quality(data, x, evs);
  latency(data, x, evs);
  chainedQ(data, x, evs);
  health(data, x);
  cost(data, x);
  decisions(data);
  return running;
}

let timer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  try {
    data = parse(new URLSearchParams(location.search).has("sample") ? await sample() : await (await fetch("/api/eval/history")).json());
    const running = draw();
    clearTimeout(timer);
    if (running) timer = setTimeout(refresh, POLL_MS);
  } catch (err) {
    $("#panels").innerHTML = `<section class="card wide" data-panel="status"><h2>Can't read the eval history</h2><p class="muted">${esc((err as Error).message)}</p></section>`;
  }
}

let resizing = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => draw());
});
void document.fonts.load("15px Excalifont").then(refresh, refresh);
