// T13's acceptance check: Rule F, the latency and craft goals, every veto, the debts and the
// checkpoint-0 A/A rule, on synthetic rows only (0 model calls, no files, no network).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t13-verdict.mjs   (the simulations' numbers go to stderr)
import { check, finish } from "./lib.mjs";

const { LOOP } = await import("../loop/config.ts");
const { rng, chain, cr1, tQuantile } = await import("../loop/stats.ts");
const { aaPass, decide, latencyVeto, ruleF } = await import("../loop/verdict.ts");
const { chainSince, debtsAfter, linksOf, pairedRatio } = await import("../loop/latency.ts");

const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const sig = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- t quantiles against the table values the spec's simulations use
for (const [p, df, t] of [[0.975, 27, 2.052], [0.995, 27, 2.771], [0.9975, 27, 3.057], [0.95, 1, 6.314], [0.9, 10, 1.372]])
  check(near(tQuantile(p, df), t, 0.002), `t quantile ${p} df ${df} is ${tQuantile(p, df)}, want ${t}`);

// ---- Rule F's operating characteristics: the planning row of work/spec-reviser/sim/rule-final-20k.out,
// with that simulation's own generator (lean's genSends) and seeds: σS .5, σT .3, ties 15%, sessions of 5.
const PLANNING = { 0.45: 2.2, 0.5: 8.0, 0.55: 21.4, 0.6: 41.9, 0.65: 65.6, 0.7: 84.7 };
const RUNS = 20000;
const t0 = Date.now();
const got = {};
for (const p of Object.keys(PLANNING).map(Number)) {
  const r = rng(Math.round(p * 1000) + 31);
  let keeps = 0;
  for (let i = 0; i < RUNS; i++) {
    const tfx = Array.from({ length: 10 }, () => gauss(r) * 0.3);
    const rows = [];
    for (let s = 0; s < 16; s++) {
      const us = gauss(r) * 0.5;
      for (let k = 0; k < 5; k++) {
        r(); // genSends' touch draw (every send touched here)
        const pb = sig(logit(p) + tfx[s % 10] + us);
        rows.push({ cluster: `s${s}`, s: r() < 0.15 ? 0 : r() < pb ? 1 : -1 });
      }
    }
    if (ruleF(rows, (x) => x.s).keep) keeps++;
  }
  got[p] = (100 * keeps) / RUNS;
  check(near(got[p], PLANNING[p], 1.5), `Rule F keeps ${got[p].toFixed(1)}% at share ${p}, planning row says ${PLANNING[p]}`);
}
console.error(`Rule F P(keep) ${Object.entries(got).map(([p, k]) => `${p}:${k.toFixed(1)}`).join(" ")} (planning ${Object.values(PLANNING).join(" / ")}; ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// ---- The latency veto at 48 cases: verify-design's fork model (thinking correlated within a fork, the
// resolver shared), which vetoes ~4 / 23 / 61% of 0 / +5 / +10% slowdowns.
const t1 = Date.now();
const VETO = [[0, 4], [0.05, 23], [0.1, 61]];
const SIMS = 1000;
const vetoed = [];
VETO.forEach(([slower, want], i) => {
  const r = rng(97 + i * 13 + 48);
  let n = 0;
  for (let s = 0; s < SIMS; s++) {
    const rows = Array.from({ length: 48 }, (_, c) => {
      const ask = gauss(r) * 0.35, moment = gauss(r) * 0.12;
      const pThink = r() < 0.615 ? 0.8 : 0.15;
      const resolver = 3500 * Math.exp(gauss(r) * 0.12 + moment);
      const arm = (isB) => (resolver + (r() < pThink ? 4200 : 1400) * Math.exp(gauss(r) * 0.35 + 0.5 * ask + moment) + 200) * (isB ? 1 + slower : 1);
      return { case: `c${c}`, cluster: `c${c}`, ttfc: [arm(false), arm(true)] };
    });
    if (latencyVeto({ ttfc: pairedRatio(rows, "ttfc") }).length) n++;
  }
  vetoed.push((100 * n) / SIMS);
  check(near(vetoed[i], want, 5), `latency veto fires on ${vetoed[i].toFixed(1)}% of +${slower * 100}% slowdowns, want ~${want}%`);
});
console.error(`latency veto at 48 cases: ${vetoed.map((v) => v.toFixed(1)).join(" / ")}% of 0 / +5 / +10% slowdowns (${((Date.now() - t1) / 1000).toFixed(1)} s)`);

// ---- Checkpoint 0's A/A rule on B1's cluster layout (8 H-chart sessions of 4, 32 tuning cases over 20
// sessions): a flawless harness fails it ~4% of the time (work/spec-reviser/sim/aa-cr1.out).
{
  const r = rng(7);
  let fails = 0;
  const half = { ttfc: [], ttd: [], order: [], share: [] };
  for (let n = 0; n < RUNS; n++) {
    const rows = [];
    for (let k = 0; k < 8; k++) for (let j = 0; j < 4; j++) rows.push({ cluster: `h${k}` });
    for (let j = 0; j < 32; j++) rows.push({ cluster: `t${j % 20}` });
    rows.forEach((x, i) => {
      const ea = gauss(r), eb = gauss(r);
      const fa = 0.7 * ea + Math.sqrt(0.51) * gauss(r), fb = 0.7 * eb + Math.sqrt(0.51) * gauss(r);
      x.ttfc = [2000, 2000 * Math.exp(0.45 * (ea - eb))];
      x.ttd = [6000, 6000 * Math.exp(0.5 * (fa - fb))];
      x.firstArm = i % 2 ? "B" : "A";
      const u = r();
      x.s = u < 0.3 ? 0 : u < 0.65 ? 1 : -1;
    });
    const aa = aaPass(rows);
    if (!aa.pass) fails++;
    for (const k in half) half[k].push(aa.tests[k].halfWidth);
    if (n === 0) check(aa.ci === LOOP.aa.ci && ["ttfc", "ttd", "order", "share"].every((k) => aa.tests[k].lo < aa.tests[k].hi), "aaPass doesn't report four intervals at LOOP.aa.ci");
  }
  const med = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
  const failPct = (100 * fails) / RUNS;
  check(failPct <= 5 && failPct >= 3, `a flawless A/A fails checkpoint 0 in ${failPct.toFixed(1)}% of runs, want ~4% (≤ 5)`);
  check(near(med(half.ttfc), 0.22, 0.03), `median TTFC half-width ±${(100 * med(half.ttfc)).toFixed(0)}%, the simulation says ±22%`);
  console.error(`A/A at 99%: fails ${failPct.toFixed(1)}% of ${RUNS} flawless runs; median half-widths ttfc ±${(100 * med(half.ttfc)).toFixed(0)}% ttd ±${(100 * med(half.ttd)).toFixed(0)}% order ±${(100 * med(half.order)).toFixed(0)}% share ±${med(half.share).toFixed(3)}`);
  // A dispatch-order bias steps the knee down; a latency drift alone never does.
  const biased = (f) => {
    const rows = [];
    for (let j = 0; j < 64; j++) rows.push({ cluster: `s${j % 28}`, firstArm: j % 2 ? "B" : "A", s: [1, 0, -1, 0][j % 4], ttd: [6000, 6000], ttfc: [2000, 2000 * f(j)] });
    return aaPass(rows);
  };
  const order = biased((j) => (j % 2 ? 1.3 : 1 / 1.3) * (1 + 0.02 * Math.sin(j)));
  check(order.failed.includes("order") && order.kneeDown, `a first-arm advantage doesn't fail the order interval: ${order.failed}`);
  const drift = biased((j) => 1.3 * (1 + 0.02 * Math.sin(j)));
  check(drift.failed.includes("ttfc") && !drift.kneeDown, `a latency-ratio failure steps the knee down or isn't seen: ${drift.failed} ${drift.kneeDown}`);
}

