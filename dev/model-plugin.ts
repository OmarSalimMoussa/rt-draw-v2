// Dev-server only: POST /api/model runs one Claude call on the owner's Claude
// subscription (CLAUDE_CODE_OAUTH_TOKEN in .env) through the Agent SDK, with
// thinking off, no tools and no settings, as v1 learned to. The reply streams
// back as NDJSON lines: {"text": "..."} chunks, then one {"done": true, ...stats}.
// Every call is appended to .data/model-calls.jsonl (what was asked, how long,
// how many tokens) so the playgrounds' model knobs can be tuned from real runs.
//
// Starting a Claude Code process takes a second or more, so processes are kept
// started and waiting per model and system prompt (v1 measured first text in
// 0.8-1.1 s with a waiting process against 1.3 s+ starting one). The stats say
// which. A page that will make several calls with one prompt at once (pictures)
// asks for that many waiting ({warm: n}), and can start them before it needs
// them with a request that has no message: {model, system, warm: n}.
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Query, type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { type Plugin, loadEnv } from "vite";

/** The short names the pages send → Anthropic's ids. */
export const MODEL_IDS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;
/** A waiting process older than this is replaced rather than trusted. */
const MAX_WAIT_MS = 10 * 60_000;
/** Models and system prompts with processes waiting, at most (pages each have their own prompts). */
const MAX_KEYS = 6;
/** Processes kept waiting for one model and prompt, at most. */
const MAX_WARM = 4;
/** How each call is made, reported back with its stats so the pages can show it. */
const SETTINGS = {
  via: "Claude Agent SDK 0.3.299 (Claude Code) on the Claude subscription",
  thinking: "disabled",
  effort: "low",
  maxOutputTokens: MAX_TOKENS,
  tools: "none",
  caching: "automatic (Claude Code caches the prompt prefix; see cache read/write tokens)",
  systemPrompt: "ours replaces Claude Code's default, but Claude Code still adds about 550 tokens of its own (measured 2026-10-15), not shown here",
  settingSources: "none",
};
/** The Claude process gets no other service's key. */
const SECRETS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "ELEVENLABS_API_KEY", "TYPESAFE_API_KEY"];

export type ModelRequest = {
  model: keyof typeof MODEL_IDS;
  system: string;
  user: string;
  /** data: URLs (PNG or JPEG), sent before the text. */
  images?: string[];
  /** Which playground asked, for the call log. */
  from?: string;
  /** Keep this many processes waiting for this model and prompt (calls made side by side). */
  warm?: number;
};

type Content = Exclude<SDKUserMessage["message"]["content"], string>;
type Spare = { q: Query; give: (content: Content) => void; ready: Promise<void>; born: number };

/** Kept on globalThis: this module is evaluated afresh after edits, and the processes outlive it. */
const g = globalThis as typeof globalThis & { __rtV2Spares?: Map<string, Promise<Spare>>; __rtV2Pools?: Map<string, Promise<Spare>[]> };
// The one-per-prompt map from before pools: let its processes go.
for (const old of g.__rtV2Spares?.values() ?? []) void old.then((s) => s.q.close(), () => {});
g.__rtV2Spares = undefined;
/** Waiting processes per model and prompt, oldest first; the map's order is least recently used first. */
const pools: Map<string, Promise<Spare>[]> = (g.__rtV2Pools ??= new Map());

const keyOf = (model: string, system: string) => {
  let h = 2166136261;
  for (const c of system) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `${model}:${h.toString(36)}`;
};

/** A Claude Code process, up and checked to be on the subscription, waiting for its one message. */
async function start(model: string, system: string, token: string): Promise<Spare> {
  let give!: (content: Content) => void;
  const first = new Promise<Content>((r) => (give = r));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: await first } } as SDKUserMessage;
  }
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_TOKENS) };
  for (const k of SECRETS) delete env[k];
  const cwd = join(tmpdir(), "rt-draw-v2-claude");
  mkdirSync(cwd, { recursive: true });
  const q = query({
    prompt: prompt(),
    options: { model, systemPrompt: system, tools: [], settingSources: [], persistSession: false, includePartialMessages: true, thinking: { type: "disabled" }, effort: "low", maxTurns: 1, cwd, env },
  });
  // Never bill an API key by accident: the process must be on the subscription's token.
  const ready = q.accountInfo().then((a) => {
    if (a.apiProvider !== "firstParty" || a.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN") throw new Error(`not on the subscription (${a.tokenSource ?? a.apiKeySource ?? "unknown"})`);
  });
  ready.catch(() => {});
  return { q, give, ready, born: Date.now() };
}

const clampWarm = (n: unknown) => Math.max(1, Math.min(MAX_WARM, Math.round(Number(n) || 1)));

