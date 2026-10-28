// Intake (evals/real/README.md): testers' new sends taken from the last pull to cards the owner can look at, between
// the loop's epochs (coordinator.ts' between) or, while the loop isn't meant to run, by `rte intake` from its timer.
// In order: ingest and splits (0 calls); images of new sends (Chrome, 0 calls); triage of each settled session and gold
// (Opus, every call behind the budget's gate, which pauses and never caps); gold's images; then each new tune card's
// bank case, with its before image, an expectation the judge drafts where gold drew none, and its replay on the
// champion (the product's calls), which opens its look window. Last, always: the owner's verdicts and the window applied
// to the bank, and R1 frozen again when it changed. A stage that fails is said and tried again next pass; a week spent
// (or a stop asked for while a call waited) ends the paid stages, never the last. Steps that open Chrome run only here,
// where no measurement runs beside them. Logs get keys and counts only: an error's own text, which can quote a tester,
// goes to real/logs/intake.log.
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expectationFor } from "../judge/judge.ts";
import { StopAsked, WeekSpent, budgetGate } from "../loop/ab.ts";
import type { Page } from "../loop/chrome.ts";
import { commitHistory } from "../loop/history.ts";
import { pageShot } from "../loop/human.ts";
import { readRows } from "../loop/metrics.ts";
import { paths } from "../loop/paths.ts";
import { caseDir } from "../loop/record.ts";
import { type Rte, championArm } from "../loop/rte.ts";
import { stampNow } from "../loop/state.ts";
import { recordOnChampion } from "../loop/commands/setup.ts";
import { admit, assignSplits, cards, freezeR1, makeBankKey, openHoldCards, recorded, reviews, shootCase, splits, undrafted, unrecorded, writeProposals } from "./cases.ts";
import { type IntakePass, TRIAGE_SETTLE_MS, chosen, goldSend, ingestAll, maybe, passFile, put, realHome, realShot, rebuildGold, regoldFile, renderSession, rendered, shootGold, triageSession, unshotGold, wantGold } from "./real.ts";

/** Opus calls in flight at once in triage and gold (the gateway runs eval roles 6 at a time). */
const PARALLEL = 4;
async function pool<T>(items: T[], f: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}


