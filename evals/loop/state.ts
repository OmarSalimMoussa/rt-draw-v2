// The coordinator's own state (spec §7.7): state.json (the epoch, its cards and how far each got, what the
// stop rules count), loop.lock (one loop at a time) and §6.7's stop and pause rules as one pure function, so
// each rule can be checked on a crafted condition. Cases keep no state here: every case is file-done (§3.3),
// and rerunning a run id carries on at its next undone case.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { LOOP } from "./config.ts";
import { paths } from "./paths.ts";
import type { HypothesisCard } from "./types.ts";

export type CardState = {
  id: string; card: HypothesisCard; branch: string;
  status: "todo" | "built" | "done" | "dropped";
  /** The candidate commit once built. */
  cand?: string; verdict?: string;
  /** The run its decision was read from (the next analyst's digest). */
  run?: string;
  /** One value of a sweep card (LOOP-V2.md D3): the sweep's id, and the value's side of the champion's and distance from it. */
  sweep?: { of: string; side: number; distance: number };
};
/** A decision as the stop rules see it. */
export type Decided = { id: string; verdict: string; component: string; at: string; v9?: boolean;
  /** One value of this sweep (LOOP-V2.md D3): the dry well counts a sweep once. */
  sweep?: string };
export type State = {
  epoch: number;
  /** The epoch's run-id prefix (2026-10-17T03-12): its runs are <stamp>-e<E>-h<n>-<stage>. */
  stamp: string;
  cards: CardState[];
  /** Seed cards not used yet: an epoch takes up to LOOP.search.cards from here before it asks the analyst and critic. */
  queue: HypothesisCard[];
  /** The last epoch this loop runs (--epochs), kept so --resume stops where the first start would have. */
  until?: number;
  keepsSinceCheckpoint: number; keepsSinceRefresh: number; refreshes: number;
  recent: Decided[];
  /** Components the dry-well rule paused, until the next checkpoint or RULES.pauseEpochs epochs on. */
  paused: string[];
  /** The epoch each paused component paused in; when a pause ran out (the component's reverts count again from there). */
  pausedAt?: Record<string, number>; wellFrom?: Record<string, string>;
  /** Why the loop won't run (a sync conflict, a broken bridge contract): cleared by a successful sync. */
  blocked?: string;
  refreshQueued?: string; lastRefresh?: string; lastOwnerStep?: string;
  /** Epochs in a row that decided nothing (§6.7's spin guard). */
  emptyEpochs?: number;
  lastRuns: string[];
};

export function readState(): State | undefined {
  const f = paths().state;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
}
/** Rewritten in place (atomically): the state is a cursor, not a record. */
export function saveState(s: State) {
  const f = paths().state;
  writeFileSync(`${f}.tmp`, `${JSON.stringify(s, null, 1)}\n`);
  renameSync(`${f}.tmp`, f);
}
export const newState = (epoch: number): State => ({
  epoch, stamp: stampNow(), cards: [], queue: [], keepsSinceCheckpoint: 0, keepsSinceRefresh: 0, refreshes: 0, recent: [], paused: [], lastRuns: [],
});
export const stampNow = () => new Date().toISOString().slice(0, 16).replace(/:/g, "-");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * loop.lock ({pid, host, start}): refused while a live loop on this host holds it. A dead holder's lock is
 * stale: it is taken over and the caller resumes (§7.7).
 */
export function lock(): { stale: boolean; release(): void } {
  const f = paths().lock;
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), start: new Date().toISOString() });
  let stale = false;
  for (;;) {
    try {
      writeFileSync(f, mine, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = JSON.parse(readFileSync(f, "utf8")) as { pid: number; host: string; start: string };
      if (held.host !== hostname() || alive(held.pid)) throw new Error(`another loop holds ${f} (pid ${held.pid} on ${held.host}, since ${held.start})`);
      unlinkSync(f);
      stale = true;
    }
  }
  return { stale, release: () => existsSync(f) && readFileSync(f, "utf8") === mine && unlinkSync(f) };
}

// ---- §6.7's stop and pause rules

