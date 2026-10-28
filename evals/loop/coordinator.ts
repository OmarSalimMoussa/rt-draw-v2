// The loop (§8.1): epochs of cards, §6.7's rules before each step, what it's doing for the status strip, checkpoints,
// testers' new sends (evals/real/intake.ts) and the bank's refresh between epochs, the canary, the epoch's record;
// rte week and rte stop-after. Its systemd unit (evals/ops/units.sh) restarts it after a crash; every other stop is the
// owner's to look at.
import { existsSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { canaryDue, runCanary } from "../judge/canary.ts";
import { calibrationFile, variants } from "../judge/judge.ts";
import * as agents from "../optimizer/agents.ts";
import { analystDigest, decisionLines } from "../optimizer/digest.ts";
import { cardOwnerReasons } from "../optimizer/gates.ts";
import { WeekSpent, harnessTag } from "./ab.ts";
import { refresh } from "./bank.ts";
import type { StoredCheckpoint } from "./checkpoint.ts";
import { CapReached, ask, gatewayStatus } from "./client.ts";
import { LOOP, WEEK_CHECK, configId } from "./config.ts";
import type { DriveCtx } from "./drive.ts";
import { commitHistory, historyAdd, historyRows, openHistory, ownerItem, recordMachine } from "./history.ts";
import { heartbeat, onAC, refuseFactorySlice } from "./load.ts";
import { METER_ROTATE_BYTES, readMeter, rollup, rotateMeter } from "./meter.ts";
import { tellOwner } from "./notify.ts";
import { paths } from "./paths.ts";
import { put, runFile } from "./record.ts";
import { cardStates, sweepSkip } from "./search.ts";
import { type Facts, RULES, type Run, type State, type StopCode, holder, lock, newState, readState, rules, saveState, stampNow } from "./state.ts";
import type { SlotN } from "./tokens.ts";
import { treeOf } from "./trees.ts";
import type { AgentLog, Arm, DecisionRow, EpochRow, HypothesisCard } from "./types.ts";
import { runCheckpoint, sync } from "./commands/checkpoint.ts";
import { probed, readyOk } from "./commands/setup.ts";
import { intake } from "../real/intake.ts";
import { build, decideCard, rebased } from "./decide.ts";
import { DAY, HOUR, type Rte, championArm, championPages, championSha, hasU1, maybe, msg, needBank, nextEpoch, sleep, tuningIdOf } from "./rte.ts";

let readyAtStart = false;
let diskAtStart: { at: number; gb: number } | undefined;
const stopFile = () => join(paths().home, "stop.request");

/** What the loop is doing now, in state.json (state.ts Run): the status strip and rte status read it. */
function setRun(st: State, run: Omit<Run, "at">) {
  st.run = { ...run, at: new Date().toISOString() };
  saveState(st);
}
/** Running, at this phase: the slot and the rest kept from the last reading. */
const phase = (st: State, what: string) => setRun(st, { status: "running", phase: what, slot: st.run?.slot });

/** A stop: in state.json, the log, and (unless the owner asked for it) the owner's mail. */
async function stopped(rte: Rte, st: State, code: StopCode, why: string) {
  setRun(st, { status: "stopped", code, why, slot: st.run?.slot });
  rte.say(`loop: STOP (${code}): ${why}`);
  if (code !== "asked" && code !== "done") await tellOwner(rte, `the loop stopped (${code})`, [why, "Eval HQ's Needs you has it; the loop starts again with rte run (or systemctl --user start rt-loop)."]);
}

type SlotStatus = { slot: SlotN; current: boolean; fiveHour?: number; sevenDay?: number; sevenDayAt?: number; resetsAt?: number; status?: string; usdThisWindow: number; usd7d: number; why?: string };

async function facts(rte: Rte, gw: string, st: State, err?: unknown): Promise<Facts> {
  const s = (await gatewayStatus(gw)) as { pace: Facts["pace"]; slots: SlotStatus[]; cap?: number; capReached: boolean };
  const lines = readMeter(paths().calls);
  const fs = statfsSync(paths().home);
  const gb = (fs.bavail * fs.bsize) / 1e9;
  diskAtStart ??= { at: Date.now(), gb };
  const perDay = ((diskAtStart.gb - gb) / (Date.now() - diskAtStart.at)) * DAY;
  return {
    now: Date.now(), pace: s.pace, recent: st.recent, ownerStepAt: Date.parse(st.lastOwnerStep ?? "1970-01-01"), checkpointAt: Date.parse(historyRows("checkpoints.jsonl").at(-1)?.at ?? "1970-01-01"),
    wellFrom: Object.fromEntries(Object.entries(st.wellFrom ?? {}).map(([c, at]) => [c, Date.parse(at)])), ready: readyAtStart, calib: rte.o.mockApi ? "dry" : maybe<{ outcome: string }>(calibrationFile())?.outcome,
    error: err === undefined ? undefined : msg(err), capped: err instanceof CapReached || s.capReached,
    blocked: st.blocked, emptyEpochs: st.emptyEpochs ?? 0, overloads: lines.flatMap((l) => ("agent" in l || !l.apiError || !/overload|529/i.test(l.apiError) ? [] : [Date.parse(l.at)])), diskGb: gb,
    daysLeft: perDay > 0 ? Math.max(0, (gb - LOOP.diskPauseGb) / perDay) : undefined, onAC: onAC(), slot: s.slots.find((x) => x.current)?.slot,
  };
}

/** When each slot's week was last checked (ms): a check the server answers without a reading waits WEEK_CHECK.afterH too. */
const weekChecked = new Map<SlotN, number>();
const weekOf = (x?: SlotStatus) => (x?.sevenDay === undefined ? "unknown" : `${Math.round(x.sevenDay * 100)}%`);

/** WEEK_CHECK: one one-word call on each token parked for its week on an old reading (or none), so its week is read again. */
async function recheckWeeks(rte: Rte, gw: string) {
  const s = (await gatewayStatus(gw)) as { stale?: SlotN[]; slots: SlotStatus[] };
  for (const slot of s.stale ?? []) {
    if (Date.now() - (weekChecked.get(slot) ?? 0) < WEEK_CHECK.afterH * HOUR) continue;
    weekChecked.set(slot, Date.now());
    // Its own request each time: the run's cache would serve a repeat.
    const req = { role: "probe", model: "haiku", system: "Answer with one word.", user: `Week check, slot ${slot}, ${new Date().toISOString()}?`, run: `week-${stampNow()}`, token: slot } as const;
    const error = await ask(req, gw).then(() => "", (e: Error) => e.message);
    const now = ((await gatewayStatus(gw)) as { slots: SlotStatus[] }).slots.find((x) => x.slot === slot);
    rte.say(`loop: token ${slot}'s week read again: ${weekOf(s.slots.find((x) => x.slot === slot))} to ${weekOf(now)} of its weekly limit (the loop pauses past ${Math.round(LOOP.weekSevenDayMax * 100)}%)${error ? `; the call failed: ${error}` : ""}; ${now?.why ? `still parked: ${now.why}` : "back in use"}`);
  }
}

/** How often a pause looks for the owner's stop-after. */
const STOP_POLL_MS = 30_000;

/** §6.7 before new work: true when the loop stops here (it says why); pauses wait here. `err`: what the step threw. */
async function halt(rte: Rte, gw: string, st: State, err?: unknown): Promise<boolean> {
  for (;;) {
    // The owner asked for a stop (rte stop-after): here, between steps, nothing is lost.
    if (existsSync(stopFile())) {
      rmSync(stopFile());
      await stopped(rte, st, "asked", "stopped as asked (rte stop-after); rte run goes on from here");
      return true;
    }
    await recheckWeeks(rte, gw);
    // A dry well's pause runs out after RULES.pauseEpochs epochs: with no keep there is no checkpoint, and every component
    // would stay paused until the epochs came up empty. Its reverts count again from here.
    for (const c of st.paused.filter((x) => st.epoch - (st.pausedAt?.[x] ?? st.epoch) >= RULES.pauseEpochs)) {
      st.paused = st.paused.filter((x) => x !== c);
      delete st.pausedAt?.[c];
      (st.wellFrom ??= {})[c] = new Date().toISOString();
      rte.say(`loop: ${c} unpaused: its dry well's ${RULES.pauseEpochs} epochs are up`);
    }
    const f = await facts(rte, gw, st, err);
    const acts = rules(f);
    const noted = acts.filter((a) => a.do === "owner" || a.do === "stop" || a.do === "skip");
    for (const a of noted) ownerItem(a.why);
    for (const a of acts) if (a.do === "skip" && !st.paused.includes(a.component!)) st.paused.push(a.component!), ((st.pausedAt ??= {})[a.component!] = st.epoch);
    if (noted.length) commitHistory(`owner list: ${noted.map((a) => a.why).join("; ").slice(0, 100)}`);
    const stop = acts.find((a) => a.do === "stop");
    if (stop) {
      await stopped(rte, st, stop.code!, stop.why);
      return true;
    }
    const pauses = acts.filter((a) => a.do === "pause");
    if (!pauses.length) {
      if (st.run?.status !== "running") setRun(st, { status: "running", phase: st.run?.phase, slot: f.slot });
      return false;
    }
    const until = Math.max(...pauses.map((a) => a.until!));
    const why = pauses.map((a) => a.why).join("; ");
    if (st.run?.status !== "paused" || st.run.why !== why) rte.say(`loop: pause until ${new Date(until).toISOString()}: ${why}`);
    setRun(st, { status: "paused", why, until: new Date(until).toISOString(), phase: st.run?.phase, slot: f.slot });
    while (Date.now() < until && !existsSync(stopFile())) await sleep(Math.min(STOP_POLL_MS, Math.max(1000, until - Date.now())));
  }
}

/** ≤ LOOP.search.cards cards: queued seed cards first, else digests → analyst → critic (§8.2). */
async function propose(rte: Rte, gw: string, st: State): Promise<HypothesisCard[]> {
  if (st.queue.length) return st.queue.splice(0, LOOP.search.cards);
  const sha = championSha();
  const last = (historyRows("checkpoints.jsonl") as StoredCheckpoint[]).at(-1);
  const ck = last && { run: last.run, champion: "B" as Arm };
  const run = `${st.stamp}-e${st.epoch}-analyst`;
  const notes = [...(await agents.championFailures(sha, run, ck)), ...st.lastRuns.flatMap((r) => maybe<agents.FailureNote[]>(runFile(r, "failures.json")) ?? [])];
  // What the coordinator would drop unrun: told up front, so an epoch isn't spent on cards that can't be measured.
  const wont = [
    ...(st.paused.length ? [`paused for a few epochs (dry well): cards on ${st.paused.join(", ")}`] : []),
    ...(rte.o.f["quality-only"] ? ["latency-goal cards: this run is --quality-only (they wait for the PGX)"] : []),
    ...(!hasU1() ? ["cards on the ink readers (marks, arrow, hit, link): no U1 set to check them on, they go to the owner"] : []),
    "patch knobs and frozen areas: they go to the owner unmeasured",
    "a cap on a picture's elements or colors (picture.maxPaths, picture.colors above 0): the owner ruled caps out",
    // e78-h5 and e82-h6 read as no effect at 0 calls: a scan answers no warm-up, and live, a shared call erases a pool's depth.
    "a deeper or earlier warm pool (more warmModel calls): every case is warmed before it's timed and both arms share identical calls, so the A/B can't see it; the owner's to try on prod",
    ...(!variants().illustrationsCalibrated ? ["a keep that switches the picture model (a picture.*Model knob): held for the owner until the judge is calibrated on illustrations"] : []),
  ];
  const decisions = decisionLines(historyRows("decisions.jsonl") as DecisionRow[]);
  const digest = analystDigest({
    championSha: sha, checkpoint: ck, runs: st.lastRuns, wont, failures: notes.map((n) => `${n.case} · ${n.component} · ${n.tag}: ${n.evidence}`),
    decisions,
  });
  const tree = treeOf(sha);
  const analysis = await rte.engine().analyst({ run, token: await agents.slotToken(rte.tokens(), gw), digest, tree, mockApi: await rte.agentMock() });
  put(runFile(run, "analyst.json"), { text: analysis });
  const criticRun = `${st.stamp}-e${st.epoch}-critic`;
  const r = await rte.engine().critic({ run: criticRun, token: await agents.slotToken(rte.tokens(), gw), analysis, digest, tried: decisions, tree, mockApi: await rte.agentMock() });
  // Its answer as written, so a dropped or empty epoch can be read back.
  put(runFile(criticRun, "critic.json"), { text: r.result?.text ?? "", cards: r.cards.map((c) => c.id), dropped: r.dropped });
  if (r.dropped.length) rte.say(`critic: dropped ${r.dropped.join("; ")}`);
  return r.cards.slice(0, LOOP.search.cards);
}

async function loopCheckpoint(rte: Rte, gw: string, st: State): Promise<string> {
  const ck = await runCheckpoint(rte, gw, st.epoch);
  Object.assign(st, { keepsSinceCheckpoint: 0, paused: [], pausedAt: {}, wellFrom: {} });
  saveState(st);
  return ck.id;
}

/**
 * Between epochs: the owner's master (at most daily), testers' new sends (intake: a week spent ends it, and the pause
 * after this waits for the week), a bank refresh (5 keeps, weekly, or queued), the judge canary.
 */
async function between(rte: Rte, gw: string, st: State) {
  if (Date.now() - Date.parse(st.lastOwnerStep ?? "1970-01-01") >= LOOP.sync.minHours * HOUR) await sync(rte, gw, st);
  phase(st, "between epochs: testers' new sends");
  try {
    await intake(rte, gw);
  } catch (err) {
    rte.say(`intake: ${err instanceof WeekSpent ? "every token is past its week; it goes on after the pause" : `stopped: ${msg(err)}; the next epoch's tries again`}`);
  }
  phase(st, "between epochs");
  const lastRefresh = st.lastRefresh ?? maybe<{ at: string }>(join(paths().home, "bank", "gates.json"))?.at;
  if (st.refreshQueued || st.keepsSinceRefresh >= LOOP.bank.refreshEveryKeeps || (lastRefresh && Date.now() - Date.parse(lastRefresh) >= 7 * DAY)) {
    const n = st.refreshes + 1;
    const champ = championArm();
    try {
      await rte.withRig(gw, [champ.tree], async (rig) => {
        const slots = await championPages(rig, champ.tree);
        const ctx: DriveCtx = { run: `${st.stamp}-refresh${n}`, arms: { A: { sha: champ.sha, tuningId: await tuningIdOf(slots[0].A) } }, harnessTag: harnessTag() };
        const no = await probed(rte, ctx, slots[0].A);
        if (no) throw new Error(no);
        const r = await refresh(ctx, slots, n);
        rte.say(`refresh ${n}: ${r.cases.length} new cases ${r.fails.length ? `refused, to bank/archive (the bank with them failed ${r.fails.join("; ")})` : "added"}`);
      });
    } catch (err) {
      ownerItem(`bank refresh ${n} failed: ${msg(err)}`);
      commitHistory(`owner list: bank refresh ${n} failed`);
    }
    Object.assign(st, { refreshes: n, keepsSinceRefresh: 0, refreshQueued: undefined, lastRefresh: new Date().toISOString() });
    saveState(st);
  }
  if (canaryDue()) {
    try {
      const h = await runCanary();
      historyAdd("health.jsonl", h);
      if (!h.pass) ownerItem(`judge drift: the canary agreed on ${(h.detail as { agree: number }).agree} of ${LOOP.canary.packets} stable packets, confirmed`);
      commitHistory(`canary: ${h.pass ? "stable" : "drift"}`);
    } catch (err) {
      rte.say(`canary: skipped (${msg(err)})`);
    }
  }
}

/** One epoch: cards, built ahead (≤ 2 engineers at once) while the ones before them are measured, then decided in turn. */
async function epoch(rte: Rte, gw: string, st: State): Promise<boolean> {
  const started = Date.now();
  if (!st.cards.length) {
    phase(st, `e${st.epoch}: the analyst and critic propose cards`);
    const proposed = cardStates(st.epoch, await propose(rte, gw, st), readFileSync(join(treeOf(championSha()), "src/core/tuning.ts"), "utf8"));
    for (const why of proposed.dropped) rte.say(`not run: ${why}`);
    st.cards = proposed.cards;
    saveState(st);
    rte.say(`epoch ${st.epoch}: ${st.cards.map((c) => `${c.id} ${c.card.kind} ${c.card.component}: ${c.card.change}`).join(" | ") || "no cards"}`);
  }
  // Card rules that need no evidence (§8.4) send a card to the owner before anything is built.
  for (const c of st.cards.filter((x) => x.status === "todo")) {
    const why = cardOwnerReasons(c.card, { u1: hasU1() }).filter((w) => !/patch/.test(w));
    const skip = st.paused.includes(c.card.component) ? `${c.card.component} is paused (dry well)` : rte.o.f["quality-only"] && c.card.goal === "latency" ? "a latency-goal card waits for the PGX (--quality-only)" : undefined;
    if (why.length) ownerItem(`${c.id}: ${c.card.change}: ${why.join("; ")}`), commitHistory(`owner list: ${c.id}`);
    if (why.length || skip) (c.status = "dropped"), rte.say(`${c.id}: not run: ${[...why, skip].filter(Boolean).join("; ")}`);
  }
  const two = limiter(2);
  const built = st.cards.map((c) => (c.status === "todo" ? two(() => build(rte, gw, st, c)) : Promise.resolve()));
  let ck: string | undefined;
  let stopped = false;
  for (const [i, c] of st.cards.entries()) {
    await built[i];
    const skip = c.status === "built" ? sweepSkip(st.cards, c, historyRows("decisions.jsonl") as DecisionRow[]) : undefined;
    if (skip) {
      c.status = "dropped";
      saveState(st);
      rte.say(`${c.id}: not run: ${skip}`);
    }
    // decideCard marks the card done in state.json itself, right as it is recorded. A week spent mid-decision ends it:
    // halt pauses until a week frees up, and the card is decided again (what it paid so far comes from the cache).
    while (c.status === "built" && !stopped && !(stopped = await halt(rte, gw, st)) && (await rebased(rte, gw, st, c))) {
      phase(st, `${c.id}: deciding (${c.card.goal}, ${c.card.component})`);
      try {
        await decideCard(rte, gw, st, c);
      } catch (err) {
        if (err instanceof WeekSpent) {
          rte.say(`${c.id}: ${err.message}: decided again after the pause`);
          continue;
        }
        // A cap, a blocked request or a broken step: the rules say whether the loop goes on.
        rte.say(`${c.id}: failed: ${msg(err)}`);
        if ((stopped = await halt(rte, gw, st, err))) continue;
        throw err;
      }
      const d = st.recent.at(-1);
      if (d?.id === c.id && d.verdict === "owner") await tellOwner(rte, `${c.id} is held for you`, [`${c.card.change}`, "Eval HQ's Needs you has its cases, ledger and patch."]);
    }
    // Here, not only after a decision: a resumed epoch owes the checkpoint a stop just before it skipped.
    if (!stopped && st.keepsSinceCheckpoint >= LOOP.checkpointEveryKeeps && !(stopped = await halt(rte, gw, st))) phase(st, "checkpoint"), (ck = await loopCheckpoint(rte, gw, st));
  }
  await Promise.allSettled(built);
  if (stopped) return false;
  // An epoch that decided nothing (no well-formed card, or every one dropped) pays the analyst and critic again for the
  // same digest: §6.7's rules stop the loop after RULES.emptyEpochs of them in a row.
  st.emptyEpochs = st.cards.some((c) => c.status === "done" && c.verdict !== "deferred") ? 0 : (st.emptyEpochs ?? 0) + 1;
  const rec = await epochRecord(gw, st, started, ck);
  rte.say(`epoch ${st.epoch}: ${rec.decisions.length} decisions, ${rec.cost.calls} calls, $${rec.cost.listUsd.toFixed(2)}, ${rec.minutes.total.toFixed(0)} min`);
  Object.assign(st, { epoch: st.epoch + 1, stamp: stampNow(), cards: [], lastRuns: st.cards.flatMap((c) => (c.run ? [c.run] : [])) });
  saveState(st);
  return true;
}

/** epochs.jsonl and budget.jsonl (§5.3) from the meter, one commit. */
async function epochRecord(gw: string, st: State, started: number, ck?: string): Promise<EpochRow> {
  // The epoch's own runs, R1 beside its keeps, and its checkpoint's.
  const lines = readMeter(paths().calls).filter((l) => l.run.startsWith(`${st.stamp}-e${st.epoch}-`) || l.run.startsWith(`real-r1-${st.stamp}-e${st.epoch}-`) || (ck !== undefined && (l.run.startsWith(ck) || l.run.startsWith(`real-r1-${ck}`))));
  const zero = { calls: 0, usd: 0, agentUsd: 0, in: 0, cacheRead: 0, write5m: 0, write1h: 0, out: 0, thinking: 0 };
  const all = rollup(lines, () => "all").all ?? zero;
  const slots = ((await gatewayStatus(gw)) as { slots: SlotStatus[] }).slots;
  const agentMin = lines.reduce((a, l) => a + ("agent" in l ? (l as AgentLog).minutes : 0), 0);
  const measure = st.cards.reduce((a, c) => a + (c.run ? (maybe<{ meter: { minutes: number } }>(runFile(c.run, "run.json"))?.meter.minutes ?? 0) : 0), 0);
  const total = (Date.now() - started) / 60_000;
  const at = new Date().toISOString();
  const row: EpochRow = {
    epoch: st.epoch, at, era: (historyRows("checkpoints.jsonl").at(-1)?.era ?? 1), machine: arch() === "arm64" ? "pgx" : "laptop", championSha: championSha(), configId,
    decisions: st.cards.filter((c) => c.status === "done").map((c) => c.id), ...(ck ? { checkpoint: ck } : {}),
    cost: {
      listUsd: all.usd, calls: all.calls, agentUsd: all.agentUsd,
      byRole: Object.fromEntries(Object.entries(rollup(lines, (l) => l.role)).map(([k, r]) => [k, { calls: r.calls, usd: r.usd }])),
      tokens: { in: all.in, cacheRead: all.cacheRead, write5m: all.write5m, write1h: all.write1h, out: all.out, thinking: all.thinking },
    },
    minutes: { total, agents: agentMin, measure, idle: Math.max(0, total - agentMin - measure) },
    slots: slots.map((s) => ({ slot: s.slot, fiveHour: s.fiveHour, sevenDay: s.sevenDay, sevenDayAt: s.sevenDayAt, usdThisWindow: s.usdThisWindow, status: s.why ?? s.status ?? "ok" })),
  };
  historyAdd("epochs.jsonl", row);
  logBudget(slots, st.epoch, at);
  recordMachine();
  commitHistory(`epoch ${st.epoch}: ${row.decisions.length} decisions, $${all.usd.toFixed(2)}`);
  return row;
}

function limiter(n: number) {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    while (busy >= n) await new Promise<void>((r) => waiting.push(r));
    busy++;
    try {
      return await f();
    } finally {
      busy--;
      waiting.shift()?.();
    }
  };
}

export async function loop(rte: Rte) {
  // --cap bounds gateway calls only: the critic and engineers would run on the owner's own token past it.
  if (rte.o.devToken) throw new Error("--dev-token is for capped smoke, bake and decide runs: the loop's agent sessions aren't under --cap");
  refuseFactorySlice();
  // First: a second loop refuses before it touches anything; intake or readiness running now is waited for.
  const held = await lock("loop", { wait: true, say: (l) => rte.say(l) });
  const stopBeat = heartbeat((gap) => (rte.suspends.push(Date.now()), rte.say(`loop: a ${Math.round(gap / 1000)}-s suspend: the decision in flight is voided`)));
  let st: State | undefined;
  try {
    needBank();
    openHistory();
    if (!historyRows("checkpoints.jsonl").length) throw new Error("no checkpoint 0 yet: checkpoint --zero --cap 750 first (§11 step 5)");
    const resume = !!rte.o.f.resume || held.stale;
    st = readState() ?? newState(nextEpoch());
    if (!resume) {
      const epochs = rte.num("epochs");
      st.until = epochs === undefined ? undefined : st.epoch + epochs - 1;
      // Starting afresh is the owner's word that what emptied the last epochs is dealt with (e85 and e86's agent bugs
      // stopped the next start before its seed cards ran); --resume keeps the count.
      st.emptyEpochs = 0;
    }
    // Seed cards queue on a resume too (a --resume once dropped them without a word); a card already queued or decided doesn't.
    if (typeof rte.o.f["seed-cards"] === "string") {
      const seen = new Set([...historyRows("decisions.jsonl").map((d) => d.card?.id), ...st.queue.map((c) => c.id), ...st.cards.map((c) => c.card.id)]);
      st.queue.push(...(JSON.parse(readFileSync(rte.o.f["seed-cards"], "utf8")) as HypothesisCard[]).filter((c) => !seen.has(c.id)));
    }
    // A stop asked for while no loop ran is stale: this start is the owner's newer word.
    if (existsSync(stopFile())) rmSync(stopFile()), rte.say("loop: an old stop-after request was dropped (this start is newer)");
    readyAtStart = readyOk();
    phase(st, "starting");
    rte.say(`loop: ${resume ? "resuming" : "starting"} at epoch ${st.epoch}${st.until !== undefined ? ` (to ${st.until})` : ""}, champion ${championSha().slice(0, 12)}`);
    const run = st;
    await rte.withGateway(async (gw) => {
      while (run.until === undefined || run.epoch <= run.until) {
        if (await halt(rte, gw, run)) return;
        // After intake, an owner step, a refresh or the canary: the rules again before the next epoch.
        if (!run.cards.length && (phase(run, "between epochs"), await between(rte, gw, run), await halt(rte, gw, run))) return;
        const moved = run.cards.length ? undefined : rotateMeter(paths().calls);
        if (moved) rte.say(`loop: the meter moved aside to ${moved} (over ${METER_ROTATE_BYTES >> 20} MB)`);
        if (!(await epoch(rte, gw, run))) return;
      }
      if (run.keepsSinceCheckpoint > 0) phase(run, "checkpoint"), await loopCheckpoint(rte, gw, run);
      await stopped(rte, run, "done", `done at epoch ${run.epoch - 1}, champion ${championSha().slice(0, 12)}`);
    });
  } catch (err) {
    // Its unit restarts it (evals/ops/units.sh); the error's own text stays in the log.
    if (st) setRun(st, { status: "stopped", code: "crashed", why: "a step threw (the log has the error); its unit restarts the loop", slot: st.run?.slot });
    throw err;
  } finally {
    stopBeat();
    held.release();
  }
}

/** budget.jsonl: each slot's spend and the server's limits, now. */
function logBudget(slots: SlotStatus[], epoch: number, at: string) {
  for (const s of slots)
    historyAdd("budget.jsonl", { at, epoch, slot: s.slot, usdThisWindow: s.usdThisWindow, fiveHour: s.fiveHour, sevenDay: s.sevenDay, sevenDayAt: s.sevenDayAt, status: s.why ?? s.status ?? "ok", resetsAt: s.resetsAt, usd7d: s.usd7d });
}

/** WEEK_CHECK by hand, the loop stopped: reads each parked token's week again (one one-word call each) and logs every slot. */
export async function weekCmd(rte: Rte) {
  rte.needCap();
  const held = await lock("week"); // a running loop's gateway owns slots.json
  try {
    openHistory();
    await rte.withGateway(async (gw) => {
      await recheckWeeks(rte, gw);
      const slots = ((await gatewayStatus(gw)) as { slots: SlotStatus[] }).slots;
      for (const s of slots) rte.say(`week: token ${s.slot}: ${weekOf(s)} of its weekly limit${s.sevenDayAt ? `, read ${new Date(s.sevenDayAt).toISOString()}` : ""}; ${s.why ? `parked: ${s.why}` : "in use"}`);
      logBudget(slots, readState()?.epoch ?? 0, new Date().toISOString());
      commitHistory("week: the tokens' weekly use, read again");
    });
  } finally {
    held.release();
  }
}

/** The owner's graceful stop: the running loop stops before its next step (a decision, an epoch, a checkpoint), or a pause. */
export async function stopAfterCmd(rte: Rte) {
  if (rte.o.f.cancel) {
    if (existsSync(stopFile())) rmSync(stopFile());
    return void rte.say("stop-after: cancelled");
  }
  rte.say(`stop-after: ${requestStop()}`);
}
/** Asks the running loop to stop before its next step; what that means now, in the owner's words. */
export function requestStop(): string {
  put(stopFile(), { at: new Date().toISOString() });
  const h = holder();
  return h?.live && h.cmd === "loop" ? "the loop stops before its next step (what's in flight finishes first); rte run goes on from there" : "no loop is running (its next start drops this request)";
}

/**
 * The loop's unit gave up (evals/ops/units.sh: OnFailure): its loop, or the readiness check before it, failed past the
 * restarts it gets. Recorded for the status strip and the owner list, and mailed: from here the loop waits for the owner.
 */
export async function unitFailedCmd(rte: Rte) {
  const why = "the loop's unit failed past its restarts (the loop or its readiness check threw; the log has the errors)";
  const st = readState();
  if (st) setRun(st, { status: "stopped", code: "crashed", why, slot: st.run?.slot });
  try {
    openHistory();
    ownerItem(why);
    commitHistory("owner list: the loop's unit failed");
  } catch (err) {
    rte.say(`unit-failed: not on the owner list: ${msg(err)}`);
  }
  await tellOwner(rte, "the loop's unit failed", [why, "Look at rte status and the log, then start it again with rte run."]);
}

/**
 * Whether the loop's unit should run (its ExecCondition: exit 0 yes, 1 no): not after a stop that is the owner's (asked
 * for, done, or one of §6.7's), so a reboot doesn't undo it; yes after a crash, which its restarts are for. `--set`: the
 * owner's word to run it again (bin/rte run).
 */
export async function wantedCmd(rte: Rte) {
  const st = readState();
  if (rte.o.f.set) {
    if (!st) return;
    // As a fresh start's: no --epochs bound, and what emptied the last epochs is the owner's to have dealt with.
    Object.assign(st, { until: undefined, emptyEpochs: 0 });
    return void setRun(st, { status: "running", phase: "starting (rte run)" });
  }
  const no = st?.run?.status === "stopped" && st.run.code !== "crashed";
  rte.say(no ? `wanted: no, the loop stopped for the owner (${st!.run!.code}): rte run starts it` : "wanted: yes");
  return no ? 1 : 0;
}
