// Live driver sessions (spec §1.5, §2): a Sonnet driver plays a user from the screen alone.
// Each turn it sees its screen at its last Enter with its ink and its screen now (D1, CDP
// captures at DRIVE_VIEW), says what it means before Enter, and talks, draws, moves the view
// or undoes; its steps become timed words and messy ink in node (synth.ts), view moves and
// undo are the harness's (0 calls, D14), then Enter goes through each arm's bridge page,
// reloaded before every case. Every send is a case: banked (bank build, refresh, top-ups) or
// written to a run (forks, G4 continuations). A driver or transport mistake is a harness event
// (§2.7, events.jsonl), never a product failure.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type View, pageName, pagesOf } from "../../src/core/board.ts";
import { HitIndex } from "../../src/core/hittest.ts";
import { groupStrokes, readMark } from "../../src/core/marks.ts";
import { parseReply } from "../../src/core/resolve.ts";
import { Scene } from "../../src/core/scene.ts";
import { sceneDiff } from "../core/diff.ts";
import { type Dropped, type Past, RETRY, type Turn, describeMarks, describeMove, isLook, moveView, parseTurn, systemPrompt, userMessage } from "../core/driver.ts";
import { personaOf, styleOf, targetOf } from "../core/personas.ts";
import { ASK_WORDS, type Scenario, applies, beatOf, plan } from "../core/scenarios.ts";
import { type Step, isView, synthesize } from "../core/synth.ts";
import { loadFixture, savedIn } from "../fixtures/fixtures.ts";
import { draw, expectationFor, missCheck } from "../judge/judge.ts";
import { type Page, paintedCapture } from "./chrome.ts";
import { ask, endCase, gatewayStatus } from "./client.ts";
import { DRIVE_VIEW, LOOP, configId, sha256 } from "./config.ts";
import { suspendGap } from "./load.ts";
import type { MeterCall } from "./meter.ts";
import { paths } from "./paths.ts";
import { type ArmFiles, appendLine, caseDir, caseDone, checkBefore, put, putImage, runCaseDone, runFile, voidCase, writeArm, writeCase } from "./record.ts";
import type { Arm, CaseInfo, CaseInput, DriverRecord, Fork, Meant, Readings, RecordedReply, SceneJSON, SendOutcome, TargetId } from "./types.ts";

/** The driver's call (§2.4): Sonnet at low effort, thinking off (U3 checks the transport); an eval role, so never pooled. */
export const DRIVER = { model: "sonnet", effort: "low", thinking: "off" } as const;
/** A first-timer's page after this send becomes its resume:<target> start (and, held out, the site:<target> start). */
export const RESUME_AFTER = 3;
/** V6: a meant longer than this (or empty) voids the case. */
const MEANT_MAX = 400;

/** One case slot: each arm's bridge page (A is the champion). */
export type Pages = { A: Page; B?: Page };
export type DriveCtx = {
  run: string;
  arms: Partial<Record<Arm, { sha: string; tuningId: string; tuning?: Record<string, number> }>>;
  harnessTag: string;
  /** Called before each send attempt: checks plant faults here (a clock jump, a dispatch limit). */
  hook?: (caseId: string, attempt: number) => void | Promise<void>;
};
export type DriveOpts = {
  /** Case ids are c-<bank>-s<session>-<n>. */
  bank: string;
  session: number;
  /** Each send goes to both arms at the same moment. */
  fork?: boolean;
  /** Whose result the next send builds on: A (top-ups), B (G4 continuations) or alternating (the owner's live mode). */
  continueOn?: Arm | "alternate";
  /** Bank every send whose before-scene is the champion's own (bank build, refresh, top-ups). */
  deposit?: boolean;
  /** Stop after this many sends (a top-up's remaining need). */
  maxSends?: number;
};
export type Session = { scenario: string; cases: string[]; banked: string[]; ended: string };

/** A harness event (§2.7): runs/<run>/events.jsonl, never counted against an arm. */
export type HarnessEvent = { v: string; kind: string; case?: string; session: string; why: string };

