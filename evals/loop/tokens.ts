// The loop's subscription tokens and how much of each is spent (spec §6.6–6.7).
// Tokens come only from the owner's tokens file (never the environment: a
// systemd-run unit never sees the caller's variables anyway), stay in memory and
// reach a Claude process only through dev/claude.ts' childEnv(). Nothing here
// logs or writes a token: the slot state on disk holds slot numbers and numbers.
//
// Rotation: new work moves off a slot at the first of five-hour utilization (or,
// until the server reports it, list $ since the window start over the window's
// estimated size W) ≥ 0.90, an allowed_warning, a rejected event or a 429, or the
// slot's weekly allowance. Two slots reporting the same resetsAt are one account.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { RateLimit } from "../../dev/claude.ts";
import { LOOP, WEEK_CHECK } from "./config.ts";

export type SlotN = 1 | 2 | 3;
export type Token = { slot: SlotN; token: string };
/** --dev-token is for a capped smoke before the loop's own tokens exist. */
export const DEV_TOKEN_MAX_CAP = 60;
const FIVE_H = 5 * 3600_000;
const WEEK = 7 * 86400_000;

function inRepo(dir: string): boolean {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

/** RT_EVAL_TOKEN_1..3 from the tokens file, refused unless it is mode 600 and outside every repo. 1 to 3 tokens. */
export function loadTokens(file = join(homedir(), ".config/rt-eval/tokens.env"), warn: (s: string) => void = console.warn): Token[] {
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} must be chmod 600 (it is ${mode.toString(8)})`);
  if (inRepo(dirname(file))) throw new Error(`${file} is inside a git work tree: keep it outside every repo`);
  const vars = parseEnv(readFileSync(file, "utf8"));
  const tokens = ([1, 2, 3] as const).filter((n) => vars[`RT_EVAL_TOKEN_${n}`]).map((slot) => ({ slot, token: vars[`RT_EVAL_TOKEN_${slot}`]! }));
  if (!tokens.length) throw new Error(`${file} holds none of RT_EVAL_TOKEN_1..3`);
  if (tokens.length < 3) warn(`tokens: ${tokens.length} of 3 slots; rotation has only ${tokens.length === 1 ? "one account" : "two accounts"}`);
  return tokens;
}

/**
 * The token the owner's dev plugin uses (CLAUDE_CODE_OAUTH_TOKEN in his checkout's .env files,
 * in vite's order), read into memory only, as slot 1. Refused unless the step's cap is ≤ 60.
 */
export function loadDevToken(cap: number | undefined, dir = join(homedir(), "projects/rt-draw-v2")): Token[] {
  if (!(cap !== undefined && cap > 0 && cap <= DEV_TOKEN_MAX_CAP)) throw new Error(`--dev-token needs --cap ${DEV_TOKEN_MAX_CAP} or less`);
  let token: string | undefined;
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"])
    if (existsSync(join(dir, f))) token = parseEnv(readFileSync(join(dir, f), "utf8")).CLAUDE_CODE_OAUTH_TOKEN || token;
  if (!token) throw new Error(`no CLAUDE_CODE_OAUTH_TOKEN in ${dir}'s .env files`);
  return [{ slot: 1, token }];
}

/**
 * Jev's key (TYPESAFE_API_KEY), held like the tokens: from the tokens file (mode 600, outside every repo), or with
 * --dev-token from the owner's checkout's .env files. Undefined when there is none: Jev calls then fail, nothing else does.
 */
export function loadJevKey(o: { file?: string } | { dev: true; dir?: string }): string | undefined {
  if (!("dev" in o)) {
    const file = o.file ?? join(homedir(), ".config/rt-eval/tokens.env");
    if (!existsSync(file)) return undefined;
    if ((statSync(file).mode & 0o777) !== 0o600 || inRepo(dirname(file))) return undefined;
    return parseEnv(readFileSync(file, "utf8")).TYPESAFE_API_KEY || undefined;
  }
  const dir = o.dir ?? join(homedir(), "projects/rt-draw-v2");
  let key: string | undefined;
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"])
    if (existsSync(join(dir, f))) key = parseEnv(readFileSync(join(dir, f), "utf8")).TYPESAFE_API_KEY || key;
  return key;
}

type SlotState = {
  slot: SlotN;
  status?: string; fiveHour?: number; sevenDay?: number; /** unix seconds */ resetsAt?: number;
  /** when the server last sent sevenDay (ms) */
  sevenDayAt?: number;
  /** list $ since windowStart (ms), the window's $ size, and whether W came from an allowed_warning */
  windowStart?: number; usdWindow: number; W: number; calibrated: boolean;
  /** a 429 or rejected event, until the window resets */
  limited: boolean;
  /** list $ per hour (start ms) over the trailing week */
  hours: Record<string, number>;
};

/** Every slot's spend and limits; the slot new work goes to. Persisted to `file` (no tokens) so a restart keeps it. */
export class Slots {
  private s: SlotState[];
  current: SlotN;
  /** $ spent since this process started: the night cap's count. */
  nightUsd = 0;
  private file?: string;
  private now: () => number;
  constructor(slots: SlotN[], file?: string, now = () => Date.now()) {
    this.file = file;
    this.now = now;
    const saved: SlotState[] = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    this.s = slots.map((slot) => saved.find((x) => x.slot === slot) ?? { slot, usdWindow: 0, W: LOOP.windowUsdStart, calibrated: false, limited: false, hours: {} });
    this.current = slots[0];
    this.current = this.next() ?? slots[0];
  }

