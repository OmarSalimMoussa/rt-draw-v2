// The machine under a run (spec §7.6–7.8, fixes F16, N8). v1's overloaded laptop made
// turns 2× slower and broke latency pairing, so: load and CPU pressure gate every wave
// of cases, a heartbeat spots a suspend (cases in flight are void), the guards
// readiness records (factory slice, managed settings, AC power), and the ladder that
// freezes how many case slots this machine runs and its dispatch limit, measured on
// stubbed pages and the fake API (0 model calls).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, hostname } from "node:os";
import { join } from "node:path";
import { LOOP } from "./config.ts";
import { paths } from "./paths.ts";
import type { LoadSample } from "./types.ts";

/** The ladder (§7.6): slot counts tried in order, and how much worse than one slot a step may get. */
export const LADDER = {
  slots: [1, 2, 4, 6, 8, 12], wallMax: 1.15, longTaskRiseMax: 0.2, longTaskFloorMs: 50,
  // The dispatch limit never goes below this: a quiet machine's p99 over a ladder's few sends read 0.2 ms, and V9
  // then voided every case of the dry run at 0.2 ms. 5 ms is under 0.2% of a 3-s TTFC.
  dispatchFloorMs: 5,
} as const;
/** Before a wave: poll this often, for at most this long, then run one slot smaller. */
const WAVE_POLL_MS = 5_000;
const WAVE_WAIT_MS = 5 * 60_000;
const HEARTBEAT_MS = 10_000;

/** `some avg10` of /proc/pressure/<what> as a share (0.1 = 10%); 0 on a kernel without PSI, where load alone gates. */
function psi(what: string): number {
  try {
    return Number(/^some avg10=([\d.]+)/m.exec(readFileSync(`/proc/pressure/${what}`, "utf8"))?.[1] ?? 0) / 100;
  } catch {
    return 0;
  }
}

/** Load now: load1 per core, CPU and memory pressure as shares. */
export const sampleLoad = (): LoadSample => ({
  at: Date.now(),
  load1: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) / cpus().length,
  psiCpu: psi("cpu"),
  psiMemory: psi("memory"),
});

/** Quiet enough for a wave of cases: load1/cores < 0.6 and CPU pressure < 10%. */
export const quiet = (s: LoadSample) => s.load1 < LOOP.loadMax && s.psiCpu < LOOP.psiMax;

/** Waits for a quiet machine; after 5 min, ok = false: run this wave one slot smaller and record that. */
export async function beforeWave(maxWaitMs = WAVE_WAIT_MS): Promise<{ ok: boolean; waitedMs: number; sample: LoadSample }> {
  const start = Date.now();
  for (let sample = sampleLoad(); ; sample = sampleLoad()) {
    const waitedMs = Date.now() - start;
    if (quiet(sample) || waitedMs >= maxWaitMs) return { ok: quiet(sample), waitedMs, sample };
    await new Promise((r) => setTimeout(r, Math.min(WAVE_POLL_MS, maxWaitMs - waitedMs)));
  }
}

export type Beat = { wall: number; mono: number };
/** How much further the wall clock ran than the monotonic one, which stands still while the machine sleeps. */
export const suspendGap = (a: Beat, b: Beat) => b.wall - a.wall - (b.mono - a.mono);

/**
 * Writes heartbeat.json every 10 s with wall and monotonic time, and calls onSuspend(gapMs) when the machine
 * slept more than 10 s in between: every case in flight is then void and replayed. Returns stop().
 */
