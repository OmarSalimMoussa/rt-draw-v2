// T9's acceptance check: the synthesizer's fixes S1–S8 on seeded steps (pen-ups,
// screen-space hand, arrowheads, loops, sketch templates, restart copies, the
// synth source tag), today's output kept for taps and lines at the start view,
// and scripts/tune.ts refusing synthetic ink for the ink readers' knobs.
// 0 model calls, no Chrome: the only child is tune.ts on a temp set.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t9-synth.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, check, cleanEnv, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const Y = await import("../core/synth.ts");
// Today's synthesizer, from the commit before these fixes, to hold taps and lines to it.
const before = join(home, "synth-7d7a373.ts");
writeFileSync(before, execFileSync("git", ["-C", ROOT, "show", "7d7a373:evals/core/synth.ts"]));
const Old = await import(pathToFileURL(before).href);

const START = { x: 0, y: -60, w: 1280, h: 800 };
const TR = { mess: 0.5, disfluency: 0.3 };
const TIDY = { mess: 0, disfluency: 0 };
const SEEDS = Array.from({ length: 40 }, (_, i) => 7 + i * 31);
const timelines = [];
const syn = (steps, traits, seed, o) => {
  const tl = Y.synthesize(steps, traits, seed, o);
  timelines.push(tl);
  return tl;
};
/** Geometry checks run without wobble, so a stroke's points sit exactly on its path. */
const still = (f) => {
  const w = Y.SYNTH.wobblePx;
  Y.SYNTH.wobblePx = 0;
  try {
    return f();
  } finally {
    Y.SYNTH.wobblePx = w;
  }
};
const bbox = (strokes) => {
  const pts = strokes.flatMap((s) => s.points);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), pts };
};

// ---- S1: a drawing after a pause starts after it; consecutive drawings get a 150–400 ms pen-up.
for (const seed of SEEDS) {
  const tl = syn([{ say: "make this" }, { pause: 3 }, { draw: "circle", around: [300, 420, 680, 230] }], TR, seed);
  check(tl.strokes[0].t0 >= tl.words.at(-1).t1 + 3000, `seed ${seed}: a circle after a 3 s pause starts at ${tl.strokes[0].t0} ms, before the pause ends (${tl.words.at(-1).t1 + 3000})`);
  const one = [{ say: "these" }, { draw: "box", box: [100, 200, 200, 150] }];
  const n = syn(one, TR, seed).strokes.length;
  const two = syn([...one, { draw: "box", box: [340, 200, 200, 150] }], TR, seed);
  const gap = two.strokes[n].t0 - two.strokes[n - 1].t1;
  check(gap >= 150 && gap <= 400, `seed ${seed}: two boxes in a row get a ${gap} ms pen-up`);
  const moved = syn([{ say: "here" }, { scroll: [200, 0] }, { draw: "tap", at: [500, 300] }], TR, seed);
  check(moved.strokes[0].t0 >= moved.moves[0].at + moved.moves[0].ms - 1, `seed ${seed}: a tap after a view move starts before the move ends`);
  const lead = syn([{ say: "move this one" }, { draw: "tap", at: [500, 300] }], TR, seed);
  check(lead.strokes[0].t0 === Math.round(lead.words.at(-1).t1 - Y.SYNTH.pointLeadMs), `seed ${seed}: a tap right after a say doesn't lead its last word`);
}

// ---- S2: taps and lines at the start view are today's output, word for word and point for point.
const kept = [
  [{ say: "move this" }, { draw: "tap", at: [400, 300] }],
  [{ say: "from here to there" }, { draw: "line", from: [120, 600], to: [900, 150] }],
  [{ say: "this one" }, { draw: "tap", at: [64, 700] }, { say: "and then a line going right across" }, { draw: "line", from: [100, 100], to: [1100, 120] }],
];
const strip = (tl) => JSON.stringify({ ...tl, strokes: tl.strokes.map(({ id, points, t0, t1 }) => ({ id, points, t0, t1 })) });
for (const steps of kept)
  for (const seed of SEEDS) {
    const was = strip(Old.synthesize(steps, TR, seed));
    check(strip(syn(steps, TR, seed, { view: START })) === was && strip(syn(steps, TR, seed)) === was, `seed ${seed}: ${steps.map((s) => Object.keys(s)[0]).join("+")} at the start view differs from today's output`);
  }