// The dry well scales with the search (LOOP-V2.md D1): two epochs' cards in a row reverted, or one epoch's on a component.
export const RULES = { decisionMaxMin: 45, voidsInRow: 2, emptyEpochs: 2, revertsInRow: 2 * LOOP.search.cards, componentRevertsInRow: LOOP.search.cards, pauseEpochs: 3, overloads: 3, overloadWindowMs: 600_000, recheckMs: 60_000 };
/** The ladder's slots §6's minutes assume (the PGX's). */
const SLOTS_30MIN = 8;
/**
 * A decision is closed as void (harness suspect) past RULES.decisionMaxMin of measuring at 8 slots (scaled for fewer): the
 * loop's wall-clock bound, as --cap is its calls'. (A $ bound per case fired twice in history, both times on accounting
 * bugs.) 30 min until Rule F's last look went from 80 cases to 160 (2026-10-27); the slowest 80-case run had taken 10.
 */
export const overrun = (minutes: number, slots: number) => minutes > RULES.decisionMaxMin * Math.max(1, SLOTS_30MIN / slots);

export type Facts = {
  now: number;
  /** The gateway's pace (tokens.ts): a stop, or a pause until the earliest reset. */
  pace: { ok: boolean; stop?: string; pauseUntil?: number };
  recent: Decided[];
  /** When the last checkpoint ran: a dry well counts only the decisions since (the checkpoint unpauses). */
  checkpointAt?: number;
  /** When a component's pause ran out: its dry well counts only the decisions since. */
  wellFrom?: Record<string, number>;
  /** When the owner last stepped in (a sync): voids before it were the owner's to fix, so they no longer count. */
  ownerStepAt?: number;
  /** The last readiness passed (at the harness's tag, within a day); calibration's outcome ("dry" on the fake API, whose judge is canned). */
  ready?: boolean; calib?: string;
  /** What a step threw, if it threw; `capped` when the gateway's --cap is reached. */
  error?: string; capped?: boolean;
  blocked?: string;
  emptyEpochs?: number;
  /** When product calls failed as overloaded (529). */
  overloads: number[];
  diskGb: number; daysLeft?: number; onAC?: boolean;
};
export type Action = { do: "stop" | "pause" | "owner" | "skip"; why: string; until?: number; component?: string };

