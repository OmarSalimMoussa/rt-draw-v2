// The A/B runner (spec §1.2–1.5, §5.2, §7.1–7.5; F14, F19, F34–F36, F41, F42): G2 and G3 decision
// runs, the A/A runs (shared in timed replay, and unshared), the calibration contrast and the
// checkpoints. Both arms of a case start from the same banked fork point on freshly reloaded bridge
// pages (the product keeps every call and span in memory, so a reused tab drifts through a run), and
// are sent the case at the same moment, in a seeded, alternated and recorded order, through the
// gateway: shared, cached, replayed or scanned as the run says. A case that trips a per-case invariant
// is void, never a product result, and flags the run. Decision runs add Rule F's looks (verdict.ts),
// live top-ups, the held-out gate and, for class D, continuation forks (a veto only).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { View } from "../../src/core/board.ts";
import type { Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";
import { draw, positionsFor } from "../judge/judge.ts";
import { type Positions, caseFile } from "../judge/packet.ts";
import { OVERUSE } from "../optimizer/patterns.ts";
import { type Chrome, type Page, capture, launchChrome } from "./chrome.ts";
import { endCase, gatewayStatus, setMode } from "./client.ts";
import { LOOP, configId } from "./config.ts";
import type { RunMode } from "./gateway.ts";
import { type Machine, beforeWave, sampleLoad } from "./load.ts";
import { appendRow, caseMetrics, readRows, rowOf } from "./metrics.ts";
import { paths } from "./paths.ts";
import { appendLine, caseDir, isDone, put, putImage, runCaseDone, runFile, writeArm, writeRun } from "./record.ts";
import { type ArmServer, serveArm } from "./servers.ts";
import { entryOrder, seedOf } from "./stats.ts";
import { type Decision, type LoopState, decide } from "./verdict.ts";
import type {
  Arm, CallLog, CaseInfo, CaseInput, DecisionClass, Fork, HypothesisCard, Readings, RecordedReply, Row, RunKind, SceneJSON, SendOutcome,
} from "./types.ts";

/** The first arm server's port; each further tree takes the next (spec §7.2: 5300 + 2k, 5301 + 2k). */
const PORT = 5300;
/** The case files a run copies when a case's inputs aren't the bank's (the yardstick's bench copies). */
export const INPUT_FILES = ["case.json", "input.json", "before.scene.json", "meant.json", "expectation.json", "readings.json", "before-ink.jpg"];

const UP = "new Promise((r) => { const t = () => (window.rtEval ? r() : setTimeout(t, 20)); t(); })";
/** The stage as the judge sees it, hashed in the page: picture clip ids count up on every render (timing.ts names them alike). */
const SVG_HASH = `crypto.subtle.digest("SHA-256", new TextEncoder().encode(document.querySelector(".stage > svg").outerHTML.replace(/pic-clip-\\d+/g, "pic-clip")))
  .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""))`;
const js = JSON.stringify;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? json<T>(file) : undefined);
const ARMS: Arm[] = ["A", "B"];

// ---- The rig: one Chrome, an arm server per tree, a page per (slot, arm, tree)

/** What an arm serves: a commit's tree, and for a knob card the tuning laid over its defaults. */
export type ArmSpec = { sha: string; tree: string; tuning?: Record<string, number> };
export type Arms = Record<Arm, ArmSpec>;
type Tab = { page: Page; errors: string[] };
export type Rig = {
  gateway: string; slots: number;
  /** Requests chrome.ts' allowlist failed: any one aborts the run. */
  blocked: string[];
  tab(slot: number, arm: Arm, tree: string): Promise<Tab>;
  close(): Promise<void>;
};

/**
 * Opens the rig a decision's runs share (scan, G2, G3): each tree's first bridge load warms its Vite before any timed case.
 * A tree listed twice is served twice, arm B's pages on the second copy: an A/A's arms get a Vite each, as an A/B's do
 * (one Vite for both put B's requests behind A's, +31 ms on B's resolver call, and a dry checkpoint 0 failed its A/A on TTFC).
 */
