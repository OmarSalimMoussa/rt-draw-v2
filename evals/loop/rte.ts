// The command line every rte command runs under (run.ts parses it): its flags as an Rte, which carries the helpers that
// read them (the log, the cap, the tokens, the gateway, the rig, the canned agents of checks), passed to each command and
// to what it calls. Below it, the helpers every command shares, which read no flag: git, the champion, the bank.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as agents from "../optimizer/agents.ts";
import { type ArmSpec, type Judge, type Rig, benchCases, openRig } from "./ab.ts";
import { bankRefuses } from "./bank.ts";
import type { Page } from "./chrome.ts";
import { spawnGateway } from "./client.ts";
import type { Pages } from "./drive.ts";
import { LOOP } from "./config.ts";
import { closedPort } from "./gateway.ts";
import { historyRows } from "./history.ts";
import type { Machine } from "./load.ts";
import { paths } from "./paths.ts";
import { ARM_PORT } from "./servers.ts";
import { lock } from "./state.ts";
import { entryOrder, seedOf } from "./stats.ts";
import { type Token, loadDevToken, loadTokens } from "./tokens.ts";
import { treeOf } from "./trees.ts";
import type { CaseInfo, HypothesisCard } from "./types.ts";

export const CO_AUTHOR = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ---- The command line

export type Opts = { cmd: string; pos: string[]; f: Record<string, string | true>; cap?: number; tokens?: string; devToken?: true | string; mockApi?: string; port: number };

export function parse(argv: string[]): Opts {
  const pos: string[] = [];
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) pos.push(argv[i]);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) f[argv[i].slice(2)] = argv[++i];
    else f[argv[i].slice(2)] = true;
  }
  const cap = typeof f.cap === "string" ? Number(f.cap) : undefined;
  if (f.cap !== undefined && !(Number.isInteger(cap) && cap! >= 0)) throw new Error(`--cap takes a whole number of calls`);
  return { cmd: pos[0] ?? "", pos, f, cap, tokens: typeof f.tokens === "string" ? f.tokens : undefined, devToken: f["dev-token"], mockApi: typeof f["mock-api"] === "string" ? f["mock-api"] : undefined, port: Number(f.port ?? ARM_PORT) };
}

/** Checks' canned critic, engineer, analyst and judge (--fakes <module>). */
export type Fakes = Partial<Pick<typeof agents, "analyst" | "critic" | "engineer">> & { judge?: (run: string, card: HypothesisCard) => Judge | undefined };

/** One command's flags and what reads them. */
export class Rte {
  readonly o: Opts;
  fakes: Fakes = {};
  /** Machine suspends the heartbeat saw (V10): a decision in flight through one is void. */
  readonly suspends: number[] = [];
  private tokenCache?: Token[];
  constructor(o: Opts) {
    this.o = o;
  }

  /** The same command line with other positionals or cap (rte real update's steps), its fakes and tokens kept. */
  with(o: Partial<Opts>): Rte {
    const r = new Rte({ ...this.o, ...o });
    r.fakes = this.fakes;
    r.tokenCache = this.tokenCache;
    return r;
  }

  str(k: string): string | undefined {
    return typeof this.o.f[k] === "string" ? (this.o.f[k] as string) : undefined;
  }
  num(k: string): number | undefined {
    return this.str(k) === undefined ? undefined : Number(this.str(k));
  }
  needCap(what = this.o.cmd) {
    if (this.o.cap === undefined) throw new Error(`${what} makes real model calls: it needs --cap n (the gateway refuses call n+1)`);
  }