// ---- S2: the same arrow on screen at 1×, 2× and 4× zoom-out: the same screen geometry and timing.
for (const seed of SEEDS.slice(0, 10)) {
  const at = (z) => {
    const view = { x: 0, y: -60 * z, w: 1280 * z, h: 800 * z };
    const b = ([x, y]) => [view.x + x * z, view.y + y * z];
    const tl = syn([{ say: "this goes here" }, { draw: "arrow", from: b([400, 300]), to: b([520, 340]) }], TR, seed, { view });
    return { tl, screen: tl.strokes.map((s) => s.points.map(([x, y, t]) => [(x - view.x) / z, (y - view.y) / z, t])) };
  };
  const one = at(1);
  for (const z of [2, 4]) {
    const zz = at(z);
    const same = zz.screen.length === one.screen.length && zz.screen.every((s, i) => s.length === one.screen[i].length && s.every((p, j) => Math.abs(p[0] - one.screen[i][j][0]) <= 0.06 && Math.abs(p[1] - one.screen[i][j][1]) <= 0.06 && Math.abs(p[2] - one.screen[i][j][2]) <= 1));
    check(same && Math.abs(zz.tl.ms - one.tl.ms) <= 1, `seed ${seed}: the arrow at ${z}× zoom-out isn't the 1× arrow on screen`);
  }
}

// ---- S3: arrowheads 25–40% of the shaft, clamped to 8–34 px (screen px; here the start view).
still(() => {
  for (const len of [12, 30, 40, 60, 100, 250])
    for (const seed of SEEDS) {
      const tl = syn([{ say: "this" }, { draw: "arrow", from: [300, 300], to: [300 + len, 300] }], TIDY, seed);
      const head = tl.strokes[1].points[0];
      const size = Math.hypot(head[0] - (300 + len), head[1] - 300);
      const [lo, hi] = [Math.min(34, Math.max(8, len * 0.25)), Math.min(34, Math.max(8, len * 0.4))];
      check(tl.strokes.length === 2 && size >= lo - 0.15 && size <= hi + 0.15, `seed ${seed}: a ${len} px arrow's head is ${size.toFixed(1)} px (want ${lo}–${hi})`);
    }
});

// ---- S4: loops are rounded boxes 10–30 px outside their target on every side.
still(() => {
  for (const [x, y, w, h] of [[300, 200, 240, 120], [100, 400, 500, 80], [700, 100, 120, 200]])
    for (const seed of SEEDS) {
      const tl = syn([{ say: "this" }, { draw: "circle", around: [x, y, w, h] }], TIDY, seed);
      const b = bbox(tl.strokes);
      const margins = [x - b.x, y - b.y, b.x + b.w - (x + w), b.y + b.h - (y + h)];
      check(tl.strokes.length === 1 && margins.every((m) => m >= 9.8 && m <= 30.2), `seed ${seed}: a loop around [${x}, ${y}, ${w}, ${h}] sits ${margins.map((m) => m.toFixed(1))} px outside it`);
      // A rounded box keeps long straight runs along its bounding box; an ellipse touches it at four points.
      const onEdge = b.pts.filter(([px, py]) => Math.min(px - b.x, b.x + b.w - px, py - b.y, b.y + b.h - py) <= 1).length / b.pts.length;
      check(onEdge >= 0.4, `seed ${seed}: a loop around [${x}, ${y}, ${w}, ${h}] isn't a rounded box (${Math.round(onEdge * 100)}% of it on its edges)`);
    }
});

// ---- S7: wave, zigzag and blob templates fill their box.
still(() => {
  const box = [200, 300, 300, 120];
  for (const shape of ["wave", "zigzag", "blob"])
    for (const seed of SEEDS) {
      const b = bbox(syn([{ say: "a chart here" }, { draw: "sketch", shape, box }], TR, seed).strokes);
      const inside = b.x >= box[0] - 0.1 && b.y >= box[1] - 0.1 && b.x + b.w <= box[0] + box[2] + 0.1 && b.y + b.h <= box[1] + box[3] + 0.1;
      check(inside && b.w >= 0.85 * box[2] && b.h >= 0.85 * box[3], `seed ${seed}: a ${shape} fills ${Math.round((b.w / box[2]) * 100)}% × ${Math.round((b.h / box[3]) * 100)}% of its box${inside ? "" : " and spills out of it"}`);
    }
});