const js = JSON.stringify;
const READY = "new Promise((r) => { const t = () => (window.rtEval ? r() : setTimeout(t, 20)); t(); })";
const dataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;
/** A capture, and whether it came back blank twice (a §7.5 invariant: a blank screen is never shown to a driver or judge). */
const driverShot = (page: Page) => paintedCapture(page, { width: DRIVE_VIEW.screenW, quality: DRIVE_VIEW.jpegQuality });
const judgeShot = (page: Page) => paintedCapture(page, { width: LOOP.judgePx, quality: LOOP.judgeQuality });
const BLANK = "a blank capture (twice)";
const pad = (n: number) => String(n).padStart(2, "0");
export const caseIdOf = (bank: string, session: number, send: number) => `c-${bank}-s${pad(session)}-${send}`;

class Capped extends Error {}
/** The gateway's call cap stops the whole step (run.ts --cap), never just one case. */
async function stopIfCapped(err?: unknown) {
  if (/call cap/.test(String(err)) || (await gatewayStatus().catch(() => ({}))).capReached) throw new Capped("the call cap is reached");
}

/** A page reloaded and holding `scene` (the product keeps every call and span in memory: one load per case). */
export async function loadPage(page: Page, run: string, caseId: string, scene: SceneJSON, camera: View, tuning?: Record<string, number>): Promise<string> {
  Object.assign(page.labels, { run, case: caseId });
  await page.reload();
  await page.eval(READY);
  return (await page.eval<{ sceneHash: string }>(`rtEval.load(${js({ scene, camera, tuning })})`)).sceneHash;
}

/** The meter's lines since byte `from` for one case (the gateway appends one per call). */
function meterSince(from: number, run: string, caseId: string): MeterCall[] {
  const file = paths().calls;
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.max(0, fstatSync(fd).size - from));
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  return buf.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as MeterCall).filter((l) => l.run === run && l.case === caseId);
}
const meterSize = () => (existsSync(paths().calls) ? statSync(paths().calls).size : 0);

/** A recorded reply's text from the reply cache. */
const replyText = (r?: RecordedReply) => {
  const file = r?.cacheFile && paths().reply(basename(r.cacheFile, ".json"));
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).text as string) : undefined;
};

/** The ink readings and the resolver's answer (readings.json): the product's own readers (this harness's copy, at defaults) and the champion's recorded resolver reply. */
function readingsOf(before: SceneJSON, input: CaseInput, replies: RecordedReply[]): Readings {
  const scene = Scene.fromJSON(before);
  const hits = new HitIndex(scene);
  const marks = groupStrokes(input.strokes).map((m, i) => {
    const r = readMark(m, hits);
    return { n: i + 1, kind: r.kind, how: r.how, targets: r.targets };
  });
  const resolver = replyText(replies.find((r) => r.role === "draw-refs"));
  return { marks, ...(resolver ? { refs: parseReply(resolver, scene).refs } : {}) };
}

type Asked = { raw: string; turn: Turn; dropped: Dropped[]; clamped: number; retries: number; reqHash: string };

/** One driver call: one retry on an unparseable reply (V1) or a transport error (V7); undefined when both failed. */
async function driverTurn(ctx: DriveCtx, caseId: string, user: string, images: string[], view: View, event: (v: string, kind: string, why: string) => void): Promise<Asked | undefined> {
  let turns: string | string[] = user;
  for (let retries = 0; retries < 2; retries++) {
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask({ role: "driver", ...DRIVER, system: systemPrompt(), turns, images, run: ctx.run, case: caseId });
    } catch (err) {
      await stopIfCapped(err);
      event("V7", "void-transport", `driver call: ${String(err)}`);
      continue;
    }
    if (r.stats.stopReason === "max_tokens") {
      event("V7", "void-transport", "driver reply cut at max_tokens");
      continue;
    }
    try {
      return { raw: r.text, ...parseTurn(r.text, view), retries, reqHash: String(r.stats.reqHash) };
    } catch (err) {
      event("V1", "void-driver", `unparseable reply (${String(err)}): ${r.text.slice(0, 80)}`);
      turns = [user, RETRY];
    }
  }
}

