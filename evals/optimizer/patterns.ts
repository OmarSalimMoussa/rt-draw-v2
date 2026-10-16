// Frozen rules the optimizer reads the product by (spec §8.2): the six trace patterns
// of the eval doc's latency table, found on one send's spans, and the over-use
// detectors a card names (§1.4 item 8), predicates over the scene diff and the ops
// that ab.ts evaluates per case and arm. Measuring side: the loop reads this, never
// writes it. Pure: no node or DOM APIs.
import type { View } from "../../src/core/board.ts";
import { DIFF } from "../core/diff.ts";
import type { OpRecord, SceneJSON, SpanJSON } from "../loop/types.ts";

/** Frozen numbers of the trace patterns. */
export const PATTERN = {
  /** Two spans this close (ms) are back to back. */
  gapMs: 30,
  /** A step shorter than this isn't worth running side by side. */
  minStepMs: 50,
  /** A reply streaming at least this long after its first text had input to hand on early. */
  streamMs: 800,
  /** A process started for its call that took at least this long to be ready. */
  coldMs: 300,
  /** A model call at least this long is a slow answer to wait on. */
  slowMs: 1000,
  /** A consumer starting up to this long after a reply ended waited for the whole reply. */
  afterMs: 500,
};

export type PatternId = "whole-reply" | "cold-parallel" | "warm-late" | "serial" | "redo" | "slow-answer";
/** One firing: the spans it fired on and what it saw. */
export type Fired = { spans: string[]; note: string };

const MODEL = "model call · ";
const COLD = "Claude process (started for this call)";
const isModel = (s: SpanJSON) => s.name.startsWith(MODEL);
const roleOf = (s: SpanJSON) => String(s.attributes.from ?? s.name.split(" · ")[1]);
const dur = (s: SpanJSON) => s.endMs - s.startMs;
const ms = (x: number) => `${Math.round(x)} ms`;
const overlaps = (a: SpanJSON, b: SpanJSON) => a.startMs < b.endMs && b.startMs < a.endMs;

/** Parent and child links of one send's spans. */
function tree(spans: SpanJSON[]) {
  const kids = new Map<string, SpanJSON[]>();
  for (const s of spans) if (s.parentId) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const childrenOf = (s: SpanJSON) => kids.get(s.spanId) ?? [];
  const hasModel = (s: SpanJSON): boolean => isModel(s) || childrenOf(s).some(hasModel);
  /** A model call's own timing phases (process, first text, streaming, overhead) are not steps. */
  const phases = new Set(spans.filter(isModel).flatMap((m) => childrenOf(m).map((c) => c.spanId)));
  const steps = spans.filter((s) => !phases.has(s.spanId) && !isModel(s));
  const siblings = (s: SpanJSON) => spans.filter((x) => x !== s && x.traceId === s.traceId && x.parentId === s.parentId && !phases.has(x.spanId));
  const coldMs = (m: SpanJSON) => childrenOf(m).filter((c) => c.name === COLD).reduce((a, c) => Math.max(a, dur(c)), -1);
  return { childrenOf, hasModel, steps, siblings, coldMs, byId: new Map(spans.map((s) => [s.spanId, s])) };
}