// ---- decide(): a clean row set keeps; every veto of §1.4 fires on its crafted set
/** Fidelity a little worse: 3 wins, 4 losses in 16, Z ≈ −0.6 on 32 cases (inside −1, outside −0.5 and 0). */
const SLIGHT_LOSS = (i) => [1, -1, 0, -1, 1, -1, 0, 0, 1, -1, 0, 0, 0, 0, 0, 0][i % 16];
const card = (o = {}) => ({ id: "h1", component: "draw", kind: "knob", change: "x", goal: "fidelity", classGuess: "Q", dialogue: false, predicts: "", isPatch: false, raisesCost: false, touchesFrozen: false, risk: "", files: [], ...o });
const STATE = { latencyDebt: false, qualityDebt: false, costVsAnchor: 1 };
const noise = (i) => 1 + 0.01 * Math.sin(i * 1.7);
/** n rows over sessions of 4; `s(i)` scores case i; B's latency is `lat` × A's. */
const rows = (n, o = {}) =>
  Array.from({ length: n }, (_, i) => ({
    case: `c${i}`, cluster: `s${Math.floor(i / 4)}`, affected: true, class: o.class ?? "Q",
    s: (o.s ?? ((i) => [1, 1, 1, 0][i % 4]))(i), sCraft: o.sCraft?.(i),
    ttfc: [2000 * noise(i), 2000 * noise(i) * (o.lat?.(i) ?? 1)], ttd: [6000, 6000 * (o.ttd?.(i) ?? 1)],
    work: [o.workA?.(i) ?? 3, o.workB?.(i) ?? 3], usd: [0.02, 0.02 * (o.usd ?? 1)], thought: [false, false], overuse: [false, o.overB?.(i) ?? false],
    pics: [[1, 0], [1, o.failB?.(i) ?? 0]], ask: o.ask?.(i) ?? "add", firstArm: o.first?.(i) ?? (i % 2 ? "B" : "A"),
    ...(o.void?.(i) ? { void: "invariant" } : {}),
  }));
