// How each model role is asked: its prompt texts as named variants, and whether it
// may think. A prompt change is then a knob change (<role>.prompt picks the variant,
// <role>.noThink turns thinking off) that the loop can A/B like any other, not an
// edit hidden in code. Variant 0 is always the text the product shipped with.
import type { Tuning } from "./tuning.ts";

type DrawText = { name: string; system: (board: boolean, w: number, h: number, cell: number, pageW: number) => string };
type ResolveText = { name: string; system: string };
/** Describe has two system prompts: all shapes in one call (describe.batch), or one per call. {min} and {max} are its word limits. */
type DescribeText = { name: string; batch: string; one: string };
type PictureText = { name: string; system: (t: Tuning) => string; user: (subject: string, w: number, h: number, t: Tuning) => string };
/** Jev as the resolver (resolve.engine): the task goes in its state with the resolver's own text; one yes/no per candidate shape. */
type ResolveJevText = { name: string; task: string; question: (shapeLine: string) => string; yes: string; no: string };
/** Jev deciding whether the drawing model thinks on this send (draw.thinkRouter). */
type DrawThinkText = { name: string; question: string; yes: string; no: string };

/** The op manual, short on purpose: v1's long manual is not carried over. On a board it speaks of board pixels, pages and the camera. */
function drawShipped(board: boolean, w: number, h: number, cell: number, pageW: number): string {
  return drawManual(board, w, h, cell, pageW, false);
}

/**
 * The manual with illustrations (LOOP-V2.md B2, B4, C1): the illustration() op for a subject drawn as one picture, a
 * picture's box unseen unless styled, detail matched to the ask, and a color example that isn't the person's red pen.
 */
function drawIllustrated(board: boolean, w: number, h: number, cell: number, pageW: number): string {
  return drawManual(board, w, h, cell, pageW, true);
}

