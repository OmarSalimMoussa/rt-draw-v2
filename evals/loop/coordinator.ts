// The loop (§8.1): epochs of cards, §6.7's rules before each step, the owner's notices, checkpoints, the bank's refresh, the
// canary, the epoch's record; rte week and rte stop-after.
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, statfsSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { canaryDue, runCanary } from "../judge/canary.ts";
import { calibrationFile, variants } from "../judge/judge.ts";
import * as agents from "../optimizer/agents.ts";
import { analystDigest } from "../optimizer/digest.ts";
import { cardOwnerReasons } from "../optimizer/gates.ts";
import { harnessTag } from "./ab.ts";
import { refresh } from "./bank.ts";
import type { StoredCheckpoint } from "./checkpoint.ts";
import { CapReached, ask, gatewayStatus } from "./client.ts";
import { LOOP, NOTIFY, WEEK_CHECK, configId } from "./config.ts";
import type { DriveCtx } from "./drive.ts";
import { commitHistory, historyAdd, historyRows, openHistory, ownerItem, recordMachine, triedIndex } from "./history.ts";
import { heartbeat, onAC, refuseFactorySlice } from "./load.ts";
import { readMeter, rollup } from "./meter.ts";
import { paths } from "./paths.ts";
import { appendLine, put, runFile } from "./record.ts";
import { cardStates, nearWins, sweepSkip } from "./search.ts";
import { type Facts, type Notice, type State, lock, newState, notices, readState, rules, saveState, stampNow } from "./state.ts";
import type { SlotN } from "./tokens.ts";
import { treeOf } from "./trees.ts";
import type { AgentLog, Arm, DecisionRow, EpochRow, HypothesisCard } from "./types.ts";
import { runCheckpoint, sync } from "./commands/checkpoint.ts";
import { probed, readyOk } from "./commands/setup.ts";
import { build, decideCard, rebased } from "./decide.ts";
import { DAY, HOUR, type Rte, championArm, championPages, championSha, hasU1, maybe, msg, needBank, nextEpoch, sleep, tuningIdOf } from "./rte.ts";

let readyAtStart = false;
let diskAtStart: { at: number; gb: number } | undefined;
/** $ a meter line spent: an agent session's cost, an upstream call's list $ (a follower and a replay pay nothing). */
const paidUsd = (l: ReturnType<typeof readMeter>[number]) => ("agent" in l ? l.totalCostUsd : l.mode === "live" && l.shared !== "follower" ? l.listUsd : 0);

/** The meter read as it grows: $ and upstream calls since `from` (ms), by role, without rereading the whole file. */
class MeterTail {
  private off = 0;
  private rest = "";
  usd = 0;
  calls = 0;
  byRole: Record<string, number> = {};
  private file: string;
  private from: number;
  constructor(file: string, from: number) {
    this.file = file;
    this.from = from;
  }
  read(): this {
    if (!existsSync(this.file)) return this;
    const size = statSync(this.file).size;
    if (size <= this.off) return this;
    const buf = Buffer.alloc(size - this.off);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.off);
    } finally {
      closeSync(fd);
    }
    this.off = size;
    const parts = (this.rest + buf.toString("utf8")).split("\n");
    this.rest = parts.pop() ?? "";
    for (const raw of parts) {
      if (!raw.trim()) continue;
      const l = JSON.parse(raw) as ReturnType<typeof readMeter>[number];
      if (Date.parse(l.at) < this.from) continue;
      const usd = paidUsd(l);
      this.usd += usd;
      if (!("agent" in l) && usd > 0) this.calls++;
      this.byRole[l.role] = (this.byRole[l.role] ?? 0) + usd;
    }
    return this;
  }
}

