// A local Anthropic Messages API (streaming) for checks, readiness and the ladder:
// a Claude Code process pointed at it (ANTHROPIC_BASE_URL, with HTTPS_PROXY at a
// closed port so nothing can leak to the real API) makes no real call. It logs
// what each request asked for (cache TTLs, betas, the first user message, the
// thinking field), so checks can prove the env does what it should.
//
//   node --import ./evals/loop/node-hooks.mjs evals/mock/fake-api.ts [--port n] [--mode ok]
//        [--replies <dir>] [--script <file>] [--latency <model-calls.jsonl>]
// prints "READY <url>"; GET /_log answers the request log, POST /_set {mode, util5h, …} changes it.
//
// --replies <dir>: files named <role>.<sha12>.txt (one reply) or .json (an array, served in turn),
//   where sha12 is the first 12 hex of sha256(the caller's system prompt); the role (the "role
//   marker") is logged with each request it answers. Unmatched requests get "ok" and role "?".
// --script <file>: a JSON array of assistant turns [{content: [blocks], stop_reason?, usage?}],
//   text and tool_use blocks; a request's turn is the number of assistant messages it carries.
// --latency <jsonl>: replays the logged model time (firstMs − waitMs to first text, the rest
//   spread over the chunks) of the log's lines in turn.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";

export type FakeMode = "ok" | "slow" | "limit" | "overload" | "auth" | "maxtokens" | "thinking";
export type FakeOpts = {
  port?: number; mode?: FakeMode; replies?: string; script?: string; latency?: string;
  /** Five-hour and seven-day utilization (0–1) in the rate-limit headers, and the status they send. */
  util5h?: number; util7d?: number; status?: "allowed" | "allowed_warning" | "rejected";
  /** Unix seconds; default an hour from start. */
  resetsAt?: number;
  /** slow: ms before the first text, then between chunks. */
  slowMs?: number; chunkMs?: number;
};
export type FakeRequest = {
  at: number; endAt?: number; path: string; model: string; mode: FakeMode; status: number; role?: string;
  /** sha12 of each system block (Claude Code adds its own blocks before ours). */
  systemSha: string[]; ttls: string[]; beta: string; firstUser: string; thinking?: unknown; effort?: string;
  images: number; assistantTurns: number;
};

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
type Block = { type: string; text?: string; cache_control?: { ttl?: string }; [k: string]: unknown };
type Body = { model: string; system?: string | Block[]; messages: { role: string; content: string | Block[] }[]; thinking?: unknown; output_config?: { effort?: string } };
type Turn = { content: Block[]; stop_reason?: string; usage?: Record<string, number> };
type Timed = { firstMs: number; restMs: number; chunks: number };

/** Every cache_control TTL in the request ("5m" when unset: the API's default). */
function ttls(b: Body): string[] {
  const out: string[] = [];
  const scan = (blocks: unknown) => Array.isArray(blocks) && blocks.forEach((x: Block) => x?.cache_control && out.push(x.cache_control.ttl ?? "5m"));
  scan(b.system);
  for (const m of b.messages) scan(m.content);
  return out;
}
const textOf = (c: string | Block[]) => (typeof c === "string" ? c : c.filter((x) => x.type === "text").map((x) => x.text).join("\n"));

