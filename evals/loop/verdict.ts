// The decision (spec §1.3–1.4): Rule F's looks for fidelity and craft cards, the paired-ratio
// rule for latency cards, then the trust check and every veto, all with LOOP's frozen numbers.
// Only the deciding latencies (LOOP.latGated: time to first drawing, render) and quality decide;
// TTFC, TTD and $ are reported (LOOP-V2.md).
// Pure and seeded (swap tests by the rows' case ids): the same rows and card always give the same
// verdict.
import { LOOP, configId } from "./config.ts";
import { type Gated, byThinking, latencyStats, pairedRatio, shiftTest, tailsOf } from "./latency.ts";
import { clusteredZ, tInterval, tQuantile } from "./stats.ts";
import type { Shadow } from "../real/shadow.ts";
import type { Code, Goal, HypothesisCard, Pair, Ratio, Row, Verdict } from "./types.ts";

export type DecideInput = {
  /** G2's rows in entry order, voided cases included (they count toward the void rate). */
  tuning: Row[];
  /** G3: the affected H-gate cases, run once a keep asks for them. */
  heldout?: Row[];
  /** G4: the continuation sends of a class D card, run once a keep asks for them. */
  continuation?: Row[];
  /** No more cases can come: the bank and LOOP.topUpMaxSends top-ups are spent. */
  exhausted?: boolean;
  /** The judge's audited second orders, and how many disagreed with the first. */
  flips?: { audited: number; flipped: number };
  /** Each arm's product calls that waited on a starting process, of all it made upstream. */
  cold?: Pair<{ n: number; of: number }>;
  /** Per-case invariants tripped (§7.5). */
  invariants?: number;
};

export type Decision = Omit<Verdict, "verdict"> & {
  /** "more": undecided, run affected cases up to `next` and decide again. */
  verdict: Verdict["verdict"] | "more";
  next?: number;
  /** A keep that stands only once these stages ran and vetoed nothing. */
  pending?: ("heldout" | "continuation")[];
  codes: Code[];
  /** Raw counts at the look it stopped at, never a share (an early-stopped share is biased). */
  counts: { wins: number; losses: number; ties: number; n: number; look: number };
  caveat?: string;
  /** ttfd and render decide, ttfc and ttd are reported; tails: "ttfd p90" … "render p95" (LOOP.latTails). */
  latency: { ttfc?: Ratio; ttd?: Ratio; ttfd?: Ratio; render?: Ratio; byThinking: Record<string, Ratio>; tails: Record<string, Ratio> };
  work: number; emptyRise: number; failedPicRise: number; usdRatio: number;
  /** Bench R1 on both arms at a keep (evals/real/shadow.ts): reported, decides nothing until the judge is calibrated on illustrations. */
  real?: Shadow;
};

type Look = { n: number; decisive: number; z: number };

/**
 * How many decisions share this card's error: a sweep's values (LOOP-V2.md D3), or the near-wins a combo puts together
 * (each already tried once), else 1.
 */
const familyOf = (card: HypothesisCard) => Math.max(1, card.sweep?.values.length ?? card.combines?.length ?? 1);
/** The z a family of k tries adds to Rule F's keep line, so the family keeps a no-op about as often as one card does. */
export const sweepShift = (k: number) => (k > 1 ? tQuantile(1 - LOOP.search.sweepAlpha / k, 1e6) - tQuantile(1 - LOOP.search.sweepAlpha, 1e6) : 0);

/**
 * Rule F's looks on rows in entry order: keep, revert, or undecided (`next`: the look that needs
 * more rows; undefined when there are none to come). Exported for the operating-characteristics check.
 */
export function ruleF<T extends { cluster: string }>(rows: T[], score: (r: T) => number, exhausted = true, keepShift = 0) {
  const looks: Look[] = [];
  for (let i = 0; i < LOOP.looks.length; i++) {
    const n = LOOP.looks[i];
    if (rows.length < n && (!exhausted || rows.length < LOOP.rareMin)) return { looks, next: exhausted ? undefined : n };
    // Out of cases short of look n: one last look on them all at n's keep line, where a card used to revert unlooked
    // (e66-h5: Z 1.79 at look 48 against 1.8, then 1.66 on all 59).
    if (rows.length < n) {
      const z = clusteredZ(rows.map((r) => ({ s: score(r), cluster: r.cluster })));
      looks.push({ n: rows.length, decisive: z.decisive, z: z.z });
      return { looks, keep: z.z >= LOOP.keepZ[i] + keepShift, n: rows.length };
    }
    const z = clusteredZ(rows.slice(0, n).map((r) => ({ s: score(r), cluster: r.cluster })));
    looks.push({ n, decisive: z.decisive, z: z.z });
    if (z.decisive < LOOP.minDecisive[i] && i < LOOP.looks.length - 1) continue;
    if (z.z >= LOOP.keepZ[i] + keepShift) return { looks, keep: true, n };
    if (z.z <= LOOP.revertZ[i]) return { looks, keep: false, n };
  }
  return { looks, keep: false, n: LOOP.looks.at(-1)! };
}