const run = (tuning, c = card(), state = STATE, extra = {}) => decide({ tuning, heldout: rows(16), exhausted: true, ...extra }, c, state);
const says = (d, verdict, re) => d.verdict === verdict && (!re || [...d.reasons, ...d.vetoes].some((x) => re.test(x)));

const clean = run(rows(32));
check(says(clean, "keep") && !clean.vetoes.length && !clean.pending, `the clean set doesn't keep cleanly: ${clean.verdict} ${clean.reasons} ${clean.vetoes}`);
check(clean.configId && clean.looks.length === 2 && clean.counts.look === 32, `the clean keep lacks configId or its looks: ${JSON.stringify(clean.looks)}`);
check(/biased/.test(clean.caveat ?? ""), "an early-stopped share carries no caveat");
check(says(decide({ tuning: rows(32), exhausted: true }, card(), STATE), "keep") && decide({ tuning: rows(32), exhausted: true }, card(), STATE).pending?.[0] === "heldout", "a Q keep without G3 isn't pending on the held-out cases");
const vetoCases = {
  "held-out": [() => run(rows(32), card(), STATE, { heldout: rows(16, { s: (i) => [-1, -1, 0, 1][i % 4] }) }), "revert", /held-out/],
  latency: [() => run(rows(32, { lat: () => 1.15 })), "revert", /latency veto: ttfc/],
  "latency (ttd)": [() => run(rows(32, { ttd: (i) => 1.12 * noise(i) })), "revert", /latency veto: ttd/],
  "latency debt": [() => run(rows(32, { lat: () => 1.03 }), card(), { ...STATE, latencyDebt: true }), "revert", /latency debt/],
  "quality debt": [() => run(rows(32, { class: "Q", lat: () => 0.8, s: SLIGHT_LOSS }), card({ goal: "latency" }), { ...STATE, qualityDebt: true }), "revert", /quality debt/],
  "empty sends": [() => run(rows(32, { workB: (i) => (i % 10 === 3 ? 0 : 3) })), "revert", /empty sends/],
  "failed pictures": [() => run(rows(32, { failB: (i) => +(i % 10 === 3) })), "revert", /failed pictures/],
  cost: [() => run(rows(32, { usd: 1.3 })), "owner", /product \$ per case/],
  "cumulative cost": [() => run(rows(32, { usd: 1.1 }), card(), { ...STATE, costVsAnchor: 1.15 }), "owner", /cumulative/],
  continuation: [() => run(rows(32, { class: "D" }), card({ dialogue: true }), STATE, { continuation: rows(20, { class: "D", s: (i) => [-1, -1, 0, 1][i % 4] }) }), "revert", /continuation/],
  "over-use": [() => run(rows(32, { overB: (i) => i % 10 < 3 }), card({ overuseDetector: "new-style", targets: { asks: ["restyle"] } })), "owner", /over-use/],
  "over-use (over A)": [() => run(rows(32, { overB: (i) => i % 7 === 0 }), card({ overuseDetector: "new-style", targets: { asks: ["restyle"] } })), "owner", /over-use/],
  "void rate": [() => run(rows(32, { void: (i) => i % 5 === 0 })), "void", /voided/],
  "position flips": [() => run(rows(32), card(), STATE, { flips: { audited: 16, flipped: 6 } }), "void", /flips/],
  "dispatch order": [() => run(rows(32, { first: (i) => (i % 4 ? "A" : "B") })), "void", /dispatched first/],
  "cold-start asymmetry": [() => run(rows(32), card(), STATE, { cold: [0.3, 0.1] }), "void", /cold starts/],
  invariants: [() => run(rows(32), card(), STATE, { invariants: 1 }), "void", /invariants/],
};
for (const [name, [make, verdict, re]] of Object.entries(vetoCases)) {
  const d = make();
  check(says(d, verdict, re), `${name} veto: got ${d.verdict} (${[...d.reasons, ...d.vetoes].join("; ")}), want ${verdict} ${re}`);
}
// …and none of them on the clean set's near misses.
const nearMisses = {
  "latency +5%": run(rows(32, { lat: () => 1.05 })),
  "cost ×1.15": run(rows(32, { usd: 1.15 })),
  "over-use only on its target asks": run(rows(32, { overB: (i) => i % 10 < 3, ask: (i) => (i % 10 < 3 ? "restyle" : "add") }), card({ overuseDetector: "new-style", targets: { asks: ["restyle"] } })),
  "8 audited, 4 flipped (too few to judge)": run(rows(32), card(), STATE, { flips: { audited: 8, flipped: 4 } }),
  "an empty send in both arms": run(rows(32, { workA: (i) => (i === 5 ? 0 : 3), workB: (i) => (i === 5 ? 0 : 3) })),
  "quality debt, but fidelity Z ≥ 0": run(rows(32, { class: "Q", lat: () => 0.8 }), card({ goal: "latency" }), { ...STATE, qualityDebt: true }),
  "quality debt on a fidelity keep": run(rows(32), card(), { ...STATE, qualityDebt: true }),
  "latency debt, this keep faster": run(rows(32, { lat: () => 0.97 }), card(), { ...STATE, latencyDebt: true }),
};
for (const [name, d] of Object.entries(nearMisses)) check(says(d, d.verdict === "keep" && !d.vetoes.length ? "keep" : "x"), `${name} shouldn't veto: ${d.verdict} ${d.vetoes}`);
check(says(run(rows(32, { class: "N" })), "revert", /no effect/), "class N isn't reverted as no effect");
const rare = decide({ tuning: rows(20), exhausted: true }, card(), STATE);
check(says(rare, "revert", /too rare/) && rare.ownerList, `20 affected cases after the top-ups isn't 'too rare': ${rare.verdict} ${rare.reasons}`);
const more = decide({ tuning: rows(20) }, card(), STATE);
check(more.verdict === "more" && more.next === 32, `20 cases with more to come doesn't ask for look 32: ${more.verdict} ${more.next}`);
const d1 = run(rows(32, { class: "D" }), card({ dialogue: true }), STATE, { heldout: rows(16) });
check(says(d1, "keep") && d1.pending?.join() === "continuation", `a D keep without G4 isn't pending on continuation: ${d1.pending}`);
const fewDecisive = decide({ tuning: rows(16, { s: (i) => (i < 6 ? -1 : 0) }) }, card(), STATE);
check(fewDecisive.verdict === "more" && fewDecisive.next === 32, `a look with fewer than ${LOOP.minDecisive[0]} decisive cases isn't skipped: ${fewDecisive.verdict}`);
const loses = run(rows(16, { s: (i) => [-1, -1, 1, 0][i % 4] }));
check(says(loses, "revert") && loses.counts.look === 16, `a losing card isn't reverted at look 16: ${loses.verdict} ${loses.counts.look}`);

