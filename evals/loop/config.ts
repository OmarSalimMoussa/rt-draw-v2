// The loop's frozen numbers (spec §1.6, verbatim) and their id. Browser-safe on
// purpose: no imports, so the progress page and the bridge read the same values
// and the same configId as node.

/** Every number the loop decides with. Frozen measuring side: the optimizer can read it, never write it. */
export const LOOP = {
  // Rule F (§1.3), looks on affected cases. To 160 with looser early reverts (the funnel audit, 2026-10-27): the early
  // reverts stopped a third of the 60/40 winners before 80. On t13's planning generator a 60/40 card now keeps 58% of
  // the time (was 42%), a no-op 8.9% (was 8.2%; the audit's 1.6 and 1.5 lines at 80 and 160 made it 11.3%), and a
  // no-op costs 66 cases where it cost 35.
  looks: [16, 32, 48, 80, 160], keepZ: [Infinity, 2.3, 1.9, 1.8, 1.7], revertZ: [-1, -0.5, 0, 0.6, 1.7], minDecisive: [10, 20, 30, 0, 0],
  rareMin: 32, topUpMaxSends: 48,
  // latency and craft goals (§1.3)
  latFutility16: 1.0, latKeepP: 0.10, latRevert48: 0.98, qualityFloorZ: -1.0, workFloorZ: -0.5,
  // a latency keep's fidelity floor by look (none at 16), and its fidelity futility from look 32 on. Its length is the
  // latency rule's looks: it ends at 80, so the 160 look is fidelity's and craft's (another p < latKeepP look adds false keeps).
  latFloorZ: [Infinity, 0, -0.5, -1.0], latFutilityZ: -1.25,
  // the slow sends too (the owner, 2026-10-19): a latency keep may come from the p90 or p95 send (both arms' quantile,
  // B/A) as well as the median paired ratio: a tail keeps when surely under latTailKeepHi95 (swap test p < latTailKeepP), at least
  // latTailKeepEst faster, once it holds latTailMinSends sends (p90 from look 32, p95 at 80). Simulated on thinking's
  // two humps (a third of the sends ×2.5): a no-effect card is kept 18% of the time (median alone 14%; every tail at
  // every look 24%), a fix of the thinking sends to ×0.4 / ×0.6 / ×0.75 100% / 95% / 85% (median alone 84 / 75 / 54%).
  // Every one of them must be past latFutility16 or latRevert48 to stop a card early, and none surely slower (latVeto).
  latTails: [0.90, 0.95], latTailKeepHi95: 0.95, latTailKeepP: 0.05, latTailKeepEst: 0.90, latTailMinSends: 3,
  // The latencies that decide (the owner, 2026-10-24, LOOP-V2.md): time to first drawing, and render: the engine's time
  // from an op landing to it on screen on the send's board (one op's apply plus the paint of the frame that brings the
  // board's last change, measured idle after the send: bridge/main.ts engine()). Never slower on either, at the median or
  // a tail: the veto has no allowance. Surely slower is one session-swap test over every deciding stat at once (stats.ts
  // slowerP: the largest standardized slowdown among TTFD and render at p50, p90 and p95), p < latVeto.p family-wise,
  // on G2's and G3's cases together. A render under renderFloorMs reads as renderFloorMs in both arms, so
  // sub-millisecond jitter is no ratio. TTFC, TTD and $ are reported.
  latGated: ["ttfd", "render"], renderFloorMs: 1,
  // vetoes and trust (§1.4)
  latVeto: { p: 0.05 },
  // G3 confirms in direction (held-out fidelity or craft Z above 0, a latency card's metric faster) once it has
  // heldoutConfirmMin affected cases; with fewer it can only veto. Was −1.0 and 8 until the funnel audit (2026-10-27):
  // two G2 keeps were thrown away on held-out fidelity, d-cand-e70-h1 at Z −1.15 and d-cand-e80-h3 at −0.63 on 13 cases
  // (pooled with G2's, 1.50).
  heldoutVetoZ: -1.645, heldoutMax: 32, heldoutConfirmMin: 16,
  // The search (LOOP-V2.md D1, D3, D4): the analyst's hypotheses an epoch, the critic's cards (a sweep is one card of up
  // to sweepMax values, a combo one card of up to comboMax tried patches), and the near wins the digest lists.
  // A sweep's k values share one card's error (D3): each keeps past keepZ raised by z(1 − sweepAlpha/k) − z(1 − sweepAlpha),
  // sweepAlpha being Rule F's one-sided pass rate for a no-op at G2 (5.5% simulated), and a latency value on a p k times smaller.
  search: { hypotheses: [4, 8], cards: 6, sweepMax: 4, comboMax: 3, pruneZ: -1.0, sweepAlpha: 0.055 },
  // renderUnmeasuredMax: past this share of a keep's cases without a render both engines could compare (a new shape
  // kind), the render veto can't speak for it: the owner's.
  workMin: 0.85, emptyRiseMax: 0.02, failedPicRiseMax: 0.02, renderUnmeasuredMax: 0.25,
  voidMax: 0.10, flipAlarm: 0.30, dispatchBand: [0.4, 0.6], coldAsymMax: 0.10,
  cont: { cases: 20, sends: 2, vetoZ: -1.0 },
  // classes (§1.2); nTimingBand is also R8's shared timed-replay A/A band
  nTimingBand: 0.03, nTimedCases: 48,
  // unshared A/A (checkpoint 0, §7.6): each of 4 intervals (TTFD, render, dispatch order, share) is mean ± t(G−1)·CR1 SE
  aa: { ci: 0.99, latNull: 1.0, shareNull: 0.5 },
  // judges (§4)
  judgePx: 640, judgeQuality: 0.8, auditShare: 0.2, lowConfidence: 1, flipFallbackAfter: 16,
  calib: { clear: 60, pass: 47, minClear: 40, selfGap: 0.10, preferMoreMax: 0.10, repeats: 8, contrast: 24,
           craftPairs: 30, craftPass: 22,
           // The illustrations round (rte calib --illustrations): the same bars on half the labels, from this many cases with pictures.
           illustrations: { clear: 30, pass: 24, minClear: 20, craftPairs: 15, craftPass: 11, repeats: 4, repeatGap: 15, cases: 48 } },
  canary: { packets: 20, alarmAtMost: 16 },
  // checkpoints (§5.2): the champion against A0, which never moves. bootstrap: the share band's draws of whole sessions,
  // and the swap test's random patterns past 11 sessions.
  checkpointEveryKeeps: 2, overfitGap: 0.15, bootstrap: 2000,
  // bank (§2.1); B1 = all 32 H-chart cases + 32 tuning cases. A refresh adds cases and none retire (the owner,
  // 2026-10-26: old cases stay relevant). Past scanMax tuning cases, each decision's diffscan takes its own seeded
  // sample of them (rte.ts scanCases): the scan replays ~0.2 s a case on the PGX, so 800 is about 3 minutes.
  bank: { tuning: 160, heldoutGate: 32, heldoutChart: 32, tuningSends: 5, heldoutSends: 4, refreshEveryKeeps: 5,
          scanMax: 800 },
  bench: { heldout: 32, tuning: 32 },
  // owner steps (§8.6)
  sync: { minHours: 24, sceneFailMax: 0.10 },
  // budget (§6.7). The token is shared with testers on prod (the owner, 2026-10-24): new work pauses at fiveHourPauseAt of
  // the five-hour window (0.60 until the owner raised it on 2026-10-26) and stops at weekSevenDayMax of the week (0.50 until
  // the owner raised it on 2026-10-27), both the server's reading of the whole account (every
  // call on a slot brings one). A decision past state.ts' RULES.decisionMaxMin of measuring is void (overrun); --cap
  // bounds every step's calls.
  fiveHourPauseAt: 0.90, weekSevenDayMax: 0.70,
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
 * and after each checkpoint. The owner stops it between steps with
 * `rte stop-after` (nothing lost; `loop --resume` goes on). `--notify-<name> n` sets one for a leg, 0 turns it off.
 * Not in configId: they decide when the owner hears, not what is measured.
 */
export const NOTIFY = { decisions: 2, minutes: 120, usd: 20, checkpoint: 1, soon: 0.8 };

/**
 * A token parked for its week (the server's 7-day use past LOOP.weekSevenDayMax) gets no calls, so nothing would read
 * its week again: once its reading is `afterH` hours old, the loop spends one one-word Haiku call on it to read it.
 * Not in configId: it decides which token pays, not what is measured.
 */
export const WEEK_CHECK = { afterH: 6 };

/**
 * An eval role's output, at most: the model's own maximum. Only the product's calls keep dev/claude.ts' MAX_TOKENS, as
 * the hosted app does: gold is the ideal the product aims at, so nothing throttles it, nor triage, the judge or the
 * loop's agents (e86's Opus analyst ran out at 4096 thinking). Here, not in dev/: a candidate's tree has the champion's.
 * Not in configId: it bounds no measurement.
 */
export const EVAL_MAX_TOKENS = 128_000;

/** Logged on every decision and checkpoint: a change to LOOP or DRIVE_VIEW changes it. */
export const configId = sha256(JSON.stringify({ LOOP, DRIVE_VIEW }));