const zOf = (rows: Row[], craft = false) => clusteredZ(rows.map((r) => ({ s: (craft ? r.sCraft : r.s) ?? 0, cluster: r.cluster }))).z;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ratio = (rows: Row[], f: (r: Row, arm: 0 | 1) => number) => {
  const a = sum(rows.map((r) => f(r, 0)));
  return a > 0 ? sum(rows.map((r) => f(r, 1))) / a : 1;
};
const rateRise = (rows: Row[], f: (r: Row, arm: 0 | 1) => number, of: (r: Row, arm: 0 | 1) => number) => {
  const rate = (arm: 0 | 1) => sum(rows.map((r) => of(r, arm))) && sum(rows.map((r) => f(r, arm))) / sum(rows.map((r) => of(r, arm)));
  return rate(1) - rate(0);
};
const pOf = (r: Ratio) => (r.p ? ` (p slower ${r.p.slower.toFixed(3)}, p faster ${r.p.faster.toFixed(3)})` : "");
/** One latency stat: "ttfd ×0.912 (p slower …)", a tail "ttfd p90 ×0.85 (…)". */
const stat = (m: string, k: string, r: Ratio) => `${m}${k === "p50" ? "" : ` ${k}`} ×${r.est.toFixed(3)}${pOf(r)}`;

/** The fidelity floor a craft or latency keep must clear: `floor`, or tighter when visible work fell (N6). */
function qualityFloor(rows: Row[], floor: number): { ok: boolean; why: string } {
  const z = zOf(rows);
  const f = ratio(rows, (r, a) => r.work[a]) < LOOP.workMin ? Math.max(floor, LOOP.workFloorZ) : floor;
  return { ok: z >= f, why: `fidelity Z ${z.toFixed(2)} < ${f}` };
}

/**
 * The latency veto (§1.4 item 2): B surely slower on any deciding latency, at the median or a tail (the owner: never
 * slower), as one family-wise swap test over all of them (latency.ts shiftTest, p < LOOP.latVeto.p). Its reason, or none.
 */
export function latencyVeto(rows: Row[]): string | undefined {
  const t = shiftTest(rows);
  if (!t || t.slower >= LOOP.latVeto.p) return undefined;
  const [m, k = "p50"] = t.worst.split(" ");
  const r = latencyStats(rows, m as Gated)[k];
  return `latency veto: surely slower (p ${t.slower.toFixed(3)} over every deciding stat), most on ${r ? stat(m, k, r) : t.worst}`;
}

/** The latency rule's looks, one per LOOP.latFloorZ: to 80, not Rule F's 160. */
const LAT_LOOKS = LOOP.looks.slice(0, LOOP.latFloorZ.length);

/**
 * The goal-latency rule (§1.3) at each look, on the median send and the slow ones (LOOP.latTails): a keep when any of
 * them is surely faster and nothing surely slower, on either deciding latency (a faster first drawing that paints
 * slower is no keep); an early stop only when every one of the card's metric's says so. Quality must hold for a keep,
 * and a futile quality ends it.
 */
