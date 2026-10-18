// The driver: a model playing a user. Pure functions, no model calls (drive.ts
// asks the gateway, the demo page calls callModel): one system prompt shared by
// every session, so every driver call shares one cached prefix; a user message
// per turn with who it is, how it behaves, this send's ask and beat, and its
// history; and its reply parsed into steps. Each turn it sees two screenshots
// (its screen at its last Enter with its ink, and its screen now), rates the last
// send, writes down what it means by this one before Enter, and talks and draws,
// or moves the view by hand.
import type { View } from "../../src/core/board.ts";
import { DRIVE_VIEW } from "../loop/config.ts";
import type { AskType, BeatId } from "../loop/types.ts";
import { PEN_MIN, type Persona, type Style, type Target } from "./personas.ts";
import { type DrawStep, type Step, type ViewStep, isView } from "./synth.ts";

/** The harness's numbers for the driver's hand, by name. Frozen for the optimizer, like SYNTH and DRIVE_VIEW. */
export const DRIVE = {
  /** A zoom step by hand: this many times closer or further. */
  zoomStep: 2,
  /** Zooming in on a box leaves this share of it around it. */
  lookPadFrac: 0.05,
  /** A position this far off the screenshot is moved onto its edge; further off, the step is dropped. */
  clampPx: 50,
};

/** Sent once when a reply doesn't parse (V1); a second failure ends the session. */
export const RETRY = "Reply with only the JSON object.";

/** An unsure `meant` (§2.4): the judges are told so, and held-out sets leave the case out. A bare "or" isn't one ("a header or banner"). */
export const HEDGE = /\b(probably|maybe|might|possibly|perhaps|i guess|i'll see|let's see|see if|not sure)\b|\bor\b.*\?/i;

type XY = [number, number];
const SCREEN = { w: 1280, h: 800 };

