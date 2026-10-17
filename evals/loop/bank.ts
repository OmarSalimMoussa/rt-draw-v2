// The bank (spec §2.1, §2.3, §3.2): fork points recorded once from live driver sessions on the
// champion and reused by every decision, so a decision pays for no driver. Built once (tuning,
// H-gate, H-chart; first-timers first, so the pages they build exist as the site:<target> starts
// of the held-out explorers and breakers), refreshed every 5 keeps or weekly (40 fresh cases in,
// the 40 oldest tuning cases to bank/archive/, never deleted), and topped up by the fork sends of
// a decision that ran short. A bank that fails a §2.3 gate is refused: run.ts stops and names it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type GateCase, HELDOUT_CHART, HELDOUT_GATE, type Scenario, TUNING, fresh, gates } from "../core/scenarios.ts";
import { missingStarts, savedIn } from "../fixtures/fixtures.ts";
import { writeMissDigest } from "../optimizer/digest.ts";
import { LOOP } from "./config.ts";
import { type DriveCtx, type Pages, type Session, driveSession } from "./drive.ts";
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

/** The first bank (§11 step 3): every set's sessions on the champion, first-timers of every set first, then the §2.3 gates. */
export async function buildBank(ctx: DriveCtx, slots: Pages[], o: { bank: string; sets: BankSet[] }): Promise<BankResult> {
  const list = o.sets.flatMap(({ set, sessions }) => (typeof sessions === "number" ? (LISTS[set] ?? []).slice(0, sessions) : sessions));
  const ordered = [...list.filter((s) => s.persona === "first-timer"), ...list.filter((s) => s.persona !== "first-timer")].map((s, i) => ({ s, n: i + 1 }));
  // Two phases: no held-out explorer starts before every first-timer has saved its page.
  const cases = await runSessions(ctx, slots, o.bank, ordered.filter((x) => x.s.persona === "first-timer"));
  cases.push(...(await runSessions(ctx, slots, o.bank, ordered.filter((x) => x.s.persona !== "first-timer"))));
  return judged(ctx, { cases, fails: bankGates().fails }, { bank: o.bank });
}

/**
 * A refresh (§1.5): 8 fresh sessions × 5 sends on the champion. The 40 oldest tuning cases retire to bank/archive/,
 * unless the refreshed bank fails a gate: then the new cases go there instead and the bank stays as it was.
 */
export async function refresh(ctx: DriveCtx, slots: Pages[], n: number): Promise<BankResult & { retired: string[] }> {
  const list = fresh(n);
  const missing = missingStarts(list.map((s) => s.start), savedIn(paths().resume));
  if (missing.length) throw new Error(`refresh ${n}: no saved page for ${missing.join(", ")} (the bank build saves them)`);
  const oldest = gateCases().filter((c) => !c.void && (c.set === "tuning" || c.set === "fresh")).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map((c) => c.id);
  const cases = await runSessions(ctx, slots, `f${n}`, list.map((s, i) => ({ s, n: i + 1 })));
  const old = new Set(oldest.slice(0, LOOP.bank.refreshCases));
  const fails = gates(gateCases().filter((c) => !old.has(c.id)));
  // Refused: every case dir of this refresh goes, voided ones too, so they can't count against the bank that stays.
  const retired = fails.length ? readdirSync(paths().bankCases).filter((d) => d.startsWith(`c-f${n}-`)) : [...old];
  mkdirSync(paths().bankArchive, { recursive: true });
  for (const id of retired) renameSync(paths().bankCase(id), join(paths().bankArchive, id));
  return { ...judged(ctx, { cases, fails }, { refresh: n, kept: fails.length ? "old" : "new" }), retired };
}

/**
 * Top-ups (§1.3): live fork sends on the champion, each forked to both arms and continuing on A, every fork point
 * deposited as a new tuning case. `k` numbers the decision's top-ups (fresh seeds each time). Returns the fork cases
 * written to ctx.run (voided ones as *.void there), for ab.ts to judge the affected ones.
 */
export async function topUp(ctx: DriveCtx, pages: Pages, n: number, k: number): Promise<string[]> {
  const out: string[] = [];
  const list = [...fresh(TOPUP_BASE + 2 * k), ...fresh(TOPUP_BASE + 2 * k + 1)];
  for (const [i, s] of list.entries()) {
    if (out.length >= Math.min(n, LOOP.topUpMaxSends)) break;
    const r = await driveSession(ctx, s, pages, { bank: `u${k}`, session: i + 1, fork: true, continueOn: "A", deposit: true, maxSends: Math.min(n, LOOP.topUpMaxSends) - out.length });
    out.push(...r.cases);
  }
  return out;
}

/** bank/gates.json and the champion-miss digest (§8.2), after every build and refresh. */
function judged(ctx: DriveCtx, r: BankResult, about: Record<string, unknown>): BankResult {
  put(join(paths().home, "bank", "gates.json"), { at: new Date().toISOString(), ...about, cases: gateCases().length, ok: !r.fails.length, fails: r.fails });
  if (ctx.arms.A?.sha) writeMissDigest(ctx.arms.A.sha);
  return r;
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
