// Every number that decides something lives here, by name, with its range and
// what it does. Parts take a Tuning (defaults unless told otherwise), every
// decision records the tuning version it used, and labeled sets from the
// playgrounds, people's sessions and evals can be replayed under any tuning to
// pick better values (scripts/tune.ts). Nothing that decides may hide a literal.

export type Knob = {
  /** "part.name", e.g. "arrow.coneMaxDeg". */
  key: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** What it does, in a sentence someone tuning it can act on. */
  doc: string;
  unit?: string;
};

const K = (key: string, value: number, min: number, max: number, step: number, doc: string, unit?: string): Knob => ({ key, value, min, max, step, doc, unit });

export const KNOBS: Knob[] = [
  // Ink: how strokes are drawn and when a stroke is a dot.
  K("ink.size", 5, 1, 16, 0.5, "pen width when drawing strokes", "px"),
  K("ink.thinning", 0.5, 0, 1, 0.05, "how much faster strokes get thinner"),
  K("ink.smoothing", 0.5, 0, 1, 0.05, "how much the stroke outline is smoothed"),
  K("ink.streamline", 0.4, 0, 1, 0.05, "how much the pen lags to smooth jitter"),
  K("ink.dotMaxPx", 3, 0, 20, 0.5, "a stroke shorter than this is a dot (a click)", "px"),
  K("ink.dotRadius", 1.1, 0.5, 3, 0.1, "a dot's radius as a multiple of the pen width"),

  // Marks: grouping strokes into marks, and reading them.
  K("marks.gapMs", 700, 100, 2000, 50, "strokes this close in time can be one mark", "ms"),
  K("marks.nearPx", 60, 0, 200, 5, "and this close in space", "px"),
  K("marks.tapPx", 14, 2, 40, 1, "a mark shorter than this is a tap", "px"),
  K("marks.closeRatio", 0.2, 0.05, 0.5, 0.01, "closed loop if the gap between its ends is under this share of its length"),
  K("marks.minLoopPx", 60, 20, 200, 5, "a loop must be at least this long", "px"),
  K("marks.straightRatio", 0.88, 0.6, 0.99, 0.01, "straight if end-to-end distance over length is at least this"),

  // Arrow: shaft plus a head that sweeps back from one end.
  K("arrow.resamplePx", 5, 2, 15, 1, "spacing of the evenly resampled points", "px"),
  K("arrow.cornerDeg", 95, 45, 160, 5, "a turn sharper than this splits a stroke into pieces", "deg"),
  K("arrow.minShaftPx", 30, 10, 120, 5, "a shaft must span at least this", "px"),
  K("arrow.maxCurve", 1.5, 1, 3, 0.05, "a shaft's length over its span may be at most this (gently curved)"),
  K("arrow.headRadiusFrac", 0.45, 0.1, 1, 0.05, "head ink must lie within this share of the shaft's span from the tip"),
  K("arrow.headRadiusMinPx", 15, 5, 60, 1, "but at least this far", "px"),
  K("arrow.headRadiusMaxPx", 80, 30, 200, 5, "and at most this far", "px"),
  K("arrow.headInkFrac", 0.6, 0.2, 1, 0.05, "this share of the non-shaft ink must be near the tip (stars and zigzags fail)"),
  K("arrow.coneMinDeg", 3, 0, 30, 1, "head ink sweeps back at least this far off the shaft line", "deg"),
  K("arrow.coneMaxDeg", 80, 40, 120, 5, "and at most this far", "deg"),
  K("arrow.coneFrac", 0.55, 0.2, 1, 0.05, "this share of the head ink must sweep back"),
  K("arrow.tangentPx", 20, 5, 60, 5, "the shaft's direction at an end is taken this far in from it", "px"),
  K("arrow.twoSided", 0.95, 0.5, 1, 0.01, "confidence for a head on both sides"),
  K("arrow.oneSided", 0.65, 0.3, 1, 0.01, "confidence for a head on one side"),
  K("arrow.threshold", 0.5, 0.1, 0.95, 0.05, "a mark is an arrow at or above this confidence"),

  // Hit-test: what ink touches and goes around.
  K("hit.enclosedSamples", 4, 1, 5, 1, "a shape is enclosed when this many of its 5 sample points are inside the loop"),
  K("hit.linePx", 8, 2, 30, 1, "ink this close to a line or arrow shape touches it", "px"),

  // Ops: what the model must write.
  K("ops.minDescriptionWords", 6, 1, 30, 1, "a new shape's description needs at least this many words"),
  K("ops.cellPx", 40, 10, 120, 5, "grid cell size for boxes written as cells (C2-J7)", "px"),

  // Render: the doodle look.
  K("render.roughness", 1.2, 0, 3, 0.1, "how wobbly outlines are"),
  K("render.strokeWidth", 1.6, 0.5, 4, 0.1, "outline width", "px"),
  K("render.fadeOpacity", 0.7, 0, 1, 0.05, "at fade 1, a picture loses this much opacity"),
  K("render.textPadPx", 16, 0, 40, 1, "text keeps at least this far from a shape's edge", "px"),
  K("render.lineHeight", 1.25, 1, 2, 0.05, "line height as a multiple of text size"),
];

export type Tuning = Readonly<Record<string, number>>;

export const DEFAULTS: Tuning = Object.freeze(Object.fromEntries(KNOBS.map((k) => [k.key, k.value])));

export const knobsOf = (part: string) => KNOBS.filter((k) => k.key.startsWith(`${part}.`));

/** Defaults with some knobs changed; unknown keys are refused so a typo can't silently do nothing. */
export function tune(changes: Record<string, number> = {}, base: Tuning = DEFAULTS): Tuning {
  for (const key of Object.keys(changes)) if (!(key in DEFAULTS)) throw new Error(`unknown knob "${key}"`);
  return Object.freeze({ ...base, ...changes });
}

/** A short stable id for a tuning, logged with every decision so results can be grouped by it. */
export function tuningId(t: Tuning): string {
  const changed = Object.keys(t).filter((k) => t[k] !== DEFAULTS[k]).sort();
  if (!changed.length) return "default";
  const text = changed.map((k) => `${k}=${t[k]}`).join(";");
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `t-${h.toString(36)}`;
}

/** Only the knobs that differ from the defaults: what to save, share or paste back. */
export const diff = (t: Tuning) => Object.fromEntries(Object.keys(t).filter((k) => t[k] !== DEFAULTS[k]).map((k) => [k, t[k]]));