/** board.ts' fitView, copied so a candidate's product code can't move the driver's eyes (D6). */
function fitView(b: View, padFrac: number, minW: number): View {
  const pad = Math.max(b.w, b.h) * padFrac;
  const w = Math.max(b.w + pad * 2, ((b.h + pad * 2) * SCREEN.w) / SCREEN.h, minW, 1);
  const h = (w * SCREEN.h) / SCREEN.w;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

/** A view scaled about its centre to a width within DRIVE_VIEW's zoom range. */
function zoomed(v: View, w: number): View {
  const k = Math.min(DRIVE_VIEW.zoomMaxPx, Math.max(DRIVE_VIEW.zoomMinPx, w)) / v.w;
  return { x: v.x + (v.w * (1 - k)) / 2, y: v.y + (v.h * (1 - k)) / 2, w: v.w * k, h: v.h * k };
}

/** The view after a move by hand (the move in board pixels). */
export function moveView(m: ViewStep, v: View): View {
  if ("scroll" in m) return { ...v, x: v.x + (m.scroll[0] ?? 0), y: v.y + (m.scroll[1] ?? 0) };
  if ("zoom" in m) return zoomed(v, m.zoom === "in" ? v.w / DRIVE.zoomStep : v.w * DRIVE.zoomStep);
  const [x, y, w, h] = m.look;
  const f = fitView({ x, y, w, h }, DRIVE.lookPadFrac, DRIVE_VIEW.lookMinPx);
  return zoomed(f, f.w);
}

export type Turn = {
  /** What it sees changed since its last send (absent on the first turn). */
  saw?: string;
  /** 1 (not at all what I meant) to 5 (exactly), for the last send. */
  satisfaction?: number;
  feeling?: string;
  /** Written before Enter: the result it wants from this send, as it would check it on screen. */
  meant: string;
  /** Breakers and explorers: their plan or guess. Never shown to judges. */
  testing?: string;
  /** Whether it says it did this send's beat. */
  beatDone?: boolean;
  steps: Step[];
  /** It's done or has given up. */
  stop: boolean;
  /** `meant` matches HEDGE. */
  hedged: boolean;
};
/** A step the parser left out, and why (recorded, never silently lost). */
export type Dropped = { step: unknown; why: string };

/** The first balanced {…} in a reply, braces inside strings skipped, so prose or a second object around it can't break the parse. */
export function firstObject(text: string): string {
  const start = text.indexOf("{");
  let [depth, inString, escaped] = [0, false, false];
  for (let i = start; start >= 0 && i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("no JSON object in the driver's reply");
}

/** A number, or a string holding one ("120"). */
const num = (x: unknown) => {
  const v = typeof x === "string" && x.trim() ? Number(x) : x;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const nums = (a: unknown, n: number) => {
  const v = Array.isArray(a) && a.length >= n ? a.slice(0, n).map(num) : [];
  return v.length === n && v.every((x) => x !== undefined) ? (v as number[]) : undefined;
};
const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const SKETCHES = ["wave", "zigzag", "blob"];

/**
 * The reply as a Turn, positions moved from the screenshot (DRIVE_VIEW pixels of
 * `view`) to board pixels. A position a little off the screenshot is clamped onto
 * it; further off, its step is dropped. View steps after a draw, unknown kinds and
 * malformed steps are dropped too; every drop is returned with its reason (V3, V4).
 * Throws only when the reply holds no parseable object (V1: retry once with RETRY).
 */
export function parseTurn(reply: string, view: View): { turn: Turn; dropped: Dropped[]; clamped: number } {
  const o = JSON.parse(firstObject(reply)) as Record<string, unknown>;
  // A bare step ({"undo": true} on the PGX's smoke) isn't a turn: retried, where it ended the session as "nothing to do".
  if (!Array.isArray(o.steps) && o.stop !== true) throw new Error("no steps list");
  const k = view.w / DRIVE_VIEW.screenW;
  const dropped: Dropped[] = [];
  let clamped = 0;
  const onScreen = (x: number, y: number): XY | undefined => {
    const c = DRIVE.clampPx;
    if (x < -c || y < -c || x > DRIVE_VIEW.screenW + c || y > DRIVE_VIEW.screenH + c) return;
    const p: XY = [Math.min(DRIVE_VIEW.screenW, Math.max(0, x)), Math.min(DRIVE_VIEW.screenH, Math.max(0, y))];
    if (p[0] !== x || p[1] !== y) clamped++;
    return p;
  };
  const point = (a: unknown) => {
    const v = nums(a, 2);
    const p = v && onScreen(v[0], v[1]);
    return p && [view.x + p[0] * k, view.y + p[1] * k];
  };
  const box = (a: unknown) => {
    const v = nums(a, 4);
    if (!v) return;
    // A box drawn right to left or bottom to top has a negative size.
    const [x, y] = [Math.min(v[0], v[0] + v[2]), Math.min(v[1], v[1] + v[3])];
    const [p, q] = [onScreen(x, y), onScreen(x + Math.abs(v[2]), y + Math.abs(v[3]))];
    return p && q && [view.x + p[0] * k, view.y + p[1] * k, (q[0] - p[0]) * k, (q[1] - p[1]) * k];
  };
  const drawStep = (s: Record<string, unknown>): DrawStep | string => {
    const d = SKETCHES.includes(s.draw as string) ? "sketch" : s.draw;
    const off = "a position off the screen or malformed";
    if (d === "circle" || d === "box" || d === "cross" || d === "underline") {
      const b = box(s.around ?? s.box);
      return !b ? off : d === "circle" ? { draw: d, around: b } : { draw: d, box: b };
    }
    if (d === "arrow" || d === "line") {
      const [from, to] = [point(s.from), point(s.to)];
      return from && to ? { draw: d, from, to } : off;
    }
    if (d === "tap") return point(s.at) ? { draw: d, at: point(s.at)! } : off;
    if (d === "sketch") {
      const shape = SKETCHES.includes(s.shape as string) ? s.shape : s.draw;
      const b = box(s.box ?? s.around);
      return !SKETCHES.includes(shape as string) ? `unknown sketch shape ${String(s.shape)}` : b ? { draw: d, shape: shape as "wave", box: b } : off;
    }
    return `unknown kind ${String(s.draw)}`;
  };
  const steps: Step[] = [];
  let [drew, acted] = [false, false];
  for (const raw of Array.isArray(o.steps) ? o.steps : []) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    let step: Step | string;
    if (typeof s.say === "string") step = s.say.trim() ? { say: s.say.trim() } : "empty say";
    else if ("pause" in s) step = (num(s.pause) ?? -1) >= 0 ? { pause: num(s.pause)! } : "malformed pause";
    else if (s.undo === true) step = acted ? "undo after a say or draw" : { undo: true };
    else if (typeof s.draw === "string") step = drawStep(s);
    else if ("scroll" in s || "zoom" in s || "look" in s) {
      if (drew) step = "view step after a draw";
      else if (nums(s.scroll, 2)) step = { scroll: nums(s.scroll, 2)!.map((v) => v * k) };
      else if (s.zoom === "in" || s.zoom === "out") step = { zoom: s.zoom };
      else {
        const look = box(s.look);
        step = look ? { look } : "a position off the screen or malformed";
      }
    } else step = "unknown step";
    if (typeof step === "string") dropped.push({ step: raw, why: step });
    else {
      steps.push(step);
      drew ||= "draw" in step;
      acted ||= "draw" in step || "say" in step;
    }
  }
  // Moving the view is a turn of its own (the prompt says so): words said while only scrolling or zooming are thinking
  // aloud, not a request. Sent, "hm, what's down here..." pressed Enter, and the bank's by-hand looks went unrecorded.
  if (!drew && steps.some(isView)) steps.splice(0, steps.length, ...steps.filter((s) => !("say" in s)));
  const sat = num(o.satisfaction);
  const meant = text(o.meant) ?? "";
  const turn: Turn = {
    saw: text(o.saw),
    satisfaction: sat === undefined ? undefined : Math.max(1, Math.min(5, Math.round(sat))),
    feeling: text(o.feeling),
    meant,
    testing: text(o.testing),
    beatDone: typeof o.beat_done === "boolean" ? o.beat_done : undefined,
    steps,
    stop: o.stop === true,
    hedged: HEDGE.test(meant),
  };
  return { turn, dropped, clamped };
}

/** A turn with nothing said or drawn presses no Enter: it only looked (or undid), and sees the new screen next turn (V2). */
export const isLook = (t: Turn) => !t.steps.some((s) => "say" in s || "draw" in s);

/** The same for every session (one pool key, one cached prefix): who and how go in the user message. */
export function systemPrompt(): string {
  return `You are role-playing a person using a product for real. Each message tells you who you are, how you behave, what kind of change you're after this send, and sometimes a twist for it. Stay in character the whole time; never mention the twist or the kind of change you were given, just do them in your own words.

The product is an infinite board: the pages of a website or app sit side by side on it, and your screen shows part of it. You talk and draw on your screen, press Enter, and the product changes the pages, drawn as hand-drawn wireframes. Asking out loud is a normal send too: you say it and press Enter (ask it to show you a page and it moves your screen there).

Each turn you get two screenshots, ${DRIVE_VIEW.screenW}×${DRIVE_VIEW.screenH} pixels each: first your screen when you last pressed Enter, with the ink you drew then; second your screen now. Give every position in the second screenshot's pixels, even after you move the view in the same turn.

Steps, in the order you do them:
- talking: {"say": "<words>"}, and {"pause": <seconds>} for a silence;
- drawing, right after the words it goes with: {"draw": "circle", "around": [x, y, w, h]}, {"draw": "arrow", "from": [x, y], "to": [x, y]}, {"draw": "line", "from": [x, y], "to": [x, y]}, {"draw": "tap", "at": [x, y]}, {"draw": "box", "box": [x, y, w, h]} (sketching where something goes), {"draw": "cross", "box": [x, y, w, h]} (scribbling it out), {"draw": "underline", "box": [x, y, w, h]}, {"draw": "sketch", "shape": "wave" | "zigzag" | "blob", "box": [x, y, w, h]} (a quick squiggle where something goes);
- moving the view by hand, like on a trackpad: {"scroll": [dx, dy]} moves what you see by that many pixels (positive to see what's right of or below the screen), {"zoom": "in"} or {"zoom": "out"} goes twice as close or far, {"look": [x, y, w, h]} zooms in on that part of the screenshot. To look at something you can't see yet, only move the view that turn: you don't press Enter, and you get the new screen next turn;
- {"undo": true} takes your last send back (the board goes back to how it was before it). Do it alone in a turn, like moving the view.

Talk like a person thinking out loud: casual, sometimes vague, with "..." where you pause. Start each send your own way: never open two sends with the same words. No stage directions, no lists, no markdown.

Reply with ONLY one JSON object, no prose around it:
{"saw": "after an earlier send: one line on what changed on screen, in your words",
 "satisfaction": 1-5 for your last send (1 not at all what you meant, 5 exactly), omitted on your first turn,
 "feeling": "one short line, in character, about that",
 "meant": "the result you want from this send, concretely, as you'd check it on screen (not a guess about what the product will do)",
 "testing": "only when your message asks for it: your plan or guess",
 "beat_done": true if you did this send's twist, false if you didn't (omitted when there is none),
 "steps": [{"say": "<words>"}, {"draw": "<kind>", ...}, {"say": "<words>"}],
 "stop": true only when you are done or have given up}`;
}

const level = (x: number, words: [string, string, string]) => words[x < PEN_MIN ? 0 : x < 0.67 ? 1 : 2];

/** How the person behaves, from their style. A style that barely draws loses the pen lines (drivers-9). */
function behaviour(b: Style): string[] {
  const out = [
    `Talking: ${level(b.words, ["you barely talk: two to five words a send, mostly pointing words like \"this here\", \"move this there\", \"delete this\", \"swap these\". You never explain", "a short sentence or two a send", "you think out loud at length, explaining and going on tangents"])}.`,
    `Describing: ${level(b.clarity, ["vague: you can't put what you want into words (\"make it more... you know\", \"the thing\", \"nicer\"), and you don't name parts of a page", "you get the idea across, roughly", "precise: you name what you want and where"])}.`,
    b.pen < PEN_MIN
      ? "The marker: you almost never draw. You keep trying in words, however vague; only once you've been misunderstood at least twice in a row and feel really frustrated do you grab it."
      : `The marker: ${level(b.pen, ["", "you draw when pointing is easier than saying", "you lean on it for nearly everything: you circle, arrow, tap and sketch boxes where things go, and your words only point at your drawings"])}.`,
    `Patience: ${level(b.patience, ["low: after one or two misses you get short, repeat yourself louder, or give up", "average: you rephrase once or twice before moving on", "high: you calmly try again in other words"])}.`,
    `Changing your mind: ${level(b.changeMind, ["rarely", "now and then you take something back (\"actually no, …\")", "often: you change your mind mid-sentence and across sends"])}.`,
  ];
  if (b.bigThenSmall) out.push("You start too big: your first send is only a huge, vague ask (like \"make it a whole online store\"), and you press Enter to see what the product does with it. You only slowly realize what it can't do: while it delivers, you stay ambitious; each time a result disappoints you, you scale back one step, a little smaller or simpler than your last ask, never straight to the bare minimum.");
  if (b.pen >= PEN_MIN) out.push("You point with the pen the way people do: circle a thing while saying \"this\", draw an arrow to move something, tap a spot, scribble a thing out, sketch a box where something should go.");
  return out;
}

/** Who drives: the persona, its style, and for a first-timer the site it remembers. */
/** How a session's person starts a send: one per session (drive.ts picks it by seed), so 35-39% of a bank's sends didn't open alike. */
export const HABITS = [
  "you jump straight into what you want, no warm-up words",
  "you often start with \"hmm\" or \"right\"",
  "you start by naming the thing you're looking at",
  "you start with a question (\"can you...\", \"could it...\")",
  "you start with what bugs you (\"this is too...\", \"I don't like...\")",
  "you start with \"I want\" or \"let's\"",
  "you start with a little reaction to the screen (\"oh\", \"huh\", \"nice\")",
  "you start with \"so\" or \"alright\", then get to it",
];
export type Card = { persona: Persona; style: Style; target?: Target; habit?: string };
/** One past send as the driver remembers it: words, marks by kind and coarse place (describeMarks), what it meant, its rating. */
export type Past = { said: string; marks: string[]; meant: string; satisfaction?: number; feeling?: string };

/** What each ask type asks for (the seed picks the type; the driver picks what, where and how). */
const ASKS: Record<AskType, string> = {
  add: "add something",
  remove: "take something away",
  move: "move something somewhere else",
  resize: "make something bigger or smaller",
  restyle: "change how something looks: its colour, style or shape",
  retext: "change some of the words on the page",
  reorder: "rearrange things: their order, alignment or layout",
  "new-page": "start another page of the site",
};

/** A board point as a coarse place on the screen: "the upper left", "the middle", … (never numbers). */
function place([x, y]: number[], v: View): string {
  const col = Math.max(0, Math.min(2, Math.floor(((x - v.x) / v.w) * 3)));
  const row = Math.max(0, Math.min(2, Math.floor(((y - v.y) / v.h) * 3)));
  return [["the upper left", "the top", "the upper right"], ["the left", "the middle", "the right"], ["the lower left", "the bottom", "the lower right"]][row][col];
}
const centre = (b: number[]) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** The marks of a send by kind and coarse place on the screen it was drawn on (drivers-10: board numbers leaked into its history). */
export function describeMarks(steps: Step[], v: View): string[] {
  return steps.flatMap((s) => {
    if (!("draw" in s)) return [];
    if (s.draw === "arrow" || s.draw === "line") return [`drew ${s.draw === "arrow" ? "an arrow" : "a line"} from ${place(s.from, v)} to ${place(s.to, v)}`];
    if (s.draw === "tap") return [`tapped ${place(s.at, v)}`];
    const at = place(centre(s.draw === "circle" ? s.around : s.box), v);
    if (s.draw === "circle") return [`circled something in ${at}`];
    if (s.draw === "cross") return [`scribbled out something in ${at}`];
    if (s.draw === "underline") return [`underlined something in ${at}`];
    return [`sketched ${s.draw === "box" ? "a box" : `a ${s.shape}`} in ${at}`];
  });
}

/** How an undo reads in the driver's message, and a second one with nothing left to take back. */
export const UNDID = "undid your last send";
export const NOTHING_TO_UNDO = "tried to undo again, but your last send was already undone";

/** A move by hand (or an undo) as the driver remembers it, without numbers. */
export function describeMove(s: ViewStep | { undo: true }, v: View): string {
  if ("undo" in s) return UNDID;
  if ("zoom" in s) return `zoomed ${s.zoom}`;
  if ("look" in s) return `zoomed in on ${place(centre(s.look), v)}`;
  const [dx, dy] = s.scroll;
  const dir = [Math.abs(dx) > v.w / 20 ? (dx > 0 ? "right" : "left") : "", Math.abs(dy) > v.h / 20 ? (dy > 0 ? "down" : "up") : ""].filter(Boolean);
  return `scrolled ${dir.join(" and ") || "a little"}`;
}

/** The driver's history: one line per past send, by kind and coarse place, never numbers. */
export function describePast(past: Past[]): string[] {
  const end = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
  return past.map((t, i) => `${i + 1}. You said "${t.said}"${t.marks.length ? `, and ${t.marks.join(", then ")}` : ""}. You meant: ${end(t.meant || "(nothing written)")}${t.satisfaction ? ` You rated it ${t.satisfaction}/5: ${t.feeling ?? ""}` : ""}`);
}

/**
 * This turn's message. `looked`: the moves by hand since the last send (describeMove),
 * made without pressing Enter. The two images go with it: the screen at the last Enter
 * with its ink (before), then the screen now.
 */
export function userMessage(card: Card, history: Past[], beat: { id: BeatId; text: string } | undefined, ask: AskType, sendsLeft: number, looked: string[] = []): string {
  const { persona: p, style, target } = card;
  const who = `Who you are: ${p.who}\n\nWhat you know about the product: ${p.knows}\n\nWhat you want: ${p.wants}${target ? `\n\nThe site you have in mind: ${target.memory}. You remember it only roughly; keep it in your head and never recite it. Ask for it the way a person would, a piece or two at a time, in your own words.` : ""}`;
  const how = `How you behave:\n${[...behaviour(style), ...(card.habit ? [`Starting a send: ${card.habit}.`] : [])].map((l) => `- ${l}`).join("\n")}`;
  const n = history.length;
  const now = n
    ? `Your sends so far:\n${describePast(history).join("\n")}\n\nThe first picture is your screen when you pressed Enter on send ${n}, with your ink; the second is your screen now`
    : "Both pictures show your screen as you open the product";
  const moved = looked.length
    ? `, after you did this without pressing Enter: ${looked.join("; ")}.${history.at(-1)?.satisfaction ? ` You've already rated send ${n}.` : ""}${looked.length >= DRIVE_VIEW.maxLooks ? " You've looked around enough: act on what you see now, or stop." : ""}`
    : ".";
  // Once the undo is done the twist says so: repeating "undo it first" had a driver undo twice and then give up.
  const twist = beat && (beat.id === "undo" && looked.some((l) => l.includes(UNDID)) ? "you've undone the last result: now ask again in other words." : beat.text);
  const task = `The kind of change you ask for this send: ${ASKS[ask]} (you pick what, where and how).${twist ? ` This send's twist: ${twist}` : ""}${p.id === "first-timer" ? "" : ` Fill "testing" with your plan or guess for this send.`}`;
  return `${who}\n\n${how}\n\n${now}${moved}\n\n${task}\n\nYou have at most ${sendsLeft} more send${sendsLeft === 1 ? "" : "s"} before you have to leave. What do you do next?`;
}

/** A step as a short line for logs and the demo page (with numbers: never shown to the driver). */
export function describeStep(s: Step): string {
  const r = (a: number[]) => a.map(Math.round).join(", ");
  if ("say" in s) return `says "${s.say}"`;
  if ("pause" in s) return `pauses ${s.pause} s`;
  if ("undo" in s) return "undoes the last send";
  if ("scroll" in s) return `scrolls by [${r(s.scroll)}]`;
  if ("zoom" in s) return `zooms ${s.zoom}`;
  if ("look" in s) return `zooms in on [${r(s.look)}]`;
  if (s.draw === "circle") return `circles [${r(s.around)}]`;
  if (s.draw === "arrow" || s.draw === "line") return `${s.draw} from [${r(s.from)}] to [${r(s.to)}]`;
  if (s.draw === "tap") return `taps [${r(s.at)}]`;
  if (s.draw === "sketch") return `sketches a ${s.shape} [${r(s.box)}]`;
  return `${s.draw === "box" ? "sketches a box" : s.draw === "cross" ? "scribbles out" : "underlines"} [${r(s.box)}]`;
}
