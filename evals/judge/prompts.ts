// The judges' frozen prompts (spec §4.3). Each role's rendered template goes into its
// judgeId (judge.ts), so editing a word here starts a new era. Fidelity and craft have two
// frozen variants, so a failed calibration (§4.5) has a fallback instead of an owner rewrite.
// There is no session judge: G4's session pairs are continuation forks judged per send.
// The first line of each user text (which image is which) is ours: images come before the text.

/** What a judge is told about the step: the harness-built transcript, never the arm's own linking. */
export type StepView = { said: string; meant: string; hedged: boolean; targetParts?: string };
export type ExpectationView = { should: string[]; mustNot: string[] };
export type Variant = 1 | 2;

export const SYSTEM =
  "You judge one step of a person using rt-draw: they talk and scribble red ink on a board of hand-drawn web-page wireframes, press Enter, and the tool edits the board. " +
  "Wireframes are sketchy on purpose: sections are boxes, pictures are quick doodles, text is a hand-drawn font. The red ink is the person's own marks and is never part of the page. " +
  "Judge only this step's ask, not the whole page.";

const INK = "[ink n] in what they said is the red mark numbered [n] in the before image.";
const meant = (s: StepView) => `${s.meant}${s.hedged ? "; they were unsure" : ""}`;
const list = (xs: string[]) => (xs.length ? xs.join(" / ") : "nothing");
const expected = (e: ExpectationView) => `A good result, written before any result was seen: should ${list(e.should)}; must not ${list(e.mustNot)}.`;
const VERDICT = '{"winner": "left"|"right"|"tie", "confidence": 1|2|3, "why": "one line"}';
const RULES =
  "Rules: (1) What they meant decides; words and ink are how they said it. (2) Doing more than asked is a fault: extra shapes, invented names or numbers, restyling what nobody pointed at, running ahead to parts not asked for. " +
  "(3) A result that changed nothing when they asked for a change loses. (4) If their words and ink allow two readings, doing the other plausible reading is a smaller fault than doing something unrelated. " +
  "(5) Ignore roughness, fonts and colours unless they asked about them. (6) Left and right are in random order. If both are equally right or equally wrong, say tie.";
const CRAFT_POINTS = "clear structure, readable text, aligned and consistent, pictures that read as what they show, nothing broken or overlapping by accident, and still a hand-drawn sketch, never a crisp mockup";

/** Expectation: the before image only, never a result. */
export const expectation = (s: StepView) =>
  `The image is the board when they pressed Enter, with their red ink. ${INK}\n` +
  `They said: "${s.said}". What they told us they meant: "${meant(s)}".` +
  (s.targetParts ? ` The site they have in mind, as context only: ${s.targetParts}. Parts they haven't asked for yet would be running ahead.` : "") +
  ' Before seeing any result, write what a good result of this step looks like. Reply with JSON only: {"should": [1-4 short lines of what should change], "mustNot": [1-2 short lines of what must not change]}';

/** Fidelity: before, left and right, with both change lists. */
export const fidelity: Record<Variant, (s: StepView, e: ExpectationView, changes: { left: string[]; right: string[] }) => string> = {
  1: (s, e, c) =>
    `The images are, in order: the board before with their red ink, the left result, the right result. ${INK}\n` +
    `They said: "${s.said}". They meant: "${meant(s)}". ${expected(e)} Left changed: ${list(c.left)}. Right changed: ${list(c.right)}. ` +
    `Which result does what they meant in this step, better? ${RULES} Reply with JSON only: ${VERDICT}`,
  2: (s, e, c) =>
    `The images are, in order: the board before with their red ink, the left result, the right result. ${INK}\n` +
    `They said: "${s.said}". They meant: "${meant(s)}". ${expected(e)} Left changed: ${list(c.left)}. Right changed: ${list(c.right)}. ` +
    `First, for each side separately: did it do what they meant in this step (yes, partly or no)? Then: which result does it better? ${RULES} ` +
    'Reply with JSON only: {"left": "yes"|"partly"|"no", "right": "yes"|"partly"|"no", "winner": "left"|"right"|"tie", "confidence": 1|2|3, "why": "one line"}',
};

/** Craft: the two after images only, no words. */
export const craft: Record<Variant, () => string> = {
  1: () => `The images are, in order: the left page, the right page.\nIgnore what was asked. Which page is the better wireframe: ${CRAFT_POINTS}? Tie if equal. Reply with JSON only: ${VERDICT}`,
  2: () =>
    `The images are, in order: the left page, the right page.\nIgnore what was asked. For each page separately, which of these does it fail: ${CRAFT_POINTS}? ` +
    'Then: which page is the better wireframe? Tie if equal. Reply with JSON only: {"left": "the points it fails, or none", "right": "the points it fails, or none", "winner": "left"|"right"|"tie", "confidence": 1|2|3, "why": "one line"}',
};

/** Miss check: before and the champion's after; feeds only the champion-miss digest, never a decision. */
export const miss = (s: StepView, e: ExpectationView, changes: string[]) =>
  `The images are, in order: the board before with their red ink, the result. ${INK}\n` +
  `They said: "${s.said}". They meant: "${meant(s)}". ${expected(e)} What changed: ${list(changes)}. Did this result do what they meant in this step? ` +
  'Judge with the same rules: doing more than asked is a fault, changing nothing when they asked for a change is a miss. Reply with JSON only: {"met": "yes"|"partly"|"no", "why": "one line"}';

/** Each role's text with placeholders, as its judgeId hashes it. */
export function template(role: "expectation" | "fidelity" | "craft" | "miss", v: Variant = 1): string {
  const s: StepView = { said: "«said»", meant: "«meant»", hedged: true, targetParts: "«parts»" };
  const e = { should: ["«should»"], mustNot: ["«mustNot»"] };
  const text = { expectation: () => expectation(s), fidelity: () => fidelity[v](s, e, { left: ["«left»"], right: ["«right»"] }), craft: () => craft[v](), miss: () => miss(s, e, ["«changes»"]) }[role]();
  return `${SYSTEM}\n${text}`;
}