function latencyRule(rows: Row[], m: Gated, holds: (rows: Row[], look: number) => { ok: boolean; why: string; futile?: boolean }, exhausted: boolean, family = 1): Core {
  const looks: Look[] = [];
  let why = "";
  for (let i = 0; i < LAT_LOOKS.length; i++) {
    const n = LAT_LOOKS[i];
    if (rows.length < n) return { looks, next: exhausted ? undefined : n, why };
    const at = rows.slice(0, n);
    const stats = Object.entries(latencyStats(at, m));
    const q = holds(at, i);
    looks.push({ n, decisive: at.filter((x) => x.s).length, z: zOf(at) });
    if (q.futile) return { looks, keep: false, n, why: q.why, floor: true };
    if (!stats.length) continue;
    const last = i === LAT_LOOKS.length - 1;
    const said = stats.map(([k, r]) => stat(m, k, r)).join("; ");
    if (i === 0 && stats.every(([, r]) => r.est > LOOP.latFutility16)) return { looks, keep: false, n, why: `${said} at look ${n}` };
    // A tail keeps only once it holds LOOP.latTailMinSends sends: p95 on 32 is the second-slowest send alone.
    const holds3 = (k: string) => n * (1 - Number(k.slice(1)) / 100) >= LOOP.latTailMinSends - 1e-9;
    // Surely faster on the swap test (LOOP-V2.md A3): the median against A, a tail against LOOP.latTailKeepHi95·A.
    const faster = stats.find(([k, r]) => (k === "p50" ? r.p!.faster < LOOP.latKeepP / family : holds3(k) && r.p!.faster < LOOP.latTailKeepP / family && r.est <= LOOP.latTailKeepEst));
    const slower = faster ? latencyVeto(at) : undefined;
    if (i > 0 && faster && !slower) {
      if (q.ok) return { looks, keep: true, n, why: stat(m, ...faster) };
      why = q.why;
    }
    if ((i === 2 && stats.every(([, r]) => r.est >= LOOP.latRevert48)) || last) return { looks, keep: false, n, why: why || slower || `${said} at look ${n}`, floor: !!why };
  }
  return { looks, keep: false, n: LAT_LOOKS.at(-1)!, why, floor: !!why };
}
type Core = { looks: Look[]; keep?: boolean; n?: number; next?: number; why?: string; floor?: boolean };

/**
 * The trust check (§1.4 item 9): a run that fails it decides nothing. The flip rate counts only
 * once LOOP.flipFallbackAfter cases were audited: on a handful, one flip would void the decision.
 */
function untrusted(all: Row[], live: Row[], i: DecideInput): string[] {
  const out: string[] = [];
  // One arm's failures (Row.lost) score as its losses but count here too: a harness that breaks one arm's tree voids.
  const voided = all.length ? all.filter((r) => r.void || r.lost).length / all.length : 0;
  if (voided > LOOP.voidMax) out.push(`voided or one-arm failures on ${(100 * voided).toFixed(0)}% of cases`);
  if (i.flips && i.flips.audited >= LOOP.flipFallbackAfter && i.flips.flipped / i.flips.audited > LOOP.flipAlarm)
    out.push(`position flips on ${i.flips.flipped} of ${i.flips.audited} audited cases`);
  const firstA = live.filter((r) => r.firstArm === "A").length / live.length;
  if (live.length >= LOOP.looks[0] && (firstA < LOOP.dispatchBand[0] || firstA > LOOP.dispatchBand[1])) out.push(`A dispatched first on ${(100 * firstA).toFixed(0)}% of cases`);
  // One cold call more isn't an asymmetry: a dialogue card's 5 live sends made it 20% alone (e76-h6, e77-h3).
  const cold = i.cold?.map((c) => (c.of ? c.n / c.of : 0));
  if (live.length >= LOOP.looks[0] && i.cold && cold && Math.abs(i.cold[0].n - i.cold[1].n) > 1 && Math.abs(cold[0] - cold[1]) > LOOP.coldAsymMax) out.push(`cold starts A ${(100 * cold[0]).toFixed(0)}% vs B ${(100 * cold[1]).toFixed(0)}%`);
  if (i.invariants) out.push(`${i.invariants} per-case invariants tripped`);
  return out;
}

