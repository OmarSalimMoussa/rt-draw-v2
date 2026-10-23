// Dev-server only: POST /api/model runs one Claude call on the owner's Claude
// subscription (CLAUDE_CODE_OAUTH_TOKEN in .env) through dev/claude.ts: no tools,
// no settings, the 5-minute cache, an empty config dir. The reply streams back as
// NDJSON lines: {"text": "..."} chunks, then one {"done": true, ...stats}. Every
// call is appended to <RT_DATA_DIR, default .data>/model-calls.jsonl (what was
// asked, how long, how many tokens) so the playgrounds' model knobs can be tuned
// from real runs.
//
// Processes are kept started and waiting per model, prompt, effort and thinking
// (a process fixes those when it starts). A request keeps one waiting for next
// time unless it says otherwise: a page that will make several calls with one
// prompt at once (pictures) asks for that many ({warm: n}), and can start them
// before it needs them with a request that has no message: {model, system, warm: n}.
//
// A model that is a Jev version ("jev-1.13.0") goes to TypeSafe AI's Jev instead
// (dev/jev.ts; TYPESAFE_API_KEY in .env): the same lines, one text chunk.
import { appendFileSync, mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { type Plugin, loadEnv } from "vite";
import { CallError, type CallStats, type Content, EFFORTS, type Effort, MAX_TOKENS, MODEL_IDS, type MockApi, Pool, SDK_VERSION, type Thinking, keepOf, keyOf, startProcess, streamCall, toContent } from "./claude.ts";
import { JEV_SETTINGS, callJev, isJev } from "./jev.ts";

export { MODEL_IDS };
const TIMEOUT_MS = 120_000;
/** Models and system prompts with processes waiting, at most (pages each have their own prompts). */
const MAX_KEYS = 6;
/** Processes kept waiting for one key, at most. */
const MAX_WARM = 4;
/** A waiting process older than this is closed rather than trusted. */
const MAX_WAIT_MS = 10 * 60_000;
/** How each call is made, reported back with its stats so the pages can show it. */
const settings = (effort: Effort, thinking: Thinking) => ({
  via: `Claude Agent SDK ${SDK_VERSION} (Claude Code) on the Claude subscription`,
  thinking: thinking === "off" ? "off (sent in the request body)" : "the model's default (it may think)",
  effort,
  maxOutputTokens: MAX_TOKENS,
  tools: "none",
  caching: "automatic, 5-minute (Claude Code caches the prompt prefix; see cache read/write tokens)",
  systemPrompt: "ours replaces Claude Code's default, but Claude Code still adds about 550 tokens of its own (measured 2026-10-15), not shown here",
  settingSources: "none (an empty config dir)",
});

export type ModelRequest = {
  model: string;
  /** Who the call is logged for: the hosted app's person (its X-Imagine-Person header, app/server/access.ts), never a page's say. */
  who?: string;
  system: string;
  user?: string;
  /** data: URLs (PNG or JPEG), sent before the text. */
  images?: string[];
  /** Which playground asked, for the call log. */
  from?: string;
  /** Free label for the call log. */
  tag?: string;
  /** Keep this many processes waiting for this key (calls made side by side); none given keeps one. */
  warm?: number;
  effort?: Effort;
  thinking?: Thinking;
};

/** Kept on globalThis: this module is evaluated afresh after edits, and the processes outlive it. */
const g = globalThis as typeof globalThis & { __rtV2Pools?: Map<string, Promise<{ q: { close(): void } }>[]>; __rtV2Pool?: Pool };
// The pools from before dev/claude.ts: let their processes go.
for (const old of g.__rtV2Pools?.values() ?? []) for (const p of old) void p.then((s) => s.q.close(), () => {});
g.__rtV2Pools = undefined;

/** `mockApi`: checks only, points every process at evals/mock/fake-api.ts. */
export function modelApi(o: { mockApi?: MockApi } = {}): Plugin {
  let token = "";
  let jevKey = "";
  let dataDir = "";
  const pool = (g.__rtV2Pool ??= new Pool({ maxKeys: MAX_KEYS, maxWarm: MAX_WARM, idleMs: MAX_WAIT_MS }));
  return {
    name: "model-api",
    apply: "serve",
    configResolved(config) {
      const env = loadEnv(config.mode, config.root, "");
      token = env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
      // Checks never send the owner's key: their Jev is the fake API's.
      jevKey = o.mockApi ? "mock" : (env.TYPESAFE_API_KEY ?? "");
      dataDir = process.env.RT_DATA_DIR || join(config.root, ".data");
    },
    configureServer(server) {
      const start = (model: string, system: string, effort: Effort, thinking: Thinking) => () =>
        startProcess(model, system, { token, effort, thinking, configDir: join(dataDir, "claude-config"), mockApi: o.mockApi });

      server.middlewares.use("/api/model", async (req, res) => {
        const fail = (status: number, error: string) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error }));
        };
        if ((req as { method?: string }).method !== "POST") return fail(405, "POST only");
        let body: ModelRequest;
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest;
        } catch {
          return fail(400, "bad JSON");
        }
        const who = req.headers["x-imagine-person"];
        body.who = typeof who === "string" ? who : undefined;
        if (isJev(body.model)) return jev(body, res);
        if (!token) return fail(500, "CLAUDE_CODE_OAUTH_TOKEN is not set in .env");
        const model = MODEL_IDS[body.model];
        if (!model) return fail(400, `unknown model "${body.model}" (haiku, sonnet, opus)`);
        const effort = body.effort ?? "low";
        if (!EFFORTS.includes(effort)) return fail(400, `unknown effort "${effort}" (${EFFORTS.join(", ")})`);
        const thinking: Thinking = body.thinking === "off" ? "off" : "auto";
        const key = keyOf(model, body.system, effort, thinking);
        const keep = keepOf(body.warm, MAX_WARM);
        const start1 = start(model, body.system, effort, thinking);
        // No message: only start processes for calls about to come.
        if (body.user === undefined) {
          pool.warm(key, keep, start1);
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ warming: keep }));
        }
        let content: Content;
        try {
          content = toContent(body.user, body.images);
        } catch (err) {
          return fail(400, (err as Error).message);
        }

        res.setHeader("content-type", "application/x-ndjson");
        const line = (x: unknown) => res.write(`${JSON.stringify(x)}\n`);
        const t0 = performance.now();
        const since = () => Math.round(performance.now() - t0);
        let firstMs: number | undefined;
        let waitMs: number | undefined;
        const taken = pool.take(key, keep, start1);
        let proc = taken.proc;
        const timer = setTimeout(() => proc.q.close(), TIMEOUT_MS);
        res.on("close", () => !res.writableEnded && proc.q.close());
        const head = { done: true, model: body.model, modelId: model, warm: taken.waiting, readyAtTake: taken.readyAtTake, effort, thinking, settings: settings(effort, thinking) };
        try {
          // A waiting process whose start failed is replaced by a fresh one: the call never fails on a dead spare.
          await proc.ready.catch((err) => {
            if (!taken.waiting) throw err;
            proc.q.close();
            proc = start1();
            Object.assign(head, { warm: false, readyAtTake: false });
            return proc.ready;
          });
          waitMs = since();
          const { text, stats } = await streamCall(proc, content, (chunk) => {
            firstMs ??= since();
            line({ text: chunk });
          });
          const out = { ...head, ms: since(), firstMs, waitMs, ...flat(stats) };
          line(out);
          log({ ...out, settings: undefined, from: body.from, tag: body.tag, who: body.who, images: body.images?.length ?? 0, system: body.system.length, user: body.user, reply: text });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const partial = err instanceof CallError ? flat(err.stats) : {};
          line({ ...head, ...partial, error, ms: since(), waitMs });
          log({ ...head, ...partial, settings: undefined, from: body.from, tag: body.tag, who: body.who, error, ms: since(), waitMs });
        } finally {
          clearTimeout(timer);
          proc.q.close();
          res.end();
        }
      });

      /** A Jev call: nothing to warm, one text line (the answers' JSON), then the stats. */
      async function jev(body: ModelRequest, res: ServerResponse) {
        res.setHeader("content-type", "application/json");
        if (body.user === undefined) return res.end(JSON.stringify({ warming: 0 }));
        if (!jevKey) return refuse(res, 500, "TYPESAFE_API_KEY is not set in .env");
        res.setHeader("content-type", "application/x-ndjson");
        const head = { done: true, model: body.model, modelId: body.model, settings: JEV_SETTINGS };
        const t0 = performance.now();
        const abort = new AbortController();
        res.on("close", () => !res.writableEnded && abort.abort());
        try {
          const { text, stats } = await callJev(jevKey, body.model, body.user, { baseUrl: o.mockApi?.baseUrl, signal: abort.signal });
          res.write(`${JSON.stringify({ text })}\n`);
          const out = { ...head, ...stats, ms: Math.round(performance.now() - t0) };
          res.end(`${JSON.stringify(out)}\n`);
          log({ ...out, settings: undefined, from: body.from, tag: body.tag, who: body.who, system: body.system?.length ?? 0, user: body.user, reply: text });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          res.end(`${JSON.stringify({ ...head, error, ms: Math.round(performance.now() - t0) })}\n`);
          log({ ...head, settings: undefined, from: body.from, tag: body.tag, who: body.who, error });
        }
      }

      function refuse(res: ServerResponse, status: number, error: string) {
        res.statusCode = status;
        res.end(JSON.stringify({ error }));
      }

      function log(rec: Record<string, unknown>) {
        try {
          mkdirSync(dataDir, { recursive: true });
          appendFileSync(join(dataDir, "model-calls.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
        } catch {}
      }
    },
  };
}

/** The stats line's numbers (src/core/model.ts' ModelStats). */
const flat = (s: CallStats) => ({
  inTokens: s.inTokens, outTokens: s.outTokens, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, write5m: s.write5m, write1h: s.write1h,
  thinkingTokens: s.thinkingTokens, thinkingBlocks: s.thinkingBlocks, stopReason: s.stopReason, served: s.served, costUsd: s.costUsd, retries: s.retries, rateLimit: s.rateLimit,
});

/** For checks: the dev server's waiting processes per key. */
export const poolSizes = () => g.__rtV2Pool?.sizes() ?? {};