// ---- Goal latency (§1.3)
const LAT = card({ goal: "latency", metric: "ttfc" });
const futile = decide({ tuning: rows(16, { class: "S", lat: () => 1.04 }) }, LAT, STATE);
check(says(futile, "revert") && futile.counts.look === 16, `a slower latency card isn't reverted at look 16: ${futile.verdict} ${futile.counts.look}`);
const fast = decide({ tuning: rows(80, { class: "S", lat: () => 0.85, s: () => 0 }), exhausted: true }, LAT, STATE);
check(says(fast, "keep") && fast.counts.look === 32 && !fast.pending, `a faster S card doesn't keep at look 32: ${fast.verdict} ${fast.counts.look} ${fast.pending}`);
// Seeded noisy B/A around `mid` (per case and per session): sets picked to reach each later look.
const noisy = (mid, seed) => {
  const r = rng(seed);
  const sess = Array.from({ length: 20 }, () => gauss(r));
  const lat = Array.from({ length: 80 }, (_, i) => mid * Math.exp(0.3 * gauss(r) + 0.15 * sess[i >> 2]));
  return rows(80, { class: "S", s: () => 0, lat: (i) => lat[i] });
};
const flat = decide({ tuning: noisy(0.99, 3), exhausted: true }, LAT, STATE);
check(says(flat, "revert") && flat.counts.look === 48, `a no-gain latency card (est ≥ 0.98 at 48) isn't reverted at look 48: ${flat.verdict} ${flat.counts.look} ${flat.reasons}`);
const late = [decide({ tuning: noisy(0.96, 20), exhausted: true }, LAT, STATE), decide({ tuning: noisy(0.96, 17), exhausted: true }, LAT, STATE)];
check(says(late[0], "keep") && late[0].counts.look === 80 && late[0].latency.ttfc.hi90 < 1, `a small sure gain isn't kept at look 80: ${late[0].verdict} ${late[0].counts.look}`);
check(says(late[1], "revert") && late[1].counts.look === 80 && late[1].latency.ttfc.hi90 >= 1, `an unsure small gain isn't reverted at look 80: ${late[1].verdict} ${late[1].counts.look}`);
const qFast = (s) => decide({ tuning: rows(80, { class: "Q", lat: () => 0.85, s }), heldout: rows(16), exhausted: true }, LAT, STATE);
check(says(qFast((i) => [1, -1, 0, 0][i % 4]), "keep"), "a faster Q card with fidelity holding isn't kept");
check(says(qFast((i) => [-1, -1, 0, 1][i % 4]), "revert", /fidelity Z/), "a faster Q card that loses fidelity (Z ≤ −1) is kept");
const qWork = (workB) => decide({ tuning: rows(80, { class: "Q", lat: () => 0.85, s: SLIGHT_LOSS, workB }), heldout: rows(16), exhausted: true }, LAT, STATE);
check(says(qWork(() => 3), "keep") && says(qWork(() => 2), "revert", /≤ -0.5/), "a visible-work drop doesn't tighten the quality floor to −0.5 (N6)");