type State = {
  scene: SceneJSON;
  camera: View;
  /** The screen at the last Enter with the ink (driver px): the driver's "before" (none before the first send). */
  lastEnter?: Buffer;
  /** The scene before the last send, for an undo. */
  undoTo?: SceneJSON;
  past: Past[];
  /** The champion's completed replies this session (failed attempts' too): V12 fills from them. */
  replies: RecordedReply[];
  /** Whether the scene is the champion's own (only those fork points are banked). */
  champion: boolean;
  /** The last banked case, waiting for the driver's rating of it. */
  rate?: string;
};
type Banked = { id: string; judged: Promise<boolean>; rated: boolean };

/** Every case of a send: the ink at Enter, each arm's outcome, its after image and calls. */
type Sent = { outcome: SendOutcome; after: Buffer; calls: MeterCall[]; replies: RecordedReply[]; hash: string; at: [number, number] };

/** A session from its start (§2.1–2.2): the scenario's plan of asks and beats, seeded words and ink. */
export async function driveSession(ctx: DriveCtx, s: Scenario, pages: Pages, o: DriveOpts): Promise<Session> {
  const saved = savedIn(paths().resume);
  let scene: SceneJSON, camera: View;
  try {
    const f = loadFixture(s.start, { saved });
    // A saved page as written, so the first case's round trip (V8) checks the file itself.
    const target = /^(?:resume|site):(.+)$/.exec(s.start)?.[1] as TargetId | undefined;
    [scene, camera] = [target ? saved(target)! : f.scene.toJSON(), f.start];
  } catch (err) {
    harnessEvent(ctx.run, { v: "V8", kind: "refused", session: `${o.bank}-s${pad(o.session)}`, why: `start ${s.start}: ${String(err)}` });
    return { scenario: s.id, cases: [], banked: [], ended: `V8: start ${s.start}` };
  }
  return play(ctx, s, pages, o, { scene, camera, past: [], replies: [], champion: true }, 1, s.sends);
}

/**
 * G4 (§1.5): from a banked case, the driver (same scenario and seed stream, its history rebuilt from the origin
 * session's banked cases) sees one arm's result of it and plays `sends` more sends, each forked to both arms from the
 * same scene and continuing on that arm. Written to ctx.run as cases <case>-k<n> (the run's own case files), never banked.
 */
export async function continueFrom(ctx: DriveCtx, pages: Pages, caseId: string, result: Pick<SendOutcome, "after" | "camera">, sends: number, on: Arm = "B"): Promise<Session> {
  const bank = (id: string, f: string) => JSON.parse(readFileSync(join(paths().bankCase(id), f), "utf8"));
  const info = bank(caseId, "case.json") as CaseInfo;
  const s: Scenario = { id: info.scenario, set: info.set, persona: info.persona, style: info.style, target: info.target, start: info.start, seed: info.seed,
    sends: info.set.startsWith("heldout") ? LOOP.bank.heldoutSends : LOOP.bank.tuningSends };
  // The origin session's banked sends up to this one, as the driver remembers them.
  const prefix = caseId.replace(/-\d+$/, "-");
  const earlier = readdirSync(paths().bankCases).filter((d) => d.startsWith(prefix) && existsSync(join(paths().bankCase(d), "done")))
    .map((d) => bank(d, "case.json") as CaseInfo).filter((c) => c.send <= info.send).sort((a, b) => a.send - b.send);
  const past: Past[] = earlier.map((c) => {
    const input = bank(c.id, "input.json") as CaseInput;
    const d = bank(c.id, "driver.json") as DriverRecord;
    const rating = c.id !== caseId && existsSync(join(paths().bankCase(c.id), "rating.json")) ? bank(c.id, "rating.json") : undefined;
    return { said: typeof input.words === "string" ? input.words : input.words.map((w) => w.word).join(" "), marks: describeMarks(d.turn.steps, d.view), meant: (bank(c.id, "meant.json") as Meant).meant,
      satisfaction: rating?.satisfaction, feeling: rating?.feeling };
  });
  // Its screen at that Enter with its ink, recaptured from the case (0 calls).
  const input = bank(caseId, "input.json") as CaseInput;
  const before = bank(caseId, "before.scene.json") as SceneJSON;
  const page = pages[on]!;
  await loadPage(page, ctx.run, `${caseId}-k0`, before, input.camera, ctx.arms[on]?.tuning);
  await page.eval(`rtEval.showInk(${js(input.strokes)}, { numbers: false })`);
  const lastEnter = (await driverShot(page)).jpeg;
  const o: DriveOpts = { bank: "", session: 0, fork: true, continueOn: on };
  return play(ctx, s, pages, o, { scene: result.after, camera: result.camera, lastEnter, undoTo: before, past, replies: [], champion: false }, info.send + 1, info.send + sends, caseId);
}

