// The loop's frozen numbers (spec §1.6, verbatim) and their id. Browser-safe on
// purpose: no imports, so the progress page and the bridge read the same values
// and the same configId as node.

/** Every number the loop decides with. Frozen measuring side: the optimizer can read it, never write it. */
export const LOOP = {
  // Rule F (§1.3), looks on affected cases
  looks: [16, 32, 48, 80], keepZ: [Infinity, 2.3, 1.8, 1.4], revertZ: [-0.2, 0.3, 0.7, 1.4], minDecisive: [10, 20, 30, 0],
  rareMin: 32, topUpMaxSends: 48,
  // latency and craft goals (§1.3)
  latFutility16: 1.0, latKeepHi90: 1.0, latRevert48: 0.98, qualityFloorZ: -1.0, workFloorZ: -0.5,
  // a latency keep's fidelity floor by look (none at 16), and its fidelity futility from look 32 on
  latFloorZ: [Infinity, 0, -0.5, -1.0], latFutilityZ: -1.25,
  // vetoes and trust (§1.4)
  latVeto: { lo95: 1.0, est: 1.08 }, latDebtLo90: 1.05, qualDebtHi90: 0.5, qualDebtFloorZ: 0,
  heldoutVetoZ: -1.0, heldoutMax: 32,
  workMin: 0.85, emptyRiseMax: 0.02, failedPicRiseMax: 0.02, costMax: 1.2, costCumMax: 1.2,
  voidMax: 0.10, flipAlarm: 0.30, dispatchBand: [0.4, 0.6], coldAsymMax: 0.10,
  cont: { cases: 20, sends: 2, vetoZ: -1.0 }, overuse: { max: 0.25, overA: 0.10 },
  // classes (§1.2); nTimingBand is also R8's shared timed-replay A/A band
  nTimingBand: 0.03, nTimedCases: 48, sConfirmCases: 24,
  // unshared A/A (checkpoint 0, §7.6): each of 4 intervals (TTFC, TTD, dispatch order, share) is mean ± t(G−1)·CR1 SE
  aa: { ci: 0.99, latNull: 1.0, shareNull: 0.5 },
  // judges (§4)
  judgePx: 640, judgeQuality: 0.8, auditShare: 0.2, lowConfidence: 1, flipFallbackAfter: 16, craftShare: 0.25,
  calib: { clear: 60, pass: 47, minClear: 40, selfGap: 0.10, preferMoreMax: 0.10, repeats: 8, contrast: 24,
           craftPairs: 30, craftPass: 22, promptVariants: 2 },
  canary: { packets: 20, alarmAtMost: 16 },
  // checkpoints (§5.2)
  checkpointEveryKeeps: 2, anchorMove: { share: 0.70, lo90: 0.60 }, overfitGap: 0.15, bootstrap: 2000,
  // bank (§2.1); B1 = all 32 H-chart cases + 32 tuning cases
  bank: { tuning: 160, heldoutGate: 32, heldoutChart: 32, tuningSends: 5, heldoutSends: 4, refreshEveryKeeps: 5,
          refreshCases: 40, missCheck: true },
  bench: { heldout: 32, tuning: 32 },
  // owner steps (§8.6)
  sync: { minHours: 24, sceneFailMax: 0.10 },
  // budget (§6.7)
  rotateAt: 0.90, windowUsdStart: 170, nightWindows: 1.2, firstNightWindows: 0.5,
  weekSevenDayMax: 0.40, weekWindowsPerToken: 3, decisionOverrun: 2.0, epochMaxMin: 60,
  // machine (§7); the per-machine dispatch limit is the ladder's p99 at the knee (machine.json), capped here
  loadMax: 0.6, psiMax: 0.10, sendTimeoutMs: 120_000, quiesceMs: 500, suspendGapMs: 10_000,
  dispatchOffsetCapMs: 25, eventLoopP99MaxMs: 20, heapGrowMaxMb: 20, diskOwnerGb: 20, diskPauseGb: 10,
} as const;
/** The driver's eyes and hand: today's values, frozen, so a candidate's shot.* or camera.* knobs can't move the simulated user. */
export const DRIVE_VIEW = { screenW: 960, screenH: 600, jpegQuality: 0.8, inkSize: 5, lookMinPx: 160, zoomMinPx: 160, zoomMaxPx: 20000, maxLooks: 3 } as const;

// SHA-256 in plain JS: synchronous, and the same in node and in a page served over
// plain http (crypto.subtle exists only in secure contexts, e.g. not on the PGX's
// Tailscale address). The round constants are the fractional bits of the first 64
// primes' cube roots, the start values of the first 8 primes' square roots.
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const fracBits = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = PRIMES.map((p) => fracBits(Math.cbrt(p)));
const H0 = PRIMES.slice(0, 8).map((p) => fracBits(Math.sqrt(p)));
const rotr = (x: number, r: number) => (x >>> r) | (x << (32 - r));

/** The hex SHA-256 of a string's UTF-8 bytes. */
export function sha256(text: string): string {
  const data = new TextEncoder().encode(text);
  const size = Math.ceil((data.length + 9) / 64) * 64; // the bytes, 0x80, zero padding, the 64-bit bit length
  const bytes = new Uint8Array(size);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(size - 8, Math.floor(data.length / 2 ** 29));
  view.setUint32(size - 4, (data.length * 8) >>> 0);
  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let at = 0; at < size; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const [a, b] = [w[i - 15], w[i - 2]];
      w[i] = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) + w[i - 16];
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => (h[i] = (h[i] + x) | 0));
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * The owner's notices, while the harness is young. The loop never stops for these: it tells the owner (the log and
 * $RT_EVAL_HOME/notices.jsonl, which a watcher relays) as each comes near (`soon` of the way) and when it's reached:
 * every `decisions` decisions, `minutes` minutes and `usd` list $ of a leg (the loop since it last started or resumed),
 * after each checkpoint, and before the night cap, which does stop it. The owner stops it between steps with
 * `rte stop-after` (nothing lost; `loop --resume` goes on). `--notify-<name> n` sets one for a leg, 0 turns it off.
 * Not in configId: they decide when the owner hears, not what is measured.
 */
export const NOTIFY = { decisions: 2, minutes: 120, usd: 20, checkpoint: 1, soon: 0.8 };

/** Logged on every decision and checkpoint: a change to LOOP or DRIVE_VIEW changes it. */
export const configId = sha256(JSON.stringify({ LOOP, DRIVE_VIEW }));
