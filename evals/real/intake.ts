// Intake (evals/real/README.md): testers' new sends taken from the last pull to cards the owner can look at, between
// the loop's epochs (coordinator.ts' between) or, while the loop isn't meant to run, by `rte intake` from its timer.
// In order: ingest and splits (0 calls); images of new sends (Chrome, 0 calls); triage and gold (Opus, every call behind
// the budget's gate, which pauses and never caps); gold's images; then each new tune card's bank case, with its before
// image, an expectation the judge drafts where gold drew none, and its replay on the champion (the product's calls),
// which opens its look window. Last, the owner's verdicts and the window applied to the bank, and R1 frozen again when it
// changed. Steps that open Chrome run only here, where no measurement runs beside them. Logs get keys and counts only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expectationFor } from "../judge/judge.ts";
import { budgetGate, WeekSpent } from "../loop/ab.ts";
import type { Page } from "../loop/chrome.ts";
import { commitHistory } from "../loop/history.ts";
import { pageShot } from "../loop/human.ts";
import { paths } from "../loop/paths.ts";
import { type Rte, championArm, msg } from "../loop/rte.ts";
import { stampNow } from "../loop/state.ts";
import { recordOnChampion } from "../loop/commands/setup.ts";
import { admit, assignSplits, cards, freezeR1, makeBankKey, openHoldCards, recorded, reviews, shootCase, splits, unrecorded, writeProposals } from "./cases.ts";
import { chosen, goldSend, ingestAll, realShot, rebuildGold, renderSession, rendered, shootGold, triageSession, unshotGold, wantGold } from "./real.ts";

/** Opus calls in flight at once in triage and gold (the gateway runs eval roles 6 at a time). */
const PARALLEL = 4;
async function pool<T>(items: T[], f: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}

/**
 * One pass of intake on the gateway `gw` (the loop's, or rte intake's own), under the loop's lock. A week spent ends it
 * (WeekSpent, thrown on): what it paid for is kept and cached. Any other failure of one session or send is said and
 * skipped, to be tried again next pass. Returns the failures.
 */
export async function intake(rte: Rte, gw: string, o: { regold?: boolean } = {}): Promise<number> {
  const say = (l: string) => rte.say(`intake: ${l}`);
  const stamp = stampNow();
  const gate = () => budgetGate(gw, `real-intake-${stamp}`);
  let failed = 0;
  const each = async <T>(what: (x: T) => string, items: T[], f: (x: T) => Promise<unknown>) =>
    pool(items, async (x) => {
      try {
        await f(x);
      } catch (err) {
        if (err instanceof WeekSpent) throw err;
        failed++;
        say(`${what(x)} failed: ${msg(err)}`);
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

  const unrendered = chosen().filter((l) => !rendered(l));
  if (unrendered.length) await onBridge(async (page) => {
    let n = 0;
    for (const l of unrendered) n += await renderSession(l, realShot(page));
    say(`${n} images of new sends`);
  });

  const pulled = cards().filter((c) => c.state === "pulled");
  const bySession = [...new Map(pulled.map((c) => [c.ss.s.id, c.ss])).values()];
  if (bySession.length) {
    const run = `real-triage-${stamp}`;
    let judged = 0;
    await each((l) => `triage of ${l.s.id}`, bySession, async (l) => (judged += await triageSession(l, pulled.filter((c) => c.ss === l).map((c) => c.key), run, gate)));
    say(`triage: ${judged} of ${pulled.length} new sends judged (${run})`);
  }

  const judged = new Set([...reviews()].filter(([, r]) => r.verdict).map(([k]) => k));
  const todo = wantGold({ regold: o.regold, judged });
  if (todo.length) {
    const run = `real-gold-${stamp}`;
    let ok = 0;
    await each((c) => `gold for ${c.x.key}`, todo, async (c) => {
      const g = await goldSend(c, run, gate);
      if (g.error) say(`gold for ${c.x.key} unreadable (try ${g.attempts}): ${g.error}`);
      else ok++;
    });
    say(`gold: ${ok} of ${todo.length} drawn (${run})`);
  }
  const rebuilt = rebuildGold();
  if (rebuilt) say(`gold: ${rebuilt} boards rebuilt by today's gold.ts`);
  if (unshotGold().length) await onBridge(async (page) => say(`gold: ${await shootGold(realShot(page))} images`));
  const opened = openHoldCards();
  if (opened) say(`${opened} R-hold cards proposed`);

  const ids = writeProposals();
  if (ids.length) {
    const unshot = ids.filter((id) => !existsSync(join(paths().bankCase(id), "before-ink.jpg")));
    if (unshot.length) await onBridge(async (page) => {
      for (const id of unshot) await shootCase(id, pageShot(page));
    });
    const run = `real-expect-${stamp}`;
    const drafts = ids.filter((id) => !existsSync(join(paths().bankCase(id), "expectation.json")));
    await each((id) => `the expectation for ${id}`, drafts, async (id) => (await gate(), await expectationFor(id, run)));
    const ready = ids.filter((id) => existsSync(join(paths().bankCase(id), "expectation.json")));
    // One run per champion: a run cut short resumes where it stopped, the cases it finished already recorded.
    const rec = `real-bank-${champ.sha.slice(0, 12)}`;
    const done = new Set(await recordOnChampion(rte, gw, ready, rec, (id) => recorded(id, rec, champ.sha)));
    for (const id of ready.filter((x) => !done.has(x))) unrecorded(id);
    say(`${done.size} of ${ids.length} new cases replayed on ${champ.sha.slice(0, 12)} and proposed (${rec})`);
  }

  const a = admit();
  if (a.admitted || a.retired) say(`bank: ${a.admitted} cases admitted, ${a.retired} retired by the owner's rejection`);
  const r1 = freezeR1();
  if (r1) {
    commitHistory(`R1: ${r1.cases} cases (${r1.tune} tune, ${r1.hold} R-hold), ${r1.hash.slice(0, 12)}`);
    say(`R1: ${r1.cases} cases (${r1.tune} tune from ${r1.people.tune} people, ${r1.hold} R-hold from ${r1.people.hold}), hash ${r1.hash.slice(0, 12)}`);
  }
  const all = cards();
  say(`cards: ${(["pulled", "labeled", "proposed", "admitted", "rejected", "skipped"] as const).map((s) => `${all.filter((c) => c.state === s).length} ${s}`).join(", ")}${failed ? `; ${failed} failed, tried again next pass` : ""}`);
  return failed;
}
