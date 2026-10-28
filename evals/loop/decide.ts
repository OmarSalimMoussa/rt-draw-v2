// One decision, the funnel (§1.2): a card through G0 → G1 → G2 (→ G3, G4) → vetoes, a keep fast-forwarding loop/champion,
// recorded either way; the card's build (knob cards by script, code cards by engineers); rte decide.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { View } from "../../src/core/board.ts";
import { judgeId, judging, lastServed, positionsFor, variants } from "../judge/judge.ts";
import { caseFile } from "../judge/packet.ts";
import * as agents from "../optimizer/agents.ts";
import { failureDigest, writeLossDigest } from "../optimizer/digest.ts";
import { OWNER_KNOBS, cardOwnerReasons, diffOf, g0 } from "../optimizer/gates.ts";
import { type ABResult, type ArmSpec, type Arms, type Judge, type Rig, StopAsked, WeekSpent, budgetGate, budgetPausedMs, harnessTag, judgedOnce, product, runAB } from "./ab.ts";
import { nextTopUp, topUp } from "./bank.ts";
import { gatewayStatus } from "./client.ts";
import { LOOP, configId } from "./config.ts";
import { type ScanResult, sameOnTheClock, scan } from "./diffscan.ts";
import { type DriveCtx, type Pages, continueFrom } from "./drive.ts";
import { decisionRow, historyRows, openHistory, realLine, recordDecision } from "./history.ts";
import { appendRow, meterOf, readRows, rowOf } from "./metrics.ts";
import { isRealCase, paths } from "./paths.ts";
import { caseDir, put, runFile } from "./record.ts";
import { TriedConflict, applyKnobs, applyTried, triedPatch } from "./search.ts";
import { type CardState, type Decided, RULES, type State, newState, overrun, readState, saveState } from "./state.ts";
import type { Token } from "./tokens.ts";
import { LockfileDiffers, treeOf, worktreeOf } from "./trees.ts";
import type { Arm, CaseInfo, DecisionRow, Fork, HypothesisCard, Row, SceneJSON } from "./types.ts";
import { type Decision, decide } from "./verdict.ts";
import { realShadow } from "../real/shadow.ts";
import { IDENT, type Rte, championSha, commitAll, git, hasU1, isAncestor, maybe, msg, needBank, nextEpoch, scanCases, sleep, tryGit, tuningIdOf } from "./rte.ts";

/** Request hashes this run already paid for: a resumed run gets them from the cache (§6.5's resume cache). */
const paid = (run: string) => meterOf(run).filter((c) => product(c) && c.mode === "live" && c.shared !== "follower" && !c.apiError && !c.dropped).map((c) => c.reqHash);

/** Rows for the fork cases drive.ts wrote to a run (G4 continuations, top-ups): judged at once (the gateway caps eval roles), kept in rows.jsonl. */
async function forkedRows(run: string, ids: string[], judge: Judge, o: { seed: string; cls: Row["class"]; cluster: (id: string) => string }): Promise<Row[]> {
  const pos = positionsFor(ids, o.seed);
  const voided = await Promise.all(ids.map((id) => judgedOnce(judge, id, pos.get(id)!)));
  const calls = meterOf(run);
  return ids.map((id, i) => {
    const info = maybe<CaseInfo>(caseFile(id, "case.json", run))!;
    const fork = maybe<Fork>(join(caseDir(run, id), "fork.json"))!;
    const row = rowOf(run, { case: id, cluster: o.cluster(id), affected: true, class: o.cls, overuse: [false, false], ask: info.ask, beat: info.beat, firstArm: fork.order[0], void: voided[i] }, calls);
    appendRow(run, row);
    return row;
  });
}
/** Each case slot's pages of both arms and the driver's context, for live fork sends in a decision run. */
async function forkCtx(rig: Rig, arms: Arms, run: string): Promise<{ ctx: DriveCtx; slots: Pages[] }> {
  const slots = await Promise.all(Array.from({ length: rig.slots }, async (_, k): Promise<Pages> => ({ A: (await rig.tab(k, "A", arms.A.tree)).page, B: (await rig.tab(k, "B", arms.B.tree)).page })));
  // Every send waits out the budget's pause first (LOOP-V2.md A4): a top-up session or a continuation is paying work too.
  const hook = async () => void (await budgetGate(rig.gateway, run));
  return { slots, ctx: { run, arms: { A: { sha: arms.A.sha, tuningId: await tuningIdOf(slots[0].A) }, B: { sha: arms.B.sha, tuningId: "", tuning: arms.B.tuning } }, harnessTag: harnessTag(), hook } };
}

