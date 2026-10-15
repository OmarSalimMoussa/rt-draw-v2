// One format for labeled examples, whoever made them: a playground session, a
// person correcting the app, or an eval. A set keeps the raw input (so any
// tuning can be replayed on it), what the app decided and with which tuning,
// and what the right answer was.
import type { Stroke } from "./ink.ts";
import type { Tuning } from "./tuning.ts";

export type Source = "playground" | "session" | "eval";

export type Example = {
  /** Which decision this is about, e.g. "marks.kind" or "marks.arrow". */
  decision: string;
  /** Raw input: the strokes of one mark (and, for decisions about shapes, the scene). */
  strokes: Stroke[];
  /** What the app said, and the measurements it said it from. */
  predicted: string;
  features?: Record<string, number | string | boolean>;
  /** The right answer. A prediction nobody corrected counts as accepted. */
  label: string;
  corrected: boolean;
};

export type LabeledSet = {
  v: 1;
  source: Source;
  /** e.g. "clowns": the scene the ink was drawn on, for decisions that depend on it. */
  scene?: string;
  createdAt: string;
  tuningId: string;
  tuning: Record<string, number>;
  examples: Example[];
};

export function makeSet(source: Source, scene: string | undefined, tuning: Tuning, tuningId: string, examples: Example[]): LabeledSet {
  return { v: 1, source, scene, createdAt: new Date().toISOString(), tuningId, tuning: { ...tuning }, examples };
}

/** How often each decision's predictions match the labels; corrected ones are what tuning learns from. */
export function score(set: LabeledSet, decide: (ex: Example) => string) {
  const by = new Map<string, { right: number; total: number }>();
  for (const ex of set.examples) {
    const s = by.get(ex.decision) ?? { right: 0, total: 0 };
    s.total++;
    if (decide(ex) === ex.label) s.right++;
    by.set(ex.decision, s);
  }
  return by;
}
