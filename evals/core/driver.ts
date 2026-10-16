// The driver: a model playing a user. Each turn it looks at the screen (as a
// user sees it: no id tags, no numbers, no grid), says how the last send went
// for it, and decides what to say and draw next, or moves the view by hand to
// look somewhere else first. It writes its private intent down before Enter, so
// judges can later compare the result with what it meant.
import { type View, fitView } from "../../src/core/board.ts";
import { type ModelName, callModel } from "../../src/core/model.ts";
import type { TraceContext } from "../../src/core/trace.ts";
import type { Tuning } from "../../src/core/tuning.ts";
import type { Persona } from "./personas.ts";
import type { DrawStep, Step, ViewStep } from "./synth.ts";

/** The harness's numbers for moving the view, by name. Frozen for the optimizer, like SYNTH. */
export const DRIVE = {
  /** A zoom step by hand: this many times closer or further. */
  zoomStep: 2,
  /** Zooming in on a box leaves this share of it around it. */
  lookPadFrac: 0.05,
  /** Turns of only moving the view before a send, at most. */
  looksPerSend: 3,
};

/** Where the driver's screenshot sits on the board: board = x + px·k. */
export type ScreenMap = { x: number; y: number; k: number };

/** The view after a move by hand (the move in board pixels). */
export function moveView(m: ViewStep, v: View, t: Tuning): View {
  if ("scroll" in m) return { ...v, x: v.x + (m.scroll[0] ?? 0), y: v.y + (m.scroll[1] ?? 0) };
  if ("zoom" in m) {
    const w = m.zoom === "in" ? v.w / DRIVE.zoomStep : v.w * DRIVE.zoomStep;
    const k = w / v.w;
    return { x: v.x + (v.w * (1 - k)) / 2, y: v.y + (v.h * (1 - k)) / 2, w, h: v.h * k };
  }
  const [x, y, w, h] = m.look;
  return fitView({ x, y, w, h }, DRIVE.lookPadFrac, t["camera.minViewPx"]);
}

/** How the person behaves, each 0 to 1 (mess and disfluency only shape the ink and words, in synth.ts). */
export type Behaviour = {
  /** How much they say: 0 a few pointing words ("move this there"), 1 thinks out loud at length. */
  words: number;
  /** How well they describe what they want: 0 vague ("make it nicer"), 1 precise. */
  clarity: number;
  /** How much they rely on the marker: 0 only when completely frustrated, 1 for nearly everything. */
  pen: number;
  patience: number;
  changeMind: number;
  bigThenSmall: boolean;
};

export type Turn = {
  /** What it sees changed since its last send (absent on the first turn). */
  saw?: string;
  /** 1 (not at all what I wanted) to 5 (exactly), for the last send. */
  satisfaction?: number;
  feeling?: string;
  /** Private: what it wants to happen after this send. */
  intent: string;
  steps: Step[];
  /** It's done or has given up. */
  stop?: boolean;
};

export type Past = { said: string; drew: string[]; intent: string; satisfaction?: number; feeling?: string };

const level = (x: number, words: [string, string, string]) => words[x < 0.34 ? 0 : x < 0.67 ? 1 : 2];

