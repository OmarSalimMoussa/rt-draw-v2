// Calls a model through the dev server's /api/model (dev/model-plugin.ts):
// the reply streams in, so ops can be applied while it's still arriving.
// Model choice is a knob like any other: an index into MODELS. A Jev version
// (JEV_VERSIONS: TypeSafe AI's decision model, src/core/decide.ts) goes through
// the same door: its user text is the JSON of Jev's {state, questions}.
import { type TraceContext, mark, span, timed } from "./trace.ts";

export const MODELS = ["haiku", "sonnet", "opus"] as const;
export type ModelName = (typeof MODELS)[number];
/** A model knob's value → its name (0 haiku, 1 sonnet, 2 opus). */
export const modelOf = (knob: number): ModelName => MODELS[Math.max(0, Math.min(MODELS.length - 1, Math.round(knob)))];
/** Jev's versions: a pinned one first (replies stay comparable), then whatever TypeSafe serves as latest. */
export const JEV_VERSIONS = ["jev-1.13.0", "jev-latest"] as const;
export type JevVersion = (typeof JEV_VERSIONS)[number];
export const jevOf = (knob: number): JevVersion => JEV_VERSIONS[Math.max(0, Math.min(JEV_VERSIONS.length - 1, Math.round(knob)))];

export type ModelStats = {
  model: ModelName | JevVersion;
  /** Anthropic's id, e.g. claude-haiku-5-5. */
  modelId?: string;
  ms: number;
  firstMs?: number;
  inTokens?: number;
  outTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Time to a Claude process that's up (most of a slow first text when it had to start one). */
  waitMs?: number;
  /** Whether a process was already started and waiting. */
  warm?: boolean;
  /** Whether that waiting process had finished starting (warm alone may still have waited for it). */
  readyAtTake?: boolean;
  /** The model id the API says served it. */
  served?: string;
  /** Thinking the model did anyway (output tokens it spent thinking). */
  thinkingTokens?: number;
  /** Cache writes by lifetime: 1-hour writes cost 2× input against 1.25× for 5-minute ones. */
  write5m?: number;
  write1h?: number;
  stopReason?: string;
  /** API retries Claude Code made. */
  retries?: number;
  /** The subscription's limits after this call: utilization 0–1, resetsAt in unix seconds. */
  rateLimit?: { status: string; fiveHour?: number; sevenDay?: number; resetsAt?: number };
  /** How the call was made: transport, thinking, caching, limits (dev/model-plugin.ts). */
  settings?: Record<string, string | number>;
  /** With copies: how many went out, and which one this answer is (1 is the first sent). */
  copies?: number;
  won?: number;
  error?: string;
};

export type ModelRequest = {
  model: ModelName | JevVersion;
  system: string;
  user: string;
  images?: string[];
  from?: string;
  /** Free label, logged with the call. */
  tag?: string;
  /** Calls with this prompt made side by side: the server keeps this many processes waiting for it. */
  warm?: number;
  /** Default low. */
  effort?: Effort;
  /** "off" asks the API not to think; default "auto" (the model's own choice). */
  thinking?: "auto" | "off";
  /**
   * Copies of this call sent for one answer (draw.copies, picture.copies). The API's wait before the first text varies
   * from call to call, so the first copy to stream text (or to end) is the answer and the others are dropped. Default 1.
   */
  copies?: number;
  /** With copies: a copy after the first goes out only when no text has come this long (ms). Default 0: all at once. */
  copyAfterMs?: number;
  /** Sent, not set: this call is copy n (2 or more) of one answer, so the eval's gateway serves it as a fresh call. */
  copy?: number;
};
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Starts `n` processes for this model and prompt now, so calls about to come don't wait for one. Not a model call.
 * A process fixes its effort and thinking when it starts: pass the ones the calls will use.
 */