/** The doc's latency table, each pattern as a rule over one send's spans. */
export const PATTERNS: Record<PatternId, { title: string; fix: string; detect: (spans: SpanJSON[]) => Fired[] }> = {
  "whole-reply": {
    title: "Waiting for a whole reply",
    fix: "start each piece of dependent work as its input lands (pipelining)",
    // A picture or camera step that starts only once a long-streaming reply has ended.
    detect(spans) {
      const t = tree(spans);
      const consumer = (s?: SpanJSON) => !!s && /^(picture|camera)/.test(isModel(s) ? roleOf(s) : s.name);
      const out: Fired[] = [];
      for (const m of spans.filter(isModel)) {
        const first = m.events.find((e) => e.name === "first text")?.atMs;
        if (first === undefined || m.endMs - first < PATTERN.streamMs) continue;
        for (const s of spans)
          if (s !== m && consumer(s) && !consumer(s.parentId ? t.byId.get(s.parentId) : undefined) && s.startMs >= m.endMs - PATTERN.gapMs && s.startMs <= m.endMs + PATTERN.afterMs)
            out.push({ spans: [m.name, s.name], note: `starts ${ms(s.startMs - m.endMs)} after the reply ended; it streamed ${ms(m.endMs - first)} after its first text` });
      }
      return out;
    },
  },
  "cold-parallel": {
    title: "Cold starts under parallel calls",
    fix: "keep as many warm processes as calls run side by side",
    // Calls of one role at the same time where some had to start a process.
    detect(spans) {
      const t = tree(spans);
      const calls = spans.filter(isModel);
      const out: Fired[] = [];
      const seen = new Set<string>();
      for (const c of calls) {
        if (seen.has(c.spanId)) continue;
        const group = calls.filter((x) => roleOf(x) === roleOf(c) && x.attributes.model === c.attributes.model && (x === c || overlaps(x, c)));
        group.forEach((x) => seen.add(x.spanId));
        const cold = group.filter((x) => t.coldMs(x) >= 0);
        if (group.length >= 2 && cold.length) out.push({ spans: cold.map((x) => x.name), note: `${group.length} ${roleOf(c)} calls at once, ${cold.length} started a process` });
      }
      return out;
    },
  },
  "warm-late": {
    title: "Warming too late",
    fix: "warm when the need becomes likely, e.g. at Send rather than at the first op that needs it",
    // A lone call that waited on a process started at the moment of the call.
    detect(spans) {
      const t = tree(spans);
      const calls = spans.filter(isModel);
      return calls
        .filter((c) => t.coldMs(c) >= PATTERN.coldMs && !calls.some((x) => x !== c && roleOf(x) === roleOf(c) && overlaps(x, c)))
        .map((c) => ({ spans: [c.name], note: `waited ${ms(t.coldMs(c))} for a process started for this call` }));
    },
  },
  serial: {
    title: "Steps in a row that don't need each other",
    fix: "run them side by side",
    // Two sibling steps with no model call in either, the second starting as the first ends.
    detect(spans) {
      const t = tree(spans);
      const steps = t.steps.filter((s) => !t.hasModel(s) && dur(s) >= PATTERN.minStepMs);
      const out: Fired[] = [];
      for (const a of steps)
        for (const b of t.siblings(a))
          if (steps.includes(b) && b.startMs >= a.endMs && b.startMs - a.endMs <= PATTERN.gapMs) out.push({ spans: [a.name, b.name], note: `${ms(dur(b))} step waited for a ${ms(dur(a))} sibling` });
      return out;
    },
  },
  redo: {
    title: "Redoing finished work",
    fix: "keep the result on the thing it belongs to, and redo only when its input changes",
    // The same request (role, model, size, images, under the same step) made twice in one send.
    detect(spans) {
      const t = tree(spans);
      const by = new Map<string, SpanJSON[]>();
      for (const c of spans.filter(isModel)) {
        const parent = c.parentId ? t.byId.get(c.parentId)?.name : "";
        const key = [roleOf(c), c.attributes.model, c.attributes.chars, c.attributes.images, parent].join("|");
        by.set(key, [...(by.get(key) ?? []), c]);
      }
      return [...by.values()].filter((g) => g.length > 1).map((g) => ({ spans: g.map((c) => c.name), note: `the same ${roleOf(g[0])} request ${g.length} times` }));
    },
  },
  "slow-answer": {
    title: "Waiting on a slow answer only part of the work needs",
    fix: "start the part that doesn't depend on it right away (speculate); let only the rest wait",
    // A step without a model call that starts as a slow sibling holding one ends, and no step like it ran meanwhile.
    detect(spans) {
      const t = tree(spans);
      const out: Fired[] = [];
      for (const a of t.steps.filter((s) => t.hasModel(s) && dur(s) >= PATTERN.slowMs))
        for (const b of t.siblings(a))
          if (!t.hasModel(b) && !isModel(b) && dur(b) >= PATTERN.minStepMs && b.startMs >= a.endMs - PATTERN.gapMs && b.startMs - a.endMs <= PATTERN.gapMs
              && !t.siblings(a).some((x) => x.name === b.name && overlaps(x, a)))
            out.push({ spans: [a.name, b.name], note: `started after the ${ms(dur(a))} '${a.name}' though nothing like it ran meanwhile` });
      return out;
    },
  },
};