export function systemPrompt(p: Persona, target: { picture: string } | undefined, b: Behaviour, w: number, h: number): string {
  return `You are role-playing a person using a product for real. Stay in character the whole time.

Who you are: ${p.who}

What you know about the product: ${p.knows}

What you want: ${p.wants}${target ? `\n\nThe page you have in mind: ${target.picture}. Keep it in your head; never recite it. Ask for it the way a person would, a piece or two at a time, in your own words.` : ""}

How you behave:
- Talking: ${level(b.words, ["you barely talk: two to five words a send, mostly pointing words like \"this here\", \"move this there\", \"delete this\", \"swap these\", \"bigger\". You never explain", "a short sentence or two a send", "you think out loud at length, explaining and going on tangents"])}.
- Describing: ${level(b.clarity, ["vague: you can't put what you want into words (\"make it more... you know\", \"the thing\", \"nicer\"), and you don't name parts of a page", "you get the idea across, roughly", "precise: you name what you want and where"])}.
- The marker: ${level(b.pen, ["you almost never pick it up. You keep trying in words, however vague; only once you've been misunderstood at least twice in a row and feel really frustrated do you grab it", "you draw when pointing is easier than saying", "you lean on it for nearly everything: you circle, arrow, tap and sketch boxes where things go, and your words only point at your drawings"])}.
- Patience: ${level(b.patience, ["low: after one or two misses you get short, repeat yourself louder, or give up", "average: you rephrase once or twice before moving on", "high: you calmly try again in other words"])}.
- Changing your mind: ${level(b.changeMind, ["rarely", "now and then you take something back (\"actually no, …\")", "often: you change your mind mid-sentence and across sends"])}.${b.bigThenSmall ? "\n- You start too big: your first send is only a huge, vague ask (like \"make it a whole online store\"), and you press Enter to see what the product does with it. You only slowly realize what it can't do: while it delivers, you stay ambitious; each time a result disappoints you, you scale back one step, a little smaller or simpler than your last ask, never straight to the bare minimum." : ""}
- You talk like a person thinking out loud: casual, short, sometimes vague, with "..." where you pause. No stage directions, no lists, no markdown.
- You point with the pen the way people do: circle a thing while saying "this", draw an arrow to move something, tap a spot, scribble a thing out, sketch a box where something should go.

The product is an infinite board: pages sit side by side on it, and your screen shows part of it. You move the view by hand, like on a trackpad: {"scroll": [dx, dy]} moves what you see by that many screenshot pixels (positive to see what's right of or below the screen), {"zoom": "out"} or {"zoom": "in"} goes twice as far or close, {"look": [x, y, w, h]} zooms in on that part of the screenshot. Or you ask the product out loud ("show me the cart page"). To look at something you can't see yet, only move the view that turn, nothing else: you don't press Enter, and you get the new screen next turn.

Each turn you see a screenshot of your screen, ${w}×${h} pixels. Give every position in that screenshot's pixels, even after you move the view in the same turn. Reply with ONLY one JSON object, no prose around it:
{
  "saw": "after an earlier send: one line on what changed on screen, in your words",
  "satisfaction": 1-5 for your last send (1 not at all what I meant, 5 exactly), omitted on your first turn,
  "feeling": "one short line, in character, about that",
  "intent": "privately and concretely: what you expect to see after this send",
  "steps": [ in the order you do them, e.g.
    {"say": "okay so... make this"}, {"draw": "circle", "around": [x, y, w, h]}, {"say": "a lot bigger"},
    other drawings: {"draw": "arrow", "from": [x, y], "to": [x, y]}, {"draw": "line", "from": [x, y], "to": [x, y]}, {"draw": "tap", "at": [x, y]},
    {"draw": "box", "box": [x, y, w, h]} (sketching where something goes), {"draw": "cross", "box": [x, y, w, h]} (scribbling it out), {"draw": "underline", "box": [x, y, w, h]},
    {"scroll": [dx, dy]}, {"zoom": "in" | "out"}, {"look": [x, y, w, h]},
    {"pause": seconds} ],
  "stop": true only when you are done or have given up
}
Draw only as much as your use of the marker says; how much you say follows your talking. Put a drawing right after the words it goes with.`;
}

/** What this send is for, when the behaviour plays out across sends (a model left alone squeezes it all into one). */
function phase(b: Behaviour, sent: number): string {
  if (!b.bigThenSmall) return "";
  if (sent === 0) return " This is your first send: make only the huge, vague ask, a sentence or two, and nothing smaller. Don't narrow it or take any of it back in this send, even if you usually change your mind mid-sentence; you'll press Enter and see what happens first.";
  return " First rate the last result honestly. If it gave you what you asked for, stay ambitious and keep building on your big idea. If it disappointed you, scale back one step only: a little smaller or simpler than your last ask, not straight to the minimum, as you slowly realize what it can and can't do. Each further disappointment takes you one more step down.";
}

