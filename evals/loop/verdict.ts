// The decision (spec §1.3–1.4): Rule F's looks for fidelity and craft cards, the paired-ratio
// rule for latency cards, then the trust check and every veto, all with LOOP's frozen numbers.
// Pure and seeded (bootstraps by the rows' case ids): the same rows, card and state always give
// the same verdict.
import { LOOP, configId } from "./config.ts";
import { type Metric, byThinking, latencyStats, pairedRatio, tailsOf } from "./latency.ts";
import { clusteredZ, tInterval } from "./stats.ts";
import type { Goal, HypothesisCard, Pair, Ratio, Row, Verdict } from "./types.ts";

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
  /** Each arm's share of product calls that waited on a starting process. */
  cold?: Pair<number>;
  /** Per-case invariants tripped (§7.5). */
  invariants?: number;
};

/** What the decision needs from the loop's state (§1.4 items 3, 4, 6). */
export type LoopState = { latencyDebt: boolean; qualityDebt: boolean; /** the champion's product $/send ÷ the anchor's */ costVsAnchor: number };

export type Decision = Omit<Verdict, "verdict"> & {
  /** "more": undecided, run affected cases up to `next` and decide again. */
  verdict: Verdict["verdict"] | "more";
  next?: number;
  /** A keep that stands only once these stages ran and vetoed nothing. */
  pending?: ("heldout" | "continuation")[];
  /** Too rare to measure: reverted, and the card goes to the owner list too. */
  ownerList?: boolean;
  /** Raw counts at the look it stopped at, never a share (an early-stopped share is biased). */
  counts: { wins: number; losses: number; ties: number; n: number; look: number };
  caveat?: string;
  latency: { ttfc?: Ratio; ttd?: Ratio; byThinking: Record<string, Ratio>; /** "ttfc p90" … "ttd p95" (LOOP.latTails) */ tails: Record<string, Ratio> };
  work: number; emptyRise: number; failedPicRise: number; usdRatio: number;
};

type Look = { n: number; decisive: number; z: number };

/**
 * Rule F's looks on rows in entry order: keep, revert, or undecided (`next`: the look that needs
 * more rows; undefined when there are none to come). Exported for the operating-characteristics check.
 */
