// Calls a model through the dev server's /api/model (dev/model-plugin.ts):
// the reply streams in, so ops can be applied while it's still arriving.
// Model choice is a knob like any other: an index into MODELS.

export const MODELS = ["haiku", "sonnet", "opus"] as const;
export type ModelName = (typeof MODELS)[number];
/** A model knob's value → its name (0 haiku, 1 sonnet, 2 opus). */
export const modelOf = (knob: number): ModelName => MODELS[Math.max(0, Math.min(MODELS.length - 1, Math.round(knob)))];

export type ModelStats = {
  model: ModelName;
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
  /** How the call was made: transport, thinking, caching, limits (dev/model-plugin.ts). */
  settings?: Record<string, string | number>;
  error?: string;
};

export type ModelRequest = { model: ModelName; system: string; user: string; images?: string[]; from?: string };

/** Every call made from this page, newest last, exactly as sent: what the Model calls drawer shows. */
export type CallRecord = { n: number; at: string; page: string; req: ModelRequest; reply: string; stats?: ModelStats; error?: string; running: boolean };
export const calls: CallRecord[] = [];
/** Fired on window whenever a call starts, streams or ends. */
export const CALLS_EVENT = "rt-model-calls";
const changed = () => window.dispatchEvent(new Event(CALLS_EVENT));

export async function callModel(req: ModelRequest, onText?: (chunk: string, soFar: string) => void, signal?: AbortSignal): Promise<{ text: string; stats: ModelStats }> {
  const rec: CallRecord = { n: calls.length + 1, at: new Date().toISOString(), page: location.pathname, req, reply: "", running: true };
  calls.push(rec);
  changed();
  try {
    const out = await send(req, (chunk, soFar) => {
      rec.reply = soFar;
      changed();
      onText?.(chunk, soFar);
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
