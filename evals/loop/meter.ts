// The budget meter (spec §3.4, §6.6): one line per model call (the gateway) and per
// agent session (agents.ts) in $RT_EVAL_HOME/meter/calls.jsonl, with list $ at
// Anthropic's list prices. Hashes and numbers only: prompts and replies live in the
// reply cache. Rollups give $ by role, run or epoch, and the shares v1 never saw
// (1-hour writes, thinking, cold starts).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { JEV_PRICE, isJev } from "../../dev/jev.ts";
import type { AgentLog, CallLog } from "./types.ts";

/** $ per million tokens; a 5-minute cache write is 1.25× input, a 1-hour one 2×. Jev: dev/jev.ts' JEV_PRICE. */
export const PRICES: Record<string, { in: number; out: number; read: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01 },
  "claude-opus-5-5": { in: 4, out: 20, read: 0.2 },
};

type Tokens = { inTokens: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; outTokens: number };
export function listUsd(model: string, t: Tokens): number {
  const p = isJev(model) ? { ...JEV_PRICE, read: 0 } : (PRICES[model] ?? PRICES["claude-sonnet-5-5"]);
  return (t.inTokens * p.in + t.cacheRead * p.read + t.cacheWrite5m * p.in * 1.25 + t.cacheWrite1h * p.in * 2 + t.outTokens * p.out) / 1e6;
}

/** §3.4's fields in order: every line has all of them (null when unknown), so a reader never guesses. */
export const CALL_FIELDS = ["at", "run", "case", "arm", "slot", "role", "page", "model", "servedModel", "sdk", "reqHash", "shared", "mode", "inTokens", "cacheRead", "cacheWrite5m", "cacheWrite1h", "outTokens", "thinkingTokens", "stopReason", "ms", "firstMs", "waitMs", "readyAtTake", "retries", "apiError", "dropped", "listUsd", "costUsd", "token", "fiveHour", "sevenDay", "resetsAt"] as const;

/** A call line, plus how a scan served it (an exact hit, the case's stand-in, or nothing). */
export type MeterCall = CallLog & { scan?: "hit" | "standin" | "miss" };

export function meterCall(file: string, l: MeterCall) {
  const line: Record<string, unknown> = Object.fromEntries(CALL_FIELDS.map((k) => [k, l[k] ?? null]));
  if (l.scan) line.scan = l.scan;
  append(file, line);
}
export const meterAgent = (file: string, l: AgentLog) => append(file, l);

function append(file: string, line: object) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/**
 * Past this size the meter moves aside whole, kept as calls-<at>.jsonl beside it, when an epoch starts afresh (no run,
 * no epoch split across two files): readMeter loads it into one string, and V8's strings stop at 512 MB (e101's loop
 * died there, 2026-10-27).
 */
export const METER_ROTATE_BYTES = 256 << 20;
export function rotateMeter(file: string, at = new Date(), max = METER_ROTATE_BYTES): string | undefined {
  if (!existsSync(file) || statSync(file).size < max) return undefined;
  const to = file.replace(/\.jsonl$/, `-${at.toISOString().replace(/[:.]/g, "-")}.jsonl`);
  renameSync(file, to);
  return to;
}

export function readMeter(file: string): (MeterCall | AgentLog)[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export type Roll = { calls: number; usd: number; agentUsd: number; in: number; cacheRead: number; write5m: number; write1h: number; out: number; thinking: number; thoughtShare: number; coldShare: number };

/** Totals per key, e.g. rollup(lines, (l) => l.role) or (l) => l.run. Only upstream calls count as calls (not followers, replays or scans). */
export function rollup(lines: (MeterCall | AgentLog)[], key: (l: MeterCall | AgentLog) => string): Record<string, Roll> {
  const out: Record<string, Roll & { thought: number; cold: number; product: number }> = {};
  for (const l of lines) {
    const r = (out[key(l)] ??= { calls: 0, usd: 0, agentUsd: 0, in: 0, cacheRead: 0, write5m: 0, write1h: 0, out: 0, thinking: 0, thoughtShare: 0, coldShare: 0, thought: 0, cold: 0, product: 0 });
    if ("agent" in l) {
      r.agentUsd += l.totalCostUsd;
      r.usd += l.totalCostUsd;
      continue;
    }
    if (l.mode !== "live" || l.shared === "follower") continue;
    r.calls++;
    r.usd += l.listUsd;
    r.in += l.inTokens;
    r.cacheRead += l.cacheRead;
    r.write5m += l.cacheWrite5m;
    r.write1h += l.cacheWrite1h;
    r.out += l.outTokens;
    r.thinking += l.thinkingTokens;
    if (l.thinkingTokens > 0) r.thought++;
    if (l.arm) {
      r.product++;
      if (!l.readyAtTake) r.cold++;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, { thought, cold, product, ...r }]) => [k, { ...r, thoughtShare: r.calls ? thought / r.calls : 0, coldShare: product ? cold / product : 0 }]));
}