  private get(slot: SlotN) {
    const s = this.s.find((x) => x.slot === slot);
    if (!s) throw new Error(`no token in slot ${slot}`);
    return s;
  }

  /** After a call on `slot`: its list $, what the server said about the limits, and whether it was refused (429). */
  record(slot: SlotN, o: { usd: number; rateLimit?: RateLimit; limited?: boolean }) {
    const s = this.get(slot);
    const now = this.now();
    this.renew(s);
    s.windowStart ??= now;
    s.usdWindow += o.usd;
    this.nightUsd += o.usd;
    const hour = String(now - (now % 3600_000));
    s.hours[hour] = (s.hours[hour] ?? 0) + o.usd;
    for (const h of Object.keys(s.hours)) if (Number(h) < now - WEEK) delete s.hours[h];
    const r = o.rateLimit;
    if (r) {
      // The CLI sends allowed_warning at ≥ 90%: the first one tells this account's window size.
      if (r.status === "allowed_warning" && !s.calibrated && s.usdWindow > 0) Object.assign(s, { W: s.usdWindow / LOOP.rotateAt, calibrated: true });
      Object.assign(s, { status: r.status, fiveHour: r.fiveHour ?? s.fiveHour, sevenDay: r.sevenDay ?? s.sevenDay });
      if (r.sevenDay !== undefined) s.sevenDayAt = now;
      if (r.resetsAt) Object.assign(s, { resetsAt: r.resetsAt, windowStart: Math.min(s.windowStart, r.resetsAt * 1000 - FIVE_H) });
      if (r.status === "rejected") s.limited = true;
    }
    if (o.limited) s.limited = true;
    this.save();
  }

  /** A window that has reset starts over. */
  private renew(s: SlotState) {
    const now = this.now();
    const end = s.resetsAt ? s.resetsAt * 1000 : s.windowStart !== undefined ? s.windowStart + FIVE_H : undefined;
    if (end === undefined || now < end) return;
    Object.assign(s, { status: undefined, fiveHour: undefined, resetsAt: undefined, windowStart: undefined, usdWindow: 0, limited: false });
  }

  /** Five-hour use: the server's utilization, else the list-$ estimate. */
  use(slot: SlotN) {
    const s = this.get(slot);
    this.renew(s);
    return s.fiveHour ?? s.usdWindow / s.W;
  }

  private week(s: SlotState) {
    const usd7d = Object.values(s.hours).reduce((a, b) => a + b, 0);
    return s.sevenDay !== undefined ? s.sevenDay > LOOP.weekSevenDayMax : usd7d > LOOP.weekWindowsPerToken * s.W;
  }

  /** Slots parked for their week on no server reading, or one WEEK_CHECK.afterH hours old: a call on each reads it again. */
  stale(): SlotN[] {
    return this.s.filter((s) => this.week(s) && this.now() - (s.sevenDayAt ?? 0) >= WEEK_CHECK.afterH * 3600_000).map((s) => s.slot);
  }

  /** Why new work can't go to this slot now, or undefined when it can. */
  why(slot: SlotN): string | undefined {
    const s = this.get(slot);
    if (this.week(s)) return "weekly allowance";
    if (s.limited) return "rate limited";
    if (s.status === "allowed_warning") return "allowed_warning";
    if (this.use(slot) >= LOOP.rotateAt) return `five-hour use ${this.use(slot).toFixed(2)}`;
  }

  private next(): SlotN | undefined {
    const order = [...this.s.slice(this.s.findIndex((x) => x.slot === this.current)), ...this.s].map((x) => x.slot);
    return order.find((slot) => !this.why(slot));
  }

  /** At a case boundary (or before an eval call): move off a spent slot. Undefined when every slot is spent. */
  boundary(): SlotN | undefined {
    const n = this.next();
    if (n) this.current = n;
    return n;
  }

  /** Two slots with the same resetsAt (to the second) are one account. */
  sameAccount(): [SlotN, SlotN] | undefined {
    const known = this.s.filter((x) => x.resetsAt && x.resetsAt * 1000 > this.now());
    for (const a of known) for (const b of known) if (a.slot < b.slot && a.resetsAt === b.resetsAt) return [a.slot, b.slot];
  }

  /** What run.ts paces by: stop (weekly or night cap) or pause until the earliest reset. */
  pace(nightWindows: number = LOOP.nightWindows): { ok: true } | { ok: false; stop?: string; pauseUntil?: number } {
    const W = this.s.reduce((a, s) => a + s.W, 0) / this.s.length;
    if (this.nightUsd >= nightWindows * W) return { ok: false, stop: `night cap (${nightWindows} windows)` };
    if (this.s.every((s) => this.week(s))) return { ok: false, stop: "every slot past its weekly allowance" };
    if (this.s.every((s) => this.why(s.slot))) return { ok: false, pauseUntil: Math.min(...this.s.map((s) => (s.resetsAt ? s.resetsAt * 1000 : (s.windowStart ?? this.now()) + FIVE_H))) };
    return { ok: true };
  }

  /** Numbers only, for /status and budget.jsonl. */
  status() {
    return this.s.map((s) => ({ slot: s.slot, current: s.slot === this.current, use: this.use(s.slot), fiveHour: s.fiveHour, sevenDay: s.sevenDay, sevenDayAt: s.sevenDayAt, resetsAt: s.resetsAt, status: s.status, usdThisWindow: s.usdWindow, windowUsd: s.W, calibrated: s.calibrated, usd7d: Object.values(s.hours).reduce((a, b) => a + b, 0), why: this.why(s.slot) }));
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.s));
  }
}
