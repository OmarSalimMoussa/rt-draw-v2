// How node callers (run.ts, drive.ts, judge.ts, agents.ts) reach the gateway: it
// runs as its own process (gateway.ts says why), and eval roles call it over HTTP.
// The gateway reads the tokens file itself; this process hands it the path only,
// and its env carries no token or key.
import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import type { Effort, RateLimit, Thinking } from "../../dev/claude.ts";
import type { RunMode } from "./gateway.ts";
import type { SlotN } from "./tokens.ts";

let gatewayUrl = process.env.RT_GATEWAY_URL;
const SECRET = /^(RT_EVAL_TOKEN_|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_|ELEVENLABS_|OPENROUTER_|TYPESAFE_)/;

export type GatewayOpts = {
  home?: string; port?: number;
  /** run.ts's --cap: the gateway refuses call n+1. */
  cap?: number;
  /** The tokens file (default ~/.config/rt-eval/tokens.env), or the dev plugin's token (true, or the checkout to read it from; cap ≤ 60). */
  tokens?: string; devToken?: true | string;
  /** The fake API's URL: every Claude process goes there, with HTTPS_PROXY at a closed port. */
  mockApi?: string;
};

/** Starts the gateway process; resolves once it listens. Later ask() calls go to it. */
export async function spawnGateway(o: GatewayOpts = {}): Promise<{ url: string; pid: number; child: ChildProcess; logs: () => string; close: () => Promise<void> }> {
  const flags = [
    ...(o.home ? ["--home", o.home] : []), ...(o.port ? ["--port", String(o.port)] : []), ...(o.cap !== undefined ? ["--cap", String(o.cap)] : []),
    ...(o.tokens ? ["--tokens", o.tokens] : []), ...(o.devToken ? ["--dev-token", ...(o.devToken === true ? [] : [o.devToken])] : []), ...(o.mockApi ? ["--mock-api", o.mockApi] : []),
  ];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET.test(k)));
  const hooks = fileURLToPath(new URL("node-hooks.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--import", hooks, fileURLToPath(new URL("gateway.ts", import.meta.url)), ...flags], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => {
    out += d;
    if (!/gateway refused to start/.test(String(d))) process.stderr.write(d);
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the gateway didn't start in 15 s")), 15_000);
    child.stdout!.on("data", () => {
      const m = /READY (\S+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      resolve(m[1]);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(/gateway refused to start: (.*)/.exec(out)?.[1] ?? `the gateway exited (${code})`));
    });
  });
  gatewayUrl = url;
  return {
    url, pid: child.pid!, child, logs: () => out,
    close: () => new Promise<void>((r) => {
      if (child.exitCode !== null) return r();
      child.on("exit", () => r());
      child.stdin!.end();
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }),
  };
}

export type AskRequest = {
  role: string; model: string; system: string;
  /** The user message's text: one string, or several text blocks after the images. */
  turns?: string | string[]; user?: string;
  images?: string[]; effort?: Effort; thinking?: Thinking;
  run?: string; case?: string;
  /** Pin a token slot (a probe, or the smoke's per-slot resetsAt check). */
  token?: SlotN;
};

/** The gateway's --cap is reached: the step stops, never just the call or the case (a typed error, so no one reads the words). */
export class CapReached extends Error {}

/** One eval-role call through the gateway. Throws on any error (never an empty success); CapReached at the cap. */
export async function ask(r: AskRequest, url = gatewayUrl): Promise<{ text: string; stats: Record<string, unknown> }> {
  const j = await post("/call", r, url);
  if (j.capped) throw new CapReached(j.error);
  if (j.error) throw new Error(j.error);
  return j;
}

/**
 * A run's mode: live (the default), replay or scan. share: false keeps both arms' identical calls apart (unshared A/A,
 * checkpoints); cached: request hashes the diffscan found identical in both arms, served from the bank cache in a live run;
 * warm (a scan only): each call also starts the processes it would take, and the case's end waits until they're up.
 */
export const setMode = (run: string, mode: RunMode, o: { share?: boolean; cached?: string[]; warm?: boolean; timed?: boolean } = {}, url = gatewayUrl) => post("/run", { run, mode, ...o }, url);
/** An agent session's list $ and last rate-limit state on its slot: the slot's window and week count agents too (§6.6). */
export const recordSpend = (o: { slot: SlotN; usd: number; rateLimit?: RateLimit }, url = gatewayUrl) => post("/spend", o, url);
/** The case is over: the gateway's event-loop delay p99 over it, and its calls per arm (replies.json's rows). */
export const endCase = (run: string, caseId: string, url = gatewayUrl) => post("/case-end", { run, case: caseId }, url);
export async function gatewayStatus(url = gatewayUrl) {
  return (await fetch(`${need(url)}/status`)).json();
}

function need(url: string | undefined): string {
  if (!url) throw new Error("no gateway: spawnGateway() first, or set RT_GATEWAY_URL");
  return url;
}
async function post(path: string, body: unknown, url: string | undefined) {
  const res = await postJson(`${need(url)}${path}`, JSON.stringify(body));
  let j;
  try {
    j = JSON.parse(res.text);
  } catch {
    j = { error: `gateway HTTP ${res.status}` };
  }
  return (res.status >= 200 && res.status < 300) || j.error ? j : { ...j, error: `gateway HTTP ${res.status}` };
}
/**
 * One JSON POST over node:http, not fetch: fetch gives up after 300 s without the answer's headers, and the gateway
 * answers an eval role's call only when it's done (gold at max effort took up to 38 minutes; the gateway's hang guard ends a stuck one).
 */
function postJson(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