// ---- Goal craft (N3)
const CRAFT = card({ goal: "craft", component: "render" });
check(says(run(rows(32, { s: () => 0, sCraft: (i) => [1, 1, 1, 0][i % 4] }), CRAFT), "keep"), "a craft winner with fidelity holding isn't kept");
check(says(run(rows(32, { s: (i) => [-1, -1, 0, 1][i % 4], sCraft: (i) => [1, 1, 1, 0][i % 4] }), CRAFT), "revert", /fidelity Z/), "a craft winner that loses fidelity is kept");
check(says(run(rows(32, { s: () => 1, sCraft: () => 0 }), CRAFT), "revert"), "a craft card is decided on fidelity instead of craft");

// ---- Debts: same-run chains through an anchor move, entering and clearing as §1.4 says
const f = (log, se = 0.02) => ({ log, se, df: 27 });
const link = (id, moved, ttfc, q = 0, ttd = 0) => ({ id, moved, ttfc: f(ttfc), ttd: f(ttd), q: f(q, 0.1) });
{
  const h = [link("c0", false, 0), link("c1", true, 0.2), link("c2", false, 0.05)];
  const c = chainSince(h, "c0", "ttfc");
  check(near(c.log, 0.05 + 0.2 - 0, 1e-12) && near(c.se, Math.sqrt(3) * 0.02, 1e-12), `chain through the anchor move is ${c.log} ± ${c.se}, want 0.25 ± ${Math.sqrt(3) * 0.02}`);
  const atMove = chainSince(h, "c1", "ttfc");
  check(near(atMove.log, 0.05, 1e-12) && near(atMove.se, 0.02, 1e-12), "a move at L itself doesn't cancel exactly");
  check(near(chainSince(h, undefined, "ttfc").log, 0.25, 1e-12), "the chain against A0 isn't this run's link plus the moves");
  check(near(chain([[1, f(0.1)], [-1, f(0.04)]]).se ** 2, 2 * 0.02 ** 2, 1e-12), "chained log variances don't add");
}
{
  // Latency debt enters at c1 (×1.105, lo90 > 1.05), holds through c2, clears at c3 (which becomes L).
  const h = [link("c0", false, 0)];
  let d = debtsAfter(undefined, h);
  check(!d.debts.latency.debt && d.debts.latency.L === "c0" && d.debts.quality.P === "c0", "checkpoint 0 doesn't start both debts at itself");
  h.push(link("c1", false, 0.1));
  d = debtsAfter(d.debts, h);
  check(d.debts.latency.debt && d.debts.latency.L === "c0" && d.vsLatencyCheckpoint.ttfc.lo90 > LOOP.latDebtLo90, `a ×1.105 champion doesn't enter latency debt: ${JSON.stringify(d.vsLatencyCheckpoint.ttfc)}`);
  h.push(link("c2", true, 0.12));
  d = debtsAfter(d.debts, h);
  check(d.debts.latency.debt && d.debts.latency.L === "c0", "latency debt clears while still ×1.13 slower");
  // c2 moved the anchor: c3's link (−0.11 against the new anchor) chains to +0.01 against c0.
  h.push(link("c3", false, -0.11));
  d = debtsAfter(d.debts, h);
  check(!d.debts.latency.debt && d.debts.latency.L === "c3" && near(Math.log(d.vsLatencyCheckpoint.ttfc.est), 0.01, 1e-9), `latency debt doesn't clear through the anchor move at c3: ${JSON.stringify(d.debts)} ${d.vsLatencyCheckpoint.ttfc.est}`);
  // The same through linksOf: a service drift that slows both arms of a run by 15% moves no link.
  const cp = (drift) => rows(64, { s: () => 0, lat: (i) => 1.02 * noise(i) }).map((r) => ({ ...r, ttfc: [r.ttfc[0] * drift, r.ttfc[1] * drift] }));
  const [l0, l1] = [linksOf("c0", cp(1), false), linksOf("c1", cp(1.15), false)];
  check(near(l0.ttfc.log, l1.ttfc.log, 1e-12) && !debtsAfter(debtsAfter(undefined, [l0]).debts, [l0, l1]).debts.latency.debt, "a drift that slows both arms of a later run moves the latency chain");
}
{
  // Quality debt: ΔQ's 90% upper bound below 0 enters it; a later checkpoint back at the level clears it.
  const h = [link("c0", false, 0, 0)];
  let d = debtsAfter(undefined, h);
  h.push(link("c1", false, 0, -0.6));
  d = debtsAfter(d.debts, h);
  check(d.debts.quality.debt && d.debts.quality.P === "c0" && d.vsQualityCheckpoint.hi90 < 0, `ΔQ −0.6 ± 0.14 doesn't enter quality debt: ${JSON.stringify(d.vsQualityCheckpoint)}`);
  h.push(link("c2", false, 0, -0.1));
  d = debtsAfter(d.debts, h);
  check(!d.debts.quality.debt && d.debts.quality.P === "c2", `quality debt doesn't clear at c2: ${JSON.stringify(d.debts.quality)}`);
  const share = linksOf("x", rows(40, { s: (i) => [1, 1, 0, -1][i % 4] }), false).q;
  check(near(share.log, logit(0.625), 1e-12) && share.df === 9, `the quality link isn't logit(share): ${share.log} df ${share.df}`);
  const { se } = cr1([1, 0], ["a", "b"]);
  check(Number.isFinite(se), "cr1 over two sessions has no SE");
}

finish();