/** This leg of the loop (since it last started or resumed): its notices (config.ts' NOTIFY), the meter since it began. */
let leg = { start: Date.now(), every: { ...NOTIFY } as Record<keyof typeof NOTIFY, number>, sent: new Set<string>(), spent: new MeterTail("", 0) };
const stopFile = () => join(paths().home, "stop.request");
/** A long step (a decision, a checkpoint) still gets its notices: the clock and the meter are looked at this often. */
const NOTICE_MS = 60_000;
let noticeChain: Promise<void> = Promise.resolve();
/** Sends the notices due (and `extra`): the log and notices.jsonl, each once per leg. Never stops anything. */
const notify = (rte: Rte, gw: string, st: State, extra?: Omit<Notice, "key">) => (noticeChain = noticeChain.then(() => notifyNow(rte, gw, st, extra)).catch((err) => rte.say(`notice: skipped (${msg(err)})`)));
async function notifyNow(rte: Rte, gw: string, st: State, extra?: Omit<Notice, "key">) {
  const spent = leg.spent.read();
  const decided = st.recent.filter((d) => Date.parse(d.at) >= leg.start);
  const cks = (historyRows("checkpoints.jsonl") as StoredCheckpoint[]).filter((c) => Date.parse(c.at) >= leg.start);
  const due = notices({ now: Date.now(), leg: { start: leg.start, usd: spent.usd, decisions: decided.length, checkpoints: cks.map((c) => c.id) }, every: leg.every }, leg.sent);
  if (extra) due.push({ key: `${extra.kind}:${Date.now()}`, ...extra });
  if (!due.length) return;
  const rows = new Map(historyRows("decisions.jsonl").map((d) => [d.id, d]));
  const minutes = (Date.now() - leg.start) / 60_000;
  const byRole = Object.entries(spent.byRole).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([role, usd]) => `${role} $${usd.toFixed(2)}`);
  const summary = {
    epoch: st.epoch, champion: championSha(), minutes: Math.round(minutes), calls: spent.calls, listUsd: spent.usd, byRole,
    decided: decided.map((d) => ({ id: d.id, verdict: d.verdict, change: rows.get(d.id)?.card?.change ?? d.component, why: rows.get(d.id)?.reasons.slice(0, 2) })),
    checkpoints: cks.map((c) => ({ id: c.id, trust: c.trust, share: c.share.all?.share, ...(c.latency.slower ? { slower: c.latency.slower } : {}) })),
    stop: "rte stop-after (before the next step: nothing lost; loop --resume goes on)",
  };
  for (const n of due) {
    leg.sent.add(n.key);
    appendLine(join(paths().home, "notices.jsonl"), { at: new Date().toISOString(), ...n, ...summary });
    rte.say(`loop: NOTICE (${n.kind}): ${n.why}; this leg ${summary.minutes} min, ${summary.calls} calls, $${spent.usd.toFixed(2)} list${byRole.length ? ` (${byRole.slice(0, 3).join(", ")})` : ""}, ${decided.length} decisions${n.kind === "stopped" ? "" : `; to stop: ${summary.stop}`}`);
  }
}
type SlotStatus = { slot: SlotN; fiveHour?: number; sevenDay?: number; sevenDayAt?: number; resetsAt?: number; status?: string; usdThisWindow: number; usd7d: number; why?: string };

async function facts(rte: Rte, gw: string, st: State, err?: unknown): Promise<Facts> {
  const s = (await gatewayStatus(gw)) as { pace: Facts["pace"]; slots: SlotStatus[]; cap?: number; capReached: boolean };
  const lines = readMeter(paths().calls);
  const fs = statfsSync(paths().home);
  const gb = (fs.bavail * fs.bsize) / 1e9;
  diskAtStart ??= { at: Date.now(), gb };
  const perDay = ((diskAtStart.gb - gb) / (Date.now() - diskAtStart.at)) * DAY;
  return {
    now: Date.now(), pace: s.pace, recent: st.recent, ownerStepAt: Date.parse(st.lastOwnerStep ?? "1970-01-01"), checkpointAt: Date.parse(historyRows("checkpoints.jsonl").at(-1)?.at ?? "1970-01-01"), ready: readyAtStart, calib: rte.o.mockApi ? "dry" : maybe<{ outcome: string }>(calibrationFile())?.outcome,
    error: err === undefined ? undefined : msg(err), capped: err instanceof CapReached || s.capReached,
    blocked: st.blocked, emptyEpochs: st.emptyEpochs ?? 0, overloads: lines.flatMap((l) => ("agent" in l || !l.apiError || !/overload|529/i.test(l.apiError) ? [] : [Date.parse(l.at)])), diskGb: gb,
    daysLeft: perDay > 0 ? Math.max(0, (gb - LOOP.diskPauseGb) / perDay) : undefined, onAC: onAC(),
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
    rte.say(`loop: token ${slot}'s week read again: ${weekOf(s.slots.find((x) => x.slot === slot))} to ${weekOf(now)} of its weekly limit (the loop stops at ${Math.round(LOOP.weekSevenDayMax * 100)}%)${error ? `; the call failed: ${error}` : ""}; ${now?.why ? `still parked: ${now.why}` : "back in use"}`);
  }
}