export function heartbeat(onSuspend: (gapMs: number) => void, file = paths().heartbeat): () => void {
  const beat = (): Beat => ({ wall: Date.now(), mono: performance.now() });
  const write = (b: Beat) => writeFileSync(file, JSON.stringify({ ...b, pid: process.pid, host: hostname() }) + "\n");
  let last = beat();
  write(last);
  const timer = setInterval(() => {
    const now = beat();
    const gap = suspendGap(last, now);
    write((last = now));
    if (gap > LOOP.suspendGapMs) onSuspend(gap);
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** On the ember box's factory slice, other agents' limits and load would set the product's speed. */
export const inFactorySlice = () => readFileSync("/proc/self/cgroup", "utf8").includes("emberhub-factory.slice");
export function refuseFactorySlice() {
  if (inFactorySlice()) throw new Error("refusing to run inside emberhub-factory.slice: run on the laptop or the PGX, outside the factory");
}

/** sha256 of Claude Code's managed settings (the policy every Claude process obeys), drop-ins included; "absent" without any. */
export function managedSettingsHash(dir = "/etc/claude-code"): string {
  const drop = join(dir, "managed-settings.d");
  const files = [join(dir, "managed-settings.json"), ...(existsSync(drop) ? readdirSync(drop).sort().map((f) => join(drop, f)) : [])].filter((f) => existsSync(f));
  if (!files.length) return "absent";
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0`).update(readFileSync(f)).update("\0");
  return h.digest("hex");
}

/** On mains (or USB-C) power: true or false on a machine with a battery, undefined on one without (the PGX). */
export function onAC(): boolean | undefined {
  const root = "/sys/class/power_supply";
  const supplies = existsSync(root) ? readdirSync(root).map((d) => ({ type: read(join(root, d, "type")), online: read(join(root, d, "online")) })) : [];
  if (!supplies.some((s) => s.type === "Battery")) return undefined;
  return supplies.some((s) => (s.type === "Mains" || s.type === "USB") && s.online === "1");
}
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : "");

/** One send of a ladder wave, measured by the caller's runWave (stubbed bridge pages, real Claude processes on the fake API). */
export type WaveSend = {
  wallMs: number; shotMs: number; longTasksMs: number;
  /** between the two arms' Enter */ dispatchOffsetMs: number;
  /** the gateway's event-loop delay p99 over the send */ loopDelayP99Ms: number;
  load: LoadSample;
};
export type Step = {
  slots: number; sends: number; wallMs: number; wallX: number; shotMs: number; longTasksMs: number;
  psiCpu: number; load1: number; dispatchP99Ms: number; loopDelayP99Ms: number; ok: boolean; why?: string;
};
/** machine.json: the frozen case slots and the V9 dispatch limit, with the steps that chose them. */
export type Machine = { host: string; arch: string; cores: number; at: string; slots: number; dispatchLimitMs: number; steps: Step[] };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.99 * xs.length) - 1];

/** A wave's numbers, and whether it stays within the knee's bounds against one slot (`base`; itself when absent). */
export function step(slots: number, sends: WaveSend[], base?: Step): Step {
  const s: Step = {
    slots, sends: sends.length,
    wallMs: median(sends.map((x) => x.wallMs)), wallX: 1, shotMs: median(sends.map((x) => x.shotMs)),
    longTasksMs: median(sends.map((x) => x.longTasksMs)), psiCpu: median(sends.map((x) => x.load.psiCpu)),
    load1: median(sends.map((x) => x.load.load1)), dispatchP99Ms: p99(sends.map((x) => x.dispatchOffsetMs)),
    loopDelayP99Ms: p99(sends.map((x) => x.loopDelayP99Ms)), ok: true,
  };
  s.wallX = base ? s.wallMs / base.wallMs : 1;
  const why = [
    s.wallX > LADDER.wallMax && `send wall ×${s.wallX.toFixed(2)} of one slot's`,
    base && s.longTasksMs > (1 + LADDER.longTaskRiseMax) * Math.max(base.longTasksMs, LADDER.longTaskFloorMs) && `long tasks ${s.longTasksMs} ms against ${base.longTasksMs}`,
    s.psiCpu >= LOOP.psiMax && `CPU pressure ${(s.psiCpu * 100).toFixed(0)}%`,
  ].filter(Boolean);
  if (why.length) Object.assign(s, { ok: false, why: why.join(", ") });
  return s;
}

/**
 * Climbs LADDER.slots up to `max` until a step breaks the knee's bounds, and freezes the last good one in
 * machine.json with the machine's dispatch limit: the p99 dispatch offset at the knee, at least
 * LADDER.dispatchFloorMs and at most LOOP.dispatchOffsetCapMs (V9 voids a case past it).
 */
export async function ladder(runWave: (slots: number) => Promise<WaveSend[]>, max = 12, file = paths().machine): Promise<Machine> {
  const steps: Step[] = [];
  for (const slots of LADDER.slots.filter((n) => n <= max)) {
    const s = step(slots, await runWave(slots), steps[0]);
    steps.push(s);
    if (!s.ok) break;
  }
  const knee = steps.filter((s) => s.ok).at(-1);
  if (!knee) throw new Error(`ladder: even one slot is too much here (${steps[0]?.why}); quiet the machine first`);
  const machine: Machine = {
    host: hostname(), arch: arch(), cores: cpus().length, at: new Date().toISOString(),
    slots: knee.slots, dispatchLimitMs: Math.min(Math.max(knee.dispatchP99Ms, LADDER.dispatchFloorMs), LOOP.dispatchOffsetCapMs), steps,
  };
  writeFileSync(file, JSON.stringify(machine, null, 2) + "\n");
  return machine;
}
