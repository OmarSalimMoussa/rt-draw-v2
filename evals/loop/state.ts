// The coordinator's own state (spec §7.7): state.json (the epoch, its cards and how far each got, what the
// stop rules count), loop.lock (one loop at a time) and §6.7's stop and pause rules as one pure function, so
// each rule can be checked on a crafted condition. Cases keep no state here: every case is file-done (§3.3),
// and rerunning a run id carries on at its next undone case.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { LOOP } from "./config.ts";
import { paths } from "./paths.ts";
import type { DecisionClass, HypothesisCard } from "./types.ts";

export type CardState = {
  id: string; card: HypothesisCard; branch: string;
  status: "todo" | "built" | "done" | "dropped";
  /** The candidate commit once built. */
  cand?: string; verdict?: string;
  /** The run its decision was read from (the next analyst's digest). */
  run?: string;
};
/** A decision as the stop rules see it. */
export type Decided = { id: string; verdict: string; component: string; at: string; overrun?: boolean; v9?: boolean };
export type State = {
  epoch: number;
  /** The epoch's run-id prefix (2026-10-17T03-12): its runs are <stamp>-e<E>-h<n>-<stage>. */
  stamp: string;
  cards: CardState[];
  /** Seed cards not used yet: an epoch takes up to 3 from here before it asks the analyst and critic. */
  queue: HypothesisCard[];
  /** The last epoch this loop runs (--epochs), kept so --resume stops where the first start would have. */
  until?: number;
  keepsSinceCheckpoint: number; keepsSinceRefresh: number; refreshes: number;
  recent: Decided[];
  /** Components the dry-well rule paused, until the next checkpoint. */
  paused: string[];
  /** Why the loop won't run (a sync conflict, a broken bridge contract): cleared by a successful sync. */
  blocked?: string;
  refreshQueued?: string; lastRefresh?: string; lastOwnerStep?: string;
  /** Epochs in a row that decided nothing (§6.7's spin guard). */
  emptyEpochs?: number;
  /** The night cap counts list $ since this moment; a new night starts 24 h later. */
  nightStart: string;
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
  epoch, stamp: stampNow(), cards: [], queue: [], keepsSinceCheckpoint: 0, keepsSinceRefresh: 0, refreshes: 0, recent: [], paused: [], nightStart: new Date().toISOString(), lastRuns: [],
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

/** §6.2's measuring $ per case by class (D's continuation and top-up sends at a live fork send's): the overrun rule's yardstick. */
export const CASE_USD: Record<DecisionClass, number> = { N: 0, S: 0.059, R: 0.014, Q: 0.074, D: 0.089 };
export const RULES = { decisionMaxMin: 30, overrunsPerNight: 3, voidsInRow: 2, emptyEpochs: 2, revertsInRow: 6, componentRevertsInRow: 3, overloads: 3, overloadWindowMs: 600_000, recheckMs: 60_000 };
/** The ladder's slots §6's 30 minutes assume (the PGX's). */
const SLOTS_30MIN = 8;
/**
 * A decision is closed as void (harness suspect) past 2× its class's $ per measured case, counted without the candidate's
 * own calls (a retry storm raises that; a long legitimate path or a costly candidate doesn't), or past 30 min of
 * measuring at 8 slots (scaled for fewer).
 */
export const overrun = (cls: DecisionClass, usd: number, measured: number, minutes: number, slots: number) =>
  usd > LOOP.decisionOverrun * CASE_USD[cls] * Math.max(1, measured) || minutes > RULES.decisionMaxMin * Math.max(1, SLOTS_30MIN / slots);

export type Facts = {
  now: number;
  /** The gateway's pace (tokens.ts): a stop, or a pause until the earliest reset. */
  pace: { ok: boolean; stop?: string; pauseUntil?: number };
  nightUsd: number; nightCapUsd: number; nightStart: number;
  recent: Decided[];
  /** When the last checkpoint ran: a dry well counts only the decisions since (the checkpoint unpauses). */
  checkpointAt?: number;
  /** The last readiness passed (at the harness's tag, within a day); calibration's outcome. */
  ready?: boolean; calib?: string;
  /** What a step threw, if it threw. */
  error?: string;
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
  // Budget: the gateway's slots, and the night cap counted here (--night-windows).
  if (f.pace.stop) out.push({ do: "stop", why: `budget: ${f.pace.stop}` });
  if (f.nightUsd >= f.nightCapUsd) out.push({ do: "stop", why: `budget: the night cap is reached ($${f.nightUsd.toFixed(2)} of $${f.nightCapUsd.toFixed(2)})` });
  if (!f.pace.stop && f.pace.pauseUntil) out.push({ do: "pause", why: "every slot is past its five-hour 0.90", until: f.pace.pauseUntil });
  // Harness suspects.
  if (f.recent.filter((d) => d.overrun && Date.parse(d.at) >= f.nightStart).length >= RULES.overrunsPerNight) out.push({ do: "stop", why: `${RULES.overrunsPerNight} decisions overran their budget tonight (harness suspect)` });
  if (last(RULES.voidsInRow)?.every((d) => d.verdict === "void")) out.push({ do: "stop", why: `${RULES.voidsInRow} void decisions in a row` });
  if (f.recent.at(-1)?.v9) out.push({ do: "stop", why: `a V9 invariant tripped in ${f.recent.at(-1)!.id}` });
  if (f.ready === false) out.push({ do: "stop", why: "readiness failed or is stale: rte ready --stub --mock-api" });
  if (f.calib === "stop") out.push({ do: "stop", why: "calibration failed with both frozen prompt variants: the judge prompt is the owner's to change" });
  if (f.error && /call cap/.test(f.error)) out.push({ do: "stop", why: `the step's --cap is reached: ${f.error}` });
  if (f.error && /requested|\/api\/(tts|stt)/.test(f.error)) out.push({ do: "stop", why: `aborted: ${f.error}` });
  if (f.blocked) out.push({ do: "stop", why: `paused for the owner: ${f.blocked}` });
  if ((f.emptyEpochs ?? 0) >= RULES.emptyEpochs) out.push({ do: "stop", why: `${f.emptyEpochs} epochs in a row decided nothing: the critic's cards were missing or all dropped (paused, --quality-only, owner-only)` });
  // A dry well: the optimizer keeps proposing what doesn't work.
  const since = f.recent.filter((d) => Date.parse(d.at) >= (f.checkpointAt ?? 0));
  if (last(RULES.revertsInRow, since)?.every((d) => d.verdict === "revert")) out.push({ do: "owner", why: `dry well: ${RULES.revertsInRow} reverts in a row` });
  for (const c of new Set(since.map((d) => d.component)))
    if (last(RULES.componentRevertsInRow, since.filter((d) => d.component === c))?.every((d) => d.verdict === "revert"))
      out.push({ do: "skip", component: c, why: `dry well: ${RULES.componentRevertsInRow} reverts in a row on ${c}; paused until the next checkpoint` });
  // The machine.
  if (f.overloads.filter((t) => t > f.now - RULES.overloadWindowMs).length >= RULES.overloads) out.push({ do: "pause", why: `${RULES.overloads} overloaded calls within 10 min`, until: f.now + RULES.overloadWindowMs });
  if (f.diskGb < LOOP.diskPauseGb) out.push({ do: "pause", why: `free disk ${f.diskGb.toFixed(1)} GB < ${LOOP.diskPauseGb}`, until: f.now + RULES.recheckMs });
  if (f.diskGb < LOOP.diskOwnerGb) out.push({ do: "owner", why: `free disk ${f.diskGb.toFixed(1)} GB < ${LOOP.diskOwnerGb}${f.daysLeft !== undefined ? `, ~${f.daysLeft.toFixed(1)} days left at this pace` : ""}` });
  if (f.onAC === false) out.push({ do: "pause", why: "on battery: new cases wait for AC", until: f.now + RULES.recheckMs });
  return out;
}