/** §6.7 before new work: true when a rule stops the loop (it says why); pauses wait here. `err`: what the step threw. */
async function halt(rte: Rte, gw: string, st: State, err?: unknown): Promise<boolean> {
  await notify(rte, gw, st);
  // The owner asked for a stop (rte stop-after): here, between steps, nothing is lost.
  if (existsSync(stopFile())) {
    rmSync(stopFile());
    rte.say("loop: STOP: as the owner asked (rte stop-after); loop --resume goes on from here");
    await notify(rte, gw, st, { kind: "stopped", why: "stopped as asked (rte stop-after); loop --resume goes on from here" });
    return true;
  }
  for (;;) {
    await recheckWeeks(rte, gw);
    const acts = rules(await facts(rte, gw, st, err));
    const noted = acts.filter((a) => a.do === "owner" || a.do === "stop" || a.do === "skip");
    for (const a of noted) ownerItem(a.why);
    for (const a of acts) if (a.do === "skip" && !st.paused.includes(a.component!)) st.paused.push(a.component!);
    if (noted.length) commitHistory(`owner list: ${noted.map((a) => a.why).join("; ").slice(0, 100)}`);
    const stop = acts.find((a) => a.do === "stop");
    if (stop) {
      rte.say(`loop: STOP: ${stop.why}`);
      await notify(rte, gw, st, { kind: "stopped", why: `the loop stopped: ${stop.why}` });
      return true;
    }
    const pauses = acts.filter((a) => a.do === "pause");
    if (!pauses.length) return false;
    const until = Math.max(...pauses.map((a) => a.until!));
    rte.say(`loop: pause until ${new Date(until).toISOString()}: ${pauses.map((a) => a.why).join("; ")}`);
    await sleep(Math.max(1000, until - Date.now()));
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
    ...(st.paused.length ? [`paused until the next checkpoint (dry well): cards on ${st.paused.join(", ")}`] : []),
    ...(rte.o.f["quality-only"] ? ["latency-goal cards: this run is --quality-only (they wait for the PGX)"] : []),
    ...(!hasU1() ? ["cards on the ink readers (marks, arrow, hit, link): no U1 set to check them on, they go to the owner"] : []),
    "patch knobs and frozen areas: they go to the owner unmeasured",
    ...(!variants().illustrationsCalibrated ? ["a keep that switches the picture model (a picture.*Model knob): held for the owner until the judge is calibrated on illustrations"] : []),
  ];
  const digest = analystDigest({
    championSha: sha, checkpoint: ck, runs: st.lastRuns, wont, failures: notes.map((n) => `${n.case} · ${n.component} · ${n.tag}: ${n.evidence}`),
    ledger: historyRows("decisions.jsonl").slice(-12).map((d) => `${d.id} ${d.card?.change ?? d.reasons[0]} → ${d.verdict}`), tried: triedIndex(), nearWins: nearWins(historyRows("decisions.jsonl") as DecisionRow[]),
  });
  const tree = treeOf(sha);
  const analysis = await rte.engine().analyst({ run, token: await agents.slotToken(rte.tokens(), gw), digest, tree, mockApi: await rte.agentMock() });
  const criticRun = `${st.stamp}-e${st.epoch}-critic`;
  const r = await rte.engine().critic({ run: criticRun, token: await agents.slotToken(rte.tokens(), gw), analysis, digest, tried: triedIndex(), tree, mockApi: await rte.agentMock() });
  // Its answer as written, so a dropped or empty epoch can be read back.
  put(runFile(criticRun, "critic.json"), { text: r.result?.text ?? "", cards: r.cards.map((c) => c.id), dropped: r.dropped });
  if (r.dropped.length) rte.say(`critic: dropped ${r.dropped.join("; ")}`);
  return r.cards.slice(0, LOOP.search.cards);
}

async function loopCheckpoint(rte: Rte, gw: string, st: State): Promise<string> {
  const ck = await runCheckpoint(rte, gw, st.epoch);
  Object.assign(st, { keepsSinceCheckpoint: 0, paused: [] });
  saveState(st);
  return ck.id;
}