export function ruleF<T extends { cluster: string }>(rows: T[], score: (r: T) => number, exhausted = true) {
  const looks: Look[] = [];
  for (let i = 0; i < LOOP.looks.length; i++) {
    const n = LOOP.looks[i];
    if (rows.length < n) return { looks, next: exhausted ? undefined : n };
    const z = clusteredZ(rows.slice(0, n).map((r) => ({ s: score(r), cluster: r.cluster })));
    looks.push({ n, decisive: z.decisive, z: z.z });
    if (z.decisive < LOOP.minDecisive[i] && i < LOOP.looks.length - 1) continue;
    if (z.z >= LOOP.keepZ[i]) return { looks, keep: true, n };
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
const x2 = (r: Ratio) => `×${r.est.toFixed(3)} (lo95 ${r.lo95.toFixed(3)}, hi90 ${r.hi90.toFixed(3)})`;
/** One latency stat: the median with its 90% upper bound, a tail ("p90", "p95") with its 95% one, the bound each keeps on. */
const stat = (m: string, k: string, r: Ratio) =>
  k === "p50" ? `${m} ${x2(r)}` : `${m} ${k} ×${r.est.toFixed(3)} (lo95 ${r.lo95.toFixed(3)}, hi95 ${(r.hi95 ?? r.hi90).toFixed(3)})`;

/** The fidelity floor a craft or latency keep must clear: `floor`, or tighter when visible work fell (N6) or in quality debt. */
function qualityFloor(rows: Row[], debt: boolean, floor: number): { ok: boolean; why: string } {
  const z = zOf(rows);
  if (debt) return { ok: z >= LOOP.qualDebtFloorZ, why: `quality debt: fidelity Z ${z.toFixed(2)} < ${LOOP.qualDebtFloorZ}` };
  const f = ratio(rows, (r, a) => r.work[a]) < LOOP.workMin ? Math.max(floor, LOOP.workFloorZ) : floor;
  return { ok: z >= f, why: `fidelity Z ${z.toFixed(2)} < ${f}` };
}

/** The latency veto (§1.4 item 2): either metric, at the median or a tail ("ttfc p90"), surely slower, and by more than LOOP.latVeto.est. */
export function latencyVeto(ratios: Record<string, Ratio | undefined>): string[] {
  return Object.entries(ratios).flatMap(([m, r]) => (r && r.lo95 > LOOP.latVeto.lo95 && r.est > LOOP.latVeto.est ? [`latency veto: ${m} ${x2(r)}`] : []));
}

/**
 * The goal-latency rule (§1.3) at each look, on the median send and the slow ones (LOOP.latTails): a keep when any of
 * them is surely faster and none surely slower; an early stop only when every one of them says so. Quality must hold
 * for a keep, and a futile quality ends it.
 */
function latencyRule(rows: Row[], m: Metric, holds: (rows: Row[], look: number) => { ok: boolean; why: string; futile?: boolean }, exhausted: boolean) {
  const looks: Look[] = [];
  let why = "";
  for (let i = 0; i < LOOP.looks.length; i++) {
    const n = LOOP.looks[i];
    if (rows.length < n) return { looks, next: exhausted ? undefined : n, why };
    const at = rows.slice(0, n);
    const stats = Object.entries(latencyStats(at, m));
    const q = holds(at, i);
    looks.push({ n, decisive: at.filter((x) => x.s).length, z: zOf(at) });
    if (q.futile) return { looks, keep: false, n, why: q.why };
    if (!stats.length) continue;
    const last = i === LOOP.looks.length - 1;
    const said = stats.map(([k, r]) => stat(m, k, r)).join("; ");
    if (i === 0 && stats.every(([, r]) => r.est > LOOP.latFutility16)) return { looks, keep: false, n, why: `${said} at look ${n}` };
    // A tail keeps only once it holds LOOP.latTailMinSends sends: p95 on 32 is the second-slowest send alone.
    const holds3 = (k: string) => n * (1 - Number(k.slice(1)) / 100) >= LOOP.latTailMinSends - 1e-9;
    const faster = stats.find(([k, r]) => (k === "p50" ? r.hi90 < LOOP.latKeepHi90 : holds3(k) && (r.hi95 ?? Infinity) < LOOP.latTailKeepHi95 && r.est <= LOOP.latTailKeepEst));
    const slower = latencyVeto(Object.fromEntries(stats.map(([k, r]) => [k === "p50" ? m : `${m} ${k}`, r])));
    if (i > 0 && faster && !slower.length) {
      if (q.ok) return { looks, keep: true, n, why: stat(m, ...faster) };
      why = q.why;
    }
    if ((i === 2 && stats.every(([, r]) => r.est >= LOOP.latRevert48)) || last) return { looks, keep: false, n, why: why || slower.join("; ") || `${said} at look ${n}` };
  }
  return { looks, keep: false, n: LOOP.looks.at(-1)!, why };
}

/**
 * The trust check (§1.4 item 9): a run that fails it decides nothing. The flip rate counts only
 * once LOOP.flipFallbackAfter cases were audited: on a handful, one flip would void the decision.
 */
function untrusted(all: Row[], live: Row[], i: DecideInput): string[] {
  const out: string[] = [];
  const voided = all.length ? (all.length - live.length) / all.length : 0;
  if (voided > LOOP.voidMax) out.push(`voided ${(100 * voided).toFixed(0)}% of cases`);
  if (i.flips && i.flips.audited >= LOOP.flipFallbackAfter && i.flips.flipped / i.flips.audited > LOOP.flipAlarm)
    out.push(`position flips on ${i.flips.flipped} of ${i.flips.audited} audited cases`);
  const firstA = live.filter((r) => r.firstArm === "A").length / live.length;
  if (live.length >= LOOP.looks[0] && (firstA < LOOP.dispatchBand[0] || firstA > LOOP.dispatchBand[1])) out.push(`A dispatched first on ${(100 * firstA).toFixed(0)}% of cases`);
  if (live.length >= LOOP.looks[0] && i.cold && Math.abs(i.cold[0] - i.cold[1]) > LOOP.coldAsymMax) out.push(`cold starts A ${(100 * i.cold[0]).toFixed(0)}% vs B ${(100 * i.cold[1]).toFixed(0)}%`);
  if (i.invariants) out.push(`${i.invariants} per-case invariants tripped`);
  return out;
}

/** keep | revert | void | owner, or "more" with the look that needs more cases. */
export function decide(input: DecideInput, card: HypothesisCard, state: LoopState): Decision {
  const all = [...input.tuning, ...(input.heldout ?? []), ...(input.continuation ?? [])];
  const live = input.tuning.filter((r) => !r.void);
  const cls = input.tuning[0]?.class ?? card.classGuess;
  const goal: Goal = cls === "S" ? "latency" : card.goal;
  const exhausted = !!input.exhausted;
  const reasons: string[] = [];
  const vetoes: string[] = [];

  let core: { looks: Look[]; keep?: boolean; n?: number; next?: number; why?: string };
  if (goal === "latency") {
    // Fidelity held tight early, looser with more cases, and a clear loss ends it: a floor that any later look could pass kept
    // a ×0.85 card losing fidelity at a .40 share 35% of the time after G3 (now 22%; a neutral one 79% → 70%, simulated).
    const holds = (rows: Row[], i: number) => {
      if (cls === "S") return { ok: true, why: "" };
      const z = zOf(rows);
      if (i > 0 && z <= LOOP.latFutilityZ) return { ok: false, futile: true, why: `fidelity Z ${z.toFixed(2)} ≤ ${LOOP.latFutilityZ}: the speed costs fidelity` };
      return qualityFloor(rows, state.qualityDebt, LOOP.latFloorZ[i]);
    };
    core = latencyRule(live, card.metric ?? "ttfc", holds, exhausted);
  } else {
    core = ruleF(live, (r) => ((goal === "craft" ? r.sCraft : r.s) ?? 0), exhausted);
    // A craft keep must not cost fidelity (N3), held tighter at look 32 or before.
    if (core.keep && goal === "craft") {
      const q = qualityFloor(live.slice(0, core.n), false, core.n! <= LOOP.looks[1] ? LOOP.workFloorZ : LOOP.qualityFloorZ);
      if (!q.ok) core = { ...core, keep: false, why: q.why };
    }
  }
  const at = live.slice(0, core.n ?? live.length);
  const score = (r: Row) => (goal === "craft" ? r.sCraft : r.s) ?? 0;
  const ttfc = pairedRatio(at, "ttfc"), ttd = pairedRatio(at, "ttd"), tails = tailsOf(at);
  // What every outcome reports, on the cases the deciding look saw.
  const seen = {
    counts: { wins: at.filter((r) => score(r) > 0).length, losses: at.filter((r) => score(r) < 0).length, ties: at.filter((r) => !score(r)).length, n: at.length, look: core.n ?? at.length },
    caveat: core.n && core.n < LOOP.looks.at(-1)! ? `stopped at look ${core.n}: an early-stopped decision's share is biased (a no-op reads ~0.47); the quality chart uses checkpoints` : undefined,
    latency: { ttfc, ttd, tails, byThinking: byThinking(at, card.metric ?? "ttfc") },
    work: ratio(at, (r, a) => r.work[a]),
    emptyRise: rateRise(at, (r, a) => +(r.work[a] === 0), () => 1),
    failedPicRise: rateRise(at, (r, a) => r.pics[a][1], (r, a) => r.pics[a][0] + r.pics[a][1]),
    usdRatio: ratio(at, (r, a) => r.usd[a]),
  };
  const out = (verdict: Decision["verdict"], extra: Partial<Decision> = {}): Decision => ({ verdict, reasons, goal, class: cls, looks: core.looks, vetoes, configId, ...seen, ...extra });

  const trust = untrusted(all, [...live, ...(input.heldout ?? []), ...(input.continuation ?? [])].filter((r) => !r.void), input);
  if (trust.length) return (reasons.push(...trust), out("void"));
  if (cls === "N") return (reasons.push("no effect: nothing differs between the arms"), out("revert"));
  if (exhausted && live.length < LOOP.rareMin) return (reasons.push(`too rare to measure: ${live.length} affected cases`), out("revert", { ownerList: true }));
  if (core.keep === undefined && core.next) return out("more", { next: core.next });
  if (!core.keep) {
    reasons.push(core.why || (core.n ? `Rule F at look ${core.n}` : `out of cases at ${live.length}`));
    return out("revert");
  }
  reasons.push(core.why || `Rule F keep at look ${core.n}`);

  // Vetoes on G2's own rows first: a revert here saves G3 and G4.
  const revert: string[] = [];
  const owner: string[] = [];
  if (goal !== "latency") {
    revert.push(...latencyVeto({ ttfc, ttd, ...tails }));
    if (state.latencyDebt)
      for (const [m, r] of Object.entries({ ttfc, ttd })) if (r && r.est > 1) revert.push(`latency debt: this keep's ${m} is ×${r.est.toFixed(3)}, above 1.00`);
  }
  if (seen.emptyRise > LOOP.emptyRiseMax) revert.push(`empty sends up ${(100 * seen.emptyRise).toFixed(1)} points`);
  if (seen.failedPicRise > LOOP.failedPicRiseMax) revert.push(`failed pictures up ${(100 * seen.failedPicRise).toFixed(1)} points`);
  if (seen.usdRatio > LOOP.costMax) owner.push(`product $ per case ×${seen.usdRatio.toFixed(2)}`);
  if (state.costVsAnchor * seen.usdRatio > LOOP.costCumMax) owner.push(`cumulative product $ per send ×${(state.costVsAnchor * seen.usdRatio).toFixed(2)} the anchor's`);
  if (card.overuseDetector) {
    const t = card.targets;
    const off = at.filter((r) => !(t?.asks?.includes(r.ask) || (r.beat && t?.beats?.includes(r.beat))));
    if (off.length) {
      const [a, b] = ([0, 1] as const).map((k) => off.filter((r) => r.overuse[k]).length / off.length);
      if (b > LOOP.overuse.max || b > a + LOOP.overuse.overA) owner.push(`over-use: ${card.overuseDetector} fired on ${(100 * b).toFixed(0)}% of B's non-target cases (A ${(100 * a).toFixed(0)}%)`);
    }
  }
  const pending: Decision["pending"] = [];
  if (!revert.length && !owner.length) {
    if ((cls === "Q" || cls === "D") && !input.heldout) pending.push("heldout");
    if (cls === "D" && !input.continuation) pending.push("continuation");
    const held = input.heldout?.filter((r) => r.affected && !r.void);
    if (held?.length && zOf(held) < LOOP.heldoutVetoZ) revert.push(`held-out: fidelity Z ${zOf(held).toFixed(2)} < ${LOOP.heldoutVetoZ}`);
    const cont = input.continuation?.filter((r) => !r.void);
    if (cont?.length && zOf(cont) <= LOOP.cont.vetoZ) revert.push(`continuation: fidelity Z ${zOf(cont).toFixed(2)} ≤ ${LOOP.cont.vetoZ}`);
  }
  vetoes.push(...revert, ...owner);
  if (revert.length) return out("revert");
  if (owner.length) return out("owner");
  return out("keep", pending.length ? { pending } : {});
}

/**
 * Checkpoint 0's A/A rule (LOOP.aa): four two-sided intervals, mean ± t(G − 1)·CR1 SE over the
 * origin sessions, must each contain their null: TTFC and TTD ratios, dispatch order (the first
 * arm's TTFC over the second's) and the share. Only a failed dispatch-order interval steps the
 * concurrency knee down; failed latency ratios never do (service drift moves both arms).
 */
export function aaPass(rows: Row[]) {
  const live = rows.filter((r) => !r.void);
  const ci = LOOP.aa.ci;
  const lat = (rs: Row[], x: (r: Row) => number) => {
    const iv = tInterval(rs.map(x), rs.map((r) => r.cluster), ci);
    const [est, lo, hi] = [iv.est, iv.lo, iv.hi].map(Math.exp);
    return { est, lo, hi, halfWidth: (hi - lo) / 2 };
  };
  const withTtfc = live.filter((r) => r.ttfc[0]! > 0 && r.ttfc[1]! > 0);
  const logB = (r: Row, m: "ttfc" | "ttd") => Math.log(r[m][1]! / r[m][0]!);
  const share = tInterval(live.map((r) => (r.s + 1) / 2), live.map((r) => r.cluster), ci);
  const tests = {
    ttfc: lat(withTtfc, (r) => logB(r, "ttfc")),
    ttd: lat(live, (r) => logB(r, "ttd")),
    order: lat(withTtfc, (r) => (r.firstArm === "B" ? 1 : -1) * logB(r, "ttfc")),
    share: { est: share.est, lo: share.lo, hi: share.hi, halfWidth: (share.hi - share.lo) / 2 },
  };
  const failed = (Object.keys(tests) as (keyof typeof tests)[]).filter((k) => {
    const nul = k === "share" ? LOOP.aa.shareNull : LOOP.aa.latNull;
    return !(tests[k].lo <= nul && nul <= tests[k].hi);
  });
  return { pass: !failed.length, ci, tests, failed, kneeDown: failed.includes("order") };
}