export async function startFakeApi(opts: FakeOpts = {}) {
  const o: FakeOpts = { mode: "ok", util5h: 0.42, util7d: 0.11, status: "allowed", resetsAt: Math.floor(Date.now() / 1000) + 3600, slowMs: 1500, chunkMs: 100, ...opts };
  const requests: FakeRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const served = new Map<string, number>();
  const replies = new Map<string, { role: string; texts: string[] }>();
  if (o.replies)
    for (const f of readdirSync(o.replies)) {
      const m = /^(.+)\.([0-9a-f]{12})\.(txt|json)$/.exec(f);
      if (!m) continue;
      const raw = readFileSync(join(o.replies, f), "utf8");
      replies.set(m[2], { role: m[1], texts: m[3] === "json" ? (JSON.parse(raw) as string[]) : [raw] });
    }
  const script: Turn[] = o.script ? JSON.parse(readFileSync(o.script, "utf8")) : [];
  const timings: Timed[] = o.latency && existsSync(o.latency)
    ? readFileSync(o.latency, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.firstMs !== undefined && !r.error)
        .map((r) => ({ firstMs: r.firstMs - (r.waitMs ?? 0), restMs: r.ms - r.firstMs, chunks: Math.max(1, Math.round((r.outTokens ?? 40) / 20)) }))
    : [];
  let timingN = 0;

  function limitHeaders(status = o.status!): Record<string, string> {
    return {
      "anthropic-ratelimit-unified-status": status,
      "anthropic-ratelimit-unified-5h-utilization": String(o.util5h),
      "anthropic-ratelimit-unified-7d-utilization": String(o.util7d),
      "anthropic-ratelimit-unified-5h-reset": String(o.resetsAt),
      "anthropic-ratelimit-unified-7d-reset": String(o.resetsAt! + 3 * 86400),
      "anthropic-ratelimit-unified-reset": String(o.resetsAt),
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    };
  }

  async function messages(req: IncomingMessage, res: ServerResponse, b: Body, rec: FakeRequest) {
    const mode = rec.mode;
    const fail = (status: number, type: string, message: string, headers: Record<string, string> = {}) => {
      rec.status = status;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ type: "error", error: { type, message } }));
    };
    if (mode === "limit") return fail(429, "rate_limit_error", "fake: usage limit reached", { ...limitHeaders("rejected"), "retry-after": "3600" });
    if (mode === "overload") return fail(529, "overloaded_error", "fake: overloaded");
    if (mode === "auth") return fail(401, "authentication_error", "fake: invalid token");

    // What to answer: the script's turn, a canned reply for this system prompt, or "ok".
    let turn: Turn;
    if (script.length) turn = script[rec.assistantTurns] ?? { content: [{ type: "text", text: "done" }] };
    else {
      const hit = rec.systemSha.map((s) => replies.get(s)).find(Boolean);
      const n = hit ? (served.get(hit.role) ?? 0) : 0;
      if (hit) served.set(hit.role, n + 1);
      rec.role = hit?.role ?? (o.replies ? "?" : undefined);
      turn = { content: [{ type: "text", text: hit ? hit.texts[n % hit.texts.length] : "ok" }] };
    }
    if (mode === "thinking") turn = { ...turn, content: [{ type: "thinking", thinking: "Let me think about this." }, ...turn.content] };
    const thinkingTokens = mode === "thinking" ? 57 : 0;
    const promptChars = JSON.stringify(b.system ?? "").length + JSON.stringify(b.messages).length;
    const write = Math.round(promptChars / 4);
    const oneHour = rec.ttls.includes("1h");
    const timed = timings.length ? timings[timingN++ % timings.length] : undefined;

    res.writeHead(200, { "content-type": "text/event-stream", ...limitHeaders() });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `msg_fake_${requests.length}`, type: "message", role: "assistant", model: `${b.model}-fake`, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: oneHour ? 0 : write, ephemeral_1h_input_tokens: oneHour ? write : 0 }, output_tokens: 1 } } });
    const slow = mode === "slow";
    await sleep(timed ? timed.firstMs : slow ? o.slowMs! : 0);
    const end = Date.now() + (timed?.restMs ?? 0);
    let outTokens = 0;
    for (const [i, block] of turn.content.entries()) {
      if (block.type === "text") {
        ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
        const text = block.text ?? "";
        const parts = Math.max(1, Math.min(text.length, timed?.chunks ?? (slow ? 4 : 2)));
        const size = Math.max(1, Math.ceil(text.length / parts));
        for (let at = 0; at < text.length || at === 0; at += size) {
          if (at) await sleep(timed ? timed.restMs / parts : slow ? o.chunkMs! : 0);
          ev("content_block_delta", { index: i, delta: { type: "text_delta", text: text.slice(at, at + size) } });
          if (!text) break;
        }
        outTokens += Math.ceil(text.length / 4);
      } else if (block.type === "thinking") {
        ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
        ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: block.thinking } });
        ev("content_block_delta", { index: i, delta: { type: "signature_delta", signature: "fake-signature" } });
      } else if (block.type === "tool_use") {
        const id = (block.id as string) ?? `toolu_fake_${requests.length}_${i}`;
        ev("content_block_start", { index: i, content_block: { type: "tool_use", id, name: block.name, input: {} } });
        ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
        outTokens += 20;
      }
      ev("content_block_stop", { index: i });
    }
    await sleep(end - Date.now());
    const stop = turn.stop_reason ?? (mode === "maxtokens" ? "max_tokens" : turn.content.some((x) => x.type === "tool_use") ? "tool_use" : "end_turn");
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTokens + thinkingTokens, output_tokens_details: { thinking_tokens: thinkingTokens }, ...turn.usage } });
    ev("message_stop", {});
    res.end();
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/_log") return res.end(JSON.stringify({ requests, maxInFlight }));
    if (path === "/_set" && req.method === "POST") {
      Object.assign(o, JSON.parse(raw || "{}"));
      return res.end("{}");
    }
    if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake: no ${path}` } }));
    }
    const b = JSON.parse(raw) as Body;
    const system = typeof b.system === "string" ? [{ type: "text", text: b.system }] : (b.system ?? []);
    const first = b.messages.find((m) => m.role === "user");
    const rec: FakeRequest = {
      at: Date.now(), path, model: b.model, mode: o.mode!, status: 200, systemSha: system.map((x) => sha12(x.text ?? "")), ttls: ttls(b),
      beta: String(req.headers["anthropic-beta"] ?? ""), firstUser: first ? textOf(first.content) : "", thinking: b.thinking, effort: b.output_config?.effort,
      images: b.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).filter((x) => x.type === "image").length,
      assistantTurns: b.messages.filter((m) => m.role === "assistant").length,
    };
    requests.push(rec);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      await messages(req, res, b, rec);
    } finally {
      inFlight--;
      rec.endAt = Date.now();
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    maxInFlight: () => maxInFlight,
    set: (p: Partial<FakeOpts>) => void Object.assign(o, p),
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
export type FakeApi = Awaited<ReturnType<typeof startFakeApi>>;

if (import.meta.main) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const api = await startFakeApi({ port: Number(arg("port") ?? 0), mode: (arg("mode") as FakeMode) ?? "ok", replies: arg("replies"), script: arg("script"), latency: arg("latency") });
  console.log(`READY ${api.url}`);
}
