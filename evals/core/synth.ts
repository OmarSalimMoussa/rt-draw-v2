// Turns a driver's steps ("say this", "circle that box", "arrow from here to
// there") into what a person would have produced: timed words and messy ink on
// one clock, so the product gets exactly what it gets from a real user. Seeded:
// the same steps and seed give the same words and strokes.
import type { Pt, Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";

/** How messy and how fluent the simulated person is, each 0 (tidy, fluent) to 1. */
export type Traits = { mess: number; disfluency: number };

/** The harness's numbers, by name. Frozen for the optimizer (eval/ is read-only to it). */
export const SYNTH = {
  /** Words a second when speaking fluently. */
  wordsPerSec: 2.8,
  /** A word gets this much longer per character past four. */
  msPerExtraChar: 35,
  /** Silence between words. */
  gapMs: 70,
  /** A "..." or "—" in the text: this long a pause, give or take half. */
  pauseMs: 700,
  /** At full disfluency, this share of word gaps get an "um" or "uh". */
  fillerRate: 0.18,
  /** And this share of words are restarted ("the, the"). */
  restartRate: 0.08,
  /** Pen speed, canvas px per ms, give or take a fifth. */
  penPxPerMs: 1.1,
  /** A point every this many ms of pen movement. */
  sampleMs: 12,
  /** At full mess, the pen wanders this far off its path. */
  wobblePx: 7,
  /** A drawing starts this long before the end of the word just said (people point while saying "this"). */
  pointLeadMs: 250,
  /** Speech carries on once this share of a drawing is done. */
  talkOverDraw: 0.6,
  /** Between the shaft and the head of an arrow. */
  liftMs: 180,
  /** At full mess, a loop stops up to this share of a turn short of closing, or runs on this far past it (people overshoot more). */
  loopShort: 0.1,
  loopOver: 0.22,
  /** At full mess, a loop can come up this share short of enclosing its box's corners. */
  loopClip: 0.15,
  /** A scribble-out runs this share of the box past its edges. */
  crossOverrun: 0.08,
  /** An arrowhead's barbs are this long, smallest to largest. */
  headMinPx: 20,
  headMaxPx: 34,
};

export type DrawStep =
  | { draw: "circle"; around: number[] }
  | { draw: "box"; box: number[] }
  | { draw: "cross"; box: number[] }
  | { draw: "underline"; box: number[] }
  | { draw: "arrow"; from: number[]; to: number[] }
  | { draw: "line"; from: number[]; to: number[] }
  | { draw: "tap"; at: number[] };
export type Step = { say: string } | DrawStep | { pause: number };

/** mulberry32: a small seeded random source. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const between = (r: Rand, a: number, b: number) => a + (b - a) * r();

/** Smooth wandering off a path: two slow waves with random phases. */
function wobble(r: Rand, amp: number) {
  const [p1, p2, f1, f2] = [r() * 6.28, r() * 6.28, between(r, 1.5, 3), between(r, 4, 7)];
  return (u: number): [number, number] => [amp * (0.7 * Math.sin(f1 * u * 6.28 + p1) + 0.3 * Math.sin(f2 * u * 6.28 + p2)), amp * (0.7 * Math.cos(f1 * u * 6.28 + p2) + 0.3 * Math.sin(f2 * u * 6.28 + p1))];
}

/** Samples a path (u from 0 to 1) at pen speed from time t0, with wobble. */
function trace(path: (u: number) => [number, number], length: number, t0: number, r: Rand, mess: number): Pt[] {
  const speed = SYNTH.penPxPerMs * between(r, 0.8, 1.2);
  const ms = Math.max(SYNTH.sampleMs * 2, length / speed);
  const n = Math.max(2, Math.round(ms / SYNTH.sampleMs));
  const off = wobble(r, SYNTH.wobblePx * mess);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    // Slow at the ends, fast in the middle, like a hand.
    const lin = i / n;
    const u = 0.5 - 0.5 * Math.cos(Math.PI * lin);
    const [x, y] = path(u);
    const [dx, dy] = off(u);
    pts.push([Math.round((x + dx) * 10) / 10, Math.round((y + dy) * 10) / 10, Math.round(t0 + lin * ms)]);
  }
  return pts;
}

const box4 = (b: number[]) => ({ x: b[0] ?? 0, y: b[1] ?? 0, w: Math.max(4, b[2] ?? 40), h: Math.max(4, b[3] ?? 40) });

