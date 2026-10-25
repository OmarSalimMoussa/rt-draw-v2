// The judges (spec §4): the expectation (once per case), fidelity (decides fidelity-goal cards),
// craft (decides craft-goal cards; reported on a seeded share of the rest) and the miss check (once
// per banked case, for the champion-miss digest only). Each is one Sonnet call at high effort
// through the gateway: never pooled, never on a latency path. Order handling is §4.4's (N4):
// positions balanced exactly, a second order only for confidence-1 decisive verdicts and a seeded
// audit, both orders for the rest of a run whose audit flips too often.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_IDS, SDK_VERSION } from "../../dev/claude.ts";
import { ask } from "../loop/client.ts";
import { LOOP } from "../loop/config.ts";
import { paths } from "../loop/paths.ts";
import { appendLine, caseDir, isDone, put, runFile } from "../loop/record.ts";
import type { Arm, Expectation, Judged, Miss, Packet } from "../loop/types.ts";
import { PACKET_VERSION, type Positions, imageOf, stepOf, writePacket } from "./packet.ts";
import * as P from "./prompts.ts";

export const JUDGE = { model: "sonnet", effort: "high" } as const;
export type Role = "expectation" | "fidelity" | "craft" | "miss";
/** Their names in the meter (metrics.ts never charges these to an arm). */
const METER: Record<Role, string> = { expectation: "expectation", fidelity: "judge", craft: "craft", miss: "miss" };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
/** History files are versioned by git: overwritten in place, never voided. */
export function save(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * §4.6: the role's prompt text (its variant's), the packet builder, image size, effort, the requested
 * and the served model, the SDK. Per role, so a craft or fidelity variant switch doesn't re-make
 * every banked expectation (same text, same model). Logged on every verdict; a new one starts an era.
 */
export function judgeId(role: Role, served: string | undefined, variant: P.Variant = 1): string {
  // Fidelity and craft read a version-2 packet (the framed images): expectations and miss checks keep version 1's ids, and their banked work.
  const parts = { text: P.template(role, variant), packet: role === "fidelity" || role === "craft" ? PACKET_VERSION : 1, px: LOOP.judgePx, quality: LOOP.judgeQuality, effort: JUDGE.effort, model: MODEL_IDS[JUDGE.model], served: served ?? null, sdk: SDK_VERSION };
  return sha(JSON.stringify(parts)).slice(0, 16);
}

/** The model the API last said it served (message_start): existing expectations and miss checks are reused while their judgeId matches it. */
let servedNow: string | undefined;
export const lastServed = () => servedNow;
/** An expectation from an owner-approved rubric (bench R1's gold, evals/real/shadow.ts): no judge made it, so none re-makes it. */
export const RUBRIC = "rubric";
const current = (have: { judgeId: string } | undefined, role: Role) => !!have && (have.judgeId === RUBRIC || servedNow === undefined || have.judgeId === judgeId(role, servedNow));

export const calibrationFile = () => join(paths().history, "judge", "calibration.json");
/**
 * The prompt variants calibration chose (§4.5): 1 until a check adopts 2. craftCalibrated false: craft-goal keeps go
 * to the owner list. illustrationsCalibrated false (the owner hasn't labeled illustrations yet): picture.model keeps
 * go there too, and R1 decides nothing (LOOP-V2.md A5, C3).
 */
export function variants(): { fidelity: P.Variant; craft: P.Variant; craftCalibrated: boolean; illustrationsCalibrated: boolean } {
  const use = maybe<{ use?: { fidelity?: P.Variant | null; craft?: P.Variant | null; illustrations?: boolean } }>(calibrationFile())?.use;
  return { fidelity: use?.fidelity ?? 1, craft: use?.craft ?? 1, craftCalibrated: !!use?.craft, illustrationsCalibrated: !!use?.illustrations };
}

/** Each judgeId once in history/judge/ids.json, with what went into it. */
function remember(id: string, role: Role, variant: P.Variant, served?: string) {
  const file = join(paths().history, "judge", "ids.json");
  const ids = maybe<Record<string, unknown>>(file) ?? {};
  if (ids[id]) return;
  ids[id] = { role, variant, served, model: MODEL_IDS[JUDGE.model], sdk: SDK_VERSION, px: LOOP.judgePx, effort: JUDGE.effort, packet: PACKET_VERSION, at: new Date().toISOString() };
  save(file, ids);
}

async function call(role: Role, user: string, images: string[], run: string, caseId: string, variant: P.Variant = 1) {
  const { text, stats } = await ask({ role: METER[role], model: JUDGE.model, effort: JUDGE.effort, system: P.SYSTEM, user, images, run, case: caseId });
  const served = typeof stats.served === "string" ? stats.served : undefined;
  servedNow = served ?? servedNow;
  const id = judgeId(role, served, variant);
  remember(id, role, variant, served);
  return { text, judgeId: id };
}