/** Sends `from`..`to` of a session from `st` (`origin`: a continuation's case, whose sends are named <origin>-k<n>). */
async function play(ctx: DriveCtx, s: Scenario, pages: Pages, o: DriveOpts, st: State, from: number, to: number, origin?: string): Promise<Session> {
  const run = ctx.run;
  const name = origin ?? `${o.bank}-s${pad(o.session)}`;
  const plans = plan({ ...s, sends: Math.max(s.sends, to) });
  const style = styleOf(s.style);
  const card = { persona: personaOf(s.persona), style, target: s.target && targetOf(s.target) };
  const traits = { mess: style.mess, disfluency: style.disfluency };
  const arms: Arm[] = o.fork ? ["A", "B"] : ["A"];
  const out: Session = { scenario: s.id, cases: [], banked: [], ended: "out of sends" };
  const banked: Banked[] = [];
  // A first-timer's own page (never a continuation's), the first one per target kept. Only a page whose pictures are all
  // filled (V12): a later session starting on one that still needs a picture would end at once with no case.
  const firstTimer = !origin && s.persona === "first-timer" && !!s.target;
  let saved = !firstTimer || existsSync(paths().resume(s.target!));
  const save = () => {
    const fill = checkBefore(st.scene, st.replies);
    if (saved || !st.champion || "refused" in fill) return;
    if (!existsSync(paths().resume(s.target!))) put(paths().resume(s.target!), fill.scene);
    saved = true;
  };
  let capped: Capped | undefined;

  try {
    for (let n = from; n <= Math.min(to, from - 1 + (o.maxSends ?? Infinity)); n++) {
      const id = origin ? `${origin}-k${n - from + 1}` : caseIdOf(o.bank, o.session, n);
      const event = (v: string, kind: string, why: string) => harnessEvent(run, { v, kind, case: id, session: name, why });
      const flags: string[] = [];
      let voided: string | undefined;

      // V8: the before-scene must survive a round trip and load in every arm. V12: no shape may still need a
      // picture (filled from a completed recorded reply, else refused).
      if (!roundTrips(st.scene)) {
        event("V8", "refused", "the before-scene doesn't round-trip through Scene.fromJSON");
        out.ended = "V8";
        break;
      }
      const fill = checkBefore(st.scene, st.replies);
      if ("refused" in fill) {
        event("V12", "refused", fill.refused);
        // A start that still needs pictures (unbaked fixtures) can't be a case at all; later in a session the send still happens, unbanked.
        if (n === from) {
          out.ended = "V12";
          break;
        }
        voided = fill.refused;
      } else if (fill.filled.length) {
        flags.push("filled");
        event("V12", "filled", `filled ${fill.filled.join(", ")} from a completed recorded picture reply`);
      }
      const before = "refused" in fill ? st.scene : fill.scene;
      let start = before;
      const on: Arm = o.continueOn === "alternate" ? (n % 2 ? "A" : "B") : (o.continueOn ?? "A");
      const view = (page: Page) => page.eval(`rtEval.setView(${js(st.camera)})`);
      // An undo restores the scene before the last send in every arm (0 calls).
      const undo = async () => {
        if (!st.undoTo) return;
        start = st.scene = st.undoTo;
        st.undoTo = undefined;
        for (const a of arms) await pages[a]!.eval(`rtEval.restore(${js(start)})`);
      };

      // Turns: looking around (view moves by hand, an undo) until the driver acts, at most DRIVE_VIEW.maxLooks.
      const looks: { raw: string; turn: Turn; reqHash: string }[] = [];
      const looked: string[] = [];
      let acting: Asked | undefined;
      let images: Buffer[] = [];
      let drawnOn = st.camera;
      let ended: string | undefined;
      try {
        for (const a of arms) await loadPage(pages[a]!, run, id, before, st.camera, ctx.arms[a]?.tuning);
      } catch (err) {
        event("V8", "refused", `an arm can't load the before-scene: ${String(err)}`);
        out.ended = "V8";
        break;
      }
      for (let look = 0; ; look++) {
        drawnOn = st.camera;
        const shot = await driverShot(pages[on]!);
        if (shot.blank) {
          event("V9", "invariant", `the driver's screen: ${BLANK}`);
          ended = `V9: the driver's screen: ${BLANK}`;
          break;
        }
        const now = shot.jpeg;
        images = [st.lastEnter ?? now, now];
        const planned = plans[n - 1];
        const user = userMessage(card, st.past, planned.beat, planned.ask, to - n + 1, looked);
        const asked = await driverTurn(ctx, id, user, images.map(dataUrl), drawnOn, event);
        if (!asked) {
          ended = "V1: the driver's reply didn't parse twice";
          break;
        }
        const t = asked.turn;
        if (asked.clamped) {
          flags.push("clamped");
          event("V3", "clamped", `${asked.clamped} positions clamped onto the screenshot`);
        }
        for (const d of asked.dropped) {
          const v = d.why === "view step after a draw" ? "V4" : /off the screen/.test(d.why) ? "V3" : "D8";
          if (!flags.includes("dropped")) flags.push("dropped");
          event(v, "dropped", `${d.why}: ${js(d.step)}`);
        }
        // The first rating after a send lands on that send, from whichever turn gives it, a look turn too (harness-7).
        if (st.rate && t.satisfaction) {
          writeCase(st.rate, { "rating.json": { satisfaction: t.satisfaction, saw: t.saw ?? "", feeling: t.feeling ?? "" } });
          banked.find((b) => b.id === st.rate)!.rated = true;
          st.rate = undefined;
        }
        if (t.satisfaction && st.past.length && !st.past.at(-1)!.satisfaction) Object.assign(st.past.at(-1)!, { satisfaction: t.satisfaction, feeling: t.feeling });
        if (t.stop || !t.steps.length) {
          ended = t.stop ? "the driver stopped" : "the driver had nothing to do";
          break;
        }
        if (!isLook(t)) {
          acting = asked;
          break;
        }
        looks.push({ raw: asked.raw, turn: t, reqHash: asked.reqHash });
        if (look >= DRIVE_VIEW.maxLooks) {
          event("V2", "look-only", `${look + 1} turns without a send`);
          ended = "V2: only looked around";
          break;
        }
        // A look turn: the harness moves the view (and undoes), 0 calls; the driver sees the new screen next turn.
        const moves: string[] = [];
        for (const step of t.steps) {
          if ("undo" in step) {
            await undo();
            moves.push(describeMove(step, drawnOn));
          } else if (isView(step)) {
            moves.push(describeMove(step, st.camera));
            st.camera = moveView(step, st.camera);
          }
        }
        for (const a of arms) await view(pages[a]!);
        looked.push(moves.join(", "));
      }
      if (!acting) {
        out.ended = ended!;
        break;
      }
      const t = acting.turn;
      // An undo ahead of the words (parseTurn drops one after them) still goes first.
      if (t.steps.some((x) => "undo" in x)) await undo();

      // The send: the steps on the person's clock (seeds D10), the view where the hand left it, the ink as data.
      const seed = s.seed * 1000 + n;
      const tl = synthesize(t.steps as Step[], traits, seed, { view: drawnOn });
      const camera = tl.moves.reduce((v, m) => moveView(m.move, v), drawnOn);
      const input: CaseInput = { camera, words: tl.words, strokes: tl.strokes, enterAtMs: tl.ms, inputHash: sha256(js([camera, tl.words, tl.strokes])) };
      const sendArg = js({ words: input.words, strokes: input.strokes });

      // Enter: the screen with the person's ink, numbered for the judges, plain for the driver's next "before".
      const p = pages[on]!;
      await p.eval(`rtEval.setView(${js(camera)})`);
      await p.eval(`rtEval.showInk(${js(input.strokes)}, { numbers: true })`);
      const inkShot = await judgeShot(p);
      const beforeInk = inkShot.jpeg;
      await p.eval(`rtEval.showInk(${js(input.strokes)}, { numbers: false })`);
      const enterShot = await driverShot(p);
      const lastEnter = enterShot.jpeg;

      // Up to two attempts: a transport error (V7) or a machine suspend (V10) voids the attempt and re-queues it once.
      let sent: Partial<Record<Arm, Sent>> = {};
      let fork: Fork | undefined;
      let loopP99 = 0;
      let blankShot = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const hashes: Partial<Record<Arm, string>> = {};
        // A re-queued attempt starts from a reloaded page again.
        if (attempt > 1) for (const a of arms) hashes[a] = await loadPage(pages[a]!, run, id, start, st.camera, ctx.arms[a]?.tuning);
        else for (const a of arms) hashes[a] = sha256(js(await pages[a]!.eval<SceneJSON>("rtEval.scene()")));
        for (const a of arms) await pages[a]!.eval(`rtEval.hideInk(); rtEval.setView(${js(camera)})`);
        await ctx.hook?.(id, attempt);
        const from = meterSize();
        const beat0 = { wall: Date.now(), mono: performance.now() };
        // Both arms at the same moment, in a seeded order that is recorded.
        const order: Arm[] = arms.length > 1 && draw(run, "order", id) < 0.5 ? ["B", "A"] : arms;
        const at: Partial<Record<Arm, number>> = {};
        const pending = order.map((a) => ((at[a] = performance.now()), pages[a]!.eval<SendOutcome>(`rtEval.send(${sendArg})`)));
        const outcomes = await Promise.all(pending);
        const beat1 = { wall: Date.now(), mono: performance.now() };
        const shots = await Promise.all(order.map((a) => judgeShot(pages[a]!)));
        if (shots.some((x) => x.blank) || inkShot.blank || enterShot.blank) blankShot = true;
        const fin = (await endCase(run, id)) as { loopP99Ms: number; calls: Partial<Record<Arm, RecordedReply[]>> };
        loopP99 = fin.loopP99Ms;
        const lines = meterSince(from, run, id);
        sent = Object.fromEntries(order.map((a, i) => [a, { outcome: outcomes[i], after: shots[i].jpeg, calls: lines.filter((l) => l.arm === a), replies: fin.calls[a] ?? [], hash: hashes[a]!, at: [at[a]!, beat1.mono] }]));
        st.replies.push(...(sent.A?.replies ?? []));
        const errors = lines.filter((l) => l.apiError);
        const gap = suspendGap(beat0, beat1);
        if (outcomes.some((x) => x.error || x.pics?.failed.length)) await stopIfCapped();
        const why = errors.length ? `V7: ${errors.length} calls failed (${errors[0].role}: ${errors[0].apiError})` : gap > LOOP.suspendGapMs ? `V10: the machine was suspended ${Math.round(gap / 1000)} s` : undefined;
        if (why) event(why.slice(0, why.indexOf(":")), errors.length ? "void-transport" : "suspend", `attempt ${attempt}: ${why}`);
        if (arms.length > 1) fork = { order, offsetsMs: order.map((a) => Math.round((at[a]! - at[order[0]]!) * 1000) / 1000), sharedReqs: [...new Set(lines.filter((l) => l.shared !== "-").map((l) => l.reqHash))],
          identicalAfter: js(sent.A!.outcome.after) === js(sent.B!.outcome.after), cameras: { A: sent.A!.outcome.camera, B: sent.B!.outcome.camera } };
        if (!why) break;
        if (attempt === 2) voided = why;
      }

      // V9: the invariants of a fork, whose arms are compared (a bank send's own timing decides nothing). V6: a meant the judges can't use.
      const limit = dispatchLimit();
      if (!voided && blankShot) voided = `V9: ${BLANK}`;
      if (!voided && fork && loopP99 > LOOP.eventLoopP99MaxMs) voided = `V9: the gateway's event-loop p99 was ${loopP99.toFixed(1)} ms`;
      if (!voided && fork && sent.A!.hash !== sent.B!.hash) voided = "V9: the arms loaded different before-scenes";
      if (!voided && fork && Math.max(...fork.offsetsMs) >= limit) voided = `V9: dispatch offset ${Math.max(...fork.offsetsMs)} ms ≥ the machine's limit ${limit} ms`;
      if (voided?.startsWith("V9")) event("V9", "invariant", `${voided} (run flagged)`);
      if (!voided && (!t.meant || t.meant.length > MEANT_MAX)) {
        voided = `V6: meant is ${t.meant ? `${t.meant.length} characters` : "empty"}`;
        event("V6", "void", voided);
      }
      if (t.hedged) {
        event("V5", "hedged", `meant: ${t.meant.slice(0, 80)}`);
        if (s.set.startsWith("heldout") && !voided) voided = "V5: a hedged meant is excluded from held-out sets";
      }

      // The beat given (an undo only after a send rated ≤ 3), checked free from the parsed reply (V11: a miss stays valid);
      // a driver that says it didn't do the twist (beat_done false) didn't, whatever its words happen to match.
      const planned = plans[n - 1];
      const given = planned.beat && applies(planned.beat.id, st.past.at(-1)?.satisfaction) ? planned.beat : undefined;
      const sc = Scene.fromJSON(start);
      const complied = !!given && t.beatDone !== false && beatOf(given.id).check(t, { send: n, looks: looks.map((l) => l.turn), view: drawnOn,
        shapes: sc.stacked().filter((x) => x.kind !== "frame").map((x) => x.box), pages: pagesOf(sc).map((x) => ({ name: pageName(x), box: x.box })) });
      if (given && !complied) event("V11", "beat-missed", `beat ${given.id} not complied`);

      const champ = sent.A!;
      const info: CaseInfo = {
        id, set: s.set, scenario: s.id, persona: s.persona, style: s.style, ...(s.target ? { target: s.target } : {}), start: s.start, ...(given ? { beat: given.id } : {}), ask: planned.ask,
        seed: s.seed, originSession: name, send: n, championSha: ctx.arms.A?.sha ?? "", tuningId: ctx.arms.A?.tuningId ?? "", harnessTag: ctx.harnessTag, configId,
        recordedAt: new Date().toISOString(), hedged: t.hedged, beatDone: complied, askDone: ASK_WORDS[planned.ask].test(`${tl.spoken} ${t.meant}`), flags,
      };
      const meant: Meant = { meant: t.meant, ...(t.testing ? { testing: t.testing } : {}), hedged: t.hedged };
      const driverRec: DriverRecord = { raw: acting.raw, turn: t, retries: acting.retries, dropped: acting.dropped, clamped: acting.clamped, reqHash: acting.reqHash, view: drawnOn, looks };
      out.cases.push(id);

      // Banked: the fork point, when its before-scene is the champion's own (§3.2).
      if (o.deposit && st.champion) {
        writeCase(id, { "case.json": info });
        if (voided) voidCase(paths().bankCase(id), voided);
        else {
          const diff = sceneDiff(start, champ.outcome.after, [camera, champ.outcome.camera]);
          writeCase(id, {
            "input.json": input, "before.scene.json": start, "before-ink.jpg": beforeInk, "driver-before.jpg": images[0], "driver-now.jpg": images[1], "driver.json": driverRec, "meant.json": meant,
            "champion-after.jpg": champ.after, "champion.json": { opsFailed: champ.outcome.ops.filter((x) => !x.ok).length, picsFailed: champ.outcome.pics?.failed.length ?? 0, empty: diff.empty },
            "replies.json": champ.replies, "readings.json": readingsOf(start, input, champ.replies),
          });
          banked.push({ id, rated: false, judged: judgeOnce(run, id, diff.changes).then((r) => (r === "capped" ? ((capped ??= new Capped("the call cap is reached")), false) : r)) });
          out.banked.push(id);
          if (on === "A") st.rate = id;
        }
      }
      // A fork's arms go to the run for ab.ts to judge; a continuation's own case files too (they're in no bank).
      if (fork) {
        const dir = caseDir(run, id);
        if (origin) writeFiles(dir, { "case.json": info, "input.json": input, "meant.json": meant, "before.scene.json": start, "before-ink.jpg": beforeInk });
        for (const a of arms) writeArm(run, id, a, armFiles(sent[a]!, loopP99), start, [camera, sent[a]!.outcome.camera]);
        put(join(dir, "fork.json"), fork);
        runCaseDone(run, id);
        if (voided) voidCase(dir, voided);
      }

      // The session goes on from the continued arm's result, whatever happened to the case.
      const next = sent[on]!.outcome;
      st.undoTo = start;
      st.scene = next.after;
      st.camera = next.camera;
      st.lastEnter = lastEnter;
      st.champion &&= on === "A";
      st.past.push({ said: tl.spoken, marks: describeMarks(t.steps, drawnOn), meant: t.meant });
      if (firstTimer && n >= RESUME_AFTER) save();
    }
  } finally {
    // Done last: once the judges (and the rating, when one came) are in; rating.json is absent when no later turn gave one.
    for (const b of banked) {
      if (await b.judged) caseDone(b.id, { last: !b.rated });
      else if (!capped) voidCase(paths().bankCase(b.id), "V7: the expectation or miss check failed twice");
    }
  }
  if (capped) throw capped;
  return out;
}

