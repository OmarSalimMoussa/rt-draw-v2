// T13's acceptance check: Rule F, the latency and craft goals, every veto and the checkpoint-0
// A/A rule, on synthetic rows only (0 model calls, no files, no network).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t13-verdict.mjs   (the simulations' numbers go to stderr)
import { check, finish } from "./lib.mjs";

const { LOOP } = await import("../loop/config.ts");
const { rng, cr1, tQuantile } = await import("../loop/stats.ts");
const { aaPass, decide, latencyVeto, ruleF } = await import("../loop/verdict.ts");

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

// ---- The latency veto at 48 cases (any surely-slower median or tail of either deciding latency, no allowance, as one
// session-swap test over them all: LOOP-V2.md A3, 2026-10-26): verify-design's fork model for time to first drawing
// (thinking correlated within a fork, the resolver shared), and each send's p90 frame for render (the case's scene sets
// it; each arm's own noise ±10%), B slower on first drawing by 0 / 5 / 10%; tails only once they hold 3 sends (p90, not
// p95, at 48). Cases come in whole sessions of 5, as decisions enter them (stats.ts entryOrder): ~10 sessions at 48.
// A test per stat (up to 12, on G2 and again on G3) reverted 10.7% of changes that cost no latency here, and caught 28.8 /
// 60.7% of 5 / 10% slowdowns; one test over the family keeps the first at its nominal 5%, for less power at 48. A quality
// keep's veto reads G2 and G3 together, more cases than this.
const t1 = Date.now();
const VETO = [[0, 4.7], [0.05, 12.6], [0.1, 33.1]];
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
      const frame = 8 * Math.exp(gauss(r) * 0.5);
      return { case: `c${c}`, cluster: `s${Math.floor(c / 5)}`, ttfd: [arm(false), arm(true)], render: [frame * Math.exp(gauss(r) * 0.1), frame * Math.exp(gauss(r) * 0.1)] };
    });
    if (latencyVeto(rows)) n++;
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
  const half = { ttfd: [], render: [], order: [], share: [] };
  for (let n = 0; n < RUNS; n++) {
    const rows = [];
    for (let k = 0; k < 8; k++) for (let j = 0; j < 4; j++) rows.push({ cluster: `h${k}` });
    for (let j = 0; j < 32; j++) rows.push({ cluster: `t${j % 20}` });
    rows.forEach((x, i) => {
      const ea = gauss(r), eb = gauss(r);
      const fa = 0.7 * ea + Math.sqrt(0.51) * gauss(r), fb = 0.7 * eb + Math.sqrt(0.51) * gauss(r);
      x.ttfd = [2000, 2000 * Math.exp(0.45 * (ea - eb))];
      x.render = [8, 8 * Math.exp(0.5 * (fa - fb))];
      x.firstArm = i % 2 ? "B" : "A";
      const u = r();
      x.s = u < 0.3 ? 0 : u < 0.65 ? 1 : -1;
    });
    const aa = aaPass(rows);
    if (!aa.pass) fails++;
    for (const k in half) half[k].push(aa.tests[k].halfWidth);
    if (n === 0) check(aa.ci === LOOP.aa.ci && ["ttfd", "render", "order", "share"].every((k) => aa.tests[k].lo < aa.tests[k].hi), "aaPass doesn't report four intervals at LOOP.aa.ci");
  }
  const med = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
  const failPct = (100 * fails) / RUNS;
  check(failPct <= 5 && failPct >= 3, `a flawless A/A fails checkpoint 0 in ${failPct.toFixed(1)}% of runs, want ~4% (≤ 5)`);
  check(near(med(half.ttfd), 0.22, 0.03), `median TTFD half-width ±${(100 * med(half.ttfd)).toFixed(0)}%, the simulation says ±22%`);
  console.error(`A/A at 99%: fails ${failPct.toFixed(1)}% of ${RUNS} flawless runs; median half-widths ttfd ±${(100 * med(half.ttfd)).toFixed(0)}% render ±${(100 * med(half.render)).toFixed(0)}% order ±${(100 * med(half.order)).toFixed(0)}% share ±${med(half.share).toFixed(3)}`);
  // A dispatch-order bias steps the knee down; a latency drift alone never does.
  const biased = (f) => {
    const rows = [];
    for (let j = 0; j < 64; j++) rows.push({ cluster: `s${j % 28}`, firstArm: j % 2 ? "B" : "A", s: [1, 0, -1, 0][j % 4], render: [8, 8 * (1 + 0.01 * Math.cos(j))], ttfd: [2000, 2000 * f(j)] });
    return aaPass(rows);
  };
  const order = biased((j) => (j % 2 ? 1.3 : 1 / 1.3) * (1 + 0.02 * Math.sin(j)));
  check(order.failed.includes("order") && order.kneeDown, `a first-arm advantage doesn't fail the order interval: ${order.failed}`);
  const drift = biased((j) => 1.3 * (1 + 0.02 * Math.sin(j)));
  check(drift.failed.includes("ttfd") && !drift.kneeDown, `a latency-ratio failure steps the knee down or isn't seen: ${drift.failed} ${drift.kneeDown}`);
}