const jsonIn = (text: string) => {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    return m ? JSON.parse(m[0]) : undefined;
  } catch {
    return undefined;
  }
};
const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()) : undefined);

/** A verdict reply. One that doesn't parse is a low-confidence tie, said so in `why`: a resumed run reads the same cached reply again. */
function verdictOf(text: string, positions: Positions, judgeId: string, variant: P.Variant): Judged {
  const j = jsonIn(text);
  const ok = !!j && ["left", "right", "tie"].includes(j.winner);
  const c = Number(j?.confidence);
  return {
    winner: ok ? j.winner : "tie", confidence: ok && (c === 2 || c === 3) ? c : 1, why: ok ? String(j.why ?? "") : `unreadable reply: ${text.slice(0, 120)}`,
    ...(ok && j.left !== undefined ? { left: String(j.left), right: String(j.right) } : {}), positions, judgeId, variant,
  };
}

/** The arm a verdict picked, or tie. */
export const pick = (j: Judged): Arm | "tie" => (j.winner === "tie" ? "tie" : j.positions[j.winner]);
/** Two orders that disagree are a tie (§4.4). */
export const combined = (first: Judged, second?: Judged): Arm | "tie" => (second && pick(second) !== pick(first) ? "tie" : pick(first));
const score = (a: Arm | "tie"): -1 | 0 | 1 => (a === "tie" ? 0 : a === "B" ? 1 : -1);
export const swap = (p: Positions): Positions => ({ left: p.right, right: p.left });

/** Where a case's own expectation lives: with the run's copy of its input (a continuation send), else in the bank. */
const ownFile = (caseId: string, name: string, run: string) =>
  existsSync(join(caseDir(run, caseId), "input.json")) ? join(caseDir(run, caseId), name) : join(paths().bankCase(caseId), name);

/** The expectation (§4.3), once per case: the before image and the step, never a result. Reused while its judgeId is current. */
export async function expectationFor(caseId: string, run: string): Promise<Expectation> {
  const file = ownFile(caseId, "expectation.json", run);
  const have = maybe<Expectation>(file);
  if (current(have, "expectation")) return have!;
  const r = await call("expectation", P.expectation(stepOf(caseId, run)), [imageOf(caseId, "before-ink.jpg", run)], run, caseId);
  const j = jsonIn(r.text);
  const [should, mustNot] = [strings(j?.should), strings(j?.mustNot)];
  if (!should?.length || !mustNot) throw new Error(`unreadable expectation for ${caseId}: ${r.text.slice(0, 120)}`);
  const e: Expectation = { judgeId: r.judgeId, should: should.slice(0, 4), mustNot: mustNot.slice(0, 2) };
  put(file, e);
  return e;
}

/**
 * The miss check (§4.1), once per banked case: did the champion's result (champion-after.jpg, and its
 * frozen change list, which the bank passes) do what they meant? Reused while its judgeId is current.
 */
export async function missCheck(caseId: string, run: string, changes: string[]): Promise<Miss> {
  const file = join(paths().bankCase(caseId), "miss.json");
  const have = maybe<Miss>(file);
  if (current(have, "miss")) return have!;
  const e = await expectationFor(caseId, run);
  const r = await call("miss", P.miss(stepOf(caseId), e, changes), [imageOf(caseId, "before-ink.jpg"), imageOf(caseId, "champion-after.jpg")], run, caseId);
  const met = jsonIn(r.text)?.met;
  if (!["yes", "partly", "no"].includes(met)) throw new Error(`unreadable miss check for ${caseId}: ${r.text.slice(0, 120)}`);
  const m: Miss = { judgeId: r.judgeId, met, why: String(jsonIn(r.text).why ?? "") };
  put(file, m);
  return m;
}

/** One fidelity call on a packet (stored in `packetRun`) in the given order; `callRun` labels the call. */
export async function fidelityCall(packetRun: string, p: Packet, positions: Positions, variant: P.Variant, callRun = packetRun): Promise<Judged> {
  const flipped = positions.left !== p.positions.left;
  const changes = flipped ? { left: p.changes.right, right: p.changes.left } : p.changes;
  const i = p.images;
  const framed = !!(i.leftChanged && i.rightChanged);
  const sides = flipped ? [i.right, i.left, ...(framed ? [i.rightChanged!, i.leftChanged!] : [])] : [i.left, i.right, ...(framed ? [i.leftChanged!, i.rightChanged!] : [])];
  const images = [i.before, ...sides].map((f) => imageOf(p.case, f, packetRun));
  const r = await call("fidelity", P.fidelity[variant](p, p.expectation, changes, framed), images, callRun, p.case, variant);
  return verdictOf(r.text, positions, r.judgeId, variant);
}

/**
 * One craft call: two images, no words. The after screens; or, when a result's screen left what changed, both framed on
 * it, so the judge compares what each arm made rather than one arm's new page against the other's untouched one.
 */