// ---- S5: underlines unchanged from today (same random draws, same points).
for (const seed of SEEDS.slice(0, 10)) {
  const steps = [{ say: "this word" }, { draw: "underline", box: [300, 200, 160, 30] }];
  check(strip(syn(steps, TR, seed)) === strip(Old.synthesize(steps, TR, seed)), `seed ${seed}: an underline differs from today's`);
}

// ---- S6: restart copies never double a comma.
const comma = "okay, so, the header, the logo, and, like, the photo, yes, there, this, here, that one, please";
let doubled = 0;
for (let seed = 0; seed < 1000; seed++) {
  const toks = Y.lines([{ say: comma }], { mess: 0, disfluency: 1 }, seed).get(0);
  if (Y.lineText(toks).includes(",,") || toks.some((t) => t.word.includes(",,"))) doubled++;
}
check(doubled === 0, `",," in ${doubled} of 1,000 seeded lines`);
const restarted = Y.lines([{ say: comma }], { mess: 0, disfluency: 1 }, 3).get(0).length > comma.split(" ").length;
check(restarted, "a fully disfluent line gets no restarts or fillers (the ',,' check would be empty)");

// ---- S8: every synthetic stroke says so.
const strokes = timelines.flatMap((t) => t.strokes);
check(strokes.length > 1000 && strokes.every((s) => s.source === "synth"), `${strokes.filter((s) => s.source !== "synth").length} of ${strokes.length} strokes lack source "synth"`);

// ---- S8: scripts/tune.ts refuses synthetic strokes for marks/arrow/hit/link unless --allow-synth.
const example = (s, i) => ({ decision: "marks.arrow", strokes: s, predicted: "arrow", label: i % 3 ? "arrow" : "not", corrected: false });
const synthSet = { v: 1, source: "eval", createdAt: "2026-10-16T00:00:00Z", tuningId: "t", tuning: {}, examples: SEEDS.slice(0, 12).map((seed, i) => example(Y.synthesize([{ say: "this" }, { draw: "arrow", from: [300, 300], to: [420 + i * 10, 330] }], TR, seed).strokes, i)) };
const realSet = { ...synthSet, source: "playground", examples: synthSet.examples.map((ex) => ({ ...ex, strokes: ex.strokes.map(({ source, ...s }) => s) })) };
writeFileSync(join(home, "synth-set.json"), JSON.stringify(synthSet));
writeFileSync(join(home, "real-set.json"), JSON.stringify(realSet));
const tune = (...args) => spawnSync(process.execPath, ["--import", "./evals/loop/node-hooks.mjs", "scripts/tune.ts", ...args], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 60_000 });
for (const parts of [[], ["--parts", "marks"], ["--parts", "arrow"], ["--parts", "hit"], ["--parts", "link"], ["--parts", "router,link"]]) {
  const r = tune(join(home, "synth-set.json"), ...parts);
  check(r.status === 2 && /refused: 12 of 12 examples hold synthetic strokes/.test(r.stderr), `tune.ts ${parts.join(" ") || "(default parts)"} on synthetic ink exits ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`);
}
const allowed = tune(join(home, "synth-set.json"), "--allow-synth", "--parts", "arrow");
check(allowed.status === 0 && /12 examples from 1 set/.test(allowed.stdout), `tune.ts --allow-synth doesn't run: ${allowed.status} ${allowed.stderr.slice(0, 200)}`);
const router = tune(join(home, "synth-set.json"), "--parts", "router");
check(router.status === 0, `tune.ts --parts router is refused synthetic ink it doesn't read: ${router.stderr.slice(0, 200)}`);
const real = tune(join(home, "real-set.json"), "--parts", "arrow");
check(real.status === 0 && /12 examples/.test(real.stdout), `tune.ts refuses a set with no synthetic strokes: ${real.stderr.slice(0, 200)}`);

finish();
