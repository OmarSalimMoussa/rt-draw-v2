// Every number that decides something lives here, by name, with its range and
// what it does. Parts take a Tuning (defaults unless told otherwise), every
// decision records the tuning version it used, and labeled sets from the
// playgrounds, people's sessions and evals can be replayed under any tuning to
// pick better values (scripts/tune.ts). Nothing that decides may hide a literal.
//
// Prefer a purpose-built model (Scribe for word times, a vision model for
// shapes) over our own rules. A knob that adjusts such a model's output is a
// patch: it names the model and its neutral value. Each model has one switch,
// patches.<model>, OFF by default: the model as it comes is the baseline, and a
// patch is only turned on once it's shown to beat that. Read a patch knob with
// patchValue(), which gives the neutral value (or undefined: don't send) when off.
import { PROMPTS } from "./prompts.ts";

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
  /** Set on on/off knobs (0 or 1): the short name their button shows. */
  name?: string;
  /** Set on knobs that adjust a purpose-built model's output: which model it patches. */
  patches?: string;
  /** The value that leaves that model's output alone. Unset: the knob isn't sent, so the model's own default applies. */
  neutral?: number;
};

const K = (key: string, value: number, min: number, max: number, step: number, doc: string, unit?: string): Knob => ({ key, value, min, max, step, doc, unit });
/** An on/off knob (0 or 1), shown as a button named `name`. */
const B = (key: string, value: 0 | 1, name: string, doc: string): Knob => ({ key, value, min: 0, max: 1, step: 1, doc, name });
/** A patch on a purpose-built model's output (see the top of this file). */
const patch = (model: string, k: Knob, neutral?: number): Knob => ({ ...k, patches: model, neutral });
/** Which of a role's prompt texts it is asked with (src/core/prompts.ts; 0 is the shipped text). */
const P = (role: keyof typeof PROMPTS): Knob => K(`${role}.prompt`, 0, 0, PROMPTS[role].length - 1, 1, `which ${role} prompt text is sent: ${PROMPTS[role].map((v, i) => `${i} ${v.name}`).join(", ")} (src/core/prompts.ts)`);

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

  // Speech: turning the mic into timed words (ElevenLabs Scribe).
  patch("scribe", K("speech.vadSilenceMs", 600, 300, 3000, 100, "silence that ends an utterance", "ms")),
  patch("scribe", K("speech.shiftMs", 0, -500, 500, 10, "moves Scribe's word times later (+) or earlier (-), for a constant offset", "ms"), 0),
  patch("scribe", K("speech.playBeforeMs", 80, 0, 500, 10, "playing a word starts this much before it", "ms"), 0),
  patch("scribe", K("speech.playAfterMs", 200, 0, 800, 10, "and runs this much past its end (Scribe's ends are tight)", "ms"), 0),

  // Link: putting [ink n] markers at the word being said.
  K("link.leadMs", 400, 0, 2000, 50, "a mark can link to a word said up to this long after the pen went down", "ms"),
  K("link.lagMs", 1500, 0, 5000, 100, "or a word said up to this long before it", "ms"),
  B("link.preferDeictic", 1, "prefer pointing words", "prefer pointing words (this, that, here, there, these) inside the window"),

  // Shot: the picture the model gets at Enter.
  K("shot.scale", 0.75, 0.25, 2, 0.05, "screenshot size as a share of canvas pixels"),
  K("shot.inkNumberPx", 22, 10, 48, 1, "size of the [n] number next to each mark", "px"),
  K("shot.inkNumberGapPx", 6, 0, 40, 1, "the [n] sits this far up and right of the mark's top-right-most ink", "px"),
  K("shot.tagPx", 11, 0, 24, 1, "size of the id tags on shapes (0 hides them)", "px"),
  K("shot.gridCellPx", 0, 0, 160, 10, "grid drawn on the screenshot (0 for none)", "px"),
  K("shot.jpegQuality", 0.8, 0.3, 1, 0.05, "JPEG quality (1 sends PNG)"),

  // Coords: how the model names a place.
  K("coords.cellPx", 40, 10, 160, 5, "grid cell size when places are named by cells", "px"),
  K("coords.roundPx", 10, 1, 50, 1, "pixel coordinates are rounded to this", "px"),
  K("coords.nearPx", 80, 10, 300, 10, "a place is described relative to a shape this close to it", "px"),

  // Tidy: snap, align and even out a scene after the model writes it.
  K("tidy.snapPx", 10, 0, 40, 1, "last step: snap positions and sizes to a grid this fine (0: off)", "px"),
  K("tidy.alignTolPx", 8, 0, 30, 1, "edges or centers this close become aligned, and sizes this close become equal", "px"),
  K("tidy.gapTolPx", 10, 0, 40, 1, "gaps between siblings this close become equal", "px"),
  K("tidy.maxMovePx", 24, 0, 80, 1, "never move a shape further than this", "px"),

  // Model choice knobs are an index: 0 haiku, 1 sonnet, 2 opus (src/core/model.ts). Prompt knobs are an index into src/core/prompts.ts.

  // Describe: the detailed id map, one description per shape from its crop.
  K("describe.model", 0, 0, 2, 1, "model that writes descriptions (0 haiku, 1 sonnet, 2 opus)"),
  K("describe.cropPadPx", 16, 0, 80, 2, "context kept around a shape in its crop", "px"),
  K("describe.cropMaxPx", 384, 128, 1024, 32, "a crop's longer side is scaled to at most this", "px"),
  K("describe.minWords", 6, 1, 30, 1, "a description must have at least this many words"),
  K("describe.maxWords", 30, 6, 80, 1, "and at most this many"),
  B("describe.batch", 1, "all shapes in one call", "on: all shapes in one call (crops numbered); off: one call per shape"),
  P("describe"),

  // Resolve: "this headline" + ink → shape ids.
  K("resolve.model", 0, 0, 2, 1, "model that resolves references (0 haiku, 1 sonnet, 2 opus)"),
  K("resolve.maxCandidates", 8, 1, 30, 1, "shapes offered to the model: the ink's hits first, then the rest by word overlap"),
  B("resolve.inkFirst", 0, "ink-only shortcut", "on: when every mark clearly points at its shapes (tap, loop, arrow) and you said this/that/these, use those shapes without asking the model; off: always ask the model"),
  B("resolve.sendScreenshot", 0, "send screenshot", "on: also send the model screenshot"),
  P("resolve"),
  B("resolve.noThink", 0, "no thinking", "on: ask the API not to think (it thinks on nearly every resolver call, which delays its first text); off: the model decides"),

  // Draw: one send → ops.
  K("draw.model", 1, 0, 2, 1, "model that writes the ops (0 haiku, 1 sonnet, 2 opus)"),
  B("draw.sendScreenshot", 1, "send screenshot", "on: send the screenshot with numbered ink"),
  B("draw.sendIdMap", 1, "send id map", "on: send every shape's id and description"),
  B("draw.sendMarks", 1, "send marks", "on: tell the model what each [ink n] is, read from its geometry (loop, tap, arrow from → to with its tip, line, sketch) and which shapes it touches; free"),
  B("draw.sendRefs", 1, "send references", "on: resolve the references first (the Resolver: \"this toy\" → toy-l1) and send the answers; one extra model call unless the ink settles it"),
  B("draw.sendOps", 0, "send scene as ops", "on: also send the scene as op lines (its exact boxes)"),
  K("draw.gridCellPx", 0, 0, 160, 10, "grid on the screenshot, so the model can name cells (0: none)", "px"),
  K("draw.mapDepth", 5, 0, 5, 1, "on a board, the site map the drawing model gets lists this many levels of each page's content (the id map is that map there)"),
  K("draw.mapWords", 40, 0, 60, 1, "and this many words of each shape's description"),
  B("draw.mapBoxes", 1, "boxes in the site map", "on: the drawing model's site map gives each shape's box in board pixels, so it can copy, align and move what no picture shows"),
  K("draw.mapMaxShapes", 0, 0, 500, 10, "the id map (on a board, the site map) lists at most this many shapes, in map order, and counts the rest (0: every shape)"),
  P("draw"),
  B("draw.noThink", 0, "no thinking", "on: ask the API not to think (thinking delays the first op); off: the model decides"),
  B("draw.fillPictures", 1, "fill pictures", "on: the picture model draws every new or changed picture (one call each), each starting as its drawing() op lands, before the send is done; off: pictures stay placeholders"),

  // Picture: a doodle inside a shape.
  K("picture.model", 1, 0, 2, 1, "model that draws pictures (0 haiku, 1 sonnet, 2 opus)"),
  K("picture.maxPaths", 24, 4, 80, 1, "a doodle may use at most this many paths"),
  K("picture.colors", 4, 1, 10, 1, "and at most this many colors"),
  K("picture.roughness", 1.4, 0, 3, 0.1, "wobble applied to the doodle's paths"),
  K("picture.parallel", 3, 1, 8, 1, "pictures drawn at the same time after a send"),
  K("picture.fill", 0.9, 0.5, 1, 0.05, "a picture fills this share of its shape"),
  K("picture.timeoutMs", 120000, 5000, 300000, 5000, "a picture call still going after this long is stopped and counts as failed (its shape stays a placeholder)", "ms"),
  P("picture"),
  B("picture.noThink", 0, "no thinking", "on: ask the API not to think; off: the model decides"),

  // Board: what a model is shown of an infinite board.
  B("board.viewportShot", 1, "what you see", "on: send the camera's view, as on screen"),
  B("board.markViews", 1, "close-ups of marks", "on: send a close-up around each mark the camera shows too small"),
  B("board.pageViews", 1, "named pages", "on: send each page you named that's off screen"),
  B("board.overview", 1, "whole board", "on: send the whole board at the biggest zoom that holds every page"),
  B("board.overviewTags", 0, "tags on the whole board", "on: id tags on the whole-board picture too (many, small)"),
  B("board.fromRefs", 1, "pictures from the resolver", "on: picture what you referred to (the resolver's answers: a page you meant, shapes off screen or too small), so \"the page with the robot\" gets its picture; off: page names in the words only"),
  B("board.earlyShots", 1, "capture early", "on: while the resolver thinks, capture the pictures that don't wait on its answers (what you see, mark close-ups, the whole board), so only the ones its answers add come after it; off: every picture waits for the resolver"),
  K("board.maxViews", 6, 1, 10, 1, "pictures sent at most: what you see and the whole board are kept, the rest fill what's left in order"),
  K("board.imageBudget", 4500, 500, 15000, 100, "image tokens sent at most (about one per 750 pixels)", "tokens"),
  K("board.readablePx", 40, 10, 200, 2, "a shape counts as shown when its larger side is at least this big in a picture", "px"),
  K("board.textPx", 9, 4, 30, 1, "and its text, if any, at least this tall", "px"),
  K("board.pageReadablePx", 400, 100, 1600, 20, "a page counts as shown when it's at least this wide in a picture", "px"),
  K("board.viewWidthPx", 960, 320, 1600, 32, "width of the camera, close-up and page pictures", "px"),
  K("board.overviewWidthPx", 1280, 320, 2000, 32, "width of the whole-board picture", "px"),
  K("board.markPadFrac", 0.3, 0, 3, 0.05, "a close-up shows this much around its mark, as a share of the mark's size"),
  K("board.markMinViewPx", 480, 100, 2000, 20, "a close-up shows at least this much of the board across", "px"),
  K("board.markZoomFrac", 0.6, 0.2, 1, 0.05, "skip a close-up unless it's at most this share of the camera's width (zoomed in enough to add something)"),
  K("board.linkSnapPx", 60, 0, 200, 5, "an arrow end this close to a page counts as on it, for links", "px"),
  K("board.mapDepth", 2, 0, 5, 1, "site map: levels of each page's content listed (0: pages and links only)"),
  K("board.mapWords", 10, 0, 40, 1, "site map: words of each shape's description (0: ids only)"),

  // Camera: the model moves the view when asked ("zoom out", "go to the shop page").
  K("camera.model", 0, 0, 2, 1, "model that moves the camera (0 haiku, 1 sonnet, 2 opus)"),
  B("camera.sendMap", 1, "send site map", "on: send the site map as text"),
  B("camera.sendView", 1, "send what you see", "on: send a picture of the current view"),
  B("camera.sendOverview", 0, "send whole board", "on: send a picture of the whole board"),
  K("camera.padFrac", 0.06, 0, 0.5, 0.01, "framing shapes by id leaves this margin, as a share of their size"),
  K("camera.minViewPx", 160, 40, 800, 20, "the camera never shows less than this much of the board across", "px"),
  K("camera.easeMs", 450, 0, 2000, 50, "the camera glides to its new view over this long", "ms"),

  // Router: fast lane (small model, no picture) vs full lane.
  K("router.fastMaxWords", 12, 1, 40, 1, "a send this short can take the fast lane"),
  K("router.fastMaxMarks", 1, 0, 5, 1, "with at most this many marks"),
  B("router.sketchIsFull", 1, "sketches go full", "on: any sketch mark goes to the full lane"),
  K("router.fastModel", 0, 0, 2, 1, "the fast lane's model (0 haiku, 1 sonnet, 2 opus)"),
  K("router.fullModel", 1, 0, 2, 1, "the full lane's model"),

  // Render: the doodle look.
  K("render.roughness", 1.2, 0, 3, 0.1, "how wobbly outlines are"),
  K("render.strokeWidth", 1.6, 0.5, 4, 0.1, "outline width", "px"),
  K("render.fadeOpacity", 0.7, 0, 1, 0.05, "at fade 1, a picture loses this much opacity"),
  K("render.textPadPx", 16, 0, 40, 1, "text keeps at least this far from a shape's edge", "px"),
  K("render.lineHeight", 1.25, 1, 2, 0.05, "line height as a multiple of text size"),

  // One switch per patched model: 0 (default) uses the model as it comes, 1 applies our patches on it.
  B("patches.scribe", 0, "scribe patches", "on: apply our patches (⚙) on Scribe's output; off: Scribe as it comes"),
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

/** Whether our patches on this model are on. */
export const patching = (t: Tuning, model: string) => t[`patches.${model}`] === 1;

/**
 * A knob's value as it should be used: for a patch whose model's patches are
 * off, its neutral value, or undefined when it shouldn't be sent at all.
 */
export function patchValue(t: Tuning, key: string): number | undefined {
  const k = KNOBS.find((x) => x.key === key);
  if (!k) throw new Error(`unknown knob "${key}"`);
  return !k.patches || patching(t, k.patches) ? t[key] : k.neutral;
}