/** keep | revert | void | owner, or "more" with the look that needs more cases. */
export function decide(input: DecideInput, card: HypothesisCard): Decision {
  const all = [...input.tuning, ...(input.heldout ?? []), ...(input.continuation ?? [])];
  const live = input.tuning.filter((r) => !r.void);
  const cls = input.tuning[0]?.class ?? card.classGuess;
  const goal: Goal = cls === "S" ? "latency" : card.goal;
  const exhausted = !!input.exhausted;
  // A card from before LOOP-V2 named ttfc or ttd: time to first drawing is what those meant to speed up.
  const metric: Gated = card.metric === "render" ? "render" : "ttfd";
  const reasons: string[] = [];
  const vetoes: string[] = [];
  const codes: Code[] = [];

  let core: Core;
  if (goal === "latency") {
    // Fidelity held tight early, looser with more cases, and a clear loss ends it: a floor that any later look could pass kept
    // a ×0.85 card losing fidelity at a .40 share 35% of the time after G3 (now 22%; a neutral one 79% → 70%, simulated).
    const holds = (rows: Row[], i: number) => {
      if (cls === "S") return { ok: true, why: "" };
      const z = zOf(rows);
      if (i > 0 && z <= LOOP.latFutilityZ) return { ok: false, futile: true, why: `fidelity Z ${z.toFixed(2)} ≤ ${LOOP.latFutilityZ}: the speed costs fidelity` };
      return qualityFloor(rows, LOOP.latFloorZ[i]);
    };
    core = latencyRule(live, metric, holds, exhausted, familyOf(card));
  } else {
    core = ruleF(live, (r) => ((goal === "craft" ? r.sCraft : r.s) ?? 0), exhausted, sweepShift(familyOf(card)));
    // A craft keep must not cost fidelity (N3), held tighter at look 32 or before.
    if (core.keep && goal === "craft") {
      const q = qualityFloor(live.slice(0, core.n), core.n! <= LOOP.looks[1] ? LOOP.workFloorZ : LOOP.qualityFloorZ);
      if (!q.ok) core = { ...core, keep: false, why: q.why, floor: true };
    }
  }
  const at = live.slice(0, core.n ?? live.length);
  const sent = at.filter((r) => !r.lost);
  const score = (r: Row) => (goal === "craft" ? r.sCraft : r.s) ?? 0;
  const ttfc = pairedRatio(at, "ttfc"), ttd = pairedRatio(at, "ttd"), ttfd = pairedRatio(at, "ttfd"), render = pairedRatio(at, "render"), tails = tailsOf(at);
  // What every outcome reports, on the cases the deciding look saw.
  const seen = {
    counts: { wins: at.filter((r) => score(r) > 0).length, losses: at.filter((r) => score(r) < 0).length, ties: at.filter((r) => !score(r)).length, n: at.length, look: core.n ?? at.length },
    caveat: core.n && core.n < (goal === "latency" ? LAT_LOOKS : LOOP.looks).at(-1)! ? `stopped at look ${core.n}: an early-stopped decision's share is biased (a no-op reads ~0.47); the quality chart uses checkpoints` : undefined,
    latency: { ttfc, ttd, ttfd, render, tails, byThinking: byThinking(at, metric) },
    // A lost case is Rule F's loss, but no send to measure: one hiccup isn't an empty send.
    work: ratio(sent, (r, a) => r.work[a]),
    emptyRise: rateRise(sent, (r, a) => +(r.work[a] === 0), () => 1),
    failedPicRise: rateRise(sent, (r, a) => r.pics[a][1], (r, a) => r.pics[a][0] + r.pics[a][1]),
    usdRatio: ratio(sent, (r, a) => r.usd[a]),
  };
  const out = (verdict: Decision["verdict"], extra: Partial<Decision> = {}): Decision => ({ verdict, reasons, goal, class: cls, looks: core.looks, vetoes, codes, configId, ...seen, ...extra });

  const trust = untrusted(all, [...live, ...(input.heldout ?? []), ...(input.continuation ?? [])].filter((r) => !r.void), input);
  if (trust.length) return (reasons.push(...trust), out("void"));
  if (cls === "N") return (reasons.push("no effect: nothing differs between the arms"), out("revert"));
  if (exhausted && live.length < LOOP.rareMin) return (reasons.push(`too rare to measure: ${live.length} affected cases`), out("revert"));
  if (core.keep === undefined && core.next) return out("more", { next: core.next });
  if (!core.keep) {
    reasons.push(core.why || (core.n ? `Rule F at look ${core.n}` : `out of cases at ${live.length}`));
    if (core.floor) codes.push("floor");
    return out("revert");
  }
  reasons.push(core.why || `Rule F keep at look ${core.n}`);

  // Vetoes on G2's own rows first: a revert here saves G3 and G4.
  const revert: string[] = [];
  const owner: string[] = [];
  const veto = (code: Code, text: string) => (revert.push(text), codes.includes(code) || codes.push(code));
  if (seen.emptyRise > LOOP.emptyRiseMax) veto("empty", `empty sends up ${(100 * seen.emptyRise).toFixed(1)} points`);
  if (seen.failedPicRise > LOOP.failedPicRiseMax) veto("pictures", `failed pictures up ${(100 * seen.failedPicRise).toFixed(1)} points`);
  const deferred = at.filter((r) => r.deferred?.[1] && !r.deferred[0]).length;
  if (deferred) veto("deferred", `render() leaves its work for after it returns (${deferred} cases), so its render time isn't measured`);
  // Not measured: no render at all, or nothing of B's own board compared (a new shape kind's paint). A new op's board
  // compares its paint, with B's apply charged on top (metrics.ts renderOf), so a slow new op still shows.
  const unmeasured = sent.filter((r) => (r.render && (r.render[0] === null || r.render[1] === null)) || r.renderSame?.[1] === "none").length;
  if (sent.length && unmeasured / sent.length > LOOP.renderUnmeasuredMax) owner.push(`render not measured on ${unmeasured} of ${sent.length} cases (a new shape kind's paint untimed), so the render veto can't speak for this keep`);
  const pending: Decision["pending"] = [];
  if (!revert.length && !owner.length) {
    // G3 confirms every keep, whatever its class (LOOP-V2.md D2): the affected H-gate cases, which no card is ever
    // tuned on, veto on fidelity, and with LOOP.heldoutConfirmMin of them they must also lean the card's way (a neutral
    // card passes a veto alone 84% of the time). Rule F's first look is the screen before it. The latency veto waits for
    // G3 and reads G2's and G3's cases together: one test on more cases, where one on each threw away good changes twice.
    if (!input.heldout) pending.push("heldout");
    if (cls === "D" && !input.continuation) pending.push("continuation");
    const held = input.heldout?.filter((r) => r.affected && !r.void);
    if (held?.length && zOf(held) < LOOP.heldoutVetoZ) veto("heldout", `held-out: fidelity Z ${zOf(held).toFixed(2)} < ${LOOP.heldoutVetoZ}`);
    const slow = held ? latencyVeto([...at, ...held]) : undefined;
    if (slow) veto("latency", held!.length ? `${slow} (G2 and held-out)` : slow);
    if (held && held.length >= LOOP.heldoutConfirmMin && !revert.length) {
      if (goal === "latency") {
        const r = pairedRatio(held, metric);
        if (r && r.est >= 1) veto("direction", `held-out: ${metric} ×${r.est.toFixed(3)} isn't faster`);
      } else if (zOf(held, goal === "craft") <= 0) veto("direction", `held-out: ${goal} Z ${zOf(held, goal === "craft").toFixed(2)} doesn't lean the card's way`);
    }
    const cont = input.continuation?.filter((r) => !r.void);
    if (cont?.length && zOf(cont) <= LOOP.cont.vetoZ) veto("continuation", `continuation: fidelity Z ${zOf(cont).toFixed(2)} ≤ ${LOOP.cont.vetoZ}`);
  }
  if (owner.length) codes.push("owner");
  vetoes.push(...revert, ...owner);
  if (revert.length) return out("revert");
  if (owner.length) return out("owner");
  return out("keep", pending.length ? { pending } : {});
}