function drawManual(board: boolean, w: number, h: number, cell: number, pageW: number, illustrated: boolean): string {
  const intro = board
    ? "You edit an infinite board of web pages and app screens, in board pixels (x right, y down). A page is a frame shape: its text is its name, shown above it, and the shapes inside its box are its content."
    : `You edit a drawing canvas of ${w}×${h} pixels (x right, y down, origin top-left).`;
  const cells = !board && cell > 0 ? `, or grid cells like C2-J7 (bare) as labeled on the screenshot (${cell} px cells, columns A, B, ... rows 1, 2, ...)` : "";
  return `${intro} Shapes sit in layers like a slide; nothing is laid out for you: a shape is drawn exactly where its box says.

Reply ONLY with op lines, one per line: no prose, no code fences. Each line is applied the moment it is complete, so put the most visible change first.

shape(id, kind, box, "description", style...)   add a shape, or change only what you give
text(id, "words", size:s|m|l|xl, color:..., align:left|center|right, weight:bold)
${illustrated ? `illustration(id, box, "what it shows")   a picture on its own: a subject, a scene, a sketch made real
drawing(id, "what the picture shows", fade:0-1)  a picture inside a shape (a photo on a card); the shape's box is unseen unless you give it a fill or stroke` : `drawing(id, "what the picture shows", fade:0-1)  a doodle picture inside a shape`}
layer(id, front | back | above:other | below:other)
move(id, box)      remove(id)      group(id, [a, b, ...])${board ? `
camera(x y w h) or camera(id, ...)   move the screen: to where they ask to look ("zoom out", "show me the cart"), or, as your last line, onto what you made if it's off screen` : ""}

kind: rect, round, circle, pill, line, arrow (line and arrow run from the box's top-left to its bottom-right)${board ? `, frame (a page, ${pageW} wide for a website, or sized to fit whatever they ask for: a phone screen, a desktop, a diagram. An empty page is theirs to use: draw on it, resizing it to fit, rather than adding another beside it. Put a new one anywhere beside the others without overlapping them; the board moves pages into place after you finish. A frame is only ever a whole page: a strip, panel or card on a page is a rect)` : ""}.
box: x y w h in ${board ? "board" : "canvas"} pixels${cells}, written bare, never in quotes. Quotes are only for descriptions and words.
${illustrated ? `Example: shape(sale-badge, pill, 1100 90 150 50, "small yellow pill badge in the top right corner announcing a toy sale", fill:#ffd43b, stroke:none)` : `Example: shape(sale-badge, pill, 1100 90 150 50, "small red pill badge in the top right corner announcing a toy sale", fill:#e03131, stroke:none)`}
style: fill:#hex  stroke:#hex|none  opacity:0-1  fade:0-1 (dims the picture, not the box).${board ? `
Clicks: give link:<page id> (the id in [brackets] in the site map) to anything that opens another page (nav items, buttons, cards, a logo that goes home), and button:yes to anything else a visitor would click; link:none and button:no undo them. Never draw arrows between pages: the board draws them from the links. Aim the camera at a page by its id: camera(contact).` : ""}
Ids are short readable names (hero-title, toy-l2). The same id changes that shape: never re-create an existing shape under a new id.
A NEW shape needs a box and a description of at least 6 words saying what it is and what it's for. Later sends find shapes by these descriptions.
Order: a shape() always comes before any text(), drawing() or move() on its id, and a text() only targets a shape that already exists (a new id never gets a bare text(): shape it first). Put each drawing() on the line right after its shape(), before the page's text and chrome, so pictures can start drawing while you are still writing.${illustrated ? `
Draw a subject they ask for (an animal, a person, an object, a scene) as one illustration(), early in your reply, rather than assembling it from boxes and circles, and never let a plain box stand in for it. Match the detail to what they ask: a sketch or an icon stays simple, and real detail comes only when they ask for it. When they ask to turn their sketch into something real, put the illustration() where the sketch is.` : ""}

The user's words carry [ink n] markers: n is the red ink mark labeled [n] in the ${board ? "pictures" : "screenshot"}, drawn while they said that word. Their ink points at things or sketches a shape and place; it is never part of the page, so don't copy it unless they ask you to draw what they sketched. If the request is unclear, make the most likely change.`;
}

const RESOLVE_SHIPPED = `You work out which shapes on a canvas a person means.
You get: the shapes that could be meant (id, kind, box as x y w h in pixels, and a description), what the person said with [ink n] at the moment they drew mark n, and what each mark is (a loop around shapes, an arrow from one place to another, a tap on a shape, a line).
Return only JSON, no prose: {"refs": [{"phrase": "this headline", "ids": ["hero-title"]}]}
One entry per phrase that refers to shapes on the canvas ("this", "that one", "the photo", "these three", "over there"), with every id it means. Use only ids from the list. Ink settles which one; words settle how many and what kind. Leave out phrases that refer to nothing on the canvas.
On a board of pages (frames), a phrase about a whole page ("the shop page", "where you pay", "the other page") means its frame id, and a part of a page means that part's id.`;

// Jev's resolver questions. "scratch-v2" is the wording tested on 207 recorded resolver calls (2026-10-18): it gave
// the same set as Haiku on 57% (Haiku repeats its own set on 77%), with 89% of the per-shape answers the same.
const RESOLVE_JEV_YES = 'A phrase they said or an ink mark they drew means this very shape: something to change, remove, copy, or place new things next to. A plural phrase ("the tabs", "these three") means every shape it covers, so each of those is yes.';
const RESOLVE_JEV_NO = "Nothing they said or drew means this shape itself: they ask for something new, or the shape only contains, surrounds or sits near what they mean (the page around a part they name, the card around a button they name).";
const RESOLVE_JEV_TASK = `You decide which shapes on a canvas a person means.
The request lists the shapes that could be meant (id, kind, box as x y w h in pixels, and a description), what the person said with [ink n] at the moment they drew mark n, and what each mark is (a loop around shapes, an arrow from one place to another, a tap on a shape, a line).
Ink settles which one; words settle how many and what kind. A phrase that refers to nothing on the canvas means no shape.
On a board of pages (frames), a phrase about a whole page ("the shop page", "where you pay", "the other page") means its frame, and a part of a page means that part.`;

const DESCRIBE_BATCH = `You write the id map for a hand-drawn wireframe. Each shape on the page has an id; people later point at shapes by saying things like "the photo of me" or "that button", and your descriptions are how their words find the right id.

You get the whole page first (shapes carry small orange id tags), then one crop per shape, each announced by its number and id.

For every id write one description: what the shape is (and what it shows or says), what it's for, and where it sits relative to its neighbours. Between {min} and {max} words. Plain words, no markdown, no quotes around names.

Example: "round photo of the owner dressed as a clown, top of the main column; the headline sits over it"

Reply with only a JSON object mapping each id to its description, nothing else.`;

const DESCRIBE_ONE = `You write one entry of the id map for a hand-drawn wireframe. People later point at shapes by saying things like "the photo of me" or "that button", and your description is how their words find this shape.

You get the whole page first (shapes carry small orange id tags), then the crop of one shape and its id.

Write one description: what the shape is (and what it shows or says), what it's for, and where it sits relative to its neighbours. Between {min} and {max} words. Plain words, no markdown.

Example: "round photo of the owner dressed as a clown, top of the main column; the headline sits over it"

Reply with only a JSON object: {"<id>": "<description>"}.`;

const PICTURE_SYSTEM = "You draw small, charming doodles as SVG elements. Output only the elements, one per line: no prose, no code fences, no <svg> wrapper.";
const PICTURE_LOOK = `Like a quick, cute marker sketch in a notebook: a recognizable silhouette, simple shapes, flat colors, no text, no background, no shading.
It must hold together: draw the biggest shape first (the body), then attach every other part so it overlaps or touches what it belongs to. Nothing floats.`;
/** The element and color limits, as the knobs set them: picture.maxPaths and picture.colors at 0 cap nothing (the owner, LOOP-V2.md B1). */
const limits = (t: Tuning) =>
  t["picture.maxPaths"] || t["picture.colors"]
    ? `At most ${t["picture.maxPaths"] || "any number of"} elements and ${t["picture.colors"] || "any number of"} colors`
    : "As many elements and colors as the subject needs, and no more";
const pictureRules = (t: Tuning) => `Use only these elements, each on its own line and self-closing: <path d="..."/>, <circle/>, <ellipse/>, <rect/>, <line/>, <polyline/>, <polygon/>.
Attributes: geometry, fill, stroke, stroke-width. Absolute coordinates, no transforms, no groups, no style attribute.
${limits(t)} (hex, like #e8590c; fill="none" for outlines). Outlines in near-black #1e1e1e, stroke-width 2 to 4.
Example (a smiling sun in a 100 x 100 box):
<circle cx="50" cy="50" r="28" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>
<path d="M38 56 Q50 66 62 56" fill="none" stroke="#1e1e1e" stroke-width="3"/>`;

// The matched variant's look: detail as the subject asks for it, not always a quick doodle (the owner, LOOP-V2.md B1).
const PICTURE_MATCHED = `Match the detail to what was asked. A sketch, icon or doodle stays simple: a bold, recognizable silhouette in a few flat shapes. When the subject asks for more (detailed, realistic, high fidelity), give it real detail: more parts, layered flat tones for light and shadow, texture lines; tone, shadow and texture layers take stroke="none", so only the outer shapes are outlined.
Either way it must hold together: draw the biggest shapes first, then attach every part so it overlaps or touches what it belongs to. Nothing floats. No text unless the subject asks for words; no background unless the subject is a scene.`;

// The short-stroke variant: every element is already outlined in #1e1e1e at the default width, so the model writes stroke and stroke-width only when they differ.
const pictureRulesShort = (t: Tuning) => `Use only these elements, each on its own line and self-closing: <path d="..."/>, <circle/>, <ellipse/>, <rect/>, <line/>, <polyline/>, <polygon/>.
Attributes: geometry, fill, stroke, stroke-width. Absolute coordinates, no transforms, no groups, no style attribute.
${limits(t)} (hex, like #e8590c; fill="none" for outlines).
Every element is outlined in near-black #1e1e1e at stroke-width ${t["picture.strokeWidth"]} unless it says otherwise, so leave out stroke and stroke-width when they are those. Write stroke="none" on a fill-only detail (a pupil, a highlight), or another stroke color or stroke-width where you want one.
Example (a smiling sun in a 100 x 100 box):
<circle cx="50" cy="50" r="28" fill="#ffd43b"/>
<path d="M38 56 Q50 66 62 56" fill="none"/>
<circle cx="42" cy="44" r="3" fill="#1e1e1e" stroke="none"/>`;

export const PROMPTS: { draw: DrawText[]; resolve: ResolveText[]; describe: DescribeText[]; picture: PictureText[]; resolveJev: ResolveJevText[]; drawThink: DrawThinkText[] } = {
  draw: [
    { name: "shipped", system: drawShipped },
    { name: "illustrated", system: drawIllustrated },
  ],
  resolve: [{ name: "shipped", system: RESOLVE_SHIPPED }],
  resolveJev: [
    { name: "scratch-v2", task: RESOLVE_SHIPPED, question: (line) => `Do their words or ink refer to this existing shape: ${line}?`, yes: RESOLVE_JEV_YES, no: RESOLVE_JEV_NO },
    // The task without Claude's JSON reply format, which Jev has no use for (untested).
    { name: "task-only", task: RESOLVE_JEV_TASK, question: (line) => `Do their words or ink refer to this existing shape: ${line}?`, yes: RESOLVE_JEV_YES, no: RESOLVE_JEV_NO },
  ],
  drawThink: [
    {
      name: "shipped",
      question: "Does drawing what they ask need the drawing model to think it through before it writes ops?",
      yes: "A new screen, page or layout, several changes at once, a sketch to interpret, or a vague request (\"make it pop\") that needs a plan first.",
      no: "One small, clear change to shapes that already exist: move, remove, recolor, resize, rename, or change text.",
    },
  ],
  describe: [{ name: "shipped", batch: DESCRIBE_BATCH, one: DESCRIBE_ONE }],
  picture: [
    {
      name: "shipped",
      system: () => PICTURE_SYSTEM,
      user: (subject, w, h, t) => `Doodle: ${subject}

${PICTURE_LOOK}
The box is ${w} wide and ${h} tall (x right, y down, 0 0 at the top left). Fill most of it, centered, and keep everything inside it.
${pictureRules(t)}`,
    },
    // The fixed instructions in the system prompt, where they're cached across pictures (seed card 3); only the subject and box vary.
    {
      name: "rules-in-system",
      system: (t) => `${PICTURE_SYSTEM}

${PICTURE_LOOK}
Each message gives the box (x right, y down, 0 0 at the top left). Fill most of it, centered, and keep everything inside it.
${pictureRules(t)}`,
      user: (subject, w, h) => `Doodle: ${subject}
The box is ${w} wide and ${h} tall.`,
    },
    // Shipped layout, but outlines are the default: the model leaves out stroke="#1e1e1e" stroke-width and the renderer supplies them (picture.ts).
    {
      name: "short-stroke",
      system: () => PICTURE_SYSTEM,
      user: (subject, w, h, t) => `Doodle: ${subject}

${PICTURE_LOOK}
The box is ${w} wide and ${h} tall (x right, y down, 0 0 at the top left). Fill most of it, centered, and keep everything inside it.
${pictureRulesShort(t)}`,
    },
    // Short-stroke's rules with detail matched to the ask: a sketch stays simple, a detailed or realistic subject gets detail.
    {
      name: "matched",
      system: () => "You draw pictures as SVG elements. Output only the elements, one per line: no prose, no code fences, no <svg> wrapper.",
      user: (subject, w, h, t) => `Picture: ${subject}

${PICTURE_MATCHED}
The box is ${w} wide and ${h} tall (x right, y down, 0 0 at the top left). Fill it, and keep everything inside it.
${pictureRulesShort(t)}`,
    },
  ],
};

/** Jev's question for draw.addHint (does the send ask for something new?), and the line the drawing model's user text gets on yes (never its system prompt). */
export const DRAW_ADD = {
  question: "Do they ask for something new to be added or built?",
  yes: "They want a new page, section, card, button, list, label or any other shape that is not on the canvas yet, drawn or built for them.",
  no: "They only change, move, remove, recolor, resize, rename or look at shapes that already exist.",
  line: 'Every shape() description is at least 6 words (count them): it is how the shape is found when they point at it later. For a name, price, label or button write e.g. "starter plan price line near top of card".',
};

export type Role = keyof typeof PROMPTS;

/** Each role's prompt knob: <role>.prompt, except Jev's questions, which belong to the part that asks them. */
export const PROMPT_KNOB: Record<Role, string> = { draw: "draw.prompt", resolve: "resolve.prompt", describe: "describe.prompt", picture: "picture.prompt", resolveJev: "resolve.jevPrompt", drawThink: "draw.thinkPrompt" };

/** The variant a tuning picks for a role (its prompt knob, clamped to the variants there are). */
export function promptOf<R extends Role>(role: R, t: Tuning): (typeof PROMPTS)[R][number] {
  const list = PROMPTS[role];
  return list[Math.max(0, Math.min(list.length - 1, Math.round(t[PROMPT_KNOB[role]] ?? 0)))];
}

/** A role's thinking from its <role>.noThink knob: off, or unset (the model's own choice, so the request is today's). */
export const thinkingOf = (role: "draw" | "resolve" | "picture", t: Tuning): { thinking?: "off" } => (t[`${role}.noThink`] ? { thinking: "off" } : {});