/** Every rule of §6.7 that fires on these facts (none: carry on). Pauses carry the time to look again. */
export function rules(f: Facts): Action[] {
  const out: Action[] = [];
  const last = (n: number, xs: Decided[] = f.recent) => (xs.length >= n ? xs.slice(-n) : undefined);
  // Budget: the server's readings of every slot (tokens.ts).
  if (f.pace.stop) out.push({ do: "stop", why: `budget: ${f.pace.stop}` });
  if (!f.pace.stop && f.pace.pauseUntil) out.push({ do: "pause", why: `every slot is past ${Math.round(LOOP.fiveHourPauseAt * 100)}% of its five-hour window`, until: f.pace.pauseUntil });
  // Harness suspects (an overrun is a void too).
  if (last(RULES.voidsInRow, f.recent.filter((d) => Date.parse(d.at) >= (f.ownerStepAt ?? 0)))?.every((d) => d.verdict === "void")) out.push({ do: "stop", why: `${RULES.voidsInRow} void decisions in a row` });
  if (f.recent.at(-1)?.v9) out.push({ do: "stop", why: `a V9 invariant tripped in ${f.recent.at(-1)!.id}` });
  if (f.ready === false) out.push({ do: "stop", why: "readiness failed or is stale: rte ready --stub --mock-api" });
  if (f.calib === "stop") out.push({ do: "stop", why: "calibration failed with both frozen prompt variants: the judge prompt is the owner's to change" });
  // §11 gates each step on the one before: no decision rests on a fidelity judge the owner's labels haven't passed.
  else if (!["pass", "pass-no-craft", "dry"].includes(f.calib ?? "")) out.push({ do: "stop", why: `the judge isn't calibrated (${f.calib ?? "never checked"}): label at /evals/label/, then rte calib --check must pass` });
  if (f.capped) out.push({ do: "stop", why: `the step's --cap is reached${f.error ? `: ${f.error}` : ""}` });
  if (f.error && /requested|\/api\/(tts|stt)/.test(f.error)) out.push({ do: "stop", why: `aborted: ${f.error}` });
  if (f.blocked) out.push({ do: "stop", why: `paused for the owner: ${f.blocked}` });
  if ((f.emptyEpochs ?? 0) >= RULES.emptyEpochs) out.push({ do: "stop", why: `${f.emptyEpochs} epochs in a row decided nothing: the critic's cards were missing or all dropped (paused, --quality-only, owner-only)` });
  // A dry well: the optimizer keeps proposing what doesn't work. A sweep's values are one try: kept if any value kept.
  const since = f.recent.filter((d) => Date.parse(d.at) >= (f.checkpointAt ?? 0)).reduce<Decided[]>((acc, d) => {
    const prev = acc.at(-1);
    if (d.sweep && prev?.sweep === d.sweep) acc[acc.length - 1] = { ...d, verdict: prev.verdict === "keep" ? "keep" : d.verdict };
    else acc.push(d);
    return acc;
  }, []);
  if (last(RULES.revertsInRow, since)?.every((d) => d.verdict === "revert")) out.push({ do: "owner", why: `dry well: ${RULES.revertsInRow} reverts in a row` });
  for (const c of new Set(since.map((d) => d.component)))
    if (last(RULES.componentRevertsInRow, since.filter((d) => d.component === c && Date.parse(d.at) >= (f.wellFrom?.[c] ?? 0)))?.every((d) => d.verdict === "revert"))
      out.push({ do: "skip", component: c, why: `dry well: ${RULES.componentRevertsInRow} reverts in a row on ${c}; paused for ${RULES.pauseEpochs} epochs or until the next checkpoint` });
  // The machine.
  if (f.overloads.filter((t) => t > f.now - RULES.overloadWindowMs).length >= RULES.overloads) out.push({ do: "pause", why: `${RULES.overloads} overloaded calls within 10 min`, until: f.now + RULES.overloadWindowMs });
  if (f.diskGb < LOOP.diskPauseGb) out.push({ do: "pause", why: `free disk ${f.diskGb.toFixed(1)} GB < ${LOOP.diskPauseGb}`, until: f.now + RULES.recheckMs });
  if (f.diskGb < LOOP.diskOwnerGb) out.push({ do: "owner", why: `free disk ${f.diskGb.toFixed(1)} GB < ${LOOP.diskOwnerGb}${f.daysLeft !== undefined ? `, ~${f.daysLeft.toFixed(1)} days left at this pace` : ""}` });
  if (f.onAC === false) out.push({ do: "pause", why: "on battery: new cases wait for AC", until: f.now + RULES.recheckMs });
  return out;
}

/** What the owner's notices are read from: this leg (the loop since it last started or resumed). */
export type NoticeFacts = {
  now: number;
  leg: { start: number; usd: number; decisions: number; checkpoints: string[] };
  every: { decisions: number; minutes: number; usd: number; checkpoint: number; soon: number };
};
export type Notice = { key: string; kind: "soon" | "reached" | "checkpoint" | "stopped"; why: string };

/**
 * The owner's notices due on these facts and not yet `sent` (by key): a heads-up as each step of `every` comes near (its
 * `soon` share) and a notice when it's reached; one per checkpoint. None of them stops anything.
 */
export function notices(f: NoticeFacts, sent: Set<string>): Notice[] {
  const out: Notice[] = [];
  const add = (key: string, kind: Notice["kind"], why: string) => !sent.has(key) && !out.some((n) => n.key === key) && out.push({ key, kind, why });
  const steps = (name: string, value: number, step: number, unit: (x: number) => string, soon: boolean) => {
    if (!(step > 0)) return;
    const k = Math.floor(value / step);
    if (k >= 1) add(`${name}:${k}`, "reached", `${unit(value)} this leg (a notice every ${unit(step)})`);
    if (soon && value >= (k + f.every.soon) * step) add(`${name}:${k + 1}:soon`, "soon", `${unit(value)} this leg; ${unit((k + 1) * step)} soon`);
  };
  steps("usd", f.leg.usd, f.every.usd, (x) => `$${x.toFixed(2)} list`, true);
  steps("minutes", (f.now - f.leg.start) / 60_000, f.every.minutes, (x) => `${Math.round(x)} min`, true);
  steps("decisions", f.leg.decisions, f.every.decisions, (x) => `${x} decision${x === 1 ? "" : "s"}`, false);
  if (f.every.checkpoint > 0) for (const id of f.leg.checkpoints) add(`checkpoint:${id}`, "checkpoint", `checkpoint ${id} ran`);
  return out;
}