/**
 * Checkpoint 0's A/A rule (LOOP.aa): four two-sided intervals, mean ± t(G − 1)·CR1 SE over the
 * origin sessions, must each contain their null: the deciding latencies' ratios (TTFD, render),
 * dispatch order (the first arm's TTFD over the second's) and the share. Only a failed
 * dispatch-order interval steps the concurrency knee down; failed latency ratios never do
 * (service drift moves both arms).
 */
export function aaPass(rows: Row[]) {
  const live = rows.filter((r) => !r.void);
  const ci = LOOP.aa.ci;
  const lat = (rs: Row[], x: (r: Row) => number) => {
    const iv = tInterval(rs.map(x), rs.map((r) => r.cluster), ci);
    const [est, lo, hi] = [iv.est, iv.lo, iv.hi].map(Math.exp);
    return { est, lo, hi, halfWidth: (hi - lo) / 2 };
  };
  const floor = (m: Gated, v: number | null | undefined) => (m === "render" && typeof v === "number" ? Math.max(v, LOOP.renderFloorMs) : v);
  const both = (m: Gated) => live.filter((r) => (floor(m, r[m]?.[0]) ?? 0) > 0 && (floor(m, r[m]?.[1]) ?? 0) > 0);
  const logB = (r: Row, m: Gated) => Math.log(floor(m, r[m]![1])! / floor(m, r[m]![0])!);
  const share = tInterval(live.map((r) => (r.s + 1) / 2), live.map((r) => r.cluster), ci);
  const tests = {
    ttfd: lat(both("ttfd"), (r) => logB(r, "ttfd")),
    render: lat(both("render"), (r) => logB(r, "render")),
    order: lat(both("ttfd"), (r) => (r.firstArm === "B" ? 1 : -1) * logB(r, "ttfd")),
    share: { est: share.est, lo: share.lo, hi: share.hi, halfWidth: (share.hi - share.lo) / 2 },
  };
  const failed = (Object.keys(tests) as (keyof typeof tests)[]).filter((k) => {
    const nul = k === "share" ? LOOP.aa.shareNull : LOOP.aa.latNull;
    return !(tests[k].lo <= nul && nul <= tests[k].hi);
  });
  return { pass: !failed.length, ci, tests, failed, kneeDown: failed.includes("order") };
}
