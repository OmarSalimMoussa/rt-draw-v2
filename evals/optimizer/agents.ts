// The optimizer's model roles (spec §8.2). The analyst and the failure analyst are one
// gateway call each, no tools. The critic (read-only) and the engineer (edits src/core)
// are Agent SDK sessions run here, on the gateway's current token slot with the §7.3 env
// (5-minute cache, quiet, empty config dir), each capped in turns, minutes and list $ by
// the meter's prices and logged as one meter line, so no agent is ever invisible. v1's
// Opus coordinator re-read ~375k tokens a request (~$72); these are Sonnet on digests.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { type CanUseTool, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL_IDS, type MockApi, type RateLimit, childEnv } from "../../dev/claude.ts";
import { ask, gatewayStatus, recordSpend } from "../loop/client.ts";
import { listUsd, meterAgent } from "../loop/meter.ts";
import { paths } from "../loop/paths.ts";
import { put } from "../loop/record.ts";
import type { Token } from "../loop/tokens.ts";
import { worktreeOf } from "../loop/trees.ts";
import type { HypothesisCard } from "../loop/types.ts";
import { type CheckpointRef, DIGEST, championMisses, failureDigest } from "./digest.ts";
import { OVERUSE } from "./patterns.ts";
import { ANALYST_SYSTEM, CRITIC_SYSTEM, ENGINEER_SYSTEM, FAILURE_SYSTEM } from "./prompts.ts";

export type Caps = { turns: number; minutes: number; usd: number };
/** Frozen per-session caps (§8.2). */
export const CAPS = { critic: { turns: 20, minutes: 8, usd: 1.5 }, engineer: { turns: 40, minutes: 15, usd: 2.5 } } satisfies Record<string, Caps>;
const MODEL = MODEL_IDS.sonnet;
const TOOLS = { critic: ["Read", "Grep", "Glob"], engineer: ["Read", "Edit", "Write", "Grep", "Glob", "Bash"] };

/**
 * The engineer's whole Bash commands (never npx: with no local TypeScript it fetches the unrelated package
 * "tsc"). No "..", no absolute paths, no output files (tune.ts --out, git diff --output), no synthetic-ink tuning (--allow-synth).
 * tune.ts imports the engineer's own src/core: it runs under node's permission model, reading the worktree only, writing
 * nothing (evals/, the tokens file) and spawning nothing.
 */
export const BASH_ALLOW = [
  /^\.\/node_modules\/\.bin\/tsc --noEmit$/,
  /^node --permission --allow-fs-read=\. --import \.\/evals\/loop\/node-hooks\.mjs scripts\/tune\.ts(?!.*\.\.)( (?![-/])[\w./-]+| --parts [\w,]+)+$/,
  /^git (status|diff)(?!.*\.\.)( --(stat|short|name-only)| src\/core\/[\w./-]*)*$/,
];

/** Why a tool call is refused, or undefined when it may run. */
export type Rule = (tool: string, input: Record<string, unknown>) => string | undefined;

/** Paths resolve against cwd and must stay under root; edit adds Edit, Write for new files only, and BASH_ALLOW. */
export function toolRule(cwd: string, o: { root: string; edit: boolean }): Rule {
  const root = resolve(o.root);
  const inside = (p: unknown) => {
    if (typeof p !== "string" || !p) return false;
    const r = resolve(cwd, p);
    return (r === root || r.startsWith(root + sep)) && !basename(r).startsWith(".env");
  };
  const where = `only paths under ${root}`;
  return (tool, input) => {
    switch (tool) {
      case "Read":
        return inside(input.file_path) ? undefined : where;
      case "Grep":
      case "Glob":
        if (!inside(input.path)) return `${where}: pass path`;
        return tool === "Glob" && /^\/|(^|\/)\.\.(\/|$)/.test(String(input.pattern)) ? `a Glob pattern stays under its path` : undefined;
      case "Edit":
      case "Write": {
        if (!o.edit) return "read-only";
        if (!inside(input.file_path)) return where;
        if (resolve(cwd, String(input.file_path)).endsWith(`${sep}speech.ts`)) return "no voice in the loop";
        return tool === "Write" && existsSync(resolve(cwd, String(input.file_path))) ? "Write only makes new files: change existing ones with Edit" : undefined;
      }
      case "Bash": {
        const cmd = String(input.command ?? "").trim();
        if (!o.edit) return "read-only";
        return BASH_ALLOW.some((re) => re.test(cmd)) ? undefined : `not on the allowlist: ${BASH_ALLOW.map((re) => re.source).join(" | ")}`;
      }
      default:
        return `${tool} isn't available`;
    }
  };
}