// ---- decide(): a clean row set keeps; every veto of §1.4 fires on its crafted set
/** Fidelity a little worse: 3 wins, 4 losses in 16, Z ≈ −0.6 on 32 cases (inside −1, outside −0.5 and 0). */
const SLIGHT_LOSS = (i) => [1, -1, 0, -1, 1, -1, 0, 0, 1, -1, 0, 0, 0, 0, 0, 0][i % 16];
const card = (o = {}) => ({ id: "h1", component: "draw", kind: "knob", change: "x", goal: "fidelity", classGuess: "Q", dialogue: false, isPatch: false, touchesFrozen: false, risk: "", files: [], ...o });
const noise = (i) => 1 + 0.01 * Math.sin(i * 1.7);
/**
 * n rows over sessions of 4; `s(i)` scores case i; A's first drawing is `latA` × 2 s, B's is `lat` × A's (TTFC the same,
 * as before LOOP-V2); render is 8 ms × `render` in B; TTD 6 s × `ttd` in B.
 */
const rows = (n, o = {}) =>
  Array.from({ length: n }, (_, i) => ({
    case: `${o.at ?? ""}c${i}`, cluster: `${o.at ?? ""}s${Math.floor(i / 4)}`, affected: true, class: o.class ?? "Q",
    s: (o.s ?? ((i) => [1, 1, 1, 0][i % 4]))(i), sCraft: o.sCraft?.(i),
    ttfc: [2000 * noise(i) * (o.latA?.(i) ?? 1), 2000 * noise(i) * (o.latA?.(i) ?? 1) * (o.lat?.(i) ?? 1)], ttd: [6000, 6000 * (o.ttd?.(i) ?? 1)],
    ttfd: [2000 * noise(i) * (o.latA?.(i) ?? 1), 2000 * noise(i) * (o.latA?.(i) ?? 1) * (o.lat?.(i) ?? 1)], render: [8 * noise(i + 3), 8 * noise(i + 3) * (o.render?.(i) ?? 1)],
    work: [o.workA?.(i) ?? 3, o.workB?.(i) ?? 3], usd: [0.02, 0.02 * (o.usd ?? 1)], thought: [false, false], overuse: [o.overA?.(i) ?? false, o.overB?.(i) ?? false],
    pics: [[1, 0], [1, o.failB?.(i) ?? 0]], ask: o.ask?.(i) ?? "add", firstArm: o.first?.(i) ?? (i % 2 ? "B" : "A"),
    ...(o.void?.(i) ? { void: "invariant" } : {}),
  }));
// G3's held-out rows lean like the tuning rows unless a case says otherwise; they come from sessions of their own ("h"),
// as the H-gate's do.
const held = (n, o = {}) => rows(n, { ...o, at: "h" });
const run = (tuning, c = card(), extra = {}) => decide({ tuning, heldout: tuning.slice(0, 16).map((r) => ({ ...r, case: `h${r.case}`, cluster: `h${r.cluster}` })), exhausted: true, ...extra }, c);
const says = (d, verdict, re) => d.verdict === verdict && (!re || [...d.reasons, ...d.vetoes].some((x) => re.test(x)));

