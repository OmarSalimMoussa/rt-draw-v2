// Intake's two Opus prompts (evals/real/README.md): triage reads a whole session and says, for each new send, what
// the person meant and whether it landed; gold draws what a send should have made. A change here labels new sends
// only: what was already triaged or drawn keeps its labels (the owner's verdicts were given on them).
import { SCREEN } from "../../src/core/board.ts";
import { promptOf } from "../../src/core/prompts.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";
import { CHECK_MENU } from "./checks.ts";
import type { RealSend, Session } from "./sessions.ts";

/** Failure kinds seen so far; triage may add one, in a few words, as other:<words>. */
export const CATEGORIES: Record<string, string> = {
  "boxy-subject": "a creature, person, plant, object or scene built from boxes, circles and lines that doesn't read as what they asked for: parts floating apart, a plain box standing in for a body",
  "low-detail": "they asked for more detail or high fidelity and got a simple doodle, or no visible change",
  "split-subject": "one subject drawn as several separate pictures (head, body, legs...) that don't line up",
  "shape-shows-through": "the shape a picture sits on shows behind or around it: a white box, a colored disc, an outline, an old shape",
  "squashed-picture": "a picture squeezed into a box of the wrong shape, or with things added that weren't asked for",
  "pen-color": "the red of the person's pen copied into the drawing as its color",
  "cut-off": "the drawing or its pictures stopped partway, or a picture came out empty",
  "missing-part": "parts they asked for weren't drawn",
  "wrong-target": "it changed something other than what they pointed at or named",
  "empty-page": "it made a page or screen without the content they asked for",
  "ignored": "it changed nothing, or only moved the camera, when they asked for a change",
};

export const TRIAGE_SYSTEM = `You review sessions of imagine, an app where people talk and draw and an AI sketches what they mean on an infinite board: websites, phone apps, desktops, diagrams, drawings. People type or speak a request and may draw red ink on the board while they talk ([ink n] in their words marks the moment they drew mark n). After each send the board changes and they react with their next send.

You see one session in order: for each send, its words, how the app read their ink, the board before and the board after. Where a later send exists you also see what they did next, which is the best evidence of what they meant: a correction ("no, the other button"), a complaint ("that doesn't look like a cat at all"), an undo, a restore, written feedback. The session's last send has none: judge it on its own.

For every send, decide:
- meant: what the person wanted, in one plain sentence, using the whole session (later corrections reveal what an earlier send meant).
- landed: "yes" if the result is what they meant and good enough to keep, "partly" if it's in the right direction but clearly lacking, "no" if it missed.
- categories: the failure kinds that apply, from this list, or other:<a few words> (none when landed is yes):
${Object.entries(CATEGORIES).map(([k, v]) => `  ${k}: ${v}`).join("\n")}
- evidence: what shows it, quoting their words or describing what's on the board.
- gold: true when the send is a clear failure with a clear intent, so a good result could be drawn for it; false when what they meant is unclear, or the failure is outside drawing (a stop, a network error).
- drawing: true when they asked for something to be drawn or changed on the board (a page, a shape, a picture, an edit, a move); false when they didn't: only a camera move ("zoom out", "show me the home page"), a question, a test, or a send stopped or failed before it asked for anything.

Judge the result as the person would. How a subject is built doesn't matter; whether it reads as what they asked for does. Shapes that come apart, a plain box where a body should be, or a stand-in nobody would recognize is a miss. A simple drawing that looks complete on its own is good enough when they asked for a sketch or a doodle: more detail is only wanted when they ask for it (detailed, realistic, high fidelity).

Reply with JSON only: {"sends": [{"n": 1, "meant": "...", "landed": "yes|partly|no", "categories": [], "evidence": "...", "gold": false, "drawing": true}, ...]}`;

/** Send numbers as runs: 3, 5 to 7. */
const runs = (ns: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j > i ? `${ns[i]} to ${ns[j]}` : `${ns[i]}`);
    i = j;
  }
  return out.join(", ");
};

/**
 * The session as text blocks, for the sends at `judged` (0-based, in order) to be judged: those have images (all the
 * images come first, two per judged send: before, after); the others are only words, as context.
 */