export async function openRig(o: { trees: string[]; gateway: string; slots: number; port?: number }): Promise<Rig> {
  const trees = o.trees;
  const servers: ArmServer[] = [];
  const blocked: string[] = [];
  let chrome: Chrome | undefined;
  const close = async () => {
    await chrome?.close();
    for (const s of servers) await s.close();
  };
  try {
    for (const [i, t] of trees.entries()) servers.push(await serveArm(t, (o.port ?? PORT) + i, o.gateway));
    chrome = await launchChrome({ dir: join(paths().home, "chrome", String(process.pid)), onBlocked: (url) => blocked.push(url) });
  } catch (err) {
    await close();
    throw err;
  }
  const tabs = new Map<string, Promise<Tab>>();
  async function open(slot: number, arm: Arm, tree: string): Promise<Tab> {
    const server = servers[arm === "B" ? trees.lastIndexOf(tree) : trees.indexOf(tree)];
    if (!server) throw new Error(`the rig doesn't serve ${tree}`);
    const page = await chrome!.newPage(server.url, { run: "-", case: "-", arm, slot });
    const tab: Tab = { page, errors: [] };
    page.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => tab.errors.push(d.exception?.description ?? d.text));
    await page.send("Runtime.enable");
    await page.goto(`${server.url}/evals/bridge/`);
    await page.eval(UP);
    return tab;
  }
  return {
    gateway: o.gateway, slots: o.slots, blocked,
    tab(slot, arm, tree) {
      const key = `${slot}|${arm}|${tree}`;
      if (!tabs.has(key)) tabs.set(key, open(slot, arm, tree));
      return tabs.get(key)!;
    },
    close,
  };
}

// ---- A run's cases

/** The structural part of judge.ts' judging() a run uses; a check may hand in a canned one. */
export type Judge = { judgeCase(caseId: string, positions: Positions): Promise<unknown>; flips?(): { audited: number; flipped: number } };
type SendInput = { words: Word[] | string; strokes: Stroke[] };
/** Planted faults, for checks only (as ready.ts' page hook). */
export type Faults = {
  /** What one arm is sent instead (a forced input mismatch). */
  input?: (caseId: string, arm: Arm, i: SendInput) => SendInput;
  /** After both sends, before the case ends at the gateway (a check stalls the gateway here). */
  afterSend?: (caseId: string) => Promise<void>;
};
export type RunSpec = {
  run: string; kind: RunKind; arms: Arms; mode: RunMode;
  /** false: every call independent (checkpoints, the unshared A/A). */
  share: boolean;
  /** Request hashes the diffscan found in both arms: served from the bank on their recorded clock in a live run. */
  cached?: string[];
  seed: string;
  card?: HypothesisCard;
  judge?: Judge;
  /** Where a case's inputs live when they aren't the bank's: they're copied into the run first. */
  source?: (caseId: string) => string | undefined;
  /** A row's affected flag and class (the diffscan's, per case); by default affected and of class `cls` (Q). */
  classify?: (caseId: string) => { affected: boolean; class: DecisionClass };
  cls?: DecisionClass;
  /** How long a wave waits for a quiet machine before running one slot smaller (load.ts' default: 5 min). */
  loadWaitMs?: number;
  faults?: Faults;
};
/** fork.json as written here: §3.3's fields plus what the invariants and continuations read. */
export type ForkFile = Fork & { enterAt: Record<Arm, number>; pageOrigin: Record<Arm, number>; cameras: Record<Arm, View>; svg: Record<Arm, string>; inputHash: Record<Arm, string>; sceneHash: Record<Arm, string>; loopP99Ms: number };

/** A case input's hash, as each arm was sent it. */
export const inputHashOf = (i: SendInput) => sha(js({ words: i.words, strokes: i.strokes }));

/**
 * Which arm is sent first on the i-th case: each consecutive pair has A first once, a seeded coin
 * picking which, so every even prefix is exactly balanced (the trust check's dispatch band).
 */
export const firstArm = (seed: string, i: number): Arm => ((i % 2 === 0) === draw(seed, "dispatch", String(i >> 1)) < 0.5 ? "A" : "B");

/** The machine's V9 dispatch limit: the ladder's p99 at the knee (machine.json), else the frozen cap. */
const dispatchLimit = () => maybe<Machine>(paths().machine)?.dispatchLimitMs ?? LOOP.dispatchOffsetCapMs;

/** This run's meter lines, read incrementally: the meter holds every run's calls. */
function meterTail(run: string) {
  const mine: CallLog[] = [];
  let pos = 0;
  return () => {
    const file = paths().calls;
    if (!existsSync(file)) return mine;
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= pos) return mine;
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      const end = buf.lastIndexOf(10) + 1; // whole lines only
      for (const l of buf.subarray(0, end).toString("utf8").split("\n")) if (l && l.includes(`"run":${js(run)}`)) mine.push(JSON.parse(l));
      pos += end;
    } finally {
      closeSync(fd);
    }
    return mine;
  };
}