export const canUseToolOf = (rule: Rule): CanUseTool => async (tool, input) => {
  const why = rule(tool, input);
  return why ? { behavior: "deny", message: why } : { behavior: "allow", updatedInput: input };
};
/** The engineer's canUseTool in a worktree: src/core only. */
export const engineerCanUseTool = (wt: string) => canUseToolOf(toolRule(wt, { root: join(wt, "src/core"), edit: true }));

/** The gateway's current token slot (or the next one not spent): agents rotate with the eval's calls. */
export async function slotToken(tokens: Token[], url?: string): Promise<Token> {
  const { slots } = (await gatewayStatus(url)) as { slots: { slot: number; current: boolean; why?: string }[] };
  const s = [...slots.filter((x) => x.current), ...slots.filter((x) => !x.current)].find((x) => !x.why && tokens.some((t) => t.slot === x.slot));
  if (!s) throw new Error("every token slot is spent: no agent session now");
  return tokens.find((t) => t.slot === s.slot)!;
}

export type AgentRun = { role: keyof typeof TOOLS; run: string; cwd: string; system: string; prompt: string; rule: Rule; caps: Caps; token: Token; mockApi?: MockApi };
export type AgentResult = { text: string; stop: "done" | "turns" | "minutes" | "usd" | "error"; error?: string; turns: number; minutes: number; usd: number; denied: string[] };

const NONE = { inTokens: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, outTokens: 0 };
/** A rate_limit_event's state, read as dev/claude.ts reads it for the gateway's calls (here: trees older than this harness lack an export). */
function rateLimitOf(i: Record<string, unknown>): RateLimit {
  const w = (i.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number } | undefined>;
  const own = (type: string) => (i.rateLimitType === type ? (i.utilization as number | undefined) : undefined);
  return { status: String(i.status), fiveHour: w.five_hour?.utilization ?? own("five_hour"), sevenDay: w.seven_day?.utilization ?? own("seven_day"), resetsAt: w.five_hour?.resetsAt ?? (i.resetsAt as number | undefined) };
}

