// The Latency modal, shared by every page (like the model call inspector): each
// trace (e.g. one send, from pressing Send to the last op on screen) as a
// waterfall of its nested spans, with their times, events and attributes.
// The spans come from OpenTelemetry (src/core/trace.ts).
import { dock, type Modal, openModal } from "./modal.ts";
import { type ReadableSpan, TRACES_EVENT, finished, open } from "./core/trace.ts";

type Row = {
  id: string;
  parentId?: string;
  traceId: string;
  name: string;
  /** performance.now() ms. */
  start: number;
  end: number;
  running: boolean;
  error?: string;
  attrs: Record<string, unknown>;
  events: { name: string; at: number }[];
  children: Row[];
  depth: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** OpenTelemetry's [seconds, nanoseconds] since the epoch → performance.now() ms. */
const toPerf = (hr: [number, number]) => hr[0] * 1000 + hr[1] / 1e6 - performance.timeOrigin;

function rows(): Row[] {
  const out: Row[] = finished().map((s: ReadableSpan) => ({
    id: s.spanContext().spanId,
    parentId: s.parentSpanContext?.spanId,
    traceId: s.spanContext().traceId,
    name: s.name,
    start: toPerf(s.startTime),
    end: toPerf(s.endTime),
    running: false,
    error: s.status.code === 2 ? (s.status.message ?? "error") : undefined,
    attrs: { ...s.attributes },
    events: s.events.map((e) => ({ name: e.name, at: toPerf(e.time) })),
    children: [],
    depth: 0,
  }));
  const now = performance.now();
  for (const [id, o] of open) out.push({ id, parentId: o.parentId, traceId: o.traceId, name: o.name, start: o.start, end: now, running: true, attrs: {}, events: [], children: [], depth: 0 });
  return out;
}

type Trace = { id: string; root: Row; all: Row[] };

function traces(): Trace[] {
  const byTrace = new Map<string, Row[]>();
  for (const r of rows()) byTrace.set(r.traceId, [...(byTrace.get(r.traceId) ?? []), r]);
  const out: Trace[] = [];
  for (const [id, all] of byTrace) {
    const byId = new Map(all.map((r) => [r.id, r]));
    for (const r of all) if (r.parentId && byId.has(r.parentId)) byId.get(r.parentId)!.children.push(r);
    const root = all.find((r) => !r.parentId || !byId.has(r.parentId))!;
    const walk = (r: Row, d: number) => {
      r.depth = d;
      r.children.sort((a, b) => a.start - b.start);
      for (const c of r.children) walk(c, d + 1);
    };
    walk(root, 0);
    out.push({ id, root, all });
  }
  return out.sort((a, b) => a.root.start - b.root.start);
}

const flat = (r: Row): Row[] => [r, ...r.children.flatMap(flat)];
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
function color(name: string) {
  if (name.startsWith("model call")) return "#5f3dc4";
  if (name.startsWith("model:") || name.startsWith("Claude process") || name.startsWith("network")) return "#9775fa";
  if (name.startsWith("screenshot")) return "#e8590c";
  if (name.startsWith("op ")) return "#2b8a3e";
  if (name.startsWith("resolve")) return "#c2255c";
  return "#1971c2";
}

function waterfall(tr: Trace, picked: string | undefined) {
  const t0 = tr.root.start;
  const total = Math.max(1, Math.max(...tr.all.map((r) => r.end)) - t0);
  const pct = (x: number) => `${((x - t0) / total) * 100}%`;
  const firstOp = tr.all.flatMap((r) => r.events).find((e) => e.name === "first op applied");
  const models = tr.all.filter((r) => r.name.startsWith("model call"));
  // Each model call's first text, from the start of the trace.
  const firstTexts = models.flatMap((r) => r.events.filter((e) => e.name === "first text").map((e) => `${r.name.replace("model call · ", "")} first text at ${ms(e.at - t0)}`));
  const summary = [
    `total ${ms(total)}${tr.root.running ? " (running)" : ""}`,
    ...firstTexts,
    firstOp ? `first op on screen at ${ms(firstOp.at - t0)}` : "",
    models.length ? `${models.length} model call${models.length > 1 ? "s" : ""}, ${ms(models.reduce((a, r) => a + (r.end - r.start), 0))} in total` : "",
  ].filter(Boolean);
  // Ticks at a round step across the whole trace.
  const step = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000].find((s) => total / s <= 8) ?? 20000;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  const LABEL = 330;
  const lines = flat(tr.root)
    .map((r) => {
      const left = pct(r.start);
      const width = `max(2px, ${((r.end - r.start) / total) * 100}%)`;
      const evs = r.events.map((e) => `<i title="${esc(e.name)} at ${ms(e.at - t0)}" style="position:absolute;left:${pct(e.at)};top:-3px;bottom:-3px;width:2px;background:#e03131"></i>`).join("");
      return `<div data-span="${r.id}" style="display:grid;grid-template-columns:${LABEL}px 1fr 70px;align-items:center;gap:8px;padding:2px 4px;cursor:pointer;border-radius:4px;${r.id === picked ? "background:#fff4e6;" : ""}">
        <div style="padding-left:${r.depth * 14}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px" title="${esc(r.name)}">${r.error ? "✗ " : ""}${esc(r.name)}</div>
        <div style="position:relative;height:14px"><div style="position:absolute;left:${left};width:${width};top:0;bottom:0;background:${color(r.name)};opacity:${r.running ? 0.45 : 0.85};border-radius:3px"></div>${evs}</div>
        <div class="stat" style="text-align:right">${ms(r.end - r.start)}</div></div>`;
    })
    .join("");
  const axis = `<div style="display:grid;grid-template-columns:${LABEL}px 1fr 70px;gap:8px;padding:0 4px"><div></div><div style="position:relative;height:16px;border-bottom:1px solid var(--line)">${ticks.map((x) => `<span class="stat muted" style="position:absolute;left:${(x / total) * 100}%;transform:translateX(-50%)">${ms(x)}</span>`).join("")}</div><div></div></div>`;
  const p = tr.all.find((r) => r.id === picked);
  const details = p
    ? `<h3 style="margin:12px 0 4px">${esc(p.name)}</h3><table class="marks">
        <tr><th>starts at</th><td>${ms(p.start - t0)}</td></tr><tr><th>takes</th><td>${ms(p.end - p.start)}${p.running ? " so far" : ""}</td></tr>
        ${p.error ? `<tr><th>error</th><td class="bad">${esc(p.error)}</td></tr>` : ""}
        ${p.events.map((e) => `<tr><th>event</th><td>${esc(e.name)} at ${ms(e.at - t0)}</td></tr>`).join("")}
        ${Object.entries(p.attrs).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join("")}
      </table>`
    : '<p class="muted stat">Click a row for its details. Red ticks are events (first text, first op).</p>';
  return `<h3 style="margin:4px 0">${esc(tr.root.name)}</h3><div class="stat" style="margin-bottom:8px">${summary.join(" · ")}</div>${axis}<div style="display:grid;gap:1px">${lines}</div>${details}`;
}

