// Jev (TypeSafe AI's decision model): one POST answers several typed questions
// about a state in about a tenth of a second (https://api.typesafe.ai/v1/systemone).
// Shared by the dev server (dev/model-plugin.ts) and the eval gateway
// (evals/loop/gateway.ts). It reaches them as an /api/model request whose model
// is a Jev version ("jev-1.13.0") and whose user text is the JSON of Jev's
// {state, questions}, exactly as sent, so the call inspector shows it whole; the
// reply text is the JSON of its answers. No process, no pool, no subscription.
export const JEV_URL = "https://api.typesafe.ai";
/** List $ per million tokens: input only, output is free. */
export const JEV_PRICE = { in: 0.042, out: 0 };
export const isJev = (model: unknown) => typeof model === "string" && /^jev-[a-z0-9.-]+$/.test(model);
const TIMEOUT_MS = 20_000;

export type JevStats = { ms: number; firstMs: number; inTokens: number; outTokens: number; served?: string };
export const JEV_SETTINGS = { via: "TypeSafe AI Jev (POST /v1/systemone)", thinking: "none (a decision model)", caching: "none", pricing: `$${JEV_PRICE.in}/M input tokens, output free` };

/** `baseUrl` is the fake API's in checks: a call there never reaches the real Jev. */
export async function callJev(key: string, version: string, user: string, o: { baseUrl?: string; signal?: AbortSignal } = {}): Promise<{ text: string; stats: JevStats }> {
  if (!key) throw new Error("no TYPESAFE_API_KEY for Jev");
  let body: { state?: unknown; questions?: unknown };
  try {
    body = JSON.parse(user) as typeof body;
  } catch {
    throw new Error("a Jev call's user text must be the JSON of {state, questions}");
  }
  if (!body?.questions || typeof body.questions !== "object") throw new Error("a Jev call needs questions");
  const t0 = performance.now();
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${o.baseUrl ?? JEV_URL}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: version, state: body.state, questions: body.questions }), signal });
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw) as { answers?: Record<string, unknown>; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  return { text: JSON.stringify(j.answers ?? {}), stats: { ms, firstMs: ms, inTokens: j.usage?.input_tokens ?? 0, outTokens: j.usage?.output_tokens ?? 0, served: j.model } };
}
