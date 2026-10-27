// The bank (spec §2.1, §2.3, §3.2): fork points recorded once from live driver sessions on the
// champion and reused by every decision, so a decision pays for no driver. Built once (tuning,
// H-gate, H-chart; first-timers first, so the pages they build exist as the site:<target> starts
// of the held-out explorers and breakers), refreshed every 5 keeps or weekly (40 fresh cases in,
// none out: a decision samples once there are too many, rte.ts scanCases), and topped up by the
// fork sends of a decision that ran short. A bank that fails a §2.3 gate is refused: run.ts stops
// and names it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type GateCase, HELDOUT_CHART, HELDOUT_GATE, type Scenario, TUNING, fresh, gates } from "../core/scenarios.ts";
import { missingStarts, savedIn } from "../fixtures/fixtures.ts";
import { writeMissDigest } from "../optimizer/digest.ts";
import { LOOP } from "./config.ts";
import { type DriveCtx, type Pages, type Session, driveSession, eachSlot } from "./drive.ts";
import { type Paths, paths } from "./paths.ts";
import { put, voidCase } from "./record.ts";
import type { CaseInfo, DriverRecord, Readings, SetId } from "./types.ts";

export type BankSet = { set: SetId; sessions: number | Scenario[] };
export type BankResult = { cases: string[]; fails: string[] };
const LISTS: Partial<Record<SetId, Scenario[]>> = { tuning: TUNING, "heldout-gate": HELDOUT_GATE, "heldout-chart": HELDOUT_CHART };
/** Top-up sessions take fresh() lists from here on, so their seeds never meet a refresh's. */
const TOPUP_BASE = 1000;

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? json<T>(file) : undefined);
const pad = (n: number) => String(n).padStart(2, "0");
const sessionMarker = (bank: string, n: number) => join(paths().home, "bank", "sessions", `${bank}-s${pad(n)}.json`);
/** A build's session numbers, fixed per scenario whatever sizes it asks for: a rerun with more sessions only adds the missing ones. */
const CANON = [...TUNING, ...HELDOUT_GATE, ...HELDOUT_CHART].map((s) => s.id);
const gatesFile = () => join(paths().home, "bank", "gates.json");
type GatesFile = { ok: boolean; fails: string[]; kept?: "old" | "new"; accepted?: string };

/**
 * Drives sessions over the slots, one per slot at a time. A session with its marker is done (a rerun skips it);
 * one a crash cut short starts over, its cases so far voided (renamed), never reused half-made.
 */
async function runSessions(ctx: DriveCtx, slots: Pages[], bank: string, todo: { s: Scenario; n: number }[]): Promise<string[]> {
  const queue = [...todo];
  const banked: string[] = [];
  await Promise.all(slots.map(async (pages) => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const marker = sessionMarker(bank, job.n);
      if (existsSync(marker)) {
        banked.push(...json<Session>(marker).banked);
        continue;
      }
      const prefix = `c-${bank}-s${pad(job.n)}-`;
      for (const d of existsSync(paths().bankCases) ? readdirSync(paths().bankCases) : []) if (d.startsWith(prefix) && !d.includes(".void")) voidCase(paths().bankCase(d), "its session restarted after a crash");
      const r = await driveSession(ctx, job.s, pages, { bank, session: job.n, deposit: true });
      put(marker, r);
      banked.push(...r.banked);
    }
  }));
  return banked;
}

/** A build's sessions as they run, first-timers of every set first, each with its number (a check's own scenarios, in no list, as they run). */
export function sessionsOf(sets: BankSet[]): { s: Scenario; n: number }[] {
  const list = sets.flatMap(({ set, sessions }) => (typeof sessions === "number" ? (LISTS[set] ?? []).slice(0, sessions) : sessions));
  return [...list.filter((s) => s.persona === "first-timer"), ...list.filter((s) => s.persona !== "first-timer")].map((s, i) => ({ s, n: CANON.indexOf(s.id) + 1 || i + 1 }));
}

/** The first bank (§11 step 3): every set's sessions on the champion, first-timers of every set first, then the §2.3 gates. */
export async function buildBank(ctx: DriveCtx, slots: Pages[], o: { bank: string; sets: BankSet[] }): Promise<BankResult> {
  const ordered = sessionsOf(o.sets);
  // Two phases: no held-out explorer starts before every first-timer has saved its page.
  const cases = await runSessions(ctx, slots, o.bank, ordered.filter((x) => x.s.persona === "first-timer"));
  cases.push(...(await runSessions(ctx, slots, o.bank, ordered.filter((x) => x.s.persona !== "first-timer"))));
  return judged(ctx, { cases, fails: bankGates().fails }, { bank: o.bank });
}

/**
 * A refresh (§1.5): 8 fresh sessions × 5 sends on the champion, added to the bank; no case retires. If the bank with
 * them fails a gate, they go to bank/archive/ instead and the bank stays as it was.
 */
