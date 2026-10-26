// rte real: testers' sends → triage → gold → bench R1 (evals/real/README.md), each paying step under its cap.
import { commitHistory, openHistory } from "../history.ts";
import type { Shot } from "../human.ts";
import { stampNow } from "../state.ts";
import * as real from "../../real/real.ts";
import { type Rte, championArm, msg } from "../rte.ts";

/** Local (the owner's dev server) sessions before this aren't triaged: the hosted app's testers started then. */
const REAL_SINCE = "2026-10-22";
/** Opus calls in flight at once in triage and gold (the gateway runs eval roles 6 at a time). */
const REAL_PARALLEL = 4;
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}
/** The real-use loop (evals/real/README.md): render and shots on a zero-call gateway, triage and gold under --cap. */
export async function realCmd(rte: Rte) {
  const step = rte.o.pos[1];
  const since = rte.str("since") ?? REAL_SINCE, only = rte.str("only");
  const shots = (f: (shot: Shot) => Promise<void>) => {
    const champ = championArm();
    return rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => f(real.realShot((await rig.tab(0, "A", champ.tree)).page)), 1), true);
  };
  if (step === "update") {
    // Every step but the owner's review, in order; triage and gold capped at 1.5× their calls (a call per session to
    // triage, a call per send for gold), so a retry loop stops there. Freeze takes accepted gold only: batch 1 stays out
    // until the owner approves it, later batches go in unless rejected.
    const capOf = (n: number) => Math.ceil(1.5 * n);
    const steps: [string, (() => number)?][] = [
      ["ingest"], ["render"], ["triage", () => real.chosen(since, only).filter(({ dir, s }) => !real.triaged(dir, s)).length],
      ["gold", () => real.wantGold(since, only, false).length], ["freeze"],
    ];
    for (const [next, calls] of steps) {
      const n = calls?.();
      if (n === 0) {
        rte.say(`real update: ${next}: nothing to do`);
        continue;
      }
      if (n !== undefined) rte.say(`real update: ${next}: ${n} calls, cap ${capOf(n)}`);
      if ((await realCmd(rte.with({ pos: [rte.o.cmd, next], cap: n === undefined ? undefined : capOf(n) }))) === 1) return 1;
    }
    return 0;
  }
  if (step === "ingest") for (const line of real.ingestStep(rte.str("raw"))) rte.say(`real ingest: ${line}`);
  else if (step === "render") {
    await shots(async (shot) => {
      let n = 0;
      for (const { dir, s } of real.chosen(since, only)) n += await real.renderSession(dir, s, shot);
      const rebuilt = real.rebuildGold();
      rte.say(`real render: ${n} images made; gold: ${rebuilt} boards rebuilt, ${await real.shootGold(shot)} images`);
    });
  } else if (step === "triage") {
    rte.needCap("real triage");
    const run = `real-triage-${stampNow()}`;
    const todo = real.chosen(since, only);
    let made = 0, kept = 0, failed = 0;
    await rte.withGateway(() => pool(todo, REAL_PARALLEL, async ({ dir, s }) => {
      try {
        const t = await real.triageSession(dir, s, run);
        if (t === "kept") return void kept++;
        made++;
        // Ids and counts only: a project's name stays under real/ (testers' data never reaches the run log).
        rte.say(`real triage: ${s.id}: ${t.sends.filter((x) => x.landed !== "yes").length} of ${t.sends.length} missed, ${t.sends.filter((x) => x.gold).length} for gold`);
      } catch (e) {
        failed++;
        rte.say(`real triage: ${s.id} failed: ${msg(e)}`);
      }
    }));
    rte.say(`real triage: ${made} sessions triaged, ${kept} already current, ${failed} failed`);
    return failed ? 1 : 0;
  } else if (step === "gold") {
    rte.needCap("real gold");
    // --run resumes an earlier gold run: the calls it finished come back from the cache, unpaid.
    const run = rte.str("run") ?? `real-gold-${stampNow()}`;
    if (!run.startsWith("real-gold-")) throw new Error("real gold --run takes an earlier gold run's name (real-gold-…)");
    const todo = real.wantGold(since, only, !!rte.o.f.regold);
    const batch = real.nextBatch();
    let failed = 0;
    await rte.withGateway(() => pool(todo, REAL_PARALLEL, async (c) => {
      try {
        const g = await real.goldSend(c, run, batch);
        rte.say(`real gold: ${c.x.key} ${g.error ? `unreadable: ${g.error}` : `${g.gold!.pictures.length} pictures${g.problems.length ? `, ${g.problems.length} problems` : ""}`}`);
        if (g.error) failed++;
      } catch (e) {
        failed++;
        rte.say(`real gold: ${c.x.key} failed: ${msg(e)}`);
      }
    }));
    await shots(async (shot) => void rte.say(`real gold: batch ${batch}, ${todo.length} sends, ${failed} failed, ${await real.shootGold(shot)} gold images`));
    return failed ? 1 : 0;
  } else if (step === "review") {
    // Its own port flag: --port is the first arm server's.
    const url = await real.serveReview(rte.str("host") ?? "127.0.0.1", rte.num("review-port") ?? 5182);
    rte.say(`real review: ${url} (Ctrl-C stops it)`);
    await new Promise(() => {});
  } else if (step === "freeze") {
    openHistory();
    const r = real.freezeReal();
    commitHistory(`real freeze: R1 = ${r.cases} cases (${r.tune} tune, ${r.hold} hold), ${r.hash.slice(0, 12)}`);
    rte.say(`real freeze: R1, ${r.cases} cases (${r.tune} R-tune from ${r.people.tune} people, ${r.hold} R-hold from ${r.people.hold}), ${r.merged} repeats merged, ${r.inkWaiting} waiting for synthesized ink${r.moved ? `, ${r.moved} left out (their gold was drawn for a send a later pull moved)` : ""}, hash ${r.hash.slice(0, 12)}`);
  } else throw new Error("real ingest | render | triage | gold | review | freeze | update");
}