/** A product call (an arm's), not the harness's own roles. */
export const product = (c: CallLog) => !["driver", "judge", "craft", "expectation", "miss", "failure", "probe", "analyst"].includes(c.role);

/** A run in progress: cases go in through add(), in entry order (dispatch order and judge positions follow it). */
export function begin(rig: Rig, s: RunSpec) {
  const p = paths();
  const order: string[] = [];
  const done = new Map(readRows(s.run).map((r) => [r.case, r])); // a resumed run keeps its finished cases
  const meter = meterTail(s.run);
  const invariants: { case: string; why: string }[] = [];
  const started = Date.now();
  const sampler = setInterval(() => appendLine(runFile(s.run, "load.ndjson"), sampleLoad()), 5000);
  sampler.unref();
  const ready = setMode(s.run, s.mode, { share: s.share, cached: s.cached }, rig.gateway).then((r) => {
    if (r.error) throw new Error(`gateway: ${r.error}`);
  });

  async function fork(id: string, i: number, slot: number): Promise<Row> {
    const dir = caseDir(s.run, id);
    if (isDone(dir) && done.has(id)) return done.get(id)!;
    const src = s.source?.(id);
    if (src) for (const f of INPUT_FILES) if (existsSync(join(src, f)) && !existsSync(join(dir, f))) f.endsWith(".jpg") ? putImage(join(dir, f), readFileSync(join(src, f))) : put(join(dir, f), json(join(src, f)));
    const at = <T>(f: string, run: string | undefined = s.run) => json<T>(caseFile(id, f, run));
    const info = at<CaseInfo>("case.json"), input = at<CaseInput>("input.json"), before = at<SceneJSON>("before.scene.json");
    const tabs = Object.fromEntries(await Promise.all(ARMS.map(async (a) => [a, await rig.tab(slot, a, s.arms[a].tree)] as const))) as Record<Arm, Tab>;
    // A fresh page per case: the product keeps every call and span it ever made in memory.
    const origin = {} as Record<Arm, number>, sceneHash = {} as Record<Arm, string>;
    await Promise.all(ARMS.map(async (a) => {
      const { page } = tabs[a];
      page.labels = { run: s.run, case: id, arm: a, slot };
      tabs[a].errors.length = 0;
      await page.reload();
      await page.eval(UP);
      origin[a] = await page.eval<number>("performance.timeOrigin");
      sceneHash[a] = (await page.eval<{ sceneHash: string }>(`rtEval.load(${js({ scene: before, camera: input.camera, tuning: s.arms[a].tuning })})`)).sceneHash;
    }));
    const first = firstArm(s.seed, i);
    const sendOf = (a: Arm) => s.faults?.input?.(id, a, { words: input.words, strokes: input.strokes }) ?? { words: input.words, strokes: input.strokes };
    const payload = { A: sendOf("A"), B: sendOf("B") };
    // Both evaluations go out in the same tick, the first arm's first: "the same moment" through one CDP pipe.
    const sent = {} as Record<Arm, Promise<SendOutcome>>;
    for (const a of first === "A" ? ARMS : (["B", "A"] as Arm[])) sent[a] = tabs[a].page.eval<SendOutcome>(`rtEval.send(${js(payload[a])})`);
    const out = { A: await sent.A, B: await sent.B };
    await s.faults?.afterSend?.(id);
    const end = (await endCase(s.run, id, rig.gateway)) as { loopP99Ms: number; calls: Record<string, RecordedReply[]> };
    const lines = meter().filter((c) => c.case === id);
    const enterAt = { A: origin.A + out.A.timing.enterAt, B: origin.B + out.B.timing.enterAt };
    const offset = Math.round((enterAt[first === "A" ? "B" : "A"] - enterAt[first]) * 10) / 10;
    const svg = {} as Record<Arm, string>;
    for (const a of ARMS) {
      const o = out[a];
      const calls = lines.filter((c) => c.arm === a && product(c));
      const role = (r: RegExp) => calls.find((c) => r.test(c.role));
      svg[a] = await tabs[a].page.eval<string>(SVG_HASH);
      writeArm(s.run, id, a, {
        "result.json": {
          ops: o.ops, reply: o.reply, error: o.error, pics: o.pics, stopReasons: calls.map((c) => c.stopReason).filter((x): x is string => !!x),
          calls: calls.map((c) => ({ role: c.role, reqHash: c.reqHash, shared: c.shared, mode: c.mode, ms: c.ms, firstMs: c.firstMs, waitMs: c.waitMs, readyAtTake: c.readyAtTake, thinkingTokens: c.thinkingTokens })),
        },
        "timing.json": {
          ...o.timing, firstTextMs: role(/^draw$/)?.firstMs, resolverMs: role(/refs|resolve/)?.ms, picturesMs: o.pics?.ms, quiescedAt: Date.now(), gatewayLoopP99Ms: end.loopP99Ms,
        },
        "spans.json": o.spans, "after.scene.json": o.after, "after.jpg": await capture(tabs[a].page, { width: LOOP.judgePx, quality: LOOP.judgeQuality }),
      }, before, [input.camera, o.camera]);
      // The arm's calls as the bank records them (replies.json): what the diffscan compares, and a top-up deposits.
      put(join(dir, a, "replies.json"), end.calls[a] ?? []);
    }
    const shared = lines.filter((c) => c.shared !== "-").map((c) => c.reqHash);
    const inputHash = { A: inputHashOf(payload.A), B: inputHashOf(payload.B) };
    const forkFile: ForkFile = {
      order: [first, first === "A" ? "B" : "A"], offsetsMs: [0, offset], sharedReqs: [...new Set(shared)], identicalAfter: js(out.A.after) === js(out.B.after) && svg.A === svg.B,
      enterAt, pageOrigin: origin, cameras: { A: out.A.camera, B: out.B.camera }, svg, inputHash, sceneHash, loopP99Ms: end.loopP99Ms,
    };
    put(join(dir, "fork.json"), forkFile);

    // Per-case invariants (§7.5): any one voids the case (V9, V12's guard) and flags the run.
    const why: string[] = [];
    if (inputHash.A !== inputHash.B) why.push("V9: the arms were sent different inputs");
    if (sceneHash.A !== sceneHash.B) why.push("V9: the arms loaded different before-scenes");
    if (Math.abs(offset) >= dispatchLimit()) why.push(`V9: dispatch offset ${Math.abs(offset)} ms ≥ the machine's ${dispatchLimit()} ms`);
    if (end.loopP99Ms > LOOP.eventLoopP99MaxMs) why.push(`V9: gateway event-loop p99 ${end.loopP99Ms.toFixed(1)} ms > ${LOOP.eventLoopP99MaxMs}`);
    if (lines.some((c) => c.cacheWrite1h > 0)) why.push("a 1-hour cache write");
    const stray = caseMetrics(s.run, id, lines).strayPictures;
    if (stray) why.push(`${stray} stray pictures (drawn for shapes the send didn't change)`);
    const errors = ARMS.flatMap((a) => tabs[a].errors.map((e) => `page error in ${a}: ${e.split("\n")[0]}`));
    why.push(...errors);
    const transport = lines.filter((c) => c.apiError && product(c));
    if (transport.length) why.push(`V7: ${transport[0].apiError}`);
    for (const w of why) invariants.push({ case: id, why: w });
    if (why.length) appendLine(runFile(s.run, "invariants.jsonl"), { case: id, why });

    // Over-use (§1.4 item 8): the card's named detector on each arm's send.
    const det = s.card?.overuseDetector ? OVERUSE[s.card.overuseDetector] : undefined;
    if (s.card?.overuseDetector && !det) throw new Error(`no over-use detector ${s.card.overuseDetector} in patterns.ts`);
    const r = maybe<Readings>(caseFile(id, "readings.json", s.run));
    const pointed = [...(r?.marks.flatMap((m) => m.targets) ?? []), ...(r?.refs?.flatMap((x) => x.ids) ?? [])];
    const overuse = ARMS.map((a) => !!det?.({ before, after: out[a].after, ops: out[a].ops, cameras: [input.camera, out[a].camera], pointed })) as [boolean, boolean];

    if (s.judge && !why.length) await s.judge.judgeCase(id, positionsFor(order, s.seed).get(id)!);
    runCaseDone(s.run, id);
    const c = s.classify?.(id) ?? { affected: true, class: s.cls ?? "Q" };
    const row = rowOf(s.run, { case: id, cluster: info.originSession, affected: c.affected, class: c.class, overuse, ask: info.ask, beat: info.beat, firstArm: first, void: why.length ? why.join("; ") : undefined }, lines);
    appendRow(s.run, row);
    return row;
  }

  return {
    order,
    invariants,
    /** Runs these cases (in waves of the rig's slots, one smaller on a busy machine) and returns their rows in order. */
    async add(ids: string[]): Promise<Row[]> {
      await ready;
      const at = ids.map((id) => (order.includes(id) ? order.indexOf(id) : order.push(id) - 1));
      const rows: Row[] = [];
      for (let k = 0; k < ids.length; ) {
        const gate = await beforeWave(s.loadWaitMs);
        const n = gate.ok ? rig.slots : Math.max(1, rig.slots - 1);
        if (!gate.ok) appendLine(runFile(s.run, "load-gate.jsonl"), { ...gate.sample, at: new Date().toISOString(), slots: n });
        rows.push(...(await Promise.all(ids.slice(k, k + n).map((id, j) => fork(id, at[k + j], j)))));
        k += n;
        if (rig.blocked.length) throw new Error(`run ${s.run} aborted: a page requested ${rig.blocked[0]} (outside its arm and /api/model)`);
        const st = await gatewayStatus(rig.gateway);
        if (st.capReached) throw new Error(`run ${s.run} stopped: the gateway's call cap (${st.cap}) is reached`);
      }
      return rows;
    },
    flips: () => s.judge?.flips?.(),
    /** Each arm's share of upstream product calls that waited on a process still starting (the cold-start asymmetry). */
    cold(): [number, number] {
      const live = meter().filter((c) => product(c) && c.mode === "live" && c.shared !== "follower");
      return ARMS.map((a) => {
        const mine = live.filter((c) => c.arm === a);
        return mine.length ? mine.filter((c) => c.readyAtTake === false).length / mine.length : 0;
      }) as [number, number];
    },
    /** run.json, at the end: the arms, the frozen config, the load and the meter. */
    finish(extra: { judgeId?: string } = {}) {
      clearInterval(sampler);
      const load = existsSync(runFile(s.run, "load.ndjson")) ? readFileSync(runFile(s.run, "load.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const upstream = meter().filter((c) => c.mode === "live" && c.shared !== "follower");
      writeRun({
        id: s.run, kind: s.kind, configId, harnessTag: harnessTag(), judgeId: extra.judgeId ?? "", machine: maybe<Machine>(p.machine)?.host ?? "", slots: rig.slots,
        arms: Object.fromEntries(ARMS.map((a) => [a, { sha: s.arms[a].sha, tuningId: s.arms[a].tuning ? sha(js(s.arms[a].tuning)).slice(0, 12) : "defaults", tree: s.arms[a].tree }])),
        load: { samples: load.length, load1Max: Math.max(0, ...load.map((l) => l.load1)), psiCpuMax: Math.max(0, ...load.map((l) => l.psiCpu)) },
        meter: { calls: upstream.length, listUsd: upstream.reduce((a, c) => a + c.listUsd, 0), minutes: (Date.now() - started) / 60_000, invariants: invariants.length },
      });
    },
  };
}

/** The harness's eval-harness-<n> tag, if it's at one. */
export function harnessTag(): string {
  try {
    return execFileSync("git", ["-C", paths().repo, "describe", "--tags", "--exact-match", "--match", "eval-harness-*", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// ---- Runs and decisions

/** A case's origin session, read where its inputs come from: a yardstick case (U1's) may not be in the bank. */
const clusterOf = (s: RunSpec) => (id: string) => json<CaseInfo>(s.source?.(id) ? join(s.source(id)!, "case.json") : caseFile(id, "case.json", s.run)).originSession;

/** A decision's extra stages (G2 → G3 → G4) and the loop state its vetoes read. */
export type Decide = {
  card: HypothesisCard; state: LoopState;
  /** G3: the affected H-gate cases (the scan's); anything else is never drawn here. */
  heldout?: string[];
  /** Live top-ups (run.ts wires drive.ts): up to n more fork sends, deposited in the bank; returns the affected new case ids. */
  topUp?: (n: number) => Promise<string[]>;
  /** G4, class D: the driver continues on B's result for `sends` more sends, each forked to both arms (drive.ts); their rows. */
  continueFrom?: (caseId: string, b: { run: string; after: SceneJSON; camera: View }, sends: number) => Promise<Row[]>;
};
export type ABResult = { rows: Row[]; heldout?: Row[]; continuation?: Row[]; decision?: Decision; invariants: { case: string; why: string }[] };

/**
 * One run over `cases` (in seeded origin-session order). Without `d` it runs them all (A/A, calibration,
 * checkpoint); with `d` it is a decision: Rule F's looks, top-ups when the bank runs short, G3 at a keep
 * (H-gate cases only) and continuation forks for class D, which can only veto. verdict.json and run.json last.
 */
export async function runAB(rig: Rig, s: RunSpec & { cases: string[] }, d?: Decide): Promise<ABResult> {
  const r = begin(rig, s);
  const order = entryOrder(s.cases, clusterOf(s), seedOf(s.seed));
  try {
    if (!d) return { rows: await r.add(order), invariants: r.invariants };
    const rows: Row[] = [];
    let heldout: Row[] | undefined, continuation: Row[] | undefined, topUps = 0;
    for (;;) {
      const exhausted = rows.length >= order.length && (!d.topUp || topUps >= LOOP.topUpMaxSends);
      const dec = decide({ tuning: rows, heldout, continuation, exhausted, flips: r.flips(), cold: r.cold(), invariants: r.invariants.length }, d.card, d.state);
      if (dec.verdict === "more") {
        // The next look counts live cases: voided ones are replaced from the order (or by top-ups).
        const upTo = rows.length + dec.next! - rows.filter((x) => !x.void).length;
        if (order.length < upTo && d.topUp && topUps < LOOP.topUpMaxSends) {
          const n = Math.min(upTo - order.length, LOOP.topUpMaxSends - topUps);
          topUps += n;
          order.push(...(await d.topUp(n)).filter((id) => !order.includes(id)));
        }
        rows.push(...(await r.add(order.slice(rows.length, upTo))));
        continue;
      }
      if (dec.pending?.includes("heldout")) {
        const gate = (d.heldout ?? []).filter((id) => json<CaseInfo>(caseFile(id, "case.json", s.run)).set === "heldout-gate");
        heldout = await r.add(entryOrder(gate, clusterOf(s), seedOf(`${s.seed} heldout`)).slice(0, LOOP.heldoutMax));
        continue;
      }
      if (dec.pending?.includes("continuation")) {
        if (!d.continueFrom) throw new Error("class D needs continuation forks: pass continueFrom");
        continuation = [];
        for (const row of rows.filter((x) => x.affected && !x.void).slice(0, LOOP.cont.cases)) {
          const f = json<ForkFile>(join(caseDir(s.run, row.case), "fork.json"));
          const after = json<SceneJSON>(join(caseDir(s.run, row.case), "B", "after.scene.json"));
          continuation.push(...(await d.continueFrom(row.case, { run: s.run, after, camera: f.cameras.B }, LOOP.cont.sends)));
        }
        continue;
      }
      put(runFile(s.run, "verdict.json"), { ...dec, invariantsTripped: r.invariants.length, topUps });
      return { rows, heldout, continuation, decision: dec, invariants: r.invariants };
    }
  } finally {
    r.finish();
  }
}

/** The yardstick's cases (bench/B1, and bench/U1 once the owner's set is frozen), each with its frozen folder. */
export function benchCases(): { id: string; bench: "B1" | "U1"; set: string; dir: string }[] {
  return (["B1", "U1"] as const).flatMap((bench) => {
    const root = join(paths().history, "bench", bench);
    if (!existsSync(join(root, "manifest.json"))) return [];
    return readdirSync(root).filter((f) => existsSync(join(root, f, "case.json"))).sort().map((id) => ({ id, bench, set: json<CaseInfo>(join(root, id, "case.json")).set, dir: join(root, id) }));
  });
}

/**
 * A checkpoint run (§5.2): the current anchor (A) against the champion (B) on the yardstick only, both live
 * and unshared, judged by fidelity and craft on every case. Checkpoint 0 passes the anchor as both arms.
 */
export async function checkpointRun(rig: Rig, o: { run: string; anchor: ArmSpec; champion: ArmSpec; seed: string; judge: Judge }): Promise<ABResult> {
  const bench = benchCases();
  if (!bench.some((c) => c.bench === "B1")) throw new Error("no yardstick: run `bench freeze` first (bench/B1 in the history worktree)");
  const dirs = new Map(bench.map((c) => [c.id, c.dir]));
  return runAB(rig, { run: o.run, kind: "checkpoint", arms: { A: o.anchor, B: o.champion }, mode: "live", share: false, seed: o.seed, judge: o.judge, cases: [...dirs.keys()], source: (id) => dirs.get(id) });
}
