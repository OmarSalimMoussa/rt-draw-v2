// The coordinator's own state (spec §7.7): state.json (the epoch, its cards and how far each got, what the
// stop rules count, and what the loop is doing now), loop.lock (one command with arm servers at a time) and §6.7's
// stop and pause rules as one pure function, so each rule can be checked on a crafted condition. Cases keep no state
// here: every case is file-done (§3.3), and rerunning a run id carries on at its next undone case.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
/**
 * What the loop is doing, for the progress page's status strip, `rte status` and the owner's notices: written as it
 * changes. A stop's `code` says which rule stopped it (STOP_CODES); `why` is the harness's own words, never an error's
 * text (an error can quote a tester, and this reaches the page and the owner's mail).
 */
export type Run = { status: "running" | "paused" | "stopped"; at: string; phase?: string; why?: string; code?: StopCode; slot?: number; until?: string };
export type State = {
  epoch: number;
  run?: Run;
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

/** Who holds loop.lock: its process, host, start and command (`loop`, `ready`, `real`, …). */
export type Holder = { pid: number; host: string; start: string; cmd: string };
/** The lock's holder, whether it lives (always false for another host's: this host can't tell). */
export function holder(): (Holder & { live: boolean }) | undefined {
  const f = paths().lock;
  if (!existsSync(f)) return undefined;
  const h = JSON.parse(readFileSync(f, "utf8")) as Holder;
  return { ...h, live: h.host !== hostname() || alive(h.pid) };
}

let mine: { text: string; depth: number } | undefined;
const LOCK_POLL_MS = 10_000;
/**
 * loop.lock: one command at a time that starts arm servers and Chrome or changes the bank (the loop, readiness, the
 * real-use steps), since they share ports and the bank. Taken again inside the process that holds it, it nests. Held by
 * another live process: refused, or with `wait` (the loop's unit, which a running intake or readiness must not fail)
 * waited for. A dead holder's lock is stale and taken over; `stale` is true only when that holder was a loop, which the
 * caller then resumes (§7.7): another command's crash says nothing about the loop.
 */
export async function lock(cmd: string, o: { wait?: boolean; say?: (line: string) => void } = {}): Promise<{ stale: boolean; release(): void }> {
  if (mine) {
    mine.depth++;
    return { stale: false, release: () => void (mine && --mine.depth === 0 && free()) };
  }
  const f = paths().lock;
  mkdirSync(paths().home, { recursive: true });
  const text = JSON.stringify({ pid: process.pid, host: hostname(), start: new Date().toISOString(), cmd } satisfies Holder);
  let stale = false, said = false;
  for (;;) {
    try {
      writeFileSync(f, text, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const h = holder();
      if (!h) continue; // freed between the two reads
      if (!h.live) {
        unlinkSync(f);
        stale ||= h.cmd === "loop";
        continue;
      }
      const why = `${f} is held by ${h.cmd} (pid ${h.pid} on ${h.host}, since ${h.start})`;
      if (!o.wait || h.cmd === "loop") throw new Error(why);
      if (!said) o.say?.(`${cmd}: waiting: ${why}`), (said = true);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  mine = { text, depth: 1 };
  const free = () => {
    if (existsSync(f) && readFileSync(f, "utf8") === text) unlinkSync(f);
    mine = undefined;
  };
  return { stale, release: () => void (mine && --mine.depth === 0 && free()) };
}
/** Refuses while a live process holds the lock (`what` can't change under it); a dead holder's stale lock doesn't block. */
export function notLocked(what: string) {
  const h = holder();
  if (h?.live && mine === undefined) throw new Error(`${paths().lock} is held by ${h.cmd} (pid ${h.pid}): ${what} can't change under it`);
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
  /** The gateway's pace (tokens.ts): a pause until a token frees up, `week` when every token is past its week. */
  pace: Pace;
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
  /** The token slot new work goes to now. */
  slot?: number;
};
/** tokens.ts' pace, as the gateway serves it. */
export type Pace = { ok: true } | { ok: false; pauseUntil: number; week: boolean };
/**
 * Why the loop stopped: `asked` (rte stop-after) and `done` (its --epochs ran) are the owner's own; `crashed` is the unit's
 * (a step threw past its restarts); the rest are §6.7's stops, each the owner's to look at.
 */
export const STOP_CODES = ["asked", "done", "crashed", "voids", "v9", "ready", "calib", "cap", "aborted", "blocked", "empty"] as const;
export type StopCode = (typeof STOP_CODES)[number];
export type Action = { do: "stop" | "pause" | "owner" | "skip"; why: string; code?: StopCode; until?: number; component?: string };

/** Every rule of §6.7 that fires on these facts (none: carry on). Pauses carry the time to look again. */
export function rules(f: Facts): Action[] {
  const out: Action[] = [];
  const last = (n: number, xs: Decided[] = f.recent) => (xs.length >= n ? xs.slice(-n) : undefined);
  // Budget: the server's readings of every slot (tokens.ts). Never a stop: the loop goes on when a token frees up.
  if (!f.pace.ok) out.push({ do: "pause", why: f.pace.week ? `every token is past ${Math.round(LOOP.weekSevenDayMax * 100)}% of its week; its week is read again then` : `every token is past ${Math.round(LOOP.fiveHourPauseAt * 100)}% of its five-hour window`, until: f.pace.pauseUntil });
  // Harness suspects (an overrun is a void too).
  if (last(RULES.voidsInRow, f.recent.filter((d) => Date.parse(d.at) >= (f.ownerStepAt ?? 0)))?.every((d) => d.verdict === "void")) out.push({ do: "stop", code: "voids", why: `${RULES.voidsInRow} void decisions in a row` });
  if (f.recent.at(-1)?.v9) out.push({ do: "stop", code: "v9", why: `a V9 invariant tripped in ${f.recent.at(-1)!.id}` });
  if (f.ready === false) out.push({ do: "stop", code: "ready", why: "readiness failed or is stale: rte ready --stub --mock-api" });
  if (f.calib === "stop") out.push({ do: "stop", code: "calib", why: "calibration failed with both frozen prompt variants: the judge prompt is the owner's to change" });
  // §11 gates each step on the one before: no decision rests on a fidelity judge the owner's labels haven't passed.
  else if (!["pass", "pass-no-craft", "dry"].includes(f.calib ?? "")) out.push({ do: "stop", code: "calib", why: `the judge isn't calibrated (${f.calib ?? "never checked"}): label in Eval HQ's Judge view, then rte calib --check must pass` });
  if (f.capped) out.push({ do: "stop", code: "cap", why: "the step's --cap is reached" });
  if (f.error && /requested|\/api\/(tts|stt)/.test(f.error)) out.push({ do: "stop", code: "aborted", why: "a request the harness never makes was asked for (the log has which)" });
  if (f.blocked) out.push({ do: "stop", code: "blocked", why: `paused for the owner: ${f.blocked}` });
  if ((f.emptyEpochs ?? 0) >= RULES.emptyEpochs) out.push({ do: "stop", code: "empty", why: `${f.emptyEpochs} epochs in a row decided nothing: the critic's cards were missing or all dropped (paused, --quality-only, owner-only)` });
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