export function triageTurns(s: Session, judged: number[]): string[] {
  const head = `Session ${s.id}: project "${s.project.name}", ${s.sends.length} sends${s.restores.length ? `; restores: ${s.restores.map((r) => `${r.label} at ${r.at}`).join(", ")}` : ""}${s.feedback.length ? `; written feedback: ${s.feedback.map((f) => `"${f.text}" (on version ${f.version ?? "?"})`).join("; ")}` : ""}.`;
  const which = judged.length === s.sends.length ? "Judge every send." : `Judge send${judged.length > 1 ? "s" : ""} ${runs(judged.map((i) => i + 1))} only; the others are here as context.`;
  return [`${head} ${which}`, ...s.sends.map((x, i) => sendText(x, i + 1, judged.includes(i) ? 2 * judged.indexOf(i) + 1 : undefined))];
}
const said = (x: RealSend) => (typeof x.words === "string" ? x.words : x.label);
const sendText = (x: RealSend, n: number, image?: number) =>
  `Send ${n} at ${x.at}${x.kind === "build" ? " (a click in the preview that builds the page it leads to)" : ""}: ${JSON.stringify(said(x) || "(nothing said)")}` +
  (x.marks.length ? `\nInk, as the app read it: ${x.marks.join("; ")}` : "") +
  (x.refs ? `\nWhat the app took them to mean: ${x.refs}` : "") +
  (x.pictures.length ? `\nPictures it asked for: ${x.pictures.map((p) => `"${p.subject}" in ${p.w}×${p.h} (${p.elements} elements)`).join("; ")}` : "") +
  (x.error ? `\nIt failed: ${x.error}` : x.status && x.status !== "done" ? `\nIt ended: ${x.status}` : "") +
  (x.replay === "ink" && !x.strokes.length ? "\nTheir ink wasn't saved: the images don't show it, only the reading above does." : "") +
  (x.before === x.after ? "\nThe board didn't change." : "") +
  (image ? `\nImages ${image} and ${image + 1}: the board before, then after.` : "");

/** The product's own op manual: gold speaks the language the drawing model speaks. */
const manual = () => promptOf("draw", DEFAULTS).system(true, 1280, 800, 0, SCREEN.w);

export const GOLD_SYSTEM = () => `You are the best possible version of imagine's drawing model. A real person used imagine and the result missed; you draw what should have happened, as the target the app will be tested against.

This is the app's own manual for its drawing model; you write the same op lines:
-----
${manual()}
-----

You get the board before the send (with the person's red ink on it, numbered, when they drew), their words, what the session shows they meant, and why the app's result missed. Write the ops that turn the before board into what they meant, then draw every picture yourself.

Rules for the result:
- A creature, person, plant, food, vehicle, object or scene is ONE drawing() on one shape sized to the subject's natural proportions, with fill:none and stroke:none: never built from circles, rectangles and lines. Its parts are in the picture.
- To redo or improve a subject, remove() every shape it was made of and make one new drawing() covering them.
- The red ink is the person's pen, never a color for the drawing; take colors from the board and the subject.
- Keep everything they didn't ask to change exactly as it is.
- Match the detail to what they asked for, never more. "A sketch" or "a drawing" stays simple and clean, about 10 to 25 elements: it only has to read clearly as the subject. Real detail (texture, shading, many parts) only when they ask for it: detailed, realistic, high fidelity. Over-drawing is a fault: it isn't what they asked for, and a bigger picture takes longer to draw.

Pictures: after the ops, give each drawing() its picture as SVG elements in the shape's own box (0 0 at its top-left, x right, y down, the shape's w × h), one element per line, self-closing, from <path/>, <circle/>, <ellipse/>, <rect/>, <line/>, <polyline/>, <polygon/>, with fill, stroke and stroke-width, absolute coordinates, no transforms or groups. Draw it the way a skilled illustrator sketches in marker: outlined in near-black, clear silhouette, exactly as much detail as they asked for (high fidelity means real detail: fur, stripes, folds, shading in a second tone; a quick sketch stays a few strokes).

Then the rubric: what any good result for this send should and must not do, as a judge would check it against a result that is not yours (other good results exist), 2 to 5 of each, concrete and visible.

Then the free checks: code that checks a result's board, from this menu (pick the ones that apply, 0 to 4):
${CHECK_MENU}

Reply in exactly this shape, nothing else:
<ops>
...op lines...
</ops>
<picture id="shape-id">
...elements...
</picture>
(one <picture> per drawing())
<rubric>{"should": ["..."], "mustNot": ["..."]}</rubric>
<checks>[{"type": "..."}]</checks>
<why>two sentences: what they meant, and what in your result does it</why>`;

/** `before`: the before board as op lines (gold.ts' boardOps). */
export function goldUser(s: Session, x: RealSend, n: number, t: { meant: string; categories: string[]; evidence: string }, before: string): string {
  const later = s.sends.slice(n).slice(0, 4).map((y, i) => `send ${n + i + 1}: ${JSON.stringify(said(y))}`).join("\n");
  return `Project "${s.project.name}". The send (${n} of ${s.sends.length}): ${JSON.stringify(said(x) || "(nothing said)")}
${x.marks.length ? `Their ink, as the app read it: ${x.marks.join("; ")}\n` : ""}The board's screen when they sent it: ${x.camera ? `${x.camera.x} ${x.camera.y} ${x.camera.w} ${x.camera.h}` : "the whole first page"} (board pixels).
What they meant: ${t.meant}
Why the app's result missed (${t.categories.join(", ")}): ${t.evidence}
${later ? `What they said next:\n${later}\n` : ""}
The board before, as op lines (every shape that's on it):
${before}

Images: the board before${x.strokes.length ? " with their ink on it" : x.marks.length ? " (their ink wasn't saved: only the reading above says where it was)" : ""}, then the app's result.`;
}
