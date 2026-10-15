// Dev-server only: POST /api/model runs one Claude call on the owner's Claude
// subscription (CLAUDE_CODE_OAUTH_TOKEN in .env) through the Agent SDK, with
// thinking off, no tools and no settings, as v1 learned to. The reply streams
// back as NDJSON lines: {"text": "..."} chunks, then one {"done": true, ...stats}.
// Every call is appended to .data/model-calls.jsonl (what was asked, how long,
// how many tokens) so the playgrounds' model knobs can be tuned from real runs.
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { type Plugin, loadEnv } from "vite";

/** The short names the pages send → Anthropic's ids. */
export const MODEL_IDS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;
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
};

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

        res.setHeader("content-type", "application/x-ndjson");
        const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
        const t0 = performance.now();
        let firstMs: number | undefined;
        let text = "";
        let usage: Record<string, number> | undefined;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
        req.on("close", () => !res.writableEnded && abort.abort());

        const content = [
          ...(body.images ?? []).map((url) => {
            const [, mime, data] = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url) ?? [];
            if (!data) throw new Error("images must be base64 data: URLs");
            return { type: "image" as const, source: { type: "base64" as const, media_type: mime as "image/png", data } };
          }),
          { type: "text" as const, text: body.user },
        ];
        async function* prompt(): AsyncGenerator<SDKUserMessage> {
          yield { type: "user", parent_tool_use_id: null, message: { role: "user", content } } as SDKUserMessage;
        }
        const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_TOKENS) };
        for (const k of SECRETS) delete env[k];
        const cwd = join(tmpdir(), "rt-draw-v2-claude");
        mkdirSync(cwd, { recursive: true });
        try {
          const q = query({
            prompt: prompt(),
            options: { model, systemPrompt: body.system, tools: [], settingSources: [], persistSession: false, includePartialMessages: true, thinking: { type: "disabled" }, maxTurns: 1, cwd, env, abortController: abort },
          });
          for await (const m of q) {
            if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") {
              firstMs ??= Math.round(performance.now() - t0);
              text += m.event.delta.text;
              line({ text: m.event.delta.text });
            } else if (m.type === "result") usage = m.usage as unknown as Record<string, number>;
          }
          const stats = { done: true, model: body.model, ms: Math.round(performance.now() - t0), firstMs, inTokens: usage?.input_tokens, outTokens: usage?.output_tokens, cacheRead: usage?.cache_read_input_tokens };
          line(stats);
          log({ ...stats, from: body.from, images: body.images?.length ?? 0, system: body.system.length, user: body.user, reply: text });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          line({ done: true, error });
          log({ from: body.from, model: body.model, error, ms: Math.round(performance.now() - t0) });
        } finally {
          clearTimeout(timer);
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
