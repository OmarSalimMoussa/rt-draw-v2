// Calls a model through the dev server's /api/model (dev/model-plugin.ts):
// the reply streams in, so ops can be applied while it's still arriving.
// Model choice is a knob like any other: an index into MODELS.

export const MODELS = ["haiku", "sonnet", "opus"] as const;
export type ModelName = (typeof MODELS)[number];
/** A model knob's value → its name (0 haiku, 1 sonnet, 2 opus). */
export const modelOf = (knob: number): ModelName => MODELS[Math.max(0, Math.min(MODELS.length - 1, Math.round(knob)))];

export type ModelStats = { model: ModelName; ms: number; firstMs?: number; inTokens?: number; outTokens?: number; cacheRead?: number; error?: string };

export async function callModel(req: { model: ModelName; system: string; user: string; images?: string[]; from?: string }, onText?: (chunk: string, soFar: string) => void, signal?: AbortSignal): Promise<{ text: string; stats: ModelStats }> {
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
        onText?.(msg.text, text);
      }
      if (msg.done) stats = msg;
    }
  }
  if (!stats) throw new Error("the model call ended without its stats");
  if (stats.error) throw new Error(stats.error);
  return { text, stats };
}