export type PatternReport = Record<PatternId, { title: string; fix: string; cases: { case: string; fired: Fired[] }[] }>;

/** Every pattern over each case's spans: where it fired, case by case. */
export function tracePatterns(cases: { case: string; spans: SpanJSON[] }[]): PatternReport {
  return Object.fromEntries(Object.entries(PATTERNS).map(([id, p]) => [id, {
    title: p.title, fix: p.fix,
    cases: cases.map((c) => ({ case: c.case, fired: p.detect(c.spans) })).filter((c) => c.fired.length),
  }])) as PatternReport;
}

// ---- Over-use detectors (§1.4 item 8)

/** One arm's send: the scenes around it, its ops, the camera before and after, and the shapes the ink or the resolver pointed at. */
export type SendFacts = { before: SceneJSON; after: SceneJSON; ops: OpRecord[]; cameras?: [View, View]; pointed?: string[] };

/** Frozen numbers of the over-use detectors. */
export const OVERUSE_K = { /** shapes added in one send */ extraShapes: 3 };

type Shape = SceneJSON["shapes"][number];
/** A shape's look as key=value words (its style and its text's look). */
const looks = (s: Shape) => [
  ...Object.entries(s.style ?? {}).map(([k, v]) => `${k}=${v}`),
  ...Object.entries(s.text ?? {}).filter(([k]) => k !== "words").map(([k, v]) => `text.${k}=${v}`),
];
const sameLook = (a: Shape, b: Shape) => a.kind === b.kind && JSON.stringify(a.style) === JSON.stringify(b.style) && JSON.stringify(looks(a)) === JSON.stringify(looks(b));
/** Shapes in both scenes whose look changed. */
const restyled = (before: SceneJSON, after: SceneJSON) => {
  const was = new Map(before.shapes.map((s) => [s.id, s]));
  return after.shapes.filter((s) => was.has(s.id) && !sameLook(was.get(s.id)!, s));
};

export const OVERUSE: Record<string, (s: SendFacts) => boolean> = {
  /** An added or restyled shape uses a look the scene had nowhere before (a blank scene has no house style to break). */
  "new-style": ({ before, after }) => {
    if (!before.shapes.length) return false;
    const seen = new Set(before.shapes.flatMap(looks));
    const ids = new Set(before.shapes.map((s) => s.id));
    return [...after.shapes.filter((s) => !ids.has(s.id)), ...restyled(before, after)].some((s) => looks(s).some((l) => !seen.has(l)));
  },
  /** The send added at least OVERUSE_K.extraShapes shapes (pages not counted). */
  "extra-shapes": ({ before, after }) => {
    const ids = new Set(before.shapes.map((s) => s.id));
    return after.shapes.filter((s) => !ids.has(s.id) && s.kind !== "frame").length >= OVERUSE_K.extraShapes;
  },
  /** A camera(...) op ran, or the view moved. */
  "camera-move": ({ ops, cameras }) =>
    ops.some((o) => o.ok && /^\s*camera\(/.test(o.line)) || (!!cameras && (["x", "y", "w", "h"] as const).some((k) => Math.abs(cameras[0][k] - cameras[1][k]) >= DIFF.cameraPx)),
  /** A shape changed its look though no ink touched it and the resolver didn't name it. */
  "restyle-unpointed": ({ before, after, pointed = [] }) => restyled(before, after).some((s) => !pointed.includes(s.id)),
};