/** The strokes for one drawing step, starting at t0. */
function strokesFor(step: DrawStep, t0: number, r: Rand, mess: number): Pt[][] {
  const out: Pt[][] = [];
  const add = (path: (u: number) => [number, number], length: number, at: number) => {
    const pts = trace(path, length, at, r, mess);
    out.push(pts);
    return pts.at(-1)![2];
  };
  switch (step.draw) {
    case "circle": {
      const b = box4(step.around);
      const cx = b.x + b.w / 2 + between(r, -0.08, 0.08) * b.w * mess;
      const cy = b.y + b.h / 2 + between(r, -0.08, 0.08) * b.h * mess;
      // Around a box's corners takes √2 its half-size; a messy hand sometimes clips a corner.
      const rx = (b.w / 2) * Math.SQRT2 * between(r, 1 - SYNTH.loopClip * mess, 1.12) + 4;
      const ry = (b.h / 2) * Math.SQRT2 * between(r, 1 - SYNTH.loopClip * mess, 1.15) + 4;
      const start = r() * Math.PI * 2;
      // A tidy loop closes; a messy one stops short or runs on past the start.
      const sweep = Math.PI * 2 * (1 + between(r, -SYNTH.loopShort, SYNTH.loopOver) * mess);
      const tilt = between(r, -0.15, 0.15) * mess;
      add((u) => {
        const a = start + sweep * u;
        const [ex, ey] = [rx * Math.cos(a), ry * Math.sin(a)];
        return [cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)];
      }, sweep * (rx + ry) / 2, t0);
      break;
    }
    case "box": {
      const b = box4(step.box);
      const o = 8 * mess;
      const c: [number, number][] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x + between(r, 0, o), b.y - between(r, 0, o)]];
      const jit = c.map(([x, y]) => [x + between(r, -o, o), y + between(r, -o, o)] as [number, number]);
      add((u) => {
        const s = u * 4;
        const i = Math.min(3, Math.floor(s));
        const f = s - i;
        return [jit[i][0] + (jit[i + 1][0] - jit[i][0]) * f, jit[i][1] + (jit[i + 1][1] - jit[i][1]) * f];
      }, 2 * (b.w + b.h), t0);
      break;
    }
    case "cross": {
      // Scribbled out: a zigzag across the box.
      const b = box4(step.box);
      const passes = Math.round(between(r, 4, 7));
      add((u) => {
        const s = u * passes;
        const i = Math.floor(Math.min(s, passes - 1e-6));
        const f = s - i;
        const o = SYNTH.crossOverrun;
        const x = b.x - b.w * o + b.w * (1 + 2 * o) * (i % 2 ? 1 - f : f);
        return [x, b.y + b.h * 0.1 + (b.h * 0.8 * (i + f)) / passes];
      }, passes * b.w, t0);
      break;
    }
    case "underline": {
      const b = box4(step.box);
      const y = b.y + b.h + between(r, 4, 10);
      const slant = between(r, -6, 6) * mess;
      add((u) => [b.x - 4 + (b.w + 8) * u, y + slant * u], b.w, t0);
      break;
    }
    case "line": {
      const [x0, y0, x1, y1] = [...step.from, ...step.to];
      add((u) => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u], Math.hypot(x1 - x0, y1 - y0), t0);
      break;
    }
    case "arrow": {
      const [x0, y0, x1, y1] = [...step.from, ...step.to];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      // A gently bowed shaft.
      const bow = len * between(r, -0.12, 0.12) * (0.3 + mess);
      const [nx, ny] = [-(y1 - y0) / len, (x1 - x0) / len];
      const [qx, qy] = [(x0 + x1) / 2 + nx * bow, (y0 + y1) / 2 + ny * bow];
      const bez = (u: number): [number, number] => [(1 - u) ** 2 * x0 + 2 * (1 - u) * u * qx + u * u * x1, (1 - u) ** 2 * y0 + 2 * (1 - u) * u * qy + u * u * y1];
      let t = add(bez, len, t0);
      // The head: two barbs back from the tip along the shaft's last direction. Messy hands
      // make them lopsided, and sometimes draw only one (it then reads like a tick).
      const back = Math.atan2(y1 - qy, x1 - qx) + Math.PI;
      const size = between(r, SYNTH.headMinPx, SYNTH.headMaxPx);
      const spread = (between(r, 22, 38) * Math.PI) / 180;
      const lop = between(r, -0.35, 0.35) * mess;
      const b1: [number, number] = [x1 + size * Math.cos(back + spread * (1 + lop)), y1 + size * Math.sin(back + spread * (1 + lop))];
      const b2: [number, number] = [x1 + size * (1 - lop) * Math.cos(back - spread * (1 - lop)), y1 + size * (1 - lop) * Math.sin(back - spread * (1 - lop))];
      t += SYNTH.liftMs * between(r, 0.6, 1.4);
      if (r() < 0.3 * mess) add((u) => [b1[0] + (x1 - b1[0]) * u, b1[1] + (y1 - b1[1]) * u], size, t);
      else add((u) => (u < 0.5 ? [b1[0] + (x1 - b1[0]) * u * 2, b1[1] + (y1 - b1[1]) * u * 2] : [x1 + (b2[0] - x1) * (u - 0.5) * 2, y1 + (b2[1] - y1) * (u - 0.5) * 2]), size * 2, t);
      break;
    }
    case "tap": {
      const [x, y] = step.at;
      const j = 3 * mess;
      out.push([[x + between(r, -j, j), y + between(r, -j, j), Math.round(t0)], [x + between(r, -1, 1), y + between(r, -1, 1), Math.round(t0 + 60)]]);
      break;
    }
  }
  return out;
}

