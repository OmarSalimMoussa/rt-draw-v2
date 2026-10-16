// The driver: a model playing a user. Each turn it looks at the screen (as a
// user sees it: no id tags, no numbers, no grid), says how the last send went
// for it, and decides what to say and draw next. It writes its private intent
// down before Enter, so judges can later compare the result with what it meant.
import { type ModelName, callModel } from "../../src/core/model.ts";
import type { TraceContext } from "../../src/core/trace.ts";
import type { Persona } from "./personas.ts";
import type { DrawStep, Step } from "./synth.ts";

/** How the person behaves, each 0 to 1 (mess and disfluency only shape the ink and words, in synth.ts). */
export type Behaviour = { patience: number; changeMind: number; bigThenSmall: boolean };

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
- Patience: ${level(b.patience, ["low: after one or two misses you get short, repeat yourself louder, or give up", "average: you rephrase once or twice before moving on", "high: you calmly try again in other words"])}.
- Changing your mind: ${level(b.changeMind, ["rarely", "now and then you take something back (\"actually no, …\")", "often: you change your mind mid-sentence and across sends"])}.${b.bigThenSmall ? "\n- Early on you ask for something far too big (\"make it a whole online store\"), then tone it down." : ""}
- You talk like a person thinking out loud: casual, short, sometimes vague, with "..." where you pause. No stage directions, no lists, no markdown.
- You point with the pen the way people do: circle a thing while saying "this", draw an arrow to move something, tap a spot, scribble a thing out, sketch a box where something should go.

Each turn you see a screenshot of the canvas, ${w}×${h} pixels. Give every position in the screenshot's pixels. Reply with ONLY one JSON object, no prose around it:
{
  "saw": "after an earlier send: one line on what changed on screen, in your words",
  "satisfaction": 1-5 for your last send (1 not at all what I meant, 5 exactly), omitted on your first turn,
  "feeling": "one short line, in character, about that",
  "intent": "privately and concretely: what you expect to see after this send",
  "steps": [ in the order you do them, e.g.
    {"say": "okay so... make this"}, {"draw": "circle", "around": [x, y, w, h]}, {"say": "a lot bigger"},
    other drawings: {"draw": "arrow", "from": [x, y], "to": [x, y]}, {"draw": "line", "from": [x, y], "to": [x, y]}, {"draw": "tap", "at": [x, y]},
    {"draw": "box", "box": [x, y, w, h]} (sketching where something goes), {"draw": "cross", "box": [x, y, w, h]} (scribbling it out), {"draw": "underline", "box": [x, y, w, h]},
    {"pause": seconds} ],
  "stop": true only when you are done or have given up
}
Draw only when a person would; many sends are words alone. Put a drawing right after the words it goes with.`;
}

export function userMessage(past: Past[], sendsLeft: number): string {
  const lines = past.map((t, i) => `${i + 1}. You said: "${t.said}"${t.drew.length ? `, and drew: ${t.drew.join("; ")}` : ""}. You wanted: ${t.intent}${t.satisfaction ? ` You rated it ${t.satisfaction}/5: ${t.feeling ?? ""}` : ""}`);
  return `${past.length ? `Your sends so far:\n${lines.join("\n")}\n\nThe screenshot shows the canvas now, after send ${past.length}.` : "This is the canvas as you open the product."} You have at most ${sendsLeft} more send${sendsLeft === 1 ? "" : "s"} before you have to leave. What do you do next?`;
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const pts = (a: unknown, n: number, k: number) => (Array.isArray(a) && a.length >= n && a.slice(0, n).every((v) => num(v) !== undefined) ? a.slice(0, n).map((v) => (v as number) * k) : undefined);

/** The model's reply as a Turn, positions moved from screenshot pixels to canvas pixels (×k). */
export function parseTurn(text: string, k: number): Turn {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const o = JSON.parse(json) as Record<string, unknown>;
  const steps: Step[] = [];
  for (const s of Array.isArray(o.steps) ? (o.steps as Record<string, unknown>[]) : []) {
    if (typeof s.say === "string" && s.say.trim()) steps.push({ say: s.say.trim() });
    else if (num(s.pause) !== undefined) steps.push({ pause: s.pause as number });
    else if (typeof s.draw === "string") {
      const d = s.draw;
      const box = pts(s.around ?? s.box, 4, k);
      const from = pts(s.from, 2, k);
      const to = pts(s.to, 2, k);
      const at = pts(s.at, 2, k);
      let step: DrawStep | undefined;
      if (d === "circle" && box) step = { draw: "circle", around: box };
      else if ((d === "box" || d === "cross" || d === "underline") && box) step = { draw: d, box };
      else if ((d === "arrow" || d === "line") && from && to) step = { draw: d, from, to };
      else if (d === "tap" && at) step = { draw: "tap", at };
      if (step) steps.push(step);
    }
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
  if (s.draw === "circle") return `circles [${r(s.around)}]`;
  if (s.draw === "arrow" || s.draw === "line") return `${s.draw} from [${r(s.from)}] to [${r(s.to)}]`;
  if (s.draw === "tap") return `taps [${r(s.at)}]`;
  return `${s.draw === "box" ? "sketches a box" : s.draw === "cross" ? "scribbles out" : "underlines"} [${r(s.box)}]`;
}

export async function driverTurn(model: ModelName, system: string, screenshot: string, past: Past[], sendsLeft: number, k: number, parent?: TraceContext): Promise<{ turn: Turn; reply: string }> {
  const { text } = await callModel({ model, system, user: userMessage(past, sendsLeft), images: [screenshot], from: "driver" }, undefined, undefined, parent);
  return { turn: parseTurn(text, k), reply: text };
}