export async function craftCall(packetRun: string, p: Packet, variant: P.Variant, callRun = packetRun): Promise<Judged> {
  const i = p.images;
  const shots = i.leftChanged && i.rightChanged ? [i.leftChanged, i.rightChanged] : [i.left, i.right];
  const r = await call("craft", P.craft[variant](), shots.map((f) => imageOf(p.case, f, packetRun)), callRun, p.case, variant);
  return verdictOf(r.text, p.positions, r.judgeId, variant);
}

/** A seeded draw in [0, 1): the same seed, kind and case always give the same draw. */
export const draw = (seed: string | number, kind: string, caseId: string) => parseInt(sha(`${seed}|${kind}|${caseId}`).slice(0, 8), 16) / 2 ** 32;

/**
 * Positions for cases in entry order: each consecutive pair gets B on the left once, a seeded coin
 * picking which, so every even prefix (every look) is exactly balanced and a top-up never moves a judged case.
 */
export function positionsFor(caseIds: string[], seed: string | number): Map<string, Positions> {
  return new Map(caseIds.map((id, i): [string, Positions] => {
    const bLeft = (i % 2 === 0) === draw(seed, "pair", String(i >> 1)) < 0.5;
    return [id, bLeft ? { left: "B", right: "A" } : { left: "A", right: "B" }];
  }));
}

/** §4.4's fallback: above LOOP.flipAlarm once LOOP.flipFallbackAfter audited cases are in, the rest of the run is judged in both orders. */
export const bothOrders = (audited: number, flipped: number) => audited >= LOOP.flipFallbackAfter && flipped / audited > LOOP.flipAlarm;
const audited = (seed: string | number, caseId: string) => draw(seed, "audit", caseId) < LOOP.auditShare;

export type CaseVerdict = { s: -1 | 0 | 1; sCraft?: -1 | 0 | 1; first: Judged; second?: Judged; craft?: Judged };

/**
 * One run's judging. Fidelity on every case; craft on every case for craft-goal cards and checkpoints
 * ("all"), else on a seeded LOOP.craftShare ("sampled"), or never (calibration probes). The flip counts
 * are measured on the audit sample only (the low-confidence one is biased) and rebuilt from the run's
 * done cases, so a resumed run carries on where it stopped.
 */
export function judging(run: string, o: { seed: string | number; craft: "all" | "sampled" | "none" }) {
  const v = variants();
  const st = { audited: 0, flipped: 0, both: false };
  const cases = runFile(run, "cases");
  for (const c of existsSync(cases) ? readdirSync(cases) : []) {
    const [f1, f2] = ["fidelity-1.json", "fidelity-2.json"].map((f) => maybe<Judged>(join(cases, c, "judge", f)));
    if (!isDone(join(cases, c)) || !f1 || !f2 || !audited(o.seed, c)) continue;
    st.audited++;
    if (pick(f1) !== pick(f2)) st.flipped++;
  }
  st.both = bothOrders(st.audited, st.flipped);

  async function fidelity(p: Packet, caseId: string) {
    const file = (n: string) => join(caseDir(run, caseId), "judge", n);
    const first = await fidelityCall(run, p, p.positions, v.fidelity);
    put(file("fidelity-1.json"), first);
    // A tie is never re-judged: a second order could only disagree, which is a tie again.
    const audit = audited(o.seed, caseId);
    if (first.winner === "tie" || !(audit || first.confidence <= LOOP.lowConfidence || st.both)) return { first };
    const second = await fidelityCall(run, p, swap(p.positions), v.fidelity);
    put(file("fidelity-2.json"), second);
    if (audit) {
      st.audited++;
      if (pick(second) !== pick(first)) st.flipped++;
      if (!st.both && bothOrders(st.audited, st.flipped)) {
        st.both = true;
        appendLine(runFile(run, "judging.jsonl"), { at: new Date().toISOString(), both: true, audited: st.audited, flipped: st.flipped });
      }
    }
    return { first, second };
  }

  /** Judges one case (its packet written first) and stores judge/fidelity-1.json [fidelity-2.json] [craft.json]. */
  async function judgeCase(caseId: string, positions: Positions): Promise<CaseVerdict> {
    const p = writePacket(run, caseId, positions, await expectationFor(caseId, run));
    const wantCraft = o.craft === "all" || (o.craft === "sampled" && draw(o.seed, "craft", caseId) < LOOP.craftShare);
    const [{ first, second }, craft] = await Promise.all([fidelity(p, caseId), wantCraft ? craftCall(run, p, v.craft) : undefined]);
    if (craft) put(join(caseDir(run, caseId), "judge", "craft.json"), craft);
    return { s: score(combined(first, second)), ...(craft ? { sCraft: score(pick(craft)) } : {}), first, second, craft };
  }

  return { judgeCase, flips: () => ({ audited: st.audited, flipped: st.flipped }), both: () => st.both };
}
