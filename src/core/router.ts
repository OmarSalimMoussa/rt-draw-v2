// Which lane a send takes: fast (a small model, no picture, for small edits to
// shapes that exist) or full (the drawing model with the screenshot). Rules
// only, no model in the routing itself: it runs in well under a millisecond,
// so the fast lane saves the whole wait of a big model when it applies.
import type { ModelName } from "./model.ts";
import { modelOf } from "./model.ts";
import type { Reading } from "./marks.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

/** What the router sees of a send: the words, each mark's reading, and how full the canvas is. */
export type Send = { words: string; marks: Pick<Reading, "kind" | "how">[]; sceneShapes: number };
export type Lane = "fast" | "full";
export type Route = { lane: Lane; model: ModelName; why: string; features: Record<string, number | string> };

/**
 * Small edits a small model can make from the id map alone. Each matches at
 * the start of a word, so "moved" and "deleting" count; "change text" also
 * matches "change the text".
 */
export const FAST_VERBS = ["move", "remove", "delete", "recolor", "rename", "bigger", "smaller", "bold", "change text"];
const verbPattern = (v: string) => new RegExp(`\\b${v.replace(" ", "( the)? ")}`, "i");
const VERB_RES = FAST_VERBS.map((v) => [v, verbPattern(v)] as const);

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function route(send: Send, t: Tuning = DEFAULTS): Route {
  const words = wordCount(send.words);
  const sketches = send.marks.filter((m) => m.kind === "sketch").length;
  const verbs = VERB_RES.filter(([, re]) => re.test(send.words)).map(([v]) => v);
  const features = { words, marks: send.marks.length, sketches, sceneShapes: send.sceneShapes, verbs: verbs.join(",") };
  const full = (why: string): Route => ({ lane: "full", model: modelOf(t["router.fullModel"]), why, features });
  if (send.sceneShapes === 0) return full("empty canvas: everything is new");
  if (t["router.sketchIsFull"] && sketches) return full("a sketch mark needs the picture to be read");
  if (send.marks.length > t["router.fastMaxMarks"]) return full(`${send.marks.length} marks (fast takes ${t["router.fastMaxMarks"]} at most)`);
  if (words > t["router.fastMaxWords"]) return full(`${words} words (fast takes ${t["router.fastMaxWords"]} at most)`);
  if (!verbs.length) return full("no small-edit verb");
  return { lane: "fast", model: modelOf(t["router.fastModel"]), why: `small edit: ${verbs.join(", ")}`, features };
}

// ---- The optional model check: the fast model classifies a send, to compare against the rules.

export const CHECK_SYSTEM = `You route requests for a canvas where people talk and draw to make app and website wireframes.
Answer with exactly one word: fast or full.
fast: a small edit to shapes that already exist (move, delete, recolor, resize, rename or change text, bold) that a small model can make from a list of shape ids, without seeing the canvas.
full: anything new, a sketch to interpret, several steps, a vague taste request ("make it pop"), or building on an empty canvas.`;

export const checkPrompt = (s: Send) =>
  `Words: "${s.words}"\nMarks: ${s.marks.length ? s.marks.map((m) => (m.kind === "sketch" ? "sketch" : m.how)).join(", ") : "none"}\nShapes on the canvas: ${s.sceneShapes}`;

/** The lane in a model's reply, if it gave one. */
export const parseLane = (reply: string): Lane | undefined => /\b(fast|full)\b/i.exec(reply)?.[1].toLowerCase() as Lane | undefined;