export async function refresh(ctx: DriveCtx, slots: Pages[], n: number): Promise<BankResult & { refused: string[] }> {
  const list = fresh(n);
  const missing = missingStarts(list.map((s) => s.start), savedIn(paths().resume));
  if (missing.length) throw new Error(`refresh ${n}: no saved page for ${missing.join(", ")} (the bank build saves them)`);
  const cases = await runSessions(ctx, slots, `f${n}`, list.map((s, i) => ({ s, n: i + 1 })));
  const fails = gates(gateCases());
  // Refused: every case dir of this refresh goes, voided ones too, so they can't count against the bank that stays.
  const refused = fails.length ? readdirSync(paths().bankCases).filter((d) => d.startsWith(`c-f${n}-`)) : [];
  if (refused.length) mkdirSync(paths().bankArchive, { recursive: true });
  for (const id of refused) renameSync(paths().bankCase(id), join(paths().bankArchive, id));
  return { ...judged(ctx, { cases, fails }, { refresh: n, kept: fails.length ? "old" : "new" }), refused };
}

/**
 * Top-ups (§1.3): live fork sends on the champion, each forked to both arms and continuing on A, every fork point
 * deposited as a new tuning case. `k` numbers the decision's top-ups (fresh seeds each time). A session per slot, as a
 * bank build drives them (one slot alone made a decision's 48 top-ups ~16 min). Returns the fork cases written to
 * ctx.run (voided ones as *.void there) in session order, for ab.ts to judge the affected ones.
 */
export async function topUp(ctx: DriveCtx, slots: Pages[], n: number, k: number): Promise<string[]> {
  const list = [...fresh(TOPUP_BASE + 2 * k), ...fresh(TOPUP_BASE + 2 * k + 1)];
  const cases: string[][] = [];
  let left = Math.min(n, LOOP.topUpMaxSends), at = 0;
  await eachSlot(slots.length, (slot) => {
    if (left <= 0 || at >= list.length) return undefined;
    const i = at++, take = Math.min(left, list[i].sends);
    left -= take;
    return async () => {
      const r = await driveSession(ctx, list[i], slots[slot], { bank: `u${k}`, session: i + 1, fork: true, continueOn: "A", deposit: true, maxSends: take });
      cases[i] = r.cases;
      left += take - r.cases.length; // a session that ended early hands its sends on
    };
  });
  return cases.flat();
}

/** The next top-up's number: one past every top-up in the bank and its archive, so no two decisions' top-ups share case ids or seeds. */
export function nextTopUp(): number {
  const dirs = [paths().bankCases, paths().bankArchive].flatMap((d) => (existsSync(d) ? readdirSync(d) : []));
  return Math.max(-1, ...dirs.map((d) => Number(/^c-u(\d+)-/.exec(d)?.[1] ?? -1))) + 1;
}

/** bank/gates.json and the champion-miss digest (§8.2), after every build and refresh. */
function judged(ctx: DriveCtx, r: BankResult, about: Record<string, unknown>): BankResult {
  put(gatesFile(), { at: new Date().toISOString(), ...about, cases: gateCases().length, ok: !r.fails.length, fails: r.fails });
  if (ctx.arms.A?.sha) writeMissDigest(ctx.arms.A.sha);
  return r;
}

/** Why the bank may not be used: its build failed a §2.3 gate (a refused refresh keeps the old bank) and wasn't accepted. */
export function bankRefuses(): string | undefined {
  const g = maybe<GatesFile>(gatesFile());
  if (g && !g.ok && g.kept !== "old" && !g.accepted)
    return `the bank failed §2.3 (${g.fails.slice(0, 2).join("; ")}${g.fails.length > 2 ? "; …" : ""}): bank build again with more sessions (only the new ones run), or rte bank accept`;
}
/** The owner's word that a bank that failed a gate may be used (a rehearsal's small bank, or a gate he judges too strict). */
export function acceptBank(): string[] {
  const g = maybe<GatesFile>(gatesFile());
  if (!g || g.ok) throw new Error("no refused bank to accept");
  put(gatesFile(), { ...g, accepted: new Date().toISOString() });
  return g.fails;
}

type Banked = GateCase & { id: string; recordedAt: string };

/** Every case in the bank as the §2.3 gates read it from its files: done cases, and voided ones never redone. */
export function gateCases(p: Paths = paths()): Banked[] {
  const dirs = existsSync(p.bankCases) ? readdirSync(p.bankCases) : [];
  const done = new Set(dirs.filter((d) => existsSync(join(p.bankCases, d, "done"))));
  const seen = new Set<string>();
  const out: Banked[] = [];
  for (const d of dirs) {
    const id = d.replace(/\.void(\.\d+)?$/, "");
    const isVoid = d !== id;
    if ((isVoid ? done.has(id) : !done.has(d)) || seen.has(id)) continue;
    const at = (f: string) => join(p.bankCases, d, f);
    const info = maybe<CaseInfo>(at("case.json"));
    if (!info) continue;
    seen.add(id);
    const say = maybe<DriverRecord>(at("driver.json"))?.turn.steps.find((s): s is { say: string } => "say" in s);
    const r = maybe<Readings>(at("readings.json"));
    out.push({
      id, recordedAt: info.recordedAt, set: info.set, persona: info.persona, start: info.start, send: info.send, ask: info.ask, beat: info.beat, complied: info.beatDone,
      hedged: info.hedged, void: isVoid, opener: say?.say ?? "", askDone: info.askDone,
      // Target spread is about screens with something on them to point at.
      firstTarget: info.start === "blank" ? undefined : (r?.marks[0]?.targets[0] ?? r?.refs?.[0]?.ids[0]),
    });
  }
  return out;
}

/** The §2.3 gates over the bank as it is (none failed: it may be used). */
export const bankGates = (p: Paths = paths()) => ({ cases: gateCases(p).length, fails: gates(gateCases(p)) });
