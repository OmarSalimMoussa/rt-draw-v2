// One Claude Code process per call, through the Agent SDK on the Claude
// subscription: the dev server (dev/model-plugin.ts) and the eval's gateway
// (evals/loop/gateway.ts) both use this. No tools, no settings, one turn, effort
// per request (default low). Starting a process takes a second or more, so
// processes are kept started and waiting per key (v1: first text 0.8–1.1 s with a
// waiting process against 1.3 s+ starting one).
//
// The env is an allowlist, never the parent's: the 5-minute prompt cache (v1 paid
// about half its use on 1-hour cache writes), the quiet flags, an empty config dir
// (no owner email in prompts, no peer-session registration), no session variables
// and no other service's key.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Query, type SDKMessage, type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";

/** The short names the pages send → Anthropic's ids. */
export const MODEL_IDS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
export const SDK_VERSION = "0.3.299";
export const MAX_TOKENS = 4096;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export type Thinking = "auto" | "off";
/** The fake API (evals/mock/fake-api.ts) and a closed local port every other request dies on. */
export type MockApi = { baseUrl: string; deadProxyPort: number };
export type Content = Exclude<SDKUserMessage["message"]["content"], string>;

/**
 * What turns thinking off, per model: the SDK's own `thinking: disabled` doesn't reach
 * the request (v1: Sonnet thought on ~55% of turns). Sonnet 5.5 answers `disabled` with
 * a 400 and takes `between_tools`; Opus 5.5 can't turn it off at all (effort is its only control).
 */
const THINKING_OFF: Record<string, object | undefined> = {
  "claude-haiku-5-5": { type: "disabled" },
  "claude-sonnet-5-5": { type: "between_tools" },
};

/** `maxTokens`: the output limit, MAX_TOKENS (the product's) unless the caller says otherwise (the eval gateway's own roles). */
export type EnvOpts = { configDir: string; model?: string; thinking?: Thinking; maxRetries?: number; maxTokens?: number; mockApi?: MockApi };

/** The env of every Claude process (spec §7.3). */
export function childEnv(token: string, o: EnvOpts): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, {
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(o.maxTokens ?? MAX_TOKENS),
    FORCE_PROMPT_CACHING_5M: "1",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: o.configDir,
  });
  if (o.maxRetries !== undefined) env.CLAUDE_CODE_MAX_RETRIES = String(o.maxRetries);
  const off = o.thinking === "off" && o.model ? THINKING_OFF[o.model] : undefined;
  if (off) env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ thinking: off });
  if (o.mockApi) {
    env.ANTHROPIC_BASE_URL = o.mockApi.baseUrl;
    env.HTTPS_PROXY = `http://127.0.0.1:${o.mockApi.deadProxyPort}`;
    // Claude Code sends http:// through HTTPS_PROXY too: only loopback (the fake API) goes direct.
    env.NO_PROXY = "127.0.0.1,localhost";
  }
  return env;
}

/** A started Claude process waiting for its one message. `up`: it has finished starting. */
export type Proc = { q: Query; give: (c: Content) => void; ready: Promise<void>; up: boolean; born: number };
export type ProcOpts = EnvOpts & { token: string; effort?: Effort };

// The prompt Claude Code adds names its working directory: one fixed folder keeps it the same for every call.
const CWD = join(tmpdir(), "rt-draw-v2-claude");

/**
 * The SDK's native CLI, found once the way the SDK finds it. Left to itself the SDK looks it up on every
 * query() with process.report.getReport(), which walks every open handle: 3–30 ms of a blocked event loop
 * per process start in a busy gateway (V9 voids a case past 20 ms).
 */
const CLI = (() => {
  if (process.platform !== "linux") return undefined;
  const musl = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime === undefined;
  const pkg = `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`;
  const req = createRequire(import.meta.url);
  for (const p of musl ? [`${pkg}-musl`, pkg] : [pkg, `${pkg}-musl`])
    try {
      return req.resolve(`${p}/claude`);
    } catch {}
})();