/** One capped agent session; its meter line is written however it ends. */
export async function runAgent(a: AgentRun): Promise<AgentResult> {
  const p = paths();
  const t0 = Date.now();
  const r: AgentResult = { text: "", stop: "done", turns: 0, minutes: 0, usd: 0, denied: [] };
  const usage = { ...NONE };
  let rateLimit: RateLimit | undefined;
  const refuse = (tool: string, input: Record<string, unknown>) => {
    const why = a.rule(tool, input);
    if (why) r.denied.push(`${tool} ${JSON.stringify(input).slice(0, 160)}: ${why}`);
    return why;
  };
  const q = query({
    prompt: a.prompt,
    options: {
      model: MODEL, systemPrompt: a.system, tools: TOOLS[a.role], settingSources: [], persistSession: false, includePartialMessages: true, effort: "high",
      maxTurns: a.caps.turns, cwd: a.cwd, env: childEnv(a.token.token, { configDir: p.claudeConfig, model: MODEL, maxRetries: 2, mockApi: a.mockApi }),
      // "default": every ask reaches canUseTool (left unset, Claude Code may pick auto mode and its classifier calls).
      permissionMode: "default", canUseTool: canUseToolOf(a.rule),
      // Claude Code runs read-only tools and some Bash without asking: the hook sees every call.
      hooks: { PreToolUse: [{ hooks: [async (i) => {
        const why = i.hook_event_name === "PreToolUse" ? refuse(i.tool_name, i.tool_input as Record<string, unknown>) : undefined;
        return why ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } } : {};
      }] }] },
    },
  });
  // A cap stops the session where it is: interrupt() ends the turn at once (an abort or close() lets the
  // CLI run on through its ~2 s grace, more turns on a fast API), then close() ends the process.
  const end = (stop: AgentResult["stop"]) => {
    if (r.stop !== "done") return;
    r.stop = stop;
    void q.interrupt().catch(() => {}).finally(() => q.close());
    setTimeout(() => q.close(), 5000).unref();
  };
  const timer = setTimeout(() => end("minutes"), a.caps.minutes * 60_000);
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      // A turn's input is counted when it starts (a cut turn read its prompt too), its output when it ends.
      if (m.type === "stream_event" && (m.event.type === "message_start" || m.event.type === "message_delta")) {
        const u = m.event.type === "message_start" ? m.event.message.usage : undefined;
        const turn = u
          ? { inTokens: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0, cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, outTokens: 0 }
          : { ...NONE, outTokens: m.event.type === "message_delta" ? (m.event.usage?.output_tokens ?? 0) : 0 };
        if (u) r.turns++;
        for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += turn[k];
        r.usd += listUsd(MODEL, turn);
        if (r.usd >= a.caps.usd) end("usd");
      } else if (m.type === "rate_limit_event") {
        rateLimit = rateLimitOf(m.rate_limit_info as unknown as Record<string, unknown>);
      } else if (m.type === "result") {
        if (m.subtype === "success") r.text = m.result;
        else {
          if (r.stop === "done") r.stop = m.subtype === "error_max_turns" ? "turns" : "error";
          r.error ??= m.subtype;
        }
      }
    }
  } catch (err) {
    // The SDK throws after an error result too (the turn cap, an interrupt).
    if (r.stop === "done") {
      r.stop = "error";
      r.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
  }
  r.minutes = (Date.now() - t0) / 60_000;
  meterAgent(p.calls, { at: new Date().toISOString(), run: a.run, role: a.role, agent: true, model: MODEL, totalCostUsd: r.usd, usage, turns: r.turns, minutes: r.minutes, token: a.token.slot });
  // The slot's five-hour estimate and weekly allowance count this session too (no gateway: a check's agent, nothing to tell).
  await recordSpend({ slot: a.token.slot, usd: r.usd, rateLimit }).catch(() => {});
  return r;
}

/**
 * The first JSON value of a kind in a reply that parses and passes `ok`. Models wrap it in prose or fences, and the
 * prose has brackets of its own ("[ink 1]", "the cap [24]"): each opening bracket is tried in turn up to its matching close.
 */
export function jsonIn<T>(text: string, open: "[" | "{", ok: (v: unknown) => boolean = () => true): T | undefined {
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + 1)) {
    let depth = 0, str = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (str) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') str = false;
      } else if (ch === '"') str = true;
      else if (ch === "[" || ch === "{") depth++;
      else if ((ch === "]" || ch === "}") && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          if (ok(v)) return v as T;
        } catch {}
        break;
      }
    }
  }
  return undefined;
}

/** The analyst: one call, no tools, on the analyst digest (§8.2). */
export async function analyst(digest: string, run: string): Promise<string> {
  return (await ask({ role: "analyst", model: "sonnet", system: ANALYST_SYSTEM, user: digest, effort: "high", run })).text;
}

export type FailureNote = { case: string; component: string; evidence: string; tag: string };
/** The failure analyst on a digest of at most 12 cases. */
export async function failureAnalyst(digest: string, run: string): Promise<FailureNote[]> {
  const { text } = await ask({ role: "failure", model: "sonnet", system: FAILURE_SYSTEM, user: digest, effort: "medium", run });
  return jsonIn<FailureNote[]>(text, "[", objects) ?? [];
}

/** The failure analyst on the champion's worst misses, once per champion sha (reused until the champion moves). */
export async function championFailures(sha: string, run: string, checkpoint?: CheckpointRef): Promise<FailureNote[]> {
  const file = paths().digest(sha).replace(/\.md$/, ".failures.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const top = championMisses(checkpoint).misses.slice(0, DIGEST.failureCases).map((m) => ({ case: m.id }));
  const notes = top.length ? await failureAnalyst(failureDigest(top), run) : [];
  put(file, notes);
  return notes;
}

/** A non-empty array of objects: what a list of cards or notes is. */
const objects = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));

