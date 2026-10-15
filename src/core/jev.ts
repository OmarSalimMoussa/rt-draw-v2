// Asking TypeSafe's Jev about a mark. Jev reads text, not pictures, so the ink
// goes in as points on a 0-100 box (and, optionally, the local measurements).
import { resample } from "./arrow.ts";
import type { Pt } from "./ink.ts";

export type JevAnswer = {
  ms: number;
  arrow?: number;
  kind?: string;
  kindProbs?: Record<string, number>;
  tip?: string;
  tipProbs?: Record<string, number>;
  tokens?: number;
  error?: string;
};

export const KINDS = {
  arrow: "a shaft with a head at one end, pointing from one place to another",
  line: "a single straight or slightly curved line with no head, like an underline or divider",
  loop: "a closed or nearly closed loop drawn around something",
  dot: "a dot or tiny tap",
  scribble: "a messy zigzag or scribble over something",
  shape: "a deliberate drawing of a shape or object, like a star, box, heart or icon",
};

/** The mark as text: each stroke's points, scaled into a 0-100 box, in drawing order. */
export function inkAsText(strokes: Pt[][], measurements?: string) {
  const all = strokes.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const scale = 100 / Math.max(1, Math.max(...xs) - x0, Math.max(...ys) - y0);
  const lines = strokes.map((s, i) => {
    const pts = s.length > 1 ? resample(s, Math.max(4, (Math.hypot(Math.max(...xs) - x0, Math.max(...ys) - y0) / 40))) : [[s[0][0], s[0][1]]];
    const step = Math.max(1, Math.ceil(pts.length / 24));
    const kept = pts.filter((_, j) => j % step === 0 || j === pts.length - 1);
    return `Stroke ${i + 1} (drawn ${i === 0 ? "first" : `after stroke ${i}`}): ${kept.map(([x, y]) => `(${Math.round((x - x0) * scale)},${Math.round((y - y0) * scale)})`).join(" ")}`;
  });
  return [
    "Hand-drawn ink on a whiteboard, in a 0-100 box (x grows right, y grows down). Points go in drawing order.",
    ...lines,
    ...(measurements ? [`Measurements: ${measurements}`] : []),
  ].join("\n");
}

/** The ends a tip could be at: the start and end of each stroke. */
export const endsOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [[`s${i + 1}-start`, `where stroke ${i + 1} starts`], [`s${i + 1}-end`, `where stroke ${i + 1} ends`]]).flat());

export async function askJev(strokes: Pt[][], measurements?: string): Promise<JevAnswer> {
  const questions = {
    arrow: { type: "noul", instructions: "Is this ink an arrow: a shaft with a head (a V or barbs) at one end?" },
    kind: { type: "choice", instructions: "What kind of mark is this ink?", criteria: KINDS },
    tip: { type: "choice", instructions: "If this is an arrow, which end is its tip (where the head is)?", criteria: endsOf(Math.min(strokes.length, 6)) },
  };
  const t0 = performance.now();
  try {
    const r = await fetch("/api/jev", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: inkAsText(strokes, measurements), questions }) });
    const b = await r.json();
    if (!r.ok) return { ms: Math.round(performance.now() - t0), error: b.error ?? JSON.stringify(b).slice(0, 200) };
    const a = b.answers ?? {};
    return { ms: Math.round(performance.now() - t0), arrow: a.arrow?.noul, kind: a.kind?.choice, kindProbs: a.kind?.probabilities, tip: a.tip?.choice, tipProbs: a.tip?.probabilities, tokens: b.usage?.input_tokens };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: (e as Error).message };
  }
}