export function startProcess(model: string, system: string, o: ProcOpts): Proc {
  let give!: (c: Content) => void;
  const first = new Promise<Content>((r) => (give = r));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: await first } } as SDKUserMessage;
  }
  mkdirSync(CWD, { recursive: true });
  mkdirSync(o.configDir, { recursive: true });
  const q = query({
    prompt: prompt(),
    options: { model, systemPrompt: system, tools: [], settingSources: [], persistSession: false, includePartialMessages: true, thinking: { type: "disabled" }, effort: o.effort ?? "low", maxTurns: 1, cwd: CWD, env: childEnv(o.token, { ...o, model }), ...(CLI ? { pathToClaudeCodeExecutable: CLI } : {}) },
  });
  const p: Proc = { q, give, up: false, born: Date.now(), ready: Promise.resolve() };
  // Never bill an API key by accident: the process must be on the subscription's token.
  p.ready = q.accountInfo().then((a) => {
    if (a.apiProvider !== "firstParty" || a.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN") throw new Error(`not on the subscription (${a.tokenSource ?? a.apiKeySource ?? "unknown"})`);
    p.up = true;
  });
  p.ready.catch(() => {});
  return p;
}

export type RateLimit = { status: string; fiveHour?: number; sevenDay?: number; resetsAt?: number };
export type CallStats = {
  inTokens: number; outTokens: number; cacheRead: number; cacheWrite: number; write5m: number; write1h: number;
  thinkingTokens: number; thinkingBlocks: number; stopReason?: string; served?: string; costUsd?: number; retries: number;
  rateLimit?: RateLimit;
};
/** A failed call, with what was learned before it failed (retries, the rate-limit state). */
export class CallError extends Error {
  stats: CallStats;
  constructor(message: string, stats: CallStats) {
    super(message);
    this.stats = stats;
  }
}

function rateLimitOf(info: Record<string, unknown>): RateLimit {
  const w = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number } | undefined>;
  const own = (type: string) => (info.rateLimitType === type ? (info.utilization as number | undefined) : undefined);
  return { status: String(info.status), fiveHour: w.five_hour?.utilization ?? own("five_hour"), sevenDay: w.seven_day?.utilization ?? own("seven_day"), resetsAt: w.five_hour?.resetsAt ?? (info.resetsAt as number | undefined) };
}

/** Sends the one message and streams the reply's text. Throws (never an empty success) on an API error, an error result or a rejected rate limit. */
export async function streamCall(p: Proc, content: Content, onText?: (chunk: string) => void): Promise<{ text: string; stats: CallStats }> {
  const s: CallStats = { inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, write5m: 0, write1h: 0, thinkingTokens: 0, thinkingBlocks: 0, retries: 0 };
  let text = "";
  const on = (m: SDKMessage) => {
    if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "message_start") {
        const u = e.message.usage;
        s.served = e.message.model;
        s.inTokens += u.input_tokens ?? 0;
        s.cacheRead += u.cache_read_input_tokens ?? 0;
        s.cacheWrite += u.cache_creation_input_tokens ?? 0;
        s.write5m += u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        s.write1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      } else if (e.type === "message_delta") {
        s.outTokens += e.usage?.output_tokens ?? 0;
        s.thinkingTokens += (e.usage as { output_tokens_details?: { thinking_tokens?: number } })?.output_tokens_details?.thinking_tokens ?? 0;
        s.stopReason = e.delta.stop_reason ?? s.stopReason;
      } else if (e.type === "content_block_start" && /thinking/.test(e.content_block.type)) s.thinkingBlocks++;
      else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
        text += e.delta.text;
        onText?.(e.delta.text);
      }
    } else if (m.type === "system" && m.subtype === "api_retry") s.retries++;
    else if (m.type === "rate_limit_event") {
      s.rateLimit = rateLimitOf(m.rate_limit_info as unknown as Record<string, unknown>);
      if (s.rateLimit.status === "rejected") throw new CallError("rate limit rejected", s);
    } else if (m.type === "assistant" && m.error === "max_output_tokens") s.stopReason = "max_tokens";
    else if (m.type === "assistant" && m.error) throw new CallError(`model error: ${m.error}`, s);
    else if (m.type === "result") {
      s.costUsd = m.total_cost_usd;
      s.stopReason ??= m.stop_reason ?? undefined;
      if (m.is_error) throw new CallError(`model call failed (${m.subtype})`, s);
    }
  };
  p.give(content);
  try {
    for await (const m of p.q as AsyncIterable<SDKMessage>) on(m);
  } catch (err) {
    // A cut-off reply still drew what it drew (Claude Code has already asked to continue it 3 times),
    // though Claude Code ends it with an error result; anything else is a failed call.
    if (s.stopReason !== "max_tokens") throw err instanceof CallError ? err : new CallError(err instanceof Error ? err.message : String(err), s);
  }
  return { text, stats: s };
}