/** G4 (class D): the driver continues on B's result; each send is forked, judged and made a row (a veto only). */
const continuation = (rig: Rig, arms: Arms, run: string) => async (caseId: string, b: { run: string; after: SceneJSON; camera: View }, sends: number, slot: number): Promise<Row[]> => {
  const had = readRows(run).filter((r) => r.case.startsWith(`${caseId}-k`));
  if (had.length) return had; // a resumed decision paid for this one already
  const { ctx, slots } = await forkCtx(rig, arms, run);
  const s = await continueFrom(ctx, slots[slot], caseId, b, sends, "B");
  return forkedRows(run, s.cases.filter((c) => existsSync(caseDir(run, c))), judging(run, { seed: run, craft: "none" }), { seed: run, cls: "D", cluster: () => caseId });
};

/** A fork send's arms differ: their product requests, or their after-scenes. Only those are judged (§1.3). */
function differs(run: string, id: string): boolean {
  const reqs = (a: Arm) => (maybe<{ calls: { reqHash: string }[] }>(join(caseDir(run, id), a, "result.json"))?.calls ?? []).map((c) => c.reqHash).sort().join();
  return !maybe<Fork>(join(caseDir(run, id), "fork.json"))?.identicalAfter || reqs("A") !== reqs("B");
}
/** A top-up's fork case (bank.ts' c-u<k>-s<n>-<send>), not a continuation of one (<case>-k<n>). */
const TOP_UP = /^c-u\d+-s\d+-\d+$/;
const clusterIn = (run: string) => (id: string) => maybe<CaseInfo>(caseFile(id, "case.json", run))!.originSession;
/** A top-up whose case was written whole: one whose expectation came back unreadable (V7) has sends but no case.json. */
const deposited = (run: string, id: string) => existsSync(caseFile(id, "case.json", run));
/** Top-ups (§1.3) for a decision whose bank ran short: live fork sends on the champion, continuing on A, deposited as new cases. */
const topUps = (rig: Rig, arms: Arms, run: string, judge: Judge, cls: Row["class"]) => async (n: number): Promise<Row[]> => {
  const { ctx, slots } = await forkCtx(rig, arms, run);
  const k = nextTopUp();
  const ids = (await topUp(ctx, slots, n, k)).filter((id) => existsSync(caseDir(run, id)) && deposited(run, id) && differs(run, id));
  return forkedRows(run, ids, judge, { seed: `${run} top-up ${k}`, cls, cluster: clusterIn(run) });
};
/**
 * A resumed decision's top-ups: every send it already paid for, and their rows (judging those a stop cut off before theirs).
 * Its banked cases aren't among them, though an earlier decision's top-ups are banked under the same c-u names.
 */
async function toppedUp(run: string, banked: string[], judge: Judge, cls: Row["class"]): Promise<{ sends: number; rows: Row[] }> {
  const dirs = existsSync(runFile(run, "cases")) ? readdirSync(runFile(run, "cases")) : [];
  const not = new Set(banked);
  const ids = [...new Set(dirs.map((d) => d.replace(/\.void(\.\d+)?$/, "")))].filter((id) => TOP_UP.test(id) && !not.has(id));
  const had = new Set(readRows(run).map((r) => r.case));
  const cut = ids.filter((id) => !had.has(id) && existsSync(join(caseDir(run, id), "done")) && deposited(run, id) && differs(run, id));
  if (cut.length) await forkedRows(run, cut, judge, { seed: `${run} top-up resumed`, cls, cluster: clusterIn(run) });
  const own = new Set(ids);
  return { sends: ids.length, rows: readRows(run).filter((r) => own.has(r.case)) };
}