/** `looked`: the view moves made by hand since the last send, without pressing Enter. */
export function userMessage(past: Past[], sendsLeft: number, b: Behaviour, looked: string[] = []): string {
  const lines = past.map((t, i) => `${i + 1}. You said: "${t.said}"${t.drew.length ? `, and drew: ${t.drew.join("; ")}` : ""}. You wanted: ${t.intent}${t.satisfaction ? ` You rated it ${t.satisfaction}/5: ${t.feeling ?? ""}` : ""}`);
  const now = past.length ? `Your sends so far:\n${lines.join("\n")}\n\nThe screenshot shows your screen now, after send ${past.length}` : "This is your screen as you open the product";
  const moved = looked.length ? `, after you moved the view without pressing Enter (${looked.join("; ")}).${past.at(-1)?.satisfaction ? ` You've already rated send ${past.length}.` : ""}${looked.length >= DRIVE.looksPerSend ? " You've looked around enough: act on what you see now, or stop." : ""}` : ".";
  return `${now}${moved} You have at most ${sendsLeft} more send${sendsLeft === 1 ? "" : "s"} before you have to leave. What do you do next?${phase(b, past.length)}`;
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const nums = (a: unknown, n: number) => (Array.isArray(a) && a.length >= n && a.slice(0, n).every((v) => num(v) !== undefined) ? (a.slice(0, n) as number[]) : undefined);

/** The model's reply as a Turn, positions moved from screenshot pixels to board pixels. */
export function parseTurn(text: string, m: ScreenMap): Turn {
  const { k } = m;
  // A point or a box's corner lands on the board where the screenshot showed it; sizes and scrolls only scale.
  const pts = (a: unknown, n: number) => nums(a, n)?.map((v, i) => (i < 2 ? (i ? m.y : m.x) + v * k : v * k));
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const o = JSON.parse(json) as Record<string, unknown>;
  const steps: Step[] = [];
  for (const s of Array.isArray(o.steps) ? (o.steps as Record<string, unknown>[]) : []) {
    if (typeof s.say === "string" && s.say.trim()) steps.push({ say: s.say.trim() });
    else if (num(s.pause) !== undefined) steps.push({ pause: s.pause as number });
    else if (typeof s.draw === "string") {
      const d = s.draw;
      const box = pts(s.around ?? s.box, 4);
      const from = pts(s.from, 2);
      const to = pts(s.to, 2);
      const at = pts(s.at, 2);
      let step: DrawStep | undefined;
      if (d === "circle" && box) step = { draw: "circle", around: box };
      else if ((d === "box" || d === "cross" || d === "underline") && box) step = { draw: d, box };
      else if ((d === "arrow" || d === "line") && from && to) step = { draw: d, from, to };
      else if (d === "tap" && at) step = { draw: "tap", at };
      if (step) steps.push(step);
    } else if (nums(s.scroll, 2)) steps.push({ scroll: nums(s.scroll, 2)!.map((v) => v * k) });
    else if (s.zoom === "in" || s.zoom === "out") steps.push({ zoom: s.zoom });
    else if (pts(s.look, 4)) steps.push({ look: pts(s.look, 4)! });
  }
  const sat = num(o.satisfaction);
  return {
    saw: typeof o.saw === "string" ? o.saw : undefined,
    satisfaction: sat === undefined ? undefined : Math.max(1, Math.min(5, Math.round(sat))),
    feeling: typeof o.feeling === "string" ? o.feeling : undefined,
    intent: typeof o.intent === "string" ? o.intent : "",
    steps,
    stop: o.stop === true,
  };
}

/** A step as a short line for the log and the driver's own history. */
export function describeStep(s: Step): string {
  const r = (a: number[]) => a.map(Math.round).join(", ");
  if ("say" in s) return `says "${s.say}"`;
  if ("pause" in s) return `pauses ${s.pause} s`;
  if ("scroll" in s) return `scrolls by [${r(s.scroll)}]`;
  if ("zoom" in s) return `zooms ${s.zoom}`;
  if ("look" in s) return `zooms in on [${r(s.look)}]`;
  if (s.draw === "circle") return `circles [${r(s.around)}]`;
  if (s.draw === "arrow" || s.draw === "line") return `${s.draw} from [${r(s.from)}] to [${r(s.to)}]`;
  if (s.draw === "tap") return `taps [${r(s.at)}]`;
  return `${s.draw === "box" ? "sketches a box" : s.draw === "cross" ? "scribbles out" : "underlines"} [${r(s.box)}]`;
}

export async function driverTurn(model: ModelName, system: string, b: Behaviour, screenshot: string, past: Past[], sendsLeft: number, m: ScreenMap, looked: string[] = [], parent?: TraceContext): Promise<{ turn: Turn; reply: string }> {
  const { text } = await callModel({ model, system, user: userMessage(past, sendsLeft, b, looked), images: [screenshot], from: "driver" }, undefined, undefined, parent);
  return { turn: parseTurn(text, m), reply: text };
}