/** Tops this model and prompt up to n waiting processes, and lets the least recently used prompts' processes go. */
function warmUp(model: string, system: string, token: string, n: number) {
  const key = keyOf(model, system);
  const pool = pools.get(key) ?? [];
  pools.delete(key);
  pools.set(key, pool);
  while (pool.length < n) pool.push(start(model, system, token));
  // Prompts edited in development leave processes nobody will use.
  for (const [k, old] of pools) {
    if (pools.size <= MAX_KEYS) break;
    pools.delete(k);
    for (const p of old) void p.then((s) => s.q.close(), () => {});
  }
}

/** A waiting process for this model and prompt if there's a fresh one (else a new one); the pool is topped back up to `n` for next time. */
async function take(model: string, system: string, token: string, n: number): Promise<{ spare: Spare; warm: boolean }> {
  const waiting = pools.get(keyOf(model, system))?.shift();
  warmUp(model, system, token, n);
  const spare = await waiting?.catch(() => undefined);
  if (spare && Date.now() - spare.born < MAX_WAIT_MS) return { spare, warm: true };
  spare?.q.close();
  return { spare: await start(model, system, token), warm: false };
}

export function modelApi(): Plugin {
  let token = "";
  let logDir = "";
  return {
    name: "model-api",
    apply: "serve",
    configResolved(config) {
      token = loadEnv(config.mode, config.root, "").CLAUDE_CODE_OAUTH_TOKEN ?? "";
      logDir = join(config.root, ".data");
    },
    configureServer(server) {
      server.middlewares.use("/api/model", async (req, res) => {
        const fail = (status: number, error: string) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error }));
        };
        if ((req as { method?: string }).method !== "POST") return fail(405, "POST only");
        if (!token) return fail(500, "CLAUDE_CODE_OAUTH_TOKEN is not set in .env");
        let body: ModelRequest;
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest;
        } catch {
          return fail(400, "bad JSON");
        }
        const model = MODEL_IDS[body.model];
        if (!model) return fail(400, `unknown model "${body.model}" (haiku, sonnet, opus)`);
        // No message: only start processes for calls about to come.
        if (body.user === undefined) {
          warmUp(model, body.system, token, clampWarm(body.warm));
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ warming: clampWarm(body.warm) }));
        }
        let content: Content;
        try {
          content = [
            ...(body.images ?? []).map((url) => {
              const [, mime, data] = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url) ?? [];
              if (!data) throw new Error("images must be base64 data: URLs");
              return { type: "image" as const, source: { type: "base64" as const, media_type: mime as "image/png", data } };
            }),
            { type: "text" as const, text: body.user },
          ];
        } catch (err) {
          return fail(400, (err as Error).message);
        }

        res.setHeader("content-type", "application/x-ndjson");
        const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
        const t0 = performance.now();
        const since = () => Math.round(performance.now() - t0);
        let text = "";
        let firstMs: number | undefined;
        let waitMs: number | undefined;
        let warm = false;
        // Usage as the API streams it: input and cache on message_start, output on message_delta.
        const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        let spare: Spare | undefined;
        const timer = setTimeout(() => spare?.q.close(), TIMEOUT_MS);
        res.on("close", () => !res.writableEnded && spare?.q.close());
        try {
          ({ spare, warm } = await take(model, body.system, token, clampWarm(body.warm)));
          await spare.ready;
          waitMs = since();
          spare.give(content);
          for await (const m of spare.q) {
            if (m.type !== "stream_event") continue;
            const e = m.event;
            if (e.type === "message_start") {
              const u = e.message.usage;
              usage.input += u.input_tokens ?? 0;
              usage.cacheRead += u.cache_read_input_tokens ?? 0;
              usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
            } else if (e.type === "message_delta") usage.output += e.usage?.output_tokens ?? 0;
            else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
              firstMs ??= since();
              text += e.delta.text;
              line({ text: e.delta.text });
            }
          }
          const stats = { done: true, model: body.model, modelId: model, ms: since(), firstMs, waitMs, warm, inTokens: usage.input, outTokens: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, settings: SETTINGS };
          line(stats);
          log({ ...stats, from: body.from, images: body.images?.length ?? 0, system: body.system.length, user: body.user, reply: text });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          line({ done: true, error, model: body.model, modelId: model, ms: since(), waitMs, warm, settings: SETTINGS });
          log({ from: body.from, model: body.model, error, ms: since() });
        } finally {
          clearTimeout(timer);
          spare?.q.close();
          res.end();
        }
      });

      function log(rec: Record<string, unknown>) {
        try {
          mkdirSync(logDir, { recursive: true });
          appendFileSync(join(logDir, "model-calls.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
        } catch {}
      }
    },
  };
}
