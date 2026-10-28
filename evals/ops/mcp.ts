// Claude's tools for the eval (evals/README.md): an MCP server on stdio, run on the laptop (.mcp.json registers it).
// status, needs_you, run, stop and intake_now run `rte api` on the PGX over ssh (evals/loop/commands/api.ts); deploy
// runs evals/ops/deploy.sh from this checkout. A tool returns what rte api says: ids, counts and the harness's own
// words, never what a tester said or drew. Each call passes Claude Code's own permission prompt. Verdicts on cards
// stay in Eval HQ, where their content is, and shipping to prod stays the owner's command (evals/ops/ship.sh).
// The PGX is RT_PGX in ~/.config/rt-eval/hosts.env, as for deploy.sh; RT_SSH replaces ssh (checks).
//   node evals/ops/mcp.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";

const ROOT = join(import.meta.dirname, "..", "..");
const NONE = { type: "object", properties: {}, additionalProperties: false };
const TOOLS = [
  { name: "status", description: "The eval's state on the PGX: the loop (its unit, status, phase, why it stopped), the lock, the champion and its keeps not yet on master, what's on prod, the last pulls, intake's cards by state, the bank by origin, each token's use.", inputSchema: NONE },
  {
    name: "needs_you",
    description: "What waits for the owner: decisions held for their call, open owner-list items, side chats, and the threads where they wrote last. With thread and text, answers that thread as Claude (resolve settles it).",
    inputSchema: { type: "object", properties: { thread: { type: "string", description: "a thread or item id from the list" }, text: { type: "string" }, resolve: { type: "boolean" } }, additionalProperties: false },
  },
  { name: "run", description: "Starts the loop's unit on the PGX: readiness at 0 calls, then the loop resumes where it stopped.", inputSchema: NONE },
  { name: "stop", description: "Asks the loop to stop after the step in flight. Nothing is lost; run goes on from there.", inputSchema: NONE },
  { name: "intake_now", description: "Pulls the hosted app's data and runs intake now (testers' new sends to cards for review). While the loop runs, it does this between its epochs instead.", inputSchema: NONE },
  { name: "deploy", description: "Deploys this checkout's branch (the one the loop follows) to the PGX: the loop finishes its card, the harness is re-pinned and the loop starts again if it was running.", inputSchema: NONE },
];

/** RT_PGX, from the environment or the laptop's hosts file. */
function pgx(): string {
  if (process.env.RT_PGX) return process.env.RT_PGX;
  const f = process.env.RT_HOSTS ?? join(homedir(), ".config", "rt-eval", "hosts.env");
  const host = existsSync(f) ? parseEnv(readFileSync(f, "utf8")).RT_PGX : undefined;
  if (!host) throw new Error(`no RT_PGX: set it in ${f}`);
  return host;
}

/** A command's exit code and output (stdout, then stderr), within `ms`. */
function exec(cmd: string, args: string[], ms: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b: Buffer) => (out += b));
    p.stderr.on("data", (b: Buffer) => (err += b));
    const timer = setTimeout(() => p.kill(), ms);
    p.on("error", (e) => ((err += e.message), ok({ code: 127, out, err })));
    p.on("close", (code) => (clearTimeout(timer), ok({ code: code ?? 1, out, err })));
  });
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function call(name: string, a: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (name === "deploy") {
    const r = await exec("bash", ["evals/ops/deploy.sh"], 300_000);
    return { text: `${r.out}${r.err}`.trim(), isError: r.code !== 0 };
  }
  const args = [name];
  if (name === "needs_you" && a.thread !== undefined) {
    const text = String(a.text ?? "").trim();
    // rte's flags: a value starting with -- would read as a flag.
    if (text.startsWith("--")) return { text: "needs_you: the text can't start with --", isError: true };
    args.push("--thread", String(a.thread), ...(text ? ["--text", text] : []), ...(a.resolve ? ["--resolve"] : []));
  }
  // A plain ssh has no node on its PATH: the units' env file has the one the loop runs with.
  const remote = `set -a; . "\${RT_EVAL_HOME:-$HOME/rt-eval}/rt-units.env"; set +a; exec "$RT_EVAL_HOME/repo/bin/rte" api ${args.map(quote).join(" ")}`;
  const r = await exec(process.env.RT_SSH ?? "ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", pgx(), remote], 120_000);
  return r.code === 0 ? { text: r.out.trim(), isError: false } : { text: `${r.out}${r.err}`.trim() || `exit ${r.code}`, isError: true };
}

const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m: { id?: number | string; method?: string; params?: Record<string, any> };
  try {
    m = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "parse error" } });
  }
  const { id, method, params = {} } = m;
  if (id === undefined) return; // a notification (initialized, cancelled): nothing to answer
  try {
    if (method === "initialize")
      return send({ id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "rt-eval", version: "1.0.0" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      if (!TOOLS.some((t) => t.name === params.name)) return send({ id, error: { code: -32602, message: `no tool ${params.name}` } });
      const r = await call(params.name, params.arguments ?? {});
      return send({ id, result: { content: [{ type: "text", text: r.text }], isError: r.isError } });
    }
    send({ id, error: { code: -32601, message: `no method ${method}` } });
  } catch (err) {
    send({ id, result: { content: [{ type: "text", text: (err as Error).message }], isError: true } });
  }
});
