// The canary (spec §4.6): 20 stable packets, decided the same way in both orders when they were
// judged, re-judged weekly and on any served-model or SDK change. 16 or fewer agreeing is an alarm
// (0.3% false alarms at 97% stability), confirmed on 20 more packets before anyone calls it an era
// break. One call per packet in its first order: ~$0.19 a run.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LOOP } from "../loop/config.ts";
import { paths } from "../loop/paths.ts";
import { appendLine } from "../loop/record.ts";
import type { Arm, HealthRow, Judged } from "../loop/types.ts";
import { draw, fidelityCall, judgeId, lastServed, pick, variants } from "./judge.ts";
import { readPacket } from "./packet.ts";

/** Weekly. */
export const CANARY_EVERY_MS = 7 * 86_400_000;
type Stable = { run: string; case: string; arm: Arm };
type Line = { kind: "set"; at: string; packets: Stable[] } | { kind: "run"; at: string; run: string; judgeId: string; agree: number; n: number; alarm: boolean; confirm?: { agree: number; n: number; confirmed: boolean } };

const file = () => join(paths().history, "judge", "canary.jsonl");
const lines = (): Line[] => (existsSync(file()) ? readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const maybe = <T>(f: string): T | undefined => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);

/** Every run packet whose two orders picked the same arm, in seeded order. */
export function stablePackets(seed: string | number): Stable[] {
  const out: Stable[] = [];
  const runs = join(paths().home, "runs");
  for (const run of existsSync(runs) ? readdirSync(runs) : []) {
    const cases = join(runs, run, "cases");
    for (const c of existsSync(cases) ? readdirSync(cases) : []) {
      const [f1, f2] = ["fidelity-1.json", "fidelity-2.json"].map((f) => maybe<Judged>(join(cases, c, "judge", f)));
      if (f1 && f2 && pick(f1) !== "tie" && pick(f1) === pick(f2) && existsSync(join(cases, c, "judge", "packet.json"))) out.push({ run, case: c, arm: pick(f1) as Arm });
    }
  }
  return out.sort((a, b) => draw(seed, "canary", `${a.run}/${a.case}`) - draw(seed, "canary", `${b.run}/${b.case}`));
}

/** ≤ 16 agreeing of 20 (the same share of a smaller confirmation set). */
export const canaryAlarm = (agree: number, n: number) => agree <= (LOOP.canary.alarmAtMost * n) / LOOP.canary.packets;

/** Due weekly, or when the judge the canary last ran under (its judgeId: served model, SDK, prompts) isn't today's. */
export function canaryDue(served = lastServed(), now = Date.now()): boolean {
  const last = lines().filter((l) => l.kind === "run").at(-1);
  if (!last || last.kind !== "run") return true;
  return now - Date.parse(last.at) >= CANARY_EVERY_MS || (served !== undefined && judgeId("fidelity", served, variants().fidelity) !== last.judgeId);
}

/** One canary run (the set is picked on the first and kept in canary.jsonl); the HealthRow is for health.jsonl. */
export async function runCanary(seed: string | number = "canary"): Promise<HealthRow> {
  let set = lines().find((l) => l.kind === "set")?.packets as Stable[] | undefined;
  if (!set) {
    set = stablePackets(seed).slice(0, LOOP.canary.packets);
    if (set.length < LOOP.canary.packets) throw new Error(`only ${set.length} stable packets: the canary needs ${LOOP.canary.packets}`);
    appendLine(file(), { kind: "set", at: new Date().toISOString(), packets: set });
  }
  const at = new Date().toISOString();
  const run = `canary-${at.slice(0, 16).replace(/:/g, "-")}`;
  const v = variants().fidelity;
  // Each packet in the order it was first asked, with today's judge.
  const agreeing = async (ps: Stable[]) =>
    (await Promise.all(ps.map(async (k) => {
      const f1 = maybe<Judged>(join(paths().run(k.run), "cases", k.case, "judge", "fidelity-1.json"))!;
      return pick(await fidelityCall(k.run, readPacket(k.run, k.case), f1.positions, v, run)) === k.arm;
    }))).filter(Boolean).length;
  const agree = await agreeing(set);
  const alarm = canaryAlarm(agree, set.length);
  let confirm: { agree: number; n: number; confirmed: boolean } | undefined;
  if (alarm) {
    const more = stablePackets(seed).filter((k) => !set!.some((s) => s.run === k.run && s.case === k.case)).slice(0, LOOP.canary.packets);
    const a = await agreeing(more);
    confirm = { agree: a, n: more.length, confirmed: canaryAlarm(a, more.length) };
  }
  const line: Line = { kind: "run", at, run, judgeId: judgeId("fidelity", lastServed(), v), agree, n: set.length, alarm, ...(confirm ? { confirm } : {}) };
  appendLine(file(), line);
  return { at, kind: "canary", pass: !confirm?.confirmed, detail: line };
}
