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
import { PROMPTS, PROMPT_KNOB } from "./prompts.ts";

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
const P = (role: keyof typeof PROMPTS, value = 0): Knob => K(PROMPT_KNOB[role], value, 0, PROMPTS[role].length - 1, 1, `which ${role} prompt text is sent: ${PROMPTS[role].map((v, i) => `${i} ${v.name}`).join(", ")} (src/core/prompts.ts)`);

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
  K("ops.minDescriptionWords", 6, 1, 30, 1, "an edit's description shorter than this keeps the one the shape had (a new shape keeps it anyway)"),
  K("ops.cellPx", 40, 10, 120, 5, "grid cell size for boxes written as cells (C2-J7)", "px"),
  B("ops.waitForShape", 1, "ops wait for their shape", "on: an op naming a shape a later line makes waits for that line, and fails only if the reply ends without it; off: it fails at once"),

  B("ops.earlyAtBox", 1, "paint a shape once its box is closed", "on: a streaming shape() line is applied as a provisional new shape as soon as the comma after its id, kind and box arrives (the description quote need not be open), and each later closed style arg reapplies it in place; the finished line replaces it, a line that fails or is cut off takes it away"),
  B("ops.earlyShape", 1, "paint a shape before its description", "on: a streaming shape() line whose id, kind, box and styles are complete and whose description quote is still open is applied as a provisional new shape and painted; the finished line replaces it, a line that fails or is cut off takes it away (best with the style-first draw prompt, which writes the description last)"),

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
  K("shot.inkNumberGapPx", 6, 0, 40, 1, "the [n] sits this far beyond an arrow's tail, or up and right of another mark's top-right-most ink", "px"),
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
  B("resolve.noThink", 1, "no thinking", "on: ask the API not to think (it thinks on nearly every resolver call, which delays its first text); off: the model decides"),
  // Jev (TypeSafe AI's decision model): one yes/no per candidate shape in a single call of about 0.1 s, each a probability.
  K("resolve.engine", 1, 0, 2, 1, "who resolves: 0 Claude (resolve.model), 1 Jev alone, 2 Jev, and Claude when Jev is unsure of a shape (resolve.jevSure)"),
  K("resolve.jevModel", 0, 0, 1, 1, "Jev version (0 jev-1.13.0, pinned; 1 jev-latest)"),
  K("resolve.jevMaxCandidates", 8, 1, 40, 1, "shapes Jev is asked about (each one more yes/no in the same call): the ink's hits first, then by word overlap, then every page"),
  K("resolve.jevYes", 0.5, 0.05, 0.95, 0.05, "Jev: a shape is meant at or above this probability"),
  K("resolve.jevSure", 0.3, 0, 0.5, 0.05, "engine 2: Jev is unsure when a shape's probability is within this of resolve.jevYes, and then Claude resolves (0: Jev always decides)"),
  B("resolve.jevRace", 0, "race Claude", "engine 2: on: ask Claude at the same time as Jev and use its answer only when Jev is unsure (no wait for Claude after Jev, but a Claude call every send); off: ask Claude only once Jev is unsure"),
  B("resolve.jevHints", 1, "unsure shapes as hints", "on: when Jev decided, the drawing model also gets the shapes it was unsure of, with how likely each is (at least resolve.jevHintMin)"),
  K("resolve.jevHintMin", 0.2, 0.05, 0.9, 0.05, "the least probability a hint shape has"),
  P("resolveJev"),
  B("resolve.speculate", 1, "draw on a guess", "on: Jev guesses the references in about 0.1 s and the drawing call starts on that guess, its ops held back; the resolver still answers, and the guess's drawing lands only when the resolver's answer gives exactly the same prompt (else it's dropped and drawing starts again on the answer, as with this off). A right guess saves the resolver's wait; the references are sent as ids alone, so a guess can match"),

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
  P("draw", 2),
  B("draw.noThink", 0, "no thinking", "on: ask the API not to think (thinking delays the first op); off: the model decides"),
  B("draw.thinkRouter", 1, "Jev decides thinking", "on: Jev decides per send whether the drawing model may think (one call of about 0.1 s, alongside the resolver): a small clear edit goes without thinking; off: draw.noThink decides"),
  K("draw.thinkYes", 0.9, 0.05, 0.95, 0.05, "with draw.thinkRouter: the drawing model may think when Jev's probability that the send needs it is at or above this"),
  K("draw.thinkJevModel", 0, 0, 1, 1, "with draw.thinkRouter: the Jev version (0 jev-1.13.0, 1 jev-latest)"),
  B("draw.addHint", 1, "short-description warning on add asks", "on: Jev answers beside the resolver whether the person asks for something new to be added or built, and on yes the drawing model's user text (never its system prompt) ends with a line that every shape() description needs at least 6 words; a failed or late Jev call leaves the text unchanged"),
  K("draw.addYes", 0.5, 0.05, 0.95, 0.05, "with draw.addHint: the line is added when Jev's probability that the send asks for something new is at or above this"),
  K("draw.addWaitMs", 1500, 100, 5000, 100, "with draw.addHint: Jev's answer later than this is dropped (no line)", "ms"),
  K("draw.copies", 1, 1, 3, 1, "copies of the drawing call sent at once: the API's wait before the first text varies from call to call, so the first copy to stream is kept and the others are dropped (each copy pays its input)"),
  K("draw.copyAfterMs", 0, 0, 3000, 100, "with draw.copies above 1: a copy after the first goes out only when no text has come this long (0: all at once)", "ms"),
  P("drawThink"),
  B("draw.fillPictures", 1, "fill pictures", "on: the picture model draws every new or changed picture (one call each), each starting as its drawing() op lands, before the send is done; off: pictures stay placeholders"),

  // Picture: a doodle inside a shape.
  K("picture.model", 1, 0, 2, 1, "model that draws pictures (0 haiku, 1 sonnet, 2 opus)"),
  K("picture.maxPaths", 0, 0, 80, 1, "a picture may use at most this many elements (0: as many as it needs)"),
  K("picture.colors", 0, 0, 10, 1, "and at most this many colors (0: as many as it needs)"),
  K("picture.roughness", 1.4, 0, 3, 0.1, "wobble applied to the doodle's paths"),
  K("picture.parallel", 3, 1, 8, 1, "pictures drawn at the same time after a send"),
  K("picture.fill", 0.9, 0.5, 1, 0.05, "a picture fills this share of its shape"),
  K("picture.timeoutMs", 120000, 5000, 300000, 5000, "a picture call still going after this long is stopped and counts as failed (its shape stays a placeholder)", "ms"),
  K("picture.copies", 1, 1, 3, 1, "copies of each picture call sent at once: the first to stream is kept, the others are dropped (each copy pays its input)"),
  K("picture.copyAfterMs", 0, 0, 3000, 100, "with picture.copies above 1: a copy after the first goes out only when no text has come this long (0: all at once)", "ms"),
  P("picture", 3),
  K("picture.context", 2, 0, 2, 1, "what the picture model sees besides its subject: 0 nothing, 1 what they said and the colors of the board's shapes, 2 also their sketches inside the shape's box"),
  K("picture.contextColors", 8, 1, 20, 1, "with picture.context: the board's most-used shape colors it lists"),
  K("picture.contextPoints", 300, 20, 2000, 10, "with picture.context 2: the sketches in the box are given in at most about this many points in all"),
  K("picture.strokeWidth", 3, 1, 6, 0.5, "with the short-stroke or matched picture prompt: the outline width every element has unless it says its own stroke-width", "px"),
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
  K("render.captionMaxShare", 0.4, 0.1, 0.8, 0.05, "words on a shape with a picture go under it, as a caption at most this share of its height"),
  K("render.minTextScale", 0.4, 0.1, 1, 0.05, "text too big for its box shrinks to fit, down to this share of its size (and never below 8px)"),
  B("render.pictureBox", 1, "bare picture boxes", "on: a shape with a picture paints no outline or fill unless it's given one, and its picture fills it; off: every shape has its outline"),

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
