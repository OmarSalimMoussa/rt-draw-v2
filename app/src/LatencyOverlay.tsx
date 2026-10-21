// The latency overlay (dev; turned on in the settings, under Debug): for the
// last few sends, how long from Enter to the board's first change and to its
// last, by the eval's clock (evals/bridge/timing.ts, so the numbers compare with
// its checkpoints), where that time went step by step, and each send's model
// calls. The numbers come from board/latency.ts. (v1's LatencyOverlay.tsx, on v2's steps.)
import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { openCallInspector } from "../../src/callsView.ts";
import { CALLS_EVENT, calls } from "../../src/core/model.ts";
import { type LatencyLog, PHASES, type SendTimes, callRows, fmtMs, isLive, segments } from "./board/latency.ts";
import { setShowsLatency } from "./settings.ts";
import { Icon } from "./sketch/Icon.tsx";

const ROWS = 6;

/** Gridlines a round number of ms apart, at most four of them. */
function axisFor(maxMs: number) {
  const step = [100, 250, 500, 1000, 2000, 5000, 10_000, 20_000].find((s) => maxMs / s <= 4) ?? 30_000;
  const max = Math.ceil(maxMs / step) * step;
  return { max, ticks: Array.from({ length: max / step + 1 }, (_, i) => i * step) };
}
const tick = (ms: number) => (ms === 0 ? "0" : ms < 1000 ? `${ms}ms` : `${ms / 1000}s`);

/** The value at quantile `q` of sorted numbers (nearest rank). */
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

/** From Enter to the send's end, or to now while it's under way. */
const spanMs = (t: SendTimes, now: number) => (t.end ?? (isLive(t) ? now : t.enter)) - t.enter;

/** The eval's clock runs from send() starting; on the bar, its moments sit that far after Enter. */
const fromEnter = (t: SendTimes, ms: number | undefined) => (ms === undefined || t.start === undefined ? undefined : t.start - t.enter + ms);

const note = (t: SendTimes) => (isLive(t) ? (t.status === "queued" ? "queued" : "so far") : t.status === "error" ? "failed" : t.status === "stopped" ? "stopped" : !t.changes ? "no changes" : "");

export function LatencyOverlay({ log }: { log: LatencyLog }) {
  useSyncExternalStore(log.subscribe, log.getVersion);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState<number>();
  const now = performance.now();
  const sends = log.sends;
  const live = sends.some(isLive);
  // While a send is under way its bar grows.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(redraw, 100);
    return () => clearInterval(id);
  }, [live]);
  // An open row's calls stream in.
  useEffect(() => {
    if (open === undefined) return;
    addEventListener(CALLS_EVENT, redraw);
    return () => removeEventListener(CALLS_EVENT, redraw);
  }, [open]);

  const shown = sends.slice(-ROWS).reverse();
  const latest = shown[0];
  const axis = axisFor(Math.max(1000, ...shown.map((t) => spanMs(t, now))));
  const settled = sends.filter((t) => t.status === "done" && t.changes > 0 && t.ttfcMs !== undefined && t.ttdMs !== undefined);
  const firsts = settled.map((t) => t.ttfcMs!).sort((a, b) => a - b);
  const dones = settled.map((t) => t.ttdMs!).sort((a, b) => a - b);

  return (
    <section className="lt" aria-label="Latency">
      <div className="lt-head">
        <span className="st-title">Latency</span>
        <span className="lt-sub">Enter → on screen</span>
        {sends.length > 0 && (
          <button type="button" className="lt-clear" onClick={() => log.clear()} title="Forget these sends">Clear</button>
        )}
        <button type="button" className="lt-x" onClick={() => setShowsLatency(false)} title="Hide (Settings → Debug brings it back)" aria-label="Hide the latency overlay">
          <Icon name="close" />
        </button>
      </div>

      {latest ? <Latest t={latest} now={now} /> : <p className="lt-empty">Say or type something and press Enter: each send shows up here.</p>}

      {shown.length > 0 && (
        <>
          <div className="lt-axis" aria-hidden>
            {axis.ticks.map((v) => <span key={v} style={{ left: `${(v / axis.max) * 100}%` }}>{tick(v)}</span>)}
          </div>
          <ol className="lt-rows">
            {shown.map((t) => (
              <Row key={t.n} t={t} now={now} max={axis.max} ticks={axis.ticks} open={open === t.n} onToggle={() => setOpen(open === t.n ? undefined : t.n)} />
            ))}
          </ol>
        </>
      )}

      {settled.length > 0 && (
        <div className="lt-foot" title={`The eval's clock (from the send starting), over the last ${settled.length} send${settled.length > 1 ? "s" : ""} that changed something: compare with ck-10's p50s, 2.44s to the first change and 3.89s to done`}>
          1st change {fmtMs(quantile(firsts, 0.5))} · done {fmtMs(quantile(dones, 0.5))} · p90 {fmtMs(quantile(dones, 0.9))}
          <span className="lt-n">{settled.length} send{settled.length > 1 ? "s" : ""}</span>
        </div>
      )}
    </section>
  );
}

