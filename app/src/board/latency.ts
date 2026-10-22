// Latency of every send, for the overlay (LatencyOverlay.tsx): when Enter was
// pressed and when each step after it happened, up to the last picture and the
// last glide, plus the two numbers the eval measures, read off the board itself
// by its own clock (evals/bridge/timing.ts), so they compare with its checkpoints.
// After v1's src/agent/latency.ts, with v2's steps.
import type { CallRecord } from "../../../src/core/model.ts";

/** One send's moments, on the performance.now() clock. */
export type SendTimes = {
  n: number;
  label: string;
  spoken: boolean;
  model: string;
  /** Enter was pressed. */
  enter: number;
  /** Scribe's last words were in (the flush after Enter). */
  words?: number;
  /** send() was called: the send before had finished. */
  start?: number;
  /** The prompt was built (marks, ink links, board shots, Jev). */
  prompt?: number;
  /** The drawing call's first text arrived. */
  firstText?: number;
  /** The first op that changed the board landed. */
  firstOp?: number;
  /** The drawing model's reply ended. */
  reply?: number;
  /** Every picture was drawn (or failed). */
  pictures?: number;
  /** send() returned: the last glide had settled. */
  end?: number;
  /** The board placed its pages and routed its arrows (after the eval's clocks stop; only when the send changed the board). */
  layout?: number;
  /** The eval's clock, from start: the first changed shape in its final state, and the last. */
  ttfcMs?: number;
  ttdMs?: number;
  /** Ops that changed the board, and lines of the reply that weren't understood. */
  changes: number;
  rejected: number;
  status: "queued" | "running" | "done" | "stopped" | "error";
  error?: string;
  /** Model calls numbered callsFrom < n ≤ callsTo were this send's. */
  callsFrom: number;
  callsTo: number;
};

/** The steps of a send, in order; each runs from the end of the one before. */
export const PHASES = [
  { key: "listen", label: "listen", hint: "Scribe's last words after Enter" },
  { key: "queue", label: "queue", hint: "waiting for the send before" },
  { key: "prompt", label: "prompt", hint: "marks, ink links, board shots, Jev" },
  { key: "model", label: "model", hint: "the drawing call, to its first text" },
  { key: "line", label: "1st line", hint: "the model writing its first change" },
  { key: "changes", label: "changes", hint: "the rest of the reply streaming in" },
  { key: "pictures", label: "pictures", hint: "pictures drawn into their shapes" },
  { key: "camera", label: "camera", hint: "the last glide settling" },
  { key: "layout", label: "layout", hint: "pages placed and arrows routed, after the clocks stop" },
] as const;

export type PhaseKey = (typeof PHASES)[number]["key"];
export type Segment = { key: PhaseKey; from: number; ms: number };

/** Kept for the overlay, and the model calls and spans kept with them. */
const KEPT = 50;

export const isLive = (t: SendTimes) => t.status === "queued" || t.status === "running";

/** The end of each step, as far as the send got. A reply without changes has its first change at its end. */
function stepEnds(t: SendTimes): (number | undefined)[] {
  const firstOp = t.firstOp ?? (t.changes ? undefined : t.reply);
  return [t.words, t.start, t.prompt, t.firstText, firstOp, t.reply, t.pictures, t.end, t.layout];
}

/** The steps as bars, in ms from Enter; while the send is live, the step under way runs to `now`. */
export function segments(t: SendTimes, now: number): Segment[] {
  const live = isLive(t);
  const out: Segment[] = [];
  let prev = t.enter;
  for (const [i, end] of stepEnds(t).entries()) {
    const key = PHASES[i].key;
    if (end === undefined) {
      // A step that never happened (failed or stopped first) is skipped; the one under way grows.
      if (live) {
        out.push({ key, from: prev - t.enter, ms: Math.max(0, now - prev) });
        break;
      }
      continue;
    }
    out.push({ key, from: prev - t.enter, ms: Math.max(0, end - prev) });
    prev = Math.max(prev, end);
  }
  return out;
}

export type CallRow = { n: number; who: string; model: string; waitMs?: number; firstMs?: number; ms?: number; warm?: boolean; inTokens?: number; outTokens?: number; running: boolean; error?: string };

/** This send's model calls, for its row in the overlay. */
export function callRows(calls: CallRecord[], t: SendTimes): CallRow[] {
  return calls
    .filter((c) => c.n > t.callsFrom && c.n <= t.callsTo)
    .map((c) => {
      const st = c.stats;
      const from = c.req.from ?? "?";
      return {
        n: c.n,
        who: c.req.model.startsWith("jev") ? `Jev · ${from}` : from,
        model: st?.modelId ?? c.req.model,
        waitMs: st?.waitMs,
        firstMs: st?.firstMs,
        ms: st?.ms,
        warm: st?.warm,
        inTokens: st && (st.inTokens ?? 0) + (st.cacheRead ?? 0) + (st.cacheWrite ?? 0),
        outTokens: st?.outTokens,
        running: c.running,
        error: c.error,
      };
    });
}

export class LatencyLog {
  /** Oldest first. */
  sends: SendTimes[] = [];
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  /** A send was entered: its times, which the sender fills in (touch() at each step). */
  begin(t: Pick<SendTimes, "label" | "spoken" | "model" | "enter">): SendTimes {
    const times: SendTimes = { ...t, n: (this.sends.at(-1)?.n ?? 0) + 1, changes: 0, rejected: 0, status: "queued", callsFrom: 0, callsTo: 0 };
    this.sends = [...this.sends.slice(-(KEPT - 1)), times];
    this.touch();
    return times;
  }

  touch() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  clear() {
    this.sends = [];
    this.touch();
  }
}

/** "840ms", "1.84s". */
export const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
