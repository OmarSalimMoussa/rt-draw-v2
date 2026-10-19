// G1, the diffscan (spec §1.2, N2): both arms run every case with the bank's replies served instantly
// (an exact hit, else the case's recorded reply for that role as a stand-in, the same in both arms), at
// 0 calls. A case is affected when any role's request hashes differ between the arms, or the after-scene
// or the rendered stage does: only affected cases are ever paid for or judged, and the rest are exact
// ties. The class is the scan's (the card's declared one is only logged): an after-scene that differs
// where nothing renders (state only the next send reads) or a request that differs on a dialogue card
// → D; a request that differs → Q; a scene or render that differs → R; else timed replay on
// LOOP.nTimedCases cases tells N (TTFC and TTD within ±LOOP.nTimingBand) from S. A stand-in can hide an
// effect that only a different upstream reply would show: that risk is accepted (§1.2).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { caseFile } from "../judge/packet.ts";
import { type ForkFile, type Rig, type RunSpec, runAB } from "./ab.ts";
import { LOOP } from "./config.ts";
import { pairedRatio, tailsOf } from "./latency.ts";
import { caseDir, put, runFile } from "./record.ts";
import { entryOrder, seedOf } from "./stats.ts";
import type { CaseInfo, DecisionClass, Ratio, RecordedReply, SceneJSON, SetId } from "./types.ts";

export type CaseScan = {
  case: string; set: SetId; affected: boolean;
  /** Roles whose request hashes differ between the arms. */
  requests: string[];
  scene: boolean; svg: boolean;
  /** Request hashes both arms sent: a live G2 run serves these from the bank, the same reply on its own clock to both. */
  identical: string[];
};
export type ScanResult = {
  run: string; class: DecisionClass; declared?: string; mismatch: boolean;
  cases: CaseScan[];
  /** The affected cases per set, in the order they ran. */
  affected: Partial<Record<SetId, string[]>>;
  /** Identical request hashes over the affected cases: RunSpec.cached for G2 and G3. */
  cached: string[];
  timed?: { run: string; ttfc?: Ratio; ttd?: Ratio; /** "ttfc p90" … "ttd p95" */ tails?: Record<string, Ratio> };
};

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const js = JSON.stringify;

/** One arm's request hashes by role, each a sorted list: pictures run side by side, so their order isn't stable. */
function byRole(calls: RecordedReply[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of calls) m.set(c.role, [...(m.get(c.role) ?? []), c.reqHash]);
  for (const v of m.values()) v.sort();
  return m;
}

/** What differs between the arms on one scanned case, from its run files. */
export function compareCase(run: string, id: string): Omit<CaseScan, "set"> {
  const dir = caseDir(run, id);
  const [a, b] = (["A", "B"] as const).map((x) => byRole(json<RecordedReply[]>(join(dir, x, "replies.json"))));
  const requests = [...new Set([...a.keys(), ...b.keys()])].filter((r) => js(a.get(r)) !== js(b.get(r)));
  const fork = json<ForkFile>(join(dir, "fork.json"));
  const scene = js(json<SceneJSON>(join(dir, "A", "after.scene.json"))) !== js(json<SceneJSON>(join(dir, "B", "after.scene.json")));
  const svg = fork.svg.A !== fork.svg.B;
  const inB = new Set([...b.values()].flat());
  return { case: id, affected: requests.length > 0 || scene || svg, requests, scene, svg, identical: [...new Set([...a.values()].flat().filter((h) => inB.has(h)))] };
}

const caseClass = (c: Omit<CaseScan, "set">): DecisionClass => (!c.affected ? "N" : c.scene && !c.svg ? "D" : c.requests.length ? "Q" : "R");

/**
 * Scans `cases` (tuning, and H-gate cases too so G3 knows which are affected), classifies the card on the
 * tuning cases and writes runs/<run>/scan.json. Timed replay runs as `<run>-timed`, only when nothing differs.
 */
export async function scan(rig: Rig, o: Pick<RunSpec, "run" | "arms" | "seed" | "card" | "loadWaitMs" | "faults"> & { cases: string[] }): Promise<ScanResult> {
  const per = new Map<string, CaseScan>();
  const caseScan = (id: string): CaseScan => ({ ...compareCase(o.run, id), set: json<CaseInfo>(caseFile(id, "case.json", o.run)).set });
  const classify = (id: string) => {
    const c = caseScan(id);
    per.set(id, c);
    return { affected: c.affected, class: caseClass(c) };
  };
  const { rows } = await runAB(rig, { ...o, kind: "scan", mode: "scan", share: true, classify });
  // A resumed scan reuses the cases it finished: they're compared from their files.
  const cases = rows.map((r) => per.get(r.case) ?? caseScan(r.case));
  // Refresh cases (set fresh) are tuning cases the bank added later.
  const tuning = cases.filter((c) => c.set === "tuning" || c.set === "fresh");
  let cls: DecisionClass;
  let timed: ScanResult["timed"];
  if (tuning.some((c) => c.scene && !c.svg)) cls = "D";
  // A resolver change moves what a later send's words point at ("that one", on what this send drew): G4 runs, as for dialogue.
  else if (tuning.some((c) => c.requests.length)) cls = o.card?.dialogue || o.card?.component === "resolve" ? "D" : "Q";
  else if (tuning.some((c) => c.affected)) cls = "R";
  else {
    // Requests, scenes and renders all identical: does the timing move? (a schedule change, or nothing)
    const ids = entryOrder(tuning.map((c) => c.case), (id) => json<CaseInfo>(caseFile(id, "case.json", o.run)).originSession, seedOf(o.seed)).slice(0, LOOP.nTimedCases);
    const run = `${o.run}-timed`;
    const t = await runAB(rig, { ...o, run, kind: "scan", mode: "replay", share: true, cases: ids, cls: "N", classify: () => ({ affected: false, class: "N" }) });
    timed = { run, ttfc: pairedRatio(t.rows, "ttfc"), ttd: pairedRatio(t.rows, "ttd"), tails: tailsOf(t.rows) };
    // The slow sends too: a schedule change on a few sends (the picture-heavy ones) moves a tail, not the median.
    const flat = (r?: Ratio) => !r || Math.abs(r.est - 1) <= LOOP.nTimingBand;
    cls = [timed.ttfc, timed.ttd, ...Object.values(timed.tails!)].every(flat) ? "N" : "S";
  }
  const affected: ScanResult["affected"] = {};
  for (const c of cases.filter((x) => x.affected)) (affected[c.set] ??= []).push(c.case);
  const cached = [...new Set(cases.filter((c) => c.affected).flatMap((c) => c.identical))];
  const result: ScanResult = { run: o.run, class: cls, declared: o.card?.classGuess, mismatch: !!o.card && o.card.classGuess !== cls, cases, affected, cached, timed };
  put(runFile(o.run, "scan.json"), result);
  return result;
}