/** A pool key: a process fixes its model, prompt, effort and (through its env) thinking when it starts. */
export const keyOf = (model: string, system: string, effort: Effort = "low", thinking: Thinking = "auto") =>
  `${model}:${effort}:${thinking}:${createHash("sha256").update(system).digest("hex").slice(0, 16)}`;

/** How many to keep waiting after a request: none asked → one (today's default, N1), warm n → n, at most `max`. */
export const keepOf = (warm: unknown, max: number) => (warm === undefined || warm === null ? 1 : Math.max(0, Math.min(max, Math.round(Number(warm) || 0))));

/** Waiting processes per key, oldest first; keys in least-recently-used order. */
export class Pool {
  private pools = new Map<string, Proc[]>();
  private reaper: ReturnType<typeof setInterval>;
  readonly o: { maxKeys?: number; idleMs?: number; maxWarm?: number };
  /** maxKeys: prompts edited in development leave processes nobody will use. idleMs: a waiting process older than this is closed. */
  constructor(o: Pool["o"] = {}) {
    this.o = o;
    this.reaper = setInterval(() => this.reap(), Math.min(this.idleMs, 60_000));
    this.reaper.unref();
  }
  get idleMs() {
    return this.o.idleMs ?? 5 * 60_000;
  }
  get maxWarm() {
    return this.o.maxWarm ?? 4;
  }

  /**
   * Tops `key` up to n waiting processes (at most maxWarm). One the reaper closes within a minute (or half of idleMs) is
   * closed now and replaced: counted, it left the take it was warmed for to start cold (the eval loop's 35 cold takes
   * all came 5 to 25 min after their key's last).
   */
  warm(key: string, n: number, start: () => Proc) {
    const now = Date.now(), last = this.idleMs - Math.min(60_000, this.idleMs / 2);
    const all = this.pools.get(key) ?? [];
    const pool = all.filter((p) => now - p.born <= last);
    for (const p of all) if (!pool.includes(p)) p.q.close();
    this.pools.delete(key);
    this.pools.set(key, pool);
    while (pool.length < Math.min(n, this.maxWarm)) pool.push(start());
    for (const [k, old] of this.pools) {
      if (this.pools.size <= (this.o.maxKeys ?? Infinity)) break;
      this.pools.delete(k);
      for (const p of old) p.q.close();
    }
  }

  /** A waiting process if there's one (else a new one), then `key` is topped back up to `keep`. readyAtTake: it had finished starting. */
  take(key: string, keep: number, start: () => Proc): { proc: Proc; waiting: boolean; readyAtTake: boolean } {
    this.reap();
    const proc = this.pools.get(key)?.shift();
    this.warm(key, keep, start);
    return proc ? { proc, waiting: true, readyAtTake: proc.up } : { proc: start(), waiting: false, readyAtTake: false };
  }

  /** Waiting processes per key. */
  sizes(): Record<string, number> {
    return Object.fromEntries([...this.pools].filter(([, p]) => p.length).map(([k, p]) => [k, p.length]));
  }

  private reap() {
    const now = Date.now();
    for (const [k, pool] of this.pools) {
      for (const p of pool.filter((p) => now - p.born > this.idleMs)) p.q.close();
      this.pools.set(k, pool.filter((p) => now - p.born <= this.idleMs));
    }
  }

  closeAll() {
    for (const pool of this.pools.values()) for (const p of pool) p.q.close();
    this.pools.clear();
    clearInterval(this.reaper);
  }
}

/** A request's images (base64 data: URLs) and text as one user message. Throws on a bad image. */
export function toContent(user: string | string[], images: string[] = []): Content {
  return [
    ...images.map((url) => {
      const [, mime, data] = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url) ?? [];
      if (!data) throw new Error("images must be base64 data: URLs");
      return { type: "image" as const, source: { type: "base64" as const, media_type: mime as "image/png", data } };
    }),
    ...(Array.isArray(user) ? user : [user]).map((text) => ({ type: "text" as const, text })),
  ];
}