/** An error's text where testers' data is (real/logs/, this user's only), and a line for the public log that points at it. */
function privately(what: string, err: unknown): string {
  const dir = join(realHome(), "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "intake.log"), `${new Date().toISOString()} ${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`, { mode: 0o600 });
  return `${what} (real/logs/intake.log has why)`;
}
/** What ends the paid stages: every token past its week, or the owner's stop during a budget pause. */
const budgetEnd = (err: unknown): err is WeekSpent | StopAsked => err instanceof WeekSpent || err instanceof StopAsked;

/**
 * One pass of intake on the gateway `gw` (the loop's, or rte intake's own), under the loop's lock. Returns the failures,
 * each said and tried again next pass. The budget's end is thrown on, after the pass's last, free stages ran.
 */
export async function intake(rte: Rte, gw: string, o: { regold?: boolean } = {}): Promise<number> {
  const say = (l: string) => rte.say(`intake: ${l}`);
  try {
    return await pass(rte, gw, say, o);
  } catch (err) {
    if (budgetEnd(err)) throw err;
    throw new Error(privately("the pass failed", err));
  }
}

async function pass(rte: Rte, gw: string, say: (l: string) => void, o: { regold?: boolean }): Promise<number> {
  const stamp = stampNow();
  const gate = () => budgetGate(gw, `real-intake-${stamp}`);
  let failed = 0;
  let ended: WeekSpent | StopAsked | undefined;
  const fail = (what: string, err: unknown) => (failed++, say(privately(`${what} failed`, err)));
  /** A stage of the pass: its failure is said and left to the next pass; once the budget ended it, paid stages are skipped. */
  const stage = async (what: string, paid: boolean, f: () => Promise<unknown>) => {
    if (paid && ended) return;
    try {
      await f();
    } catch (err) {
      if (budgetEnd(err)) ended ??= err;
      else fail(what, err);
    }
  };
  const each = <T>(what: (x: T) => string, items: T[], f: (x: T) => Promise<unknown>) =>
    pool(items, async (x) => {
      if (ended) return;
      try {
        await f(x);
      } catch (err) {
        if (budgetEnd(err)) ended ??= err;
        else fail(what(x), err);
      }
    });

  for (const r of ingestAll()) say(`${r.source}: ${r.sessions} sessions, ${r.sends} sends`);
  makeBankKey();
  const placed = assignSplits();
  if (placed.length) {
    const sp = splits();
    say(`${placed.length} new people: ${placed.filter((p) => sp[p] === "tune").length} tune, ${placed.filter((p) => sp[p] === "hold").length} R-hold`);
  }
  const champ = championArm();
  const onBridge = <T>(f: (page: Page) => Promise<T>) => rte.withRig(gw, [champ.tree], async (rig) => f((await rig.tab(0, "A", champ.tree)).page), 1);
  const regold = !!o.regold || (existsSync(regoldFile()) && (rmSync(regoldFile()), true));

  await stage("images of new sends", false, async () => {
    const unrendered = chosen().filter((l) => !rendered(l));
    if (unrendered.length) await onBridge(async (page) => {
      let n = 0;
      for (const l of unrendered) n += await renderSession(l, realShot(page), (key, err) => fail(`the images of ${key}`, err));
      say(`${n} images of new sends`);
    });
  });

  await stage("triage", true, async () => {
    // A session is judged once it settled: what the person did next is the best evidence, and a send is judged once.
    const settled = (at: string) => Date.now() - Date.parse(at) >= TRIAGE_SETTLE_MS;
    const pulled = cards().filter((c) => c.state === "pulled" && settled(c.ss.s.sends.at(-1)!.at));
    const bySession = [...new Map(pulled.map((c) => [c.ss.s.id, c.ss])).values()];
    if (!bySession.length) return;
    const run = `real-triage-${stamp}`;
    let judged = 0;
    await each((l) => `triage of ${l.s.id}`, bySession, async (l) => {
      const n = await triageSession(l, pulled.filter((c) => c.ss === l).map((c) => c.key), run, gate);
      judged += n;
    });
    say(`triage: ${judged} of ${pulled.length} new sends judged (${run})`);
  });

  await stage("gold", true, async () => {
    const judged = new Set([...reviews()].filter(([, r]) => r.verdict).map(([k]) => k));
    const todo = wantGold({ regold, judged });
    if (!todo.length) return;
    const run = `real-gold-${stamp}`;
    let ok = 0;
    await each((c) => `gold for ${c.x.key}`, todo, async (c) => {
      const g = await goldSend(c, run, gate);
      if (g.error) say(privately(`gold for ${c.x.key} unreadable (try ${g.attempts})`, g.error));
      else ok++;
    });
    say(`gold: ${ok} of ${todo.length} drawn (${run})`);
  });

  await stage("gold's images", false, async () => {
    const rebuilt = rebuildGold();
    if (rebuilt) say(`gold: ${rebuilt} boards rebuilt by today's gold.ts`);
    if (unshotGold().length) await onBridge(async (page) => say(`gold: ${await shootGold(realShot(page), (key, err) => fail(`gold's image for ${key}`, err))} images`));
    const opened = openHoldCards();
    if (opened) say(`${opened} R-hold cards proposed`);
  });

  await stage("proposals", false, async () => {
    const ids = writeProposals();
    if (!ids.length) return;
    const unshot = ids.filter((id) => !existsSync(join(paths().bankCase(id), "before-ink.jpg")));
    if (unshot.length) await onBridge(async (page) => {
      for (const id of unshot) await shootCase(id, pageShot(page)).catch((err) => fail(`the before image of ${id}`, err));
    });
    if (ended) return;
    const run = `real-expect-${stamp}`;
    const drafts = ids.filter((id) => existsSync(join(paths().bankCase(id), "before-ink.jpg")) && !existsSync(join(paths().bankCase(id), "expectation.json")));
    await each((id) => `the expectation for ${id}`, drafts, async (id) => {
      await gate();
      await expectationFor(id, run).catch((err) => {
        if (!budgetEnd(err)) undrafted(id);
        throw err;
      });
    });
    if (ended) return;
    const ready = ids.filter((id) => existsSync(join(paths().bankCase(id), "expectation.json")));
    // One run per champion: a run cut short resumes where it stopped, the cases it finished already recorded. A replay
    // that came back void or lost is sent again, so each pass is one real try at it (RECORD_TRIES).
    const rec = `real-bank-${champ.sha.slice(0, 12)}`;
    for (const r of readRows(rec)) if (ready.includes(r.case) && (r.void || r.lost)) rmSync(caseDir(rec, r.case), { recursive: true, force: true });
    const done = new Set(await recordOnChampion(rte, gw, ready, rec, (id) => recorded(id, rec, champ.sha)));
    for (const id of ready.filter((x) => !done.has(x))) unrecorded(id);
    say(`${done.size} of ${ready.length} new cases replayed on ${champ.sha.slice(0, 12)} and proposed (${rec})`);
  });

  // Always, at 0 calls: the owner's word and the look window on the bank, and R1.
  await stage("admission", false, async () => {
    const a = admit();
    if (a.admitted || a.retired) say(`bank: ${a.admitted} cases admitted, ${a.retired} retired by the owner's rejection`);
    const r1 = freezeR1();
    if (r1) {
      commitHistory(`R1: ${r1.cases} cases (${r1.tune} tune, ${r1.hold} R-hold), ${r1.hash.slice(0, 12)}`);
      say(`R1: ${r1.cases} cases (${r1.tune} tune from ${r1.people.tune} people, ${r1.hold} R-hold from ${r1.people.hold}), hash ${r1.hash.slice(0, 12)}`);
    }
  });
  const all = cards();
  say(`cards: ${(["pulled", "labeled", "proposed", "admitted", "rejected", "skipped"] as const).map((s) => `${all.filter((c) => c.state === s).length} ${s}`).join(", ")}${failed ? `; ${failed} failed, tried again next pass` : ""}`);
  const last = maybe<IntakePass>(passFile());
  put(passFile(), { at: new Date().toISOString(), failed, failedPasses: failed ? (last?.failedPasses ?? 0) + 1 : 0, ...(ended ? { ended: ended instanceof WeekSpent ? "week" : "stop" } : {}) } satisfies IntakePass);
  if (ended) throw ended;
  return failed;
}
