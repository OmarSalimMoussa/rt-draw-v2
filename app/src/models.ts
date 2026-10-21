// The drawing models the settings menu offers: Claude only, since v2 reaches
// models through the Claude subscription. Each sets draw.model; every other knob
// stays the eval's tuned default. Prices: Anthropic's list prices (evals/loop/meter.ts).
import { DEFAULTS, type Tuning, tune } from "../../src/core/tuning.ts";

export type DrawModel = { name: "sonnet" | "opus" | "haiku"; label: string; knob: 0 | 1 | 2; price: [number, number] };

export const DRAW_MODELS: DrawModel[] = [
  { name: "sonnet", label: "Claude Sonnet 5.5", knob: 1, price: [2, 10] },
  { name: "opus", label: "Claude Opus 5.5", knob: 2, price: [4, 20] },
  { name: "haiku", label: "Claude Haiku 5.5", knob: 0, price: [0.1, 0.5] },
];

/** What the eval tuned for. */
export const DEFAULT_MODEL = DRAW_MODELS.find((m) => m.knob === DEFAULTS["draw.model"]) ?? DRAW_MODELS[0];

export const drawModel = (name: string | null | undefined) => DRAW_MODELS.find((m) => m.name === name) ?? DEFAULT_MODEL;

/** The tuning a send runs with: the champion's, with this drawing model. */
export const tuningFor = (m: DrawModel): Tuning => (m.knob === DEFAULTS["draw.model"] ? DEFAULTS : tune({ "draw.model": m.knob }));