/** The expectation and the miss check (§4.1), once each, beside the session; one retry on a transport error (V7). Never rejects. */
async function judgeOnce(run: string, id: string, changes: string[]): Promise<boolean | "capped"> {
  for (let i = 0; i < 2; i++) {
    try {
      await expectationFor(id, run);
      await missCheck(id, run, changes);
      return true;
    } catch (err) {
      if (await stopIfCapped(err).then(() => false, () => true)) return "capped";
      harnessEvent(run, { v: "V7", kind: "void-transport", case: id, session: id.replace(/-\d+$/, ""), why: `judge: ${String(err)}` });
    }
  }
  return false;
}

const roundTrips = (j: SceneJSON) => {
  try {
    return js(Scene.fromJSON(j).toJSON()) === js(j);
  } catch {
    return false;
  }
};

/** One arm's run files (§3.3) from its outcome, its meter lines and the gateway's loop delay. */
function armFiles(x: Sent, loopP99: number): ArmFiles {
  const o = x.outcome;
  const span = (re: RegExp) => o.spans.find((s) => re.test(s.name));
  const first = span(/^model call · draw /)?.events.find((e) => e.name === "first text");
  const resolver = span(/^resolve references/);
  return {
    "result.json": { ops: o.ops, reply: o.reply, ...(o.error ? { error: o.error } : {}), ...(o.pics ? { pics: o.pics } : {}), stopReasons: x.calls.flatMap((c) => (c.stopReason ? [c.stopReason] : [])),
      calls: x.calls.map((c) => ({ role: c.role, reqHash: c.reqHash, shared: c.shared, mode: c.mode, ms: c.ms, firstMs: c.firstMs, waitMs: c.waitMs, readyAtTake: c.readyAtTake, thinkingTokens: c.thinkingTokens })) },
    "timing.json": { enterAt: o.timing.enterAt, ttfcMs: o.timing.ttfcMs, ttdMs: o.timing.ttdMs, ttloMs: o.timing.ttloMs, firstTextMs: first && Math.round(first.atMs - o.timing.enterAt),
      resolverMs: resolver && Math.round(resolver.endMs - resolver.startMs), picturesMs: o.pics?.ms, renders: o.timing.renders, longTasksMs: o.timing.longTasksMs,
      // The page's clock: Enter plus the time node waited for the send to quiesce.
      quiescedAt: Math.round(o.timing.enterAt + x.at[1] - x.at[0]), heapMb: o.timing.heapMb, gatewayLoopP99Ms: loopP99 },
    "spans.json": o.spans, "after.scene.json": o.after, "after.jpg": x.after,
  };
}

function writeFiles(dir: string, files: Record<string, object | Buffer>) {
  for (const [name, data] of Object.entries(files)) name.endsWith(".jpg") ? putImage(join(dir, name), data as Buffer) : put(join(dir, name), data);
}

/** The machine's dispatch limit (machine.json, the ladder's p99 at the knee), capped by LOOP; read per case. */
function dispatchLimit(): number {
  try {
    return Math.min(LOOP.dispatchOffsetCapMs, JSON.parse(readFileSync(paths().machine, "utf8")).dispatchLimitMs ?? Infinity);
  } catch {
    return LOOP.dispatchOffsetCapMs;
  }
}

export function harnessEvent(run: string, e: HarnessEvent) {
  appendLine(runFile(run, "events.jsonl"), { at: new Date().toISOString(), ...e });
}
export { Capped };