  /** Every line also goes to $RT_EVAL_HOME/logs/: a closed terminal (launch.sh) loses only the piped copy. */
  say(line: string) {
    console.log(line);
    try {
      mkdirSync(paths().logs, { recursive: true });
      appendFileSync(join(paths().logs, `run-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${this.o.cmd}: ${line}\n`);
    } catch {
      // no valid home yet (status, a refusal): the terminal has it
    }
  }

  /** The loop's tokens in memory (1–3 from the tokens file, or --dev-token's one); never printed or written. */
  tokens(): Token[] {
    const o = this.o;
    return (this.tokenCache ??= o.devToken ? loadDevToken(o.cap, typeof o.devToken === "string" ? o.devToken : undefined) : loadTokens(o.tokens));
  }

  async withGateway<T>(f: (gw: string) => Promise<T>, zeroCall = false): Promise<T> {
    const o = this.o;
    const g = await spawnGateway(zeroCall ? { cap: 1, tokens: fakeTokens(), mockApi: "http://127.0.0.1:9" } : { cap: o.cap, tokens: o.tokens, devToken: o.devToken, mockApi: o.mockApi });
    try {
      return await f(g.url);
    } finally {
      await g.close();
    }
  }

  /** --mock-api for the agent sessions run here (the gateway sets up its own): nothing gets past the fake API. */
  async agentMock() {
    return this.o.mockApi ? { baseUrl: this.o.mockApi, deadProxyPort: await closedPort() } : undefined;
  }

  /** Arm servers and Chrome for `f`, under loop.lock (state.ts lock): they share ports and the bank with any other rig. */
  async withRig<T>(gw: string, trees: string[], f: (rig: Rig) => Promise<T>, slots = slotsHere()): Promise<T> {
    const held = await lock(this.o.cmd);
    try {
      const rig = await openRig({ trees, gateway: gw, slots, port: this.o.port });
      try {
        return await f(rig);
      } finally {
        await rig.close();
      }
    } finally {
      held.release();
    }
  }

  /** The loop's agents, or checks' canned ones. */
  engine() {
    return { analyst: this.fakes.analyst ?? agents.analyst, critic: this.fakes.critic ?? agents.critic, engineer: this.fakes.engineer ?? agents.engineer };
  }
}

// ---- Shared, reading no flag

export const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const js = JSON.stringify;
export const maybe = <T>(f: string): T | undefined => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);
export const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export function tryGit(dir: string, ...a: string[]): string | undefined {
  try {
    return git(dir, ...a);
  } catch {
    return undefined; // a non-zero exit is the answer
  }
}
/** The loop always commits as itself: the machine's identity (the owner's email) would land in cand/* commits and tried patches. */
export const IDENT = ["-c", "user.name=rt-eval loop", "-c", "user.email=rt-eval@localhost"];
export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, ...IDENT, "commit", "-q", "-m", message, "-m", CO_AUTHOR);
  return git(dir, "rev-parse", "HEAD");
}
export const isAncestor = (a: string, b: string) => tryGit(paths().repo, "merge-base", "--is-ancestor", a, b) !== undefined;
export const championSha = () => git(paths().repo, "rev-parse", "loop/champion");
export const championArm = (): ArmSpec => {
  const sha = championSha();
  return { sha, tree: treeOf(sha) };
};
export const initFrom = () => maybe<{ from: string }>(join(paths().home, "init.json"))?.from;
/** The branch init cloned (the owner's master; eval-build in a rehearsal): sync and init --refresh fetch it. */
export const upstream = () => maybe<{ branch?: string }>(join(paths().home, "init.json"))?.branch ?? "master";

/** Throwaway tokens for a gateway that must make no call: replay and scan only, cap 1, a dead API address. */
export function fakeTokens(): string {
  const f = join(paths().home, "meter", "zero-call-tokens.env");
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${[1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-zero-call-${n}-${randomBytes(8).toString("hex")}`).join("\n")}\n`, { mode: 0o600 });
  }
  return f;
}
export const slotsHere = () => maybe<Machine>(paths().machine)?.slots ?? 1;
/** Each case slot's champion page, for driver sessions. */
export const championPages = (rig: Rig, tree: string) => Promise.all(Array.from({ length: rig.slots }, async (_, k): Promise<Pages> => ({ A: (await rig.tab(k, "A", tree)).page })));
export const tuningIdOf = async (page: Page) => (await page.eval<{ tuningId: string }>("rtEval.health()")).tuningId;

/** Done, unvoided banked cases of these sets, by id. */
export function banked(sets: string[]): string[] {
  const p = paths();
  return [p.bankCases, p.realBank].flatMap((d) => (existsSync(d) ? readdirSync(d) : []))
    .filter((id) => !id.includes(".void") && existsSync(join(p.bankCase(id), "done")) && sets.includes(maybe<CaseInfo>(join(p.bankCase(id), "case.json"))!.set)).sort();
}
/** Cases in a seeded order that keeps each origin session together (as decisions enter them). */
export const ordered = (ids: string[], seed: string) => entryOrder(ids, (id) => maybe<CaseInfo>(join(paths().bankCase(id), "case.json"))!.originSession, seedOf(seed));
/**
 * What a decision's diffscan runs: every H-gate case, and every tuning case up to LOOP.bank.scanMax; past it a sample of
 * whole sessions seeded by the decision, a different one each time, so no case drops out for good.
 */
export const scanCases = (seed: string) => [...ordered(banked(["tuning", "fresh", "real"]), seed).slice(0, LOOP.bank.scanMax), ...banked(["heldout-gate"])].sort();

/** A bank that failed §2.3 is used by nothing after it (bench, checkpoints, calibration, decisions) until rebuilt or accepted. */
export function needBank() {
  const no = bankRefuses();
  if (no) throw new Error(no);
}
export const hasU1 = () => benchCases().some((c) => c.bench === "U1");
export const nextEpoch = () => Math.max(0, ...historyRows("epochs.jsonl").map((e) => e.epoch)) + 1;