/**
 * What a decision teaches the next analyst: its candidate-loss digest and one failure-analyst call on its losses, unless
 * the budget is paused (the digest alone then).
 */
async function lessons(gw: string, run: string, rows: Row[]) {
  if (!existsSync(runFile(run, "rows.jsonl"))) return;
  writeLossDigest(run);
  // The driver's cases only: a real send's never reaches the failure analyst (failureDigest), so it can't take a place.
  const lost = rows.filter((r) => !r.void && !r.lost && r.s < 0 && !isRealCase(r.case)).slice(0, 12);
  if (lost.length && ((await gatewayStatus(gw)) as { pace: { ok: boolean } }).pace.ok) put(runFile(run, "failures.json"), await agents.failureAnalyst(failureDigest(lost.map((r) => ({ case: r.case, run }))), run).catch(() => []));
}

/** One card through G0 → G1 → G2 (→ G3, G4) → vetoes; a keep fast-forwards loop/champion. Recorded either way. */
export async function decideCard(rte: Rte, gw: string, st: State, c: CardState): Promise<Decided> {
  const p = paths();
  const id = c.id;
  const run = (stage: string) => `${st.stamp}-${id}-${stage}`;
  const base = championSha();
  const cand = c.cand!;
  const t0 = Date.now(), paused0 = budgetPausedMs();
  const affected: DecisionRow["affected"] = { tuning: 0, of: 0, topUp: 0 };
  const record = (d: Decision, at: string, result: Omit<ABResult, "invariants"> = { rows: [] }, owner: string[] = []) => {
    const row = decisionRow({ id, epoch: st.epoch, card: c.card, candSha: cand, baseSha: base, run: at, judgeId: judgeId("fidelity", lastServed(), variants().fidelity), result: { ...result, decision: d }, affected });
    if (d.verdict === "keep") git(p.repo, "branch", "-f", "loop/champion", cand);
    // Once per run: a resumed decision isn't recorded twice, and `rte decide --card` again on the same branch (a new run)
    // is (d-cand-e80-h3's second re-decide, on the funnel audit's rules, went unrecorded under its id alone).
    if (!historyRows("decisions.jsonl").some((x) => x.id === id && x.run === at)) recordDecision(row, { owner });
    c.run = at;
    rte.say(`${id}: ${d.verdict} (${d.class}, ${d.goal}): ${[...d.reasons, ...d.vetoes].join("; ")}`);
    return row;
  };
  // The card is done in state.json at once: a stop before lessons() and the rig's close would otherwise re-decide a keep
  // on resume as "no change was made" (its candidate is the champion by then).
  const settle = (decided: Decided): Decided => {
    const d = c.sweep ? { ...decided, sweep: c.sweep.of } : decided;
    if (!st.cards.includes(c)) return d; // rte decide: no epoch's card
    Object.assign(c, { status: "done", verdict: d.verdict });
    st.recent = [...st.recent, d].slice(-50);
    if (d.verdict === "keep") st.keepsSinceCheckpoint++, st.keepsSinceRefresh++;
    saveState(st);
    return d;
  };
  const gate = (verdict: "revert" | "owner", reasons: string[], o: { owner?: string[]; cls?: Decision["class"]; codes?: Decision["codes"] } = {}): Decided => {
    const codes = o.codes ?? (verdict === "owner" ? ["owner"] : []);
    const d: Decision = { verdict, reasons, goal: c.card.goal, class: o.cls ?? c.card.classGuess, looks: [], vetoes: [], codes, configId, counts: { wins: 0, losses: 0, ties: 0, n: 0, look: 0 }, latency: { byThinking: {}, tails: {} }, work: 1, emptyRise: 0, failedPicRise: 0, usdRatio: 1 };
    put(runFile(run("g0"), "verdict.json"), d);
    record(d, run("g0"), undefined, o.owner ?? (verdict === "owner" ? reasons : []));
    return settle({ id, verdict, component: c.card.component, at: new Date().toISOString() });
  };
  // Past RULES.decisionMaxMin of measuring at 8 slots: harness suspect (§6.7). Hours waiting out the budget's pause (ab.ts budgetGate) aren't measuring.
  const overBy = (slots: number) => {
    const minutes = (Date.now() - t0 - (budgetPausedMs() - paused0)) / 60_000;
    return overrun(minutes, slots) ? `overran: ${minutes.toFixed(0)} min of measuring (${RULES.decisionMaxMin} at 8 slots)` : undefined;
  };

  // G0, free: the diff's gates, then (code cards) the typecheck and the scene round trip in the candidate's tree.
  if (cand === base) return gate("revert", ["no change was made"], { codes: ["no-change"] });
  const knob = c.card.kind === "knob";
  let tree: string | undefined;
  try {
    tree = knob ? undefined : treeOf(cand);
  } catch (err) {
    if (err instanceof LockfileDiffers) return gate("owner", [err.message]);
    throw err;
  }
  const diff = diffOf(p.repo, base, cand);
  const g = g0({ diff, tree, ownerOk: c.card.ownerOk });
  // A picture model switch by what the change does to tuning.ts, whatever kind of card made it (a combo or a code card
  // too): its keep waits for the judge's illustration calibration. Every other model switch or router is measured alone.
  const pictureModels = [...diff.matchAll(/^\+.*\b(?:K|B)\("(picture\.\w*[mM]odel)",/gm)].map((m) => m[1]);
  if (g.waived) rte.say(`${id}: the owner waived ${g.waived.length} owner finding${g.waived.length > 1 ? "s" : ""}: ${g.waived.join("; ").slice(0, 300)}`);
  if (g.verdict !== "pass") return gate(g.verdict === "owner" ? "owner" : "revert", g.reasons);
  // An owner's knob moved by any card (a code card or a combo too, not only a knob card).
  const ownerKnobs = OWNER_KNOBS.filter((k) => new RegExp(`^\\+.*\\b(?:K|B)\\("${k.replace(/\./g, "\\.")}",`, "m").test(diff));
  if (ownerKnobs.length) return gate("owner", [`an owner's knob: ${ownerKnobs.join(", ")}`]);

  // A knob card is one tree with two tunings (§7.2).
  const champ: ArmSpec = { sha: base, tree: treeOf(base) };
  const arms: Arms = { A: champ, B: knob ? { sha: cand, tree: champ.tree, tuning: c.card.knobs } : { sha: cand, tree: tree! } };
  return rte.withRig(gw, [arms.A.tree, arms.B.tree], async (rig) => {
    // G1: the diffscan at 0 calls (a finished scan is read back on resume).
    const scanRun = run("scan");
    // Knobs a code card adds or moves in tuning.ts, as its own knobs are: e88-h3's jev.copies came that way.
    const moved = [...git(p.repo, "diff", base, cand, "--", "src/core/tuning.ts").matchAll(/^\+\s*K\("([\w.]+)"/gm)].map((m) => m[1]);
    const sc = hedgeScan(c.card, maybe<ScanResult>(runFile(scanRun, "scan.json")) ?? (await scan(rig, { run: scanRun, arms, seed: scanRun, card: c.card, cases: scanCases(scanRun) })), moved);
    const tuning = [...(sc.affected.tuning ?? []), ...(sc.affected.fresh ?? []), ...(sc.affected.real ?? [])];
    Object.assign(affected, { tuning: tuning.length, of: sc.cases.filter((x) => x.set !== "heldout-gate").length, real: sc.affected.real?.length ?? 0 });
    if (rte.o.f["quality-only"] && sc.class === "S") {
      rte.say(`${id}: a schedule change (S): latency-goal cards wait for the PGX (--quality-only)`);
      return settle({ id, verdict: "deferred", component: c.card.component, at: new Date().toISOString() });
    }
    // Top-ups are live sends (R runs on the banked replies: a top-up has none). Too rare (§1.3) at 0 calls when even
    // every top-up send, affected at the scan's rate, can't bring the affected cases to LOOP.rareMin.
    const tops = sc.class === "Q" || sc.class === "D";
    const more = tops && affected.of ? (LOOP.topUpMaxSends * tuning.length) / affected.of : 0;
    if (sc.class !== "N" && sc.class !== "S" && tuning.length + more < LOOP.rareMin) {
      const why = `too rare to measure: ${tuning.length} affected cases${tops ? `, ~${more.toFixed(0)} more from ${LOOP.topUpMaxSends} top-up sends` : ""} (< ${LOOP.rareMin})`;
      return gate("revert", [why], { cls: sc.class });
    }
    let at: string, result: ABResult;
    if (sc.class === "N" || sc.class === "S") {
      // N reverts at 0 calls; S is decided on the timed replay's latency, also at 0 calls.
      at = sc.class === "N" ? scanRun : sc.timed!.run;
      const sets = new Map(sc.cases.map((x) => [x.case, x.set]));
      const rows = readRows(at).filter((r) => sets.get(r.case) !== "heldout-gate").map((r) => ({ ...r, class: sc.class, affected: sc.class === "S" }));
      result = { rows, decision: decide({ tuning: rows, exhausted: true }, c.card), invariants: [] };
      // G3 for a schedule change (LOOP-V2.md D2): the H-gate cases replayed too, at 0 calls, and they can only veto.
      if (result.decision!.pending?.includes("heldout")) {
        const gate = sc.cases.filter((x) => x.set === "heldout-gate").map((x) => x.case).slice(0, LOOP.heldoutMax);
        const h = await runAB(rig, { run: `${at}-heldout`, kind: "scan", mode: "replay", arms, share: true, seed: `${at} heldout`, cases: gate, cls: "S", classify: () => ({ affected: true, class: "S" }) });
        const heldout = h.rows.map((r) => ({ ...r, class: sc.class, affected: true }));
        result = { rows, heldout, decision: decide({ tuning: rows, heldout, exhausted: true }, c.card), invariants: h.invariants };
        // A schedule change draws the same on the held-out cases too, or it isn't one (diffscan.ts sameOnTheClock).
        if (result.decision!.verdict === "keep" && !sameOnTheClock(`${at}-heldout`, h.rows))
          result.decision = { ...result.decision!, verdict: "revert", vetoes: [...result.decision!.vetoes, "held-out: a schedule change drew differently on the recorded clock: only the judged path keeps that"], codes: [...result.decision!.codes, "schedule"] };
      }
      put(runFile(at, "verdict.json"), result.decision!);
    } else {
      // G2 (+ G3, G4): only the affected cases, live (R: on the banked replies), identical calls shared and cached.
      at = run("ab");
      const judge = rte.fakes.judge?.(at, c.card) ?? judging(at, { seed: at, craft: c.card.goal === "craft" ? "all" : "none" });
      result = await runAB(rig, {
        // R runs on the banked replies at 0 calls, on their recorded clock: instant replies would hide a change that
        // makes the first drawing wait (the owner's latency).
        run: at, kind: "ab", arms, mode: sc.class === "R" ? "scan" : "live", ...(sc.class === "R" ? { timed: true } : {}), share: true, cached: [...sc.cached, ...paid(at)], seed: at, card: c.card, judge, cases: tuning,
        cls: sc.class,
      }, {
        card: c.card, heldout: sc.affected["heldout-gate"], continueFrom: sc.class === "D" ? continuation(rig, arms, at) : undefined,
        topUp: tops ? topUps(rig, arms, at, judge, sc.class) : undefined, toppedUp: tops ? await toppedUp(at, tuning, judge, sc.class) : undefined, overrun: () => overBy(rig.slots),
      });
      affected.topUp = result.topUps ?? 0;
    }
    let d = result.decision!;
    const owner: string[] = [];
    // A timing trip voided its case only (ab.ts' Invariant): the harness is suspect when the arms got different things.
    const v9 = result.invariants.some((x) => x.why.startsWith("V9") && !x.timing);
    if (rte.suspends.some((t) => t >= t0) && d.verdict !== "void") d = { ...d, verdict: "void", reasons: [...d.reasons, "V10: the machine was suspended during the decision"] };
    // A void goes to the owner list, never rerun (§1.4 item 9): in history every rerun of a void voided again, the same
    // harness asymmetry each time. The owner re-decides it with rte decide --card once the cause is fixed.
    if (d.verdict === "void") owner.push(`void: ${d.reasons.join("; ")}`);
    if (d.verdict === "owner") owner.push(...d.vetoes);
    if (d.verdict === "keep") {
      const hold = [...new Set([
        ...cardOwnerReasons(c.card, { u1: hasU1() }),
        ...(c.card.goal === "craft" && !variants().craftCalibrated ? ["a craft keep before craft calibration passed"] : []),
        ...(pictureModels.length && !variants().illustrationsCalibrated ? [`a picture model switch (${pictureModels.join(", ")}) before the judge is calibrated on illustrations`] : []),
      ])];
      if (hold.length) (d = { ...d, verdict: "owner", vetoes: [...d.vetoes, ...hold], codes: [...d.codes, "owner"] }), owner.push(...hold);
    }
    // The whole path's measuring against the time bound (§6.7): void, harness suspect.
    const over = result.overrun ?? (d.verdict === "void" ? undefined : overBy(rig.slots));
    if (over && !result.overrun) d = { ...d, verdict: "void", reasons: [...d.reasons, over] };
    // Testers' real sends beside a keep (LOOP-V2.md A5): reported, never deciding, so a failure here never loses the keep.
    // After the budget check and under a run name outside the decision's ($ and minutes are R1's own, not the class's).
    if (d.verdict === "keep" && !rte.fakes.judge && !((await gatewayStatus(gw)) as { pace: { ok: boolean } }).pace.ok) rte.say(`${id}: R1 skipped: the budget is pausing paid calls`);
    else if (d.verdict === "keep" && !rte.fakes.judge) {
      const r1 = `real-r1-${st.stamp}-${id}`;
      const shadow = await realShadow(rig, { run: r1, arms, seed: r1, judge: judging(r1, { seed: r1, craft: "none" }) }).catch((err) => (rte.say(`${id}: R1 failed: ${err instanceof Error ? err.message : String(err)}`), undefined));
      if (shadow) (d = { ...d, real: shadow }), rte.say(`${id}: ${realLine(shadow)}`);
    }
    record(d, at, { ...result, decision: d }, owner);
    const done = settle({ id, verdict: d.verdict, component: c.card.component, at: new Date().toISOString(), v9 });
    await lessons(gw, at, result.rows);
    return done;
  });
}

// ---- Building cards: knob cards by script, code cards by engineers

/** A knob card's commit: the defaults in tuning.ts set to the card's values, within each knob's range. */
/**
 * A token for an engineer session once a slot is under the five-hour pause (LOOP.fiveHourPauseAt): builds run beside
 * the decisions, so a pause waits here (budgetGate: the loop says paused, and a stop ends the wait) instead of dropping
 * the card. Undefined when every token is past its week: the card stays unbuilt, and the loop pauses until a week is read
 * again.
 */
async function freeSlot(rte: Rte, gw: string, run: string): Promise<Token | undefined> {
  for (;;) {
    try {
      await budgetGate(gw, run);
    } catch (err) {
      if (err instanceof WeekSpent) return undefined;
      throw err;
    }
    try {
      return await agents.slotToken(rte.tokens(), gw);
    } catch (err) {
      if (!(err instanceof agents.NoSlot)) throw err;
      await sleep(60_000); // a slot parked for another reason (a failed reading): looked at again
    }
  }
}

/**
 * A hedge (more copies of a call, or sooner: draw.copies, picture.copyAfterMs, …) answers nothing in a scan or a replay
 * (gateway.ts: a copy is live only), so the scan reads it as no effect or a schedule change: e74-h2, e76-h1 and e76-h2
 * were decided at 0 calls that way. It goes live on every scanned case, none from the cache: each arm's first call is
 * one shared live call, B's copies fresh ones, and the first to stream wins.
 */
export function hedgeScan(card: HypothesisCard, sc: ScanResult, moved: string[] = []): ScanResult {
  const hedge = [...Object.keys(card.knobs ?? {}), ...moved].some((k) => /\.(copies|copyAfterMs)$/.test(k));
  if (!hedge || (sc.class !== "N" && sc.class !== "S")) return sc;
  const affected: ScanResult["affected"] = {};
  for (const x of sc.cases) (affected[x.set] ??= []).push(x.case);
  return { ...sc, class: "Q", affected, cached: [] };
}

/** Builds a card on its branch (cand/e<E>-h<n>, off the champion): a commit, or the champion itself when nothing changed. */
export async function build(rte: Rte, gw: string, st: State, c: CardState) {
  try {
    const wt = worktreeOf(c.branch);
    if (git(wt, "status", "--porcelain")) git(wt, "reset", "-q", "--hard"), git(wt, "clean", "-qfd");
    if (Number(git(wt, "rev-list", "--count", "loop/champion..HEAD")) === 0) {
      const engineer = async (note?: string, role = "engineer") => {
        const token = await freeSlot(rte, gw, `${st.stamp}-${c.id}-${role}`);
        // Every token is past its week: the card stays to build after the loop's pause.
        if (!token) return false;
        await rte.engine().engineer({ card: c.card, branch: c.branch, run: `${st.stamp}-${c.id}-${role}`, token, mockApi: await rte.agentMock(), note });
        return true;
      };
      let built = true;
      if (c.card.kind === "knob") applyKnobs(wt, c.card.knobs ?? {});
      else if (c.card.kind === "combo") {
        try {
          applyTried(wt, c.card.combines ?? [], paths().history, join(paths().home, "tmp"));
        } catch (err) {
          if (!(err instanceof TriedConflict)) throw err;
          git(wt, "reset", "-q", "--hard"), git(wt, "clean", "-qfd");
          rte.say(`${c.id}: ${msg(err)}: an engineer makes them together`);
          const patches = (c.card.combines ?? []).map((id) => `# ${id}\n\`\`\`diff\n${triedPatch(id, paths().history)}\`\`\``).join("\n\n");
          built = await engineer(`Its tried patches don't apply one after another on today's champion (they edit the same lines, or the code moved). Make all of them together by hand, each one's intent kept:\n\n${patches}`);
        }
      } else built = await engineer();
      // G0's diff gates, free, once as built: a reject its engineer can fix (e88-h4's `const HEX = 16` outside tuning.ts)
      // goes back to it once with the reasons, rather than reverting the card unmeasured.
      if (built && c.card.kind !== "knob" && git(wt, "status", "--porcelain")) {
        commitAll(wt, `${c.card.change}\n\n${c.id}: a ${c.card.kind} card on ${c.card.component} (goal ${c.card.goal}), written by the eval loop`);
        const g = g0({ diff: diffOf(wt, "loop/champion", "HEAD") });
        if (g.verdict === "reject") {
          rte.say(`${c.id}: the gate rejects it as built (${g.reasons.join("; ").slice(0, 200)}): its engineer fixes it once`);
          built = await engineer(`The gate rejects this change as built. Fix what it names and keep the change's intent:\n- ${g.reasons.join("\n- ")}`, "engineer-fix");
        }
      }
      if (!built) return void rte.say(`${c.id}: not built yet: every token is past its week; it's built after the pause`);
    }
    if (git(wt, "status", "--porcelain")) commitAll(wt, `${c.card.change}\n\n${c.id}: a ${c.card.kind} card on ${c.card.component} (goal ${c.card.goal}), written by the eval loop`);
    knobbed(c);
    Object.assign(c, { cand: git(wt, "rev-parse", "HEAD"), status: "built" });
  } catch (err) {
    // A stop asked for while it waited on the budget: still to build when the loop starts again.
    if (err instanceof StopAsked) return void rte.say(`${c.id}: not built yet: ${err.message}`);
    rte.say(`${c.id}: not built: ${msg(err)}`);
    c.status = "dropped";
  }
  saveState(st);
}

/**
 * A card's knobs are what B runs, on a branch built now or before (a resumed card, `rte decide --card`): an engineer
 * that wrote prompt variant 3 but left its default (e83-h4's {"draw.prompt": 3}), or a new knob at 0 (e83-h3's
 * draw.inlinePictures), had B run today's behaviour, read as no effect at 0 calls. Already set, it changes nothing.
 */
function knobbed(c: CardState) {
  if (c.card.kind === "knob" || !Object.keys(c.card.knobs ?? {}).length) return;
  const wt = worktreeOf(c.branch);
  applyKnobs(wt, c.card.knobs!);
  if (!git(wt, "status", "--porcelain")) return;
  commitAll(wt, `${c.id}: its card's knobs set, ${JSON.stringify(c.card.knobs)}`);
  c.cand = git(wt, "rev-parse", "HEAD");
}

/** The candidate on top of today's champion (a keep moved it); a conflict rebuilds it once (the engineer once more). */
export async function rebased(rte: Rte, gw: string, st: State, c: CardState): Promise<boolean> {
  try {
    knobbed(c);
  } catch (err) {
    rte.say(`${c.id}: not built: ${msg(err)}`);
    c.status = "dropped";
    saveState(st);
    return false;
  }
  const champ = championSha();
  if (isAncestor(champ, c.cand!)) return true;
  const wt = worktreeOf(c.branch);
  if (tryGit(wt, ...IDENT, "rebase", "-q", "loop/champion") !== undefined) {
    c.cand = git(wt, "rev-parse", "HEAD");
    return true;
  }
  tryGit(wt, "rebase", "--abort");
  git(wt, "reset", "-q", "--hard", "loop/champion");
  rte.say(`${c.id}: conflicts with the moved champion: built once more`);
  await build(rte, gw, st, c);
  return c.status === "built";
}

export async function decideCmd(rte: Rte) {
  const branch = rte.o.pos[1];
  if (!branch) throw new Error("decide <branch> [--goal latency --metric ttfd|render | --card <decision id>] [--owner-ok] --cap n");
  // The owner's own change, judged on what it's for: fidelity by default, or a speed change (one the loop's gates sent
  // to the owner and the owner wants measured) on its metric.
  const goal = rte.str("goal") ?? "fidelity", metric = rte.str("metric");
  if (!["fidelity", "latency"].includes(goal)) throw new Error("decide --goal takes fidelity or latency");
  if (goal === "latency" && !["ttfd", "render"].includes(metric ?? "")) throw new Error("decide --goal latency needs --metric ttfd or render");
  rte.needCap("decide");
  needBank();
  openHistory();
  const st = readState() ?? newState(nextEpoch());
  // --card: a loop decision's own card (its goal, class guess, over-use detector and targets) on its candidate branch,
  // decided again under today's rules.
  const from = rte.str("card");
  const prior = from ? (historyRows("decisions.jsonl") as DecisionRow[]).filter((d) => d.id === from && d.card).pop()?.card : undefined;
  if (from && !prior) throw new Error(`decide --card: no card decision ${from} in decisions.jsonl`);
  const card: HypothesisCard = prior ? { ...prior, ...(rte.o.f["owner-ok"] ? { ownerOk: true } : {}) } : { id: branch, component: "owner", kind: "code", change: `rte decide ${branch}`, goal: goal as HypothesisCard["goal"], ...(goal === "latency" ? { metric: metric as "ttfd" | "render" } : {}), ...(rte.o.f["owner-ok"] ? { ownerOk: true } : {}), classGuess: "Q", dialogue: false, isPatch: false, touchesFrozen: false, risk: "", files: [] };
  const c: CardState = { id: `d-${branch.replace(/[^\w-]+/g, "-")}`, card, branch, status: "built", cand: git(paths().repo, "rev-parse", branch) };
  const d = await rte.withGateway(async (gw) => ((await rebased(rte, gw, st, c)) ? decideCard(rte, gw, st, c) : undefined));
  return d?.verdict === "keep" ? 0 : 1;
}