let modal: Modal | undefined;
let selected: string | undefined;
let picked: string | undefined;

function refresh() {
  if (!modal?.isOpen()) return;
  const all = traces();
  const tr = all.find((x) => x.id === selected) ?? all.at(-1);
  selected = tr?.id;
  modal.body.querySelector("[data-list]")!.innerHTML = [...all]
    .reverse()
    .map((x) => `<button data-trace="${x.id}" style="text-align:left;font-size:12px;${x.id === selected ? "background:#fff4e6;" : ""}"><b>${esc(x.root.name)}</b><br><span class="muted">${x.root.running ? "running…" : ms(Math.max(...x.all.map((r) => r.end)) - x.root.start)} · ${x.all.length} spans</span></button>`)
    .join("");
  (modal.body.querySelector("[data-detail]") as HTMLElement).innerHTML = tr ? waterfall(tr, picked) : '<p class="muted">Nothing timed yet on this page.</p>';
}

/** Opens the Latency modal on a trace (the latest when omitted). */
export function openLatency(traceId?: string) {
  selected = traceId;
  picked = undefined;
  if (!modal?.isOpen()) {
    modal = openModal("Latency");
    modal.body.style.cssText += ";display:grid;grid-template-columns:220px 1fr";
    modal.body.innerHTML = `<div data-list style="border-right:1px solid var(--line);overflow:auto;padding:10px;display:grid;gap:4px;align-content:start"></div><div data-detail style="overflow:auto;padding:12px 18px"></div>`;
    modal.body.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-trace],[data-span]");
      if (el?.dataset.trace) [selected, picked] = [el.dataset.trace, undefined];
      else if (el?.dataset.span) picked = el.dataset.span;
      refresh();
    });
  }
  refresh();
}

/** The page's "Latency (n)" button in the dock, shown once something has been timed. */
export function mountLatencyView() {
  const btn = document.createElement("button");
  btn.style.cssText = "display:none;box-shadow:2px 3px 0 #0002";
  dock().prepend(btn);
  btn.addEventListener("click", () => openLatency());
  // Spans end in bursts (every op): redraw at most once a frame.
  let queued = false;
  window.addEventListener(TRACES_EVENT, () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const n = new Set(finished().filter((s) => !s.parentSpanContext).map((s) => s.spanContext().traceId)).size;
      btn.style.display = n || open.size ? "block" : "none";
      btn.textContent = `Latency (${n})${open.size ? " …" : ""}`;
      refresh();
    });
  });
}