/** A word as the person says it, and whether they pause after it. */
export type Token = { word: string; pause: boolean };

/**
 * What each say step comes out as, fillers and restarts included: the same
 * steps, traits and seed always give the same words (their own random stream,
 * so timing them by a real voice instead changes nothing here).
 */
export function lines(steps: Step[], traits: Traits, seed: number): Map<number, Token[]> {
  const r = rng(seed ^ 0x5bd1e995);
  const out = new Map<number, Token[]>();
  steps.forEach((step, i) => {
    if (!("say" in step)) return;
    const toks: Token[] = [];
    for (const raw of step.say.split(/\s+/).filter(Boolean)) {
      const pause = /(\.\.\.|…|—)$/.test(raw);
      const w = raw.replace(/(\.\.\.|…|—)+/g, "");
      if (w) {
        if (r() < SYNTH.fillerRate * traits.disfluency) toks.push({ word: r() < 0.5 ? "um," : "uh,", pause: false });
        if (r() < SYNTH.restartRate * traits.disfluency && w.length > 1) toks.push({ word: `${w},`, pause: false });
        toks.push({ word: w, pause });
      } else if (toks.length) toks.at(-1)!.pause = true;
    }
    out.set(i, toks);
  });
  return out;
}

/** A line as text for a voice: its pauses written as "...", which voices pause on. */
export const lineText = (toks: Token[]) => toks.map((t) => `${t.word}${t.pause ? "..." : ""}`).join(" ");

/** A say step spoken by a real voice: each word's start and end in its audio (seconds), and the audio's length. */
export type Voiced = { words: { start: number; end: number }[]; ms: number };

export type Timeline = {
  words: Word[];
  strokes: Stroke[];
  /** What was said, fillers and restarts included. */
  spoken: string;
  ms: number;
  /** Where each voiced line starts on the clock (by step index). */
  clips: { step: number; at: number }[];
};

/**
 * The steps played out on one clock (ms from when the person starts). Say
 * steps given in `voiced` take their word times from the voice; the rest are
 * timed at SYNTH's speaking pace.
 */
export function synthesize(steps: Step[], traits: Traits, seed: number, voiced?: Map<number, Voiced>): Timeline {
  const r = rng(seed);
  const said = lines(steps, traits, seed);
  const words: Word[] = [];
  const strokes: Stroke[] = [];
  const clips: Timeline["clips"] = [];
  let now = between(r, 300, 700);
  steps.forEach((step, i) => {
    if ("say" in step) {
      const toks = said.get(i) ?? [];
      const v = voiced?.get(i);
      if (v && v.words.length === toks.length) {
        clips.push({ step: i, at: Math.round(now) });
        toks.forEach((t, j) => words.push({ word: t.word, t0: Math.round(now + v.words[j].start * 1000), t1: Math.round(now + v.words[j].end * 1000) }));
        now += v.ms + SYNTH.gapMs;
        return;
      }
      for (const t of toks) {
        const ms = 1000 / (SYNTH.wordsPerSec * between(r, 0.85, 1.15) * (1 - 0.3 * traits.disfluency)) + Math.max(0, t.word.length - 4) * SYNTH.msPerExtraChar;
        words.push({ word: t.word, t0: Math.round(now), t1: Math.round(now + ms) });
        now += ms + SYNTH.gapMs * between(r, 0.5, 1.5);
        if (t.pause) now += SYNTH.pauseMs * between(r, 0.5, 1.5);
      }
    } else if ("pause" in step) {
      now += Math.max(0, Math.min(10, Number(step.pause) || 0)) * 1000;
    } else {
      const lastWord = words.at(-1);
      const t0 = Math.max(strokes.at(-1)?.t1 ?? 0, lastWord ? lastWord.t1 - SYNTH.pointLeadMs : now);
      for (const pts of strokesFor(step, t0, r, traits.mess)) strokes.push({ id: strokes.length + 1, points: pts, t0: pts[0][2], t1: pts.at(-1)![2] });
      const end = strokes.at(-1)?.t1 ?? t0;
      now = Math.max(now, t0 + (end - t0) * SYNTH.talkOverDraw);
    }
  });
  const ms = Math.max(now, strokes.at(-1)?.t1 ?? 0, words.at(-1)?.t1 ?? 0);
  return { words, strokes, spoken: words.map((w) => w.word).join(" "), ms: Math.round(ms), clips };
}