const clean = run(rows(32));
check(says(clean, "keep") && !clean.vetoes.length && !clean.pending, `the clean set doesn't keep cleanly: ${clean.verdict} ${clean.reasons} ${clean.vetoes}`);
check(clean.configId && clean.looks.length === 2 && clean.counts.look === 32, `the clean keep lacks configId or its looks: ${JSON.stringify(clean.looks)}`);
check(/biased/.test(clean.caveat ?? ""), "an early-stopped share carries no caveat");
check(says(decide({ tuning: rows(32), exhausted: true }, card()), "keep") && decide({ tuning: rows(32), exhausted: true }, card()).pending?.[0] === "heldout", "a Q keep without G3 isn't pending on the held-out cases");
// G3 confirms every keep, whatever its class (LOOP-V2.md D2).
for (const cls of ["R", "S"]) {
  const d = decide({ tuning: rows(80, { class: cls, lat: () => (cls === "S" ? 0.85 : 1) }), exhausted: true }, cls === "S" ? card({ goal: "latency", metric: "ttfd" }) : card());
  check(says(d, "keep") && d.pending?.join() === "heldout", `a class ${cls} keep without G3 isn't pending on the held-out cases: ${d.verdict} ${d.pending}`);
}
const vetoCases = {
  "held-out": [() => run(rows(32), card(), { heldout: held(16, { s: (i) => [-1, -1, 0, 1][i % 4] }) }), "revert", /held-out/],
  // The latency veto reads G2's and G3's cases together: slower held-out cases from 8 sessions of their own are read as
  // surely slower; from 4 they aren't (1/16 at best, LOOP-V2.md A3).
  "held-out slower (first drawing)": [() => run(rows(32), card(), { heldout: held(32, { lat: () => 1.15 }) }), "revert", /latency veto: surely slower.*most on ttfd.*\(G2 and held-out\)/],
  "held-out slower (render)": [() => run(rows(32), card(), { heldout: held(32, { render: (i) => 1.15 * noise(i) }) }), "revert", /latency veto: surely slower.*most on render/],
  "held-out slower, 4 sessions: no veto": [() => run(rows(32), card(), { heldout: held(16, { lat: () => 1.15 }) }), "keep"],
  "held-out neutral (no direction)": [() => run(rows(32), card(), { heldout: held(16, { s: () => 0 }) }), "revert", /held-out: fidelity Z 0\.00 doesn't lean/],
  "held-out not faster (latency card)": [() => decide({ tuning: rows(80, { class: "S", lat: () => 0.85, s: () => 0 }), heldout: held(32, { class: "S", s: () => 0 }), exhausted: true }, card({ goal: "latency", metric: "ttfd" })), "revert", /held-out: ttfd ×1\.000 isn't faster/],
  // Faster on G2 and slower on G3 pools to no clear slowdown: G3's direction rule reverts it.
  "a faster S card, slower on held-out": [() => decide({ tuning: rows(80, { class: "S", lat: () => 0.85, s: () => 0 }), heldout: held(32, { class: "S", lat: () => 1.15, s: () => 0 }), exhausted: true }, card({ goal: "latency", metric: "ttfd" })), "revert", /held-out: ttfd ×1\.150 isn't faster|latency veto/],
  latency: [() => run(rows(32, { lat: () => 1.15 })), "revert", /latency veto: surely slower.*most on ttfd/],
  "latency +5% (no allowance)": [() => run(rows(32, { lat: () => 1.05 })), "revert", /latency veto: surely slower.*most on ttfd/],
  "latency (render)": [() => run(rows(32, { render: (i) => 1.12 * noise(i) })), "revert", /latency veto: surely slower.*most on render/],
  "empty sends": [() => run(rows(32, { workB: (i) => (i % 10 === 3 ? 0 : 3) })), "revert", /empty sends/],
  "failed pictures": [() => run(rows(32, { failB: (i) => +(i % 10 === 3) })), "revert", /failed pictures/],
  "render deferred": [() => run(rows(32).map((r, i) => (i === 7 ? { ...r, deferred: [false, true] } : r))), "revert", /render\(\) leaves its work/],
  continuation: [() => run(rows(32, { class: "D" }), card({ dialogue: true }), { continuation: rows(20, { class: "D", s: (i) => [-1, -1, 0, 1][i % 4] }) }), "revert", /continuation/],
  "void rate": [() => run(rows(32, { void: (i) => i % 5 === 0 })), "void", /voided/],
  "position flips": [() => run(rows(32), card(), { flips: { audited: 16, flipped: 6 } }), "void", /flips/],
  "dispatch order": [() => run(rows(32, { first: (i) => (i % 4 ? "A" : "B") })), "void", /dispatched first/],
  "cold-start asymmetry": [() => run(rows(32), card(), { cold: [{ n: 6, of: 20 }, { n: 2, of: 20 }] }), "void", /cold starts/],
  invariants: [() => run(rows(32), card(), { invariants: 1 }), "void", /invariants/],
};
for (const [name, [make, verdict, re]] of Object.entries(vetoCases)) {
  const d = make();
  check(says(d, verdict, re), `${name} veto: got ${d.verdict} (${[...d.reasons, ...d.vetoes].join("; ")}), want ${verdict} ${re}`);
}
// One cold call more is no asymmetry, though it's 20% of a dialogue card's 5 live sends (e76-h6).
const oneCold = run(rows(32), card(), { cold: [{ n: 1, of: 5 }, { n: 0, of: 5 }] });
check(oneCold.verdict !== "void" && !oneCold.reasons.some((x) => /cold starts/.test(x)), `one cold call of 5: ${oneCold.verdict} (${oneCold.reasons.join("; ")})`);
// …and none of them on the clean set's near misses.
const nearMisses = {
  "latency unchanged": run(rows(32, { lat: () => 1 })),
  "TTD ×1.3 (reported, never decides)": run(rows(32, { ttd: (i) => 1.3 * noise(i) })),
  "TTFC ×1.3 with first drawing unchanged (reported)": run(rows(32).map((r) => ({ ...r, ttfc: [r.ttfc[0], r.ttfc[1] * 1.3] }))),
  "cost ×1.3 (reported, never decides)": run(rows(32, { usd: 1.3 })),
  // Over-use is reported, never decides: its only hold in history (e65-h2) was false.
  "over-use on 30% of the other cases (reported)": run(rows(32, { overB: (i) => i % 10 < 3 }), card({ overuseDetector: "new-style", targets: { asks: ["restyle"] } })),
  "8 audited, 4 flipped (too few to judge)": run(rows(32), card(), { flips: { audited: 8, flipped: 4 } }),
  "an empty send in both arms": run(rows(32, { workA: (i) => (i === 5 ? 0 : 3), workB: (i) => (i === 5 ? 0 : 3) })),
  // One arm's hiccup is its loss in Rule F, never an empty send (1 of 32 would be 3.1 points, over the 2-point veto).
  "a lost case": run(rows(32).map((r, i) => (i === 20 ? { ...r, s: -1, work: [1, 0], ttfc: [null, null], ttd: [0, 0], ttfd: [null, null], render: [null, null], lost: { arm: "B", why: "B's page failed" } } : r))),
  "render deferred in both arms": run(rows(32).map((r, i) => (i === 7 ? { ...r, deferred: [true, true] } : r))),
};
for (const [name, d] of Object.entries(nearMisses)) check(says(d, d.verdict === "keep" && !d.vetoes.length ? "keep" : "x"), `${name} shouldn't veto: ${d.verdict} ${d.vetoes}`);
// A combo shares one keep line with the near-wins it puts together (LOOP-V2.md D3): it keeps a pattern a lone card keeps
// only when that pattern clears the higher line, and never keeps what a lone card doesn't.
{
  const combo = card({ kind: "combo", combines: ["e1-h1", "e2-h1", "e3-h1"] });
  const pats = Array.from({ length: 12 }, (_, k) => rows(48, { s: (i) => ((i * 7) % 12 < k ? 1 : (i * 5) % 12 < 2 ? 0 : -1) }));
  const kept = pats.map((p) => [run(p).verdict === "keep", run(p, combo).verdict === "keep"]);
  check(kept.some(([one, c]) => one && !c) && !kept.some(([one, c]) => c && !one), `a combo's keep line isn't above a lone card's: ${JSON.stringify(kept)}`);
}
// Render compares, board by board, what both engines' timings share: paint and apply, paint alone where one engine
// applied fewer of a board's lines (a new op), nothing where one loaded it differently (a new shape kind) or failed on it.
{
  const { sameContent } = await import("../loop/ab.ts");
  const run1 = (applied, board) => ({ applyMs: 1, paintMs: 2, ops: 3, applied, board });
  const A = { ...run1(3, "a"), other: run1(3, "b") }, B = { ...run1(3, "b"), other: run1(3, "a") };
  const flags = (x) => JSON.stringify([x.A, x.B]);
  check(flags(sameContent(A, B)) === JSON.stringify([{ own: "all", other: "all" }, { own: "all", other: "all" }]) && !sameContent(A, B).why.length, `two engines on the same content: ${flags(sameContent(A, B))}`);
  const newOp = sameContent({ ...A, other: run1(2, "b") }, B);
  check(flags(newOp) === JSON.stringify([{ own: "all", other: "paint" }, { own: "paint", other: "all" }]) && /A's engine applied 2 of B's 3 lines/.test(newOp.why[0]), `an engine that applied fewer of a board's lines didn't keep that board's paint alone: ${flags(newOp)} ${newOp.why}`);
  const newKind = sameContent(A, { ...B, other: run1(3, "c") });
  check(newKind.A.own === "none" && newKind.B.other === "none" && newKind.A.other === "all" && /B's engine loaded A's board differently/.test(newKind.why[0]), `a board loaded differently wasn't left out: ${flags(newKind)}`);
  check(sameContent(A, run1(3, "b")).A.own === "none", "an engine with no timing on the other board wasn't caught");
  // Too many cases without render go to the owner.
  const half = rows(32).map((r, i) => (i % 2 ? { ...r, render: [r.render[0], null] } : r));
  check(says(run(half), "owner", /render not measured whole on 16 of 32/), `half the cases without render didn't go to the owner: ${run(half).verdict} ${run(half).vetoes}`);
  // A new shape kind on B's board: render still reads on A's board alone, but B's new paint was never timed.
  const kind = rows(32).map((r, i) => (i % 3 ? r : { ...r, renderSame: ["all", "none"] }));
  check(says(run(kind), "owner", /render not measured whole on 11 of 32/), `cases timed only on A's board didn't count as unmeasured: ${run(kind).verdict} ${run(kind).vetoes}`);
  check(run(rows(32).map((r, i) => (i % 8 ? r : { ...r, renderSame: ["all", "paint"] }))).verdict === "keep", "a few cases with a new op went to the owner");
}
check(says(run(rows(32, { class: "N" })), "revert", /no effect/), "class N isn't reverted as no effect");
const rare = decide({ tuning: rows(20), exhausted: true }, card());
check(says(rare, "revert", /too rare/) && rare.ownerList, `20 affected cases after the top-ups isn't 'too rare': ${rare.verdict} ${rare.reasons}`);
const more = decide({ tuning: rows(20) }, card());
check(more.verdict === "more" && more.next === 32, `20 cases with more to come doesn't ask for look 32: ${more.verdict} ${more.next}`);
const d1 = run(rows(32, { class: "D" }), card({ dialogue: true }), { heldout: rows(16) });
check(says(d1, "keep") && d1.pending?.join() === "continuation", `a D keep without G4 isn't pending on continuation: ${d1.pending}`);
const fewDecisive = decide({ tuning: rows(16, { s: (i) => (i < 6 ? -1 : 0) }) }, card());
check(fewDecisive.verdict === "more" && fewDecisive.next === 32, `a look with fewer than ${LOOP.minDecisive[0]} decisive cases isn't skipped: ${fewDecisive.verdict}`);
const loses = run(rows(16, { s: (i) => [-1, -1, 1, 0][i % 4] }));
check(says(loses, "revert") && loses.counts.look === 16, `a losing card isn't reverted at look 16: ${loses.verdict} ${loses.counts.look}`);

// ---- Goal latency (§1.3)
const LAT = card({ goal: "latency", metric: "ttfd" });
const futile = decide({ tuning: rows(16, { class: "S", lat: () => 1.04 }) }, LAT);
check(says(futile, "revert") && futile.counts.look === 16, `a slower latency card isn't reverted at look 16: ${futile.verdict} ${futile.counts.look}`);
const fast = decide({ tuning: rows(80, { class: "S", lat: () => 0.85, s: () => 0 }), exhausted: true }, LAT);
check(says(fast, "keep") && fast.counts.look === 32 && fast.pending?.join() === "heldout", `a faster S card doesn't keep at look 32, pending G3: ${fast.verdict} ${fast.counts.look} ${fast.pending}`);
const fastHeld = decide({ tuning: rows(80, { class: "S", lat: () => 0.85, s: () => 0 }), heldout: rows(32, { class: "S", lat: () => 0.85, s: () => 0 }), exhausted: true }, LAT);
// Under LOOP.heldoutConfirmMin affected held-out cases G3 can only veto: too few to say which way they lean.
check(says(run(rows(32), card(), { heldout: rows(LOOP.heldoutConfirmMin - 1, { s: () => 0 }) }), "keep"), "G3 asks a direction of fewer held-out cases than LOOP.heldoutConfirmMin");
check(says(fastHeld, "keep") && !fastHeld.pending && !fastHeld.vetoes.length, `a faster S card that holds on held-out isn't kept: ${fastHeld.verdict} ${fastHeld.vetoes}`);
// Seeded noisy B/A around `mid`: cases differ, each arm has its own noise and session shift, so both arms spread alike
// as in a run (the tails compare the arms' spreads) and log B/A has the old 0.3 per case, 0.15 per session. Sets picked
// to reach each later look.
const noisy = (mid, seed) => {
  const r = rng(seed);
  const sess = Array.from({ length: 20 }, () => [gauss(r), gauss(r)]);
  const arm = (k) => (i) => 0.21 * gauss(r) + 0.106 * sess[i >> 2][k];
  const base = Array.from({ length: 80 }, () => Math.exp(0.4 * gauss(r)));
  const [a, b] = [Array.from({ length: 80 }, (_, i) => arm(0)(i)), Array.from({ length: 80 }, (_, i) => arm(1)(i))];
  return rows(80, { class: "S", s: () => 0, latA: (i) => base[i] * Math.exp(a[i]), lat: (i) => mid * Math.exp(b[i] - a[i]) });
};
const flat = decide({ tuning: noisy(0.99, 5), exhausted: true }, LAT);
check(says(flat, "revert") && flat.counts.look === 48, `a no-gain latency card (est ≥ 0.98 at 48) isn't reverted at look 48: ${flat.verdict} ${flat.counts.look} ${flat.reasons}`);
const late = [decide({ tuning: noisy(0.96, 6), exhausted: true }, LAT), decide({ tuning: noisy(0.96, 8), exhausted: true }, LAT)];
check(says(late[0], "keep") && late[0].counts.look === 80 && late[0].latency.ttfd.p.faster < LOOP.latKeepP, `a small sure gain isn't kept at look 80: ${late[0].verdict} ${late[0].counts.look}`);
check(says(late[1], "revert") && late[1].counts.look === 80 && late[1].latency.ttfd.p.faster >= LOOP.latKeepP, `an unsure small gain isn't reverted at look 80: ${late[1].verdict} ${late[1].counts.look}`);
// The slow sends (LOOP.latTails): a quarter of the sends think (A ×3) and B stops that; the median send doesn't move,
// so the median alone calls it no gain, and the p90 keeps it at look 32. A fidelity winner that makes those sends ×1.6
// slower instead is reverted by the tail's latency veto.
const slowA = (i) => (i % 4 === 3 ? 3 : 1) * Math.exp(0.1 * Math.sin(i * 2.3));
const thinkless = decide({ tuning: rows(80, { class: "S", s: () => 0, latA: slowA, lat: (i) => (i % 4 === 3 ? 0.4 : 1) }), exhausted: true }, LAT);
check(says(thinkless, "keep", /^ttfd p9[05] ×0\.[3-5]/) && thinkless.counts.look === 32 && Math.abs(thinkless.latency.ttfd.est - 1) < 0.01 && thinkless.latency.tails["ttfd p90"].p.faster < LOOP.latTailKeepP,
  `a change that speeds only the slow quarter isn't kept on its tail at look 32: ${thinkless.verdict} ${thinkless.counts.look} ${thinkless.reasons}`);
const slowTail = run(rows(32, { latA: slowA, lat: (i) => (i % 4 === 3 ? 1.6 : 1) }));
check(says(slowTail, "revert", /latency veto: surely slower.*most on ttfd p9[05]/) && Math.abs(slowTail.latency.ttfd.est - 1) < 0.01, `a fidelity winner ×1.6 slower on the slow quarter isn't vetoed on its tail: ${slowTail.verdict} ${slowTail.vetoes}`);
// A faster first drawing that paints slower is no keep; a render card keeps on render, and is held to first drawing.
const paintsSlower = decide({ tuning: rows(80, { class: "S", s: () => 0, lat: () => 0.85, render: () => 1.2 }), exhausted: true }, LAT);
check(says(paintsSlower, "revert", /latency veto: surely slower.*most on render/), `a faster first drawing that renders ×1.2 slower isn't reverted: ${paintsSlower.verdict} ${paintsSlower.reasons}`);
const RENDER = card({ goal: "latency", metric: "render", component: "render" });
const paints = decide({ tuning: rows(80, { class: "S", s: () => 0, render: () => 0.8 }), exhausted: true }, RENDER);
check(says(paints, "keep", /^render/) && paints.counts.look === 32, `a ×0.8 render card isn't kept at look 32: ${paints.verdict} ${paints.counts.look} ${paints.reasons}`);
const paintsLate = decide({ tuning: rows(80, { class: "S", s: () => 0, render: () => 0.8, lat: () => 1.1 }), exhausted: true }, RENDER);
check(says(paintsLate, "revert", /latency veto: surely slower.*most on ttfd/), `a faster render that draws first ×1.1 later isn't reverted: ${paintsLate.verdict} ${paintsLate.reasons}`);
const legacy = decide({ tuning: rows(80, { class: "S", s: () => 0, lat: () => 0.85 }), exhausted: true }, card({ goal: "latency", metric: "ttfc" }));
check(says(legacy, "keep", /^ttfd/), `a card from before LOOP-V2 (metric ttfc) isn't decided on first drawing: ${legacy.verdict} ${legacy.reasons}`);
const qFast = (s) => decide({ tuning: rows(80, { class: "Q", lat: () => 0.85, s }), heldout: rows(16, { class: "Q", lat: () => 0.85 }), exhausted: true }, LAT);
check(says(qFast((i) => [1, -1, 0, 0][i % 4]), "keep"), "a faster Q card with fidelity holding isn't kept");
check(says(qFast((i) => [-1, -1, 0, 1][i % 4]), "revert", /costs fidelity/) && qFast((i) => [-1, -1, 0, 1][i % 4]).counts.look === 32, "a faster Q card that clearly loses fidelity isn't reverted at look 32");
// Even fidelity holds at look 32; one extra loss (Z −0.24 there) waits for look 48's −0.5.
const oneLoss = (i) => (i === 2 ? -1 : [1, -1, 0, 0][i % 4]);
check(qFast((i) => [1, -1, 0, 0][i % 4]).counts.look === 32 && says(qFast(oneLoss), "keep") && qFast(oneLoss).counts.look === 48, "a faster Q card's fidelity floor isn't Z ≥ 0 at look 32, ≥ −0.5 at 48");
const qWork = (workB) => decide({ tuning: rows(80, { class: "Q", lat: () => 0.85, s: SLIGHT_LOSS, workB }), heldout: rows(16, { class: "Q", lat: () => 0.85 }), exhausted: true }, LAT);
check(says(qWork(() => 3), "keep") && says(qWork(() => 2), "revert", /< -0.5/), "a visible-work drop doesn't tighten the quality floor to −0.5 (N6)");

// ---- Goal craft (N3)
const CRAFT = card({ goal: "craft", component: "render" });
check(says(run(rows(32, { s: () => 0, sCraft: (i) => [1, 1, 1, 0][i % 4] }), CRAFT), "keep"), "a craft winner with fidelity holding isn't kept");
check(says(run(rows(32, { s: (i) => [-1, -1, 0, 1][i % 4], sCraft: (i) => [1, 1, 1, 0][i % 4] }), CRAFT), "revert", /fidelity Z/), "a craft winner that loses fidelity is kept");
check(says(run(rows(32, { s: () => 1, sCraft: () => 0 }), CRAFT), "revert"), "a craft card is decided on fidelity instead of craft");

// ---- Codes: search.ts reads why a decision went its way from these, never from the words.
check(JSON.stringify(run(rows(32, { lat: () => 1.15 })).codes) === '["latency"]' && JSON.stringify(run(rows(32, { workB: (i) => (i % 10 === 3 ? 0 : 3) })).codes) === '["empty"]', "a veto's code isn't recorded");
check(JSON.stringify(run(rows(32, { s: (i) => [-1, -1, 0, 1][i % 4], sCraft: (i) => [1, 1, 1, 0][i % 4] }), CRAFT).codes) === '["floor"]' && !run(rows(32)).codes.length, "a fidelity floor's revert, or a clean keep, has the wrong codes");
const { se } = cr1([1, 0], ["a", "b"]);
check(Number.isFinite(se), "cr1 over two sessions has no SE");

finish();