/** Between epochs: the owner's master (at most daily), a bank refresh (5 keeps, weekly, or queued), the judge canary. */
async function between(rte: Rte, gw: string, st: State) {
  if (Date.now() - Date.parse(st.lastOwnerStep ?? "1970-01-01") >= LOOP.sync.minHours * HOUR) await sync(rte, gw, st);
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
    // decideCard marks the card done in state.json itself, right as it is recorded.
    if (c.status === "built" && !stopped && !(stopped = await halt(rte, gw, st)) && (await rebased(rte, gw, st, c))) {
      try {
        await decideCard(rte, gw, st, c);
      } catch (err) {
        // A cap, a blocked request or a broken step: the rules say whether the loop goes on.
        rte.say(`${c.id}: failed: ${msg(err)}`);
        if ((stopped = await halt(rte, gw, st, err))) continue;
        throw err;
      }
    }
    // Here, not only after a decision: a resumed epoch owes the checkpoint a stop just before it skipped.
    if (!stopped && st.keepsSinceCheckpoint >= LOOP.checkpointEveryKeeps && !(stopped = await halt(rte, gw, st))) ck = await loopCheckpoint(rte, gw, st);
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
  const held = lock(); // first: a second loop refuses before it touches anything
  const stopBeat = heartbeat((gap) => (rte.suspends.push(Date.now()), rte.say(`loop: a ${Math.round(gap / 1000)}-s suspend: the decision in flight is voided`)));
  try {
    needBank();
    openHistory();
    if (!historyRows("checkpoints.jsonl").length) throw new Error("no checkpoint 0 yet: checkpoint --zero --cap 750 first (§11 step 5)");
    const resume = !!rte.o.f.resume || held.stale;
    const st = readState() ?? newState(nextEpoch());
    if (!resume) {
      const epochs = rte.num("epochs");
      st.until = epochs === undefined ? undefined : st.epoch + epochs - 1;
      if (typeof rte.o.f["seed-cards"] === "string") {
        const seen = new Set([...historyRows("decisions.jsonl").map((d) => d.card?.id), ...st.queue.map((c) => c.id), ...st.cards.map((c) => c.card.id)]);
        st.queue.push(...(JSON.parse(readFileSync(rte.o.f["seed-cards"], "utf8")) as HypothesisCard[]).filter((c) => !seen.has(c.id)));
      }
    }
    saveState(st);
    const every = Object.fromEntries(Object.entries(NOTIFY).map(([k, v]) => [k, rte.num(`notify-${k}`) ?? v])) as typeof leg.every;
    for (const [k, v] of Object.entries(every)) if (!(Number.isFinite(v) && v >= 0)) throw new Error(`--notify-${k} takes a number ≥ 0 (0 is off)`);
    const start = Date.now();
    leg = { start, every, sent: new Set(), spent: new MeterTail(paths().calls, start) };
    // A stop asked for while no loop ran is stale: this start is the owner's newer word.
    if (existsSync(stopFile())) rmSync(stopFile()), rte.say("loop: an old stop-after request was dropped (this start is newer)");
    readyAtStart = readyOk();
    rte.say(`loop: ${resume ? "resuming" : "starting"} at epoch ${st.epoch}${st.until !== undefined ? ` (to ${st.until})` : ""}, champion ${championSha().slice(0, 12)}, notices every ${["decisions", "minutes", "usd"].map((k) => `${k} ${leg.every[k as keyof typeof NOTIFY] || "off"}`).join(", ")}, checkpoint ${leg.every.checkpoint ? "on" : "off"}`);
    await rte.withGateway(async (gw) => {
      const ticker = setInterval(() => void notify(rte, gw, st), NOTICE_MS);
      try {
        while (st.until === undefined || st.epoch <= st.until) {
          if (await halt(rte, gw, st)) return;
          // After an owner step, a refresh or the canary: the rules (and the owner's notices) again before the next epoch.
          if (!st.cards.length && ((await between(rte, gw, st)), await halt(rte, gw, st))) return;
          if (!(await epoch(rte, gw, st))) return;
        }
        if (st.keepsSinceCheckpoint > 0) await loopCheckpoint(rte, gw, st);
        rte.say(`loop: done at epoch ${st.epoch - 1}, champion ${championSha().slice(0, 12)}`);
        await notify(rte, gw, st, { kind: "stopped", why: `the loop is done at epoch ${st.epoch - 1}` });
      } finally {
        clearInterval(ticker);
        await noticeChain;
      }
    });
  } finally {
    stopBeat();
    held.release();
  }
}

/** The owner's graceful stop: the running loop stops before its next step (a decision, an epoch, a checkpoint). */
/** budget.jsonl: each slot's spend and the server's limits, now. */
function logBudget(slots: SlotStatus[], epoch: number, at: string) {
  for (const s of slots)
    historyAdd("budget.jsonl", { at, epoch, slot: s.slot, usdThisWindow: s.usdThisWindow, fiveHour: s.fiveHour, sevenDay: s.sevenDay, sevenDayAt: s.sevenDayAt, status: s.why ?? s.status ?? "ok", resetsAt: s.resetsAt, usd7d: s.usd7d });
}

/** WEEK_CHECK by hand, the loop stopped: reads each parked token's week again (one one-word call each) and logs every slot. */
export async function weekCmd(rte: Rte) {
  rte.needCap();
  const held = lock(); // a running loop's gateway owns slots.json
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

export async function stopAfterCmd(rte: Rte) {
  if (rte.o.f.cancel) {
    if (existsSync(stopFile())) rmSync(stopFile());
    return void rte.say("stop-after: cancelled");
  }
  put(stopFile(), { at: new Date().toISOString() });
  rte.say(existsSync(paths().lock) ? "stop-after: the loop stops before its next step (what's in flight finishes first); loop --resume goes on from there" : "stop-after: no loop is running (its next start drops this request)");
}