/** The newest send: its first change, big, then done, and each step's share. */
function Latest({ t, now }: { t: SendTimes; now: number }) {
  const ms = new Map(segments(t, now).map((s) => [s.key, s.ms]));
  const n = note(t);
  return (
    <div className="lt-latest">
      <div className="lt-big">
        {t.ttfcMs !== undefined ? fmtMs(t.ttfcMs) : isLive(t) ? fmtMs(spanMs(t, now)) : "–"}
        {t.ttfcMs !== undefined && <small>first change</small>}
        {t.ttdMs !== undefined && <small>done {fmtMs(t.ttdMs)}</small>}
        {n && <small className={t.status === "error" ? "bad" : undefined}>{n}</small>}
      </div>
      <ul className="lt-legend">
        {PHASES.map((p) => (
          <li key={p.key} title={p.hint}>
            <i className={`lt-swatch lt-${p.key}`} />
            {p.label}
            <b>{ms.has(p.key) ? fmtMs(ms.get(p.key)!) : "–"}</b>
          </li>
        ))}
        <li title="The eval's first change: the first changed shape in its final state">
          <i className="lt-swatch lt-tick" />
          first change
        </li>
      </ul>
      <div className="lt-facts">
        {[t.end !== undefined && `Enter → done ${fmtMs(t.end - t.enter)}`, t.rejected > 0 && `${t.rejected} line${t.rejected > 1 ? "s" : ""} not understood`, t.error].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

/** One send: what was asked, its steps as a bar on the shared time scale, and (opened) its model calls. */
function Row({ t, now, max, ticks, open, onToggle }: { t: SendTimes; now: number; max: number; ticks: number[]; open: boolean; onToggle(): void }) {
  const segs = segments(t, now).filter((s) => s.ms > 0);
  const end = segs.length ? segs.at(-1)!.from + segs.at(-1)!.ms : 0;
  const pct = (ms: number) => `${Math.min(100, (ms / max) * 100)}%`;
  const first = fromEnter(t, t.ttfcMs);
  const breakdown = [
    `“${t.label}” · ${t.model}`,
    ...segments(t, now).map((s) => `${PHASES.find((p) => p.key === s.key)!.label}: ${fmtMs(s.ms)}`),
    t.ttfcMs !== undefined && `first change ${fmtMs(t.ttfcMs)} · done ${fmtMs(t.ttdMs!)} (the eval's clock)`,
    "Click for its model calls",
  ].filter(Boolean).join("\n");
  return (
    <li className="lt-row">
      <button type="button" className="lt-open" onClick={onToggle} title={breakdown} aria-expanded={open}>
        <div className="lt-label">
          {t.spoken && <Icon name="mic" />}
          <span className="lt-text">{t.label}</span>
          {t.status === "error" && <span className="lt-tag bad">failed</span>}
          {t.status === "stopped" && <span className="lt-tag">stopped</span>}
          {!isLive(t) && !t.changes && <span className="lt-tag">no changes</span>}
          <span className="lt-total">{t.ttdMs === undefined ? "–" : fmtMs(t.ttdMs)}</span>
        </div>
        <div className="lt-track">
          {ticks.slice(1).map((v) => <i key={v} className="lt-grid" style={{ left: pct(v) }} />)}
          {segs.length > 0 && (
            <div className={isLive(t) ? "lt-bar live" : "lt-bar"} style={{ width: pct(end) }}>
              {segs.map((s) => <span key={s.key} className={`lt-seg lt-${s.key}`} style={{ flexGrow: s.ms }} />)}
            </div>
          )}
          {first !== undefined && <i className="lt-first" style={{ left: pct(first) }} />}
        </div>
      </button>
      {open && <Calls t={t} />}
    </li>
  );
}

/** A send's model calls (a running send's so far), each opening v2's call inspector. */
function Calls({ t }: { t: SendTimes }) {
  const rows = t.status === "queued" ? [] : callRows(calls, t.status === "running" ? { ...t, callsTo: Infinity } : t);
  if (!rows.length) return <p className="lt-empty">{t.status === "queued" ? "Not started yet." : "No model calls (or they've been forgotten)."}</p>;
  return (
    <ul className="lt-calls">
      {rows.map((c) => (
        <li key={c.n}>
          <button type="button" onClick={() => openCallInspector(c.n)} title="Open in the call inspector: the prompt, the images and the reply">
            <span className="lt-who">{c.who}</span>
            <span className="lt-what">
              {[
                c.model,
                c.waitMs !== undefined && `wait ${fmtMs(c.waitMs)}`,
                c.firstMs !== undefined && `1st text ${fmtMs(c.firstMs)}`,
                c.ms !== undefined ? fmtMs(c.ms) : c.running ? "running…" : undefined,
                c.warm !== undefined && (c.warm ? "warm" : "cold"),
                c.inTokens !== undefined && `${c.inTokens}/${c.outTokens ?? 0} tok`,
              ].filter(Boolean).join(" · ")}
            </span>
            {c.error && <span className="lt-tag bad">{c.error}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