const KINDS = ["knob", "variant", "code", "op", "newknob"];
const GOALS = ["fidelity", "craft", "latency"];
/** What's wrong with a card the critic wrote, if anything. */
function cardFault(c: Partial<HypothesisCard>): string | undefined {
  for (const k of ["id", "component", "change", "predicts", "risk"] as const) if (typeof c[k] !== "string" || !c[k]) return `no ${k}`;
  if (!KINDS.includes(c.kind!)) return `kind ${c.kind}`;
  if (!GOALS.includes(c.goal!)) return `goal ${c.goal}`;
  if (!["S", "R", "Q", "D"].includes(c.classGuess!)) return `classGuess ${c.classGuess}`;
  for (const k of ["dialogue", "isPatch", "raisesCost", "touchesFrozen"] as const) if (typeof c[k] !== "boolean") return `no ${k}`;
  if (!Array.isArray(c.files)) return "no files";
  if (c.overuseDetector && !(c.overuseDetector in OVERUSE)) return `unknown detector ${c.overuseDetector}`;
  if (c.knobs && Object.values(c.knobs).some((v) => typeof v !== "number")) return "a knob value isn't a number";
  if (c.kind === "knob" && !Object.keys(c.knobs ?? {}).length) return "a knob card without knobs";
}

/** At most 3 well-formed cards, knob cards first; the rest with why they were dropped. */
export function readCards(text: string): { cards: HypothesisCard[]; dropped: string[] } {
  // A list of cards, else an empty list (no card worth running): never an array the prose quotes ("the cap [24]").
  const all = jsonIn<Partial<HypothesisCard>[]>(text, "[", objects) ?? jsonIn<[]>(text, "[", (v) => Array.isArray(v) && !v.length);
  if (!Array.isArray(all)) return { cards: [], dropped: ["no JSON array of cards in the critic's answer"] };
  const dropped = all.flatMap((c) => (cardFault(c) ? [`${c.id ?? "?"}: ${cardFault(c)}`] : []));
  const ok = all.filter((c) => !cardFault(c)) as HypothesisCard[];
  const cards = [...ok.filter((c) => c.kind === "knob"), ...ok.filter((c) => c.kind !== "knob")].slice(0, 3);
  return { cards, dropped: [...dropped, ...ok.filter((c) => !cards.includes(c)).map((c) => `${c.id}: over the 3-card limit`)] };
}

type Session = { run: string; token: Token; mockApi?: MockApi; caps?: Caps };

/** The critic: a read-only session in the champion's tree on the analyst's output, the digest and the tried index. */
export async function critic(o: Session & { analysis: string; digest: string; tried: string[]; tree: string }) {
  const prompt = `# The analyst's hypotheses\n${o.analysis}\n\n# The digest\n${o.digest}\n\n# Tried\n${o.tried.join("\n") || "none yet"}`;
  const result = await runAgent({ role: "critic", run: o.run, cwd: o.tree, system: CRITIC_SYSTEM, prompt, rule: toolRule(o.tree, { root: o.tree, edit: false }), caps: o.caps ?? CAPS.critic, token: o.token, mockApi: o.mockApi });
  return { ...readCards(result.text), result };
}

/** The engineer: one card's change in $RT_EVAL_HOME/wt/<branch> (made off loop/champion); the coordinator commits it. */
export async function engineer(o: Session & { card: HypothesisCard; branch: string }): Promise<AgentResult & { wt: string }> {
  const wt = worktreeOf(o.branch);
  const prompt = `The card:\n${JSON.stringify(o.card, null, 2)}\n\nIts files: ${o.card.files.join(", ") || "(none named)"}. Read them before you change them.`;
  const result = await runAgent({ role: "engineer", run: o.run, cwd: wt, system: ENGINEER_SYSTEM, prompt, rule: toolRule(wt, { root: join(wt, "src/core"), edit: true }), caps: o.caps ?? CAPS.engineer, token: o.token, mockApi: o.mockApi });
  return { ...result, wt };
}