export function warmModel(model: ModelName, system: string, n = 1, opts: { effort?: Effort; thinking?: "auto" | "off" } = {}) {
  void fetch("/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, system, warm: n, ...opts }) }).catch(() => {});
}

/** Every call made from this page, newest last, exactly as sent: what the Model calls drawer shows. */
export type CallRecord = { n: number; at: string; page: string; req: ModelRequest; reply: string; stats?: ModelStats; error?: string; running: boolean };
export const calls: CallRecord[] = [];
/** Fired on window whenever a call starts, streams or ends. */
export const CALLS_EVENT = "rt-model-calls";
const changed = () => window.dispatchEvent(new Event(CALLS_EVENT));

export async function callModel(req: ModelRequest, onText?: (chunk: string, soFar: string) => void, signal?: AbortSignal, parent?: TraceContext): Promise<{ text: string; stats: ModelStats }> {
  return span(`model call · ${req.from ?? "?"} · ${req.model}`, parent, async (ctx, s) => {
    let first = true;
    const out = await race(req, (chunk, soFar) => {
      if (first) mark(ctx, "first text");
      first = false;
      onText?.(chunk, soFar);
    }, signal);
    const st = out.stats;
    s.setAttributes({ model: st.modelId ?? req.model, inTokens: (st.inTokens ?? 0) + (st.cacheRead ?? 0) + (st.cacheWrite ?? 0), outTokens: st.outTokens ?? 0, cacheRead: st.cacheRead ?? 0, warm: !!st.warm, copies: st.copies ?? 1 });
    // The server's phases, measured there (from when it got the request): process, the model's wait, streaming.
    // Clamped to this call, since the server's clock starts a little after ours. A copy's start when it was the answer.
    const t0 = out.sentAt;
    const end = performance.now();
    const at = (ms?: number) => Math.min(end, t0 + (ms ?? 0));
    // A Jev call has no process: no wait.
    if (st.waitMs !== undefined) timed(ctx, st.warm ? "Claude process (already waiting)" : "Claude process (started for this call)", t0, at(st.waitMs));
    if (st.firstMs !== undefined) timed(ctx, "model: time to first text", at(st.waitMs), at(st.firstMs));
    if (st.firstMs !== undefined) timed(ctx, "model: streaming the reply", at(st.firstMs), at(st.ms), { outTokens: st.outTokens ?? 0 });
    timed(ctx, "network and server overhead", at(st.ms), end);
    return out;
  }, { from: req.from ?? "?", model: req.model, images: req.images?.length ?? 0, chars: req.system.length + req.user.length });
}

/**
 * req.copies calls for one answer: the first to stream text, or to end, is it, and the others are dropped (each copy is
 * its own entry in the Model calls drawer). Copies after the first go out after copyAfterMs with no text yet; a copy
 * that fails before any text sends the next one at once. One copy is a plain call.
 */
function race(req: ModelRequest, onText: (chunk: string, soFar: string) => void, signal?: AbortSignal): Promise<{ text: string; stats: ModelStats; sentAt: number }> {
  const { copies = 1, copyAfterMs = 0, ...one } = req;
  const n = Math.max(1, Math.round(copies));
  if (n === 1) {
    const sentAt = performance.now();
    return record(one, onText, signal).then((out) => ({ ...out, sentAt }));
  }
  return new Promise((resolve, reject) => {
    const drops: AbortController[] = [];
    const errors: unknown[] = [];
    let won = -1, sent = 0, live = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const win = (i: number) => {
      if (won >= 0) return;
      won = i;
      clearTimeout(timer);
      drops.forEach((d, k) => k !== i && d.abort(new Error("dropped: another copy answered first")));
    };
    const next = () => {
      clearTimeout(timer);
      if (won >= 0 || sent >= n || signal?.aborted) return;
      const i = sent++;
      const sentAt = performance.now();
      const drop = (drops[i] = new AbortController());
      live++;
      record(i ? { ...one, copy: i + 1 } : one, (chunk, soFar) => {
        win(i);
        if (won === i) onText(chunk, soFar);
      }, signal ? AbortSignal.any([signal, drop.signal]) : drop.signal).then(
        (out) => {
          live--;
          win(i);
          if (won === i) resolve({ ...out, stats: { ...out.stats, copies: sent, won: i + 1 }, sentAt });
        },
        (err) => {
          live--;
          if (won === i) return reject(err);
          if (won >= 0) return;
          errors.push(err);
          next();
          if (!live) reject(errors[0]);
        },
      );
      if (sent < n) copyAfterMs > 0 ? (timer = setTimeout(next, copyAfterMs)) : next();
    };
    next();
  });
}

async function record(req: ModelRequest, onText: (chunk: string, soFar: string) => void, signal?: AbortSignal): Promise<{ text: string; stats: ModelStats }> {
  const rec: CallRecord = { n: calls.length + 1, at: new Date().toISOString(), page: location.pathname, req, reply: "", running: true };
  calls.push(rec);
  changed();
  try {
    const out = await send(req, (chunk, soFar) => {
      rec.reply = soFar;
      changed();
      onText(chunk, soFar);
    }, signal, rec);
    rec.stats = out.stats;
    return out;
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    rec.running = false;
    changed();
  }
}

async function send(req: ModelRequest, onText: (chunk: string, soFar: string) => void, signal: AbortSignal | undefined, rec: CallRecord): Promise<{ text: string; stats: ModelStats }> {
  const res = await fetch("/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal });
  if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `model call failed (HTTP ${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  let stats: ModelStats | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)) as { text?: string; done?: boolean } & ModelStats;
      buf = buf.slice(nl + 1);
      if (msg.text) {
        text += msg.text;
        onText(msg.text, text);
      }
      if (msg.done) stats = rec.stats = msg;
    }
  }
  if (!stats) throw new Error("the model call ended without its stats");
  if (stats.error) throw new Error(stats.error);
  return { text, stats };
}
