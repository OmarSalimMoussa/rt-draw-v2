// The scenario table (§2.1–2.3), frozen: who drives, from which start, and per
// send which kind of change to ask for and which beat (a twist the driver applies
// to whatever it sees), all from the scenario's seed. The lists are fixed rows
// whose seeds were picked so the planned sends cover every beat and ask type with
// room to spare: the bank refuses itself when a gate fails (§2.3), and a refused
// bank is a paid build thrown away. Beat checks and gates are free: they read
// parsed replies and case files, never a model.
import type { View } from "../../src/core/board.ts";
import type { AskType, BeatId, PersonaId, SetId, StartId, StyleId, TargetId } from "../loop/types.ts";
import type { Turn } from "./driver.ts";
import { COHERENT, PEN_MIN, TARGETS, styleOf, targetOf } from "./personas.ts";
import { type DrawStep, isView, rng } from "./synth.ts";

export type Scenario = {
  id: string;
  set: SetId;
  persona: PersonaId;
  style: StyleId;
  /** First-timers only. */
  target?: TargetId;
  start: StartId;
  /** 5 (tuning, fresh), 4 (held-out). */
  sends: number;
  /** Picks the ask types and beats (plan), the synthesis and the look timing. */
  seed: number;
};

export const ASKS: AskType[] = ["add", "remove", "move", "resize", "restyle", "retext", "reorder", "new-page"];
/** Ask-type quotas (§2.2), in the order of ASKS. */
const QUOTA = {
  firstTimer: [0.5, 0.05, 0.1, 0.05, 0.1, 0.1, 0.05, 0.05],
  other: [0.15, 0.12, 0.15, 0.12, 0.12, 0.12, 0.12, 0.1],
};
export const quotaOf = (p: PersonaId) => (p === "first-timer" ? QUOTA.firstTimer : QUOTA.other);

/** About this share of sends get no beat (§2.2). */
const NO_BEAT = 0.4;
/** Starts on the five-page toy shop: the only ones with pages off screen to name or move to. */
const isBoard = (s: StartId) => s.startsWith("toyshop");

type Box = { x: number; y: number; w: number; h: number };
/** What a beat check reads besides the acting turn: this send's look turns before it, the screen it drew on and what's there (board px), the last send's meant. */
export type BeatCtx = { send: number; looks: Turn[]; view: View; shapes: Box[]; pages: { name: string; box: Box }[]; lastMeant?: string };
/** What a planned send knows about who drives it. */
type Fit = { send: number; ask: AskType; pen: number; clarity: number; board: boolean };

export type Beat = {
  id: BeatId;
  /** Picked this much more often than a weight-1 beat when it fits: rarely fitting beats get more, so every beat reaches its coverage. */
  weight: number;
  text: string | ((side: string, send: number) => string);
  fits: (f: Fit) => boolean;
  /** Whether the driver did it, read free from the parsed reply (V11: a miss stays valid, out of coverage). */
  check: (t: Turn, c: BeatCtx) => boolean;
};

const says = (t: Turn) => t.steps.flatMap((s) => ("say" in s ? [s.say] : []));
const said = (t: Turn) => says(t).join(" ");
const draws = (t: Turn) => t.steps.filter((s): s is DrawStep => "draw" in s);
/** Board px per screen px (SYNTH's 1280-wide screen). */
const scale = (c: BeatCtx) => c.view.w / 1280;
const centre = (b: number[]) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const boxOf = (b: number[]): Box => ({ x: b[0], y: b[1], w: b[2], h: b[3] });
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const distance = (p: number[], b: Box) => Math.hypot(Math.max(b.x - p[0], 0, p[0] - b.x - b.w), Math.max(b.y - p[1], 0, p[1] - b.y - b.h));
/** Where a mark points from. */
const anchor = (s: DrawStep) => (s.draw === "tap" ? s.at : s.draw === "arrow" || s.draw === "line" ? s.from : centre(s.draw === "circle" ? s.around : s.box));
/** Words that name a part of a page. */
export const PART_NOUNS = /\b(header|footer|nav|navbar|navigation|menu|button|title|heading|headline|logo|image|photo|picture|card|banner|hero|sidebar|form|field|input|link|icon|label|list|table|chart|graph|grid|section|column|row|tab|map|price|search|bar|box|text|caption|page|avatar|calendar|player|cover|checklist|paragraph)s?\b/i;
const POINTING = /\b(this|that|these|those|here|there)\b/i;
const pen = (f: Fit) => f.pen >= PEN_MIN;
const onBoard = (f: Fit) => f.board;
const always = () => true;

/** The doc's behaviours (§2.2's beat table); big-small is never picked: a style that starts big gets it on sends 1 and 2. */
export const BEATS: Beat[] = [
  { id: "amb-arrow", weight: 1, fits: pen, text: "draw one short arrow between two things, so it's unclear which end is the head. Say which one you meant only in \"meant\".",
    check: (t, c) => draws(t).some((s) => s.draw === "arrow" && Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) / scale(c) >= 40 && Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) / scale(c) <= 120) },
  { id: "amb-shape", weight: 1, fits: pen, text: "sketch one quick shape that could be a box or a circle, over an empty spot where something new should go.",
    check: (t, c) => draws(t).some((s) => (s.draw === "box" || s.draw === "circle") && c.shapes.reduce((a, b) => a + overlap(boxOf(s.draw === "circle" ? s.around : s.box), b), 0) < 0.2 * (s.draw === "circle" ? s.around : s.box)[2] * (s.draw === "circle" ? s.around : s.box)[3]) },
  { id: "two-cand", weight: 1, fits: pen, text: (side) => `say "this" or "that" while pointing between two similar things close together; you mean the ${side} one.`,
    check: (t, c) => POINTING.test(said(t)) && draws(t).some((s) => c.shapes.filter((b) => distance(anchor(s), b) / scale(c) <= 80).length >= 2) },
  { id: "contra", weight: 1, fits: always, text: "ask for something, then contradict part of it in the same breath; the last version is what you mean.",
    check: (t) => says(t).length >= 2 || /\b(no|actually|wait)\b/i.test(said(t)) },
  { id: "mind", weight: 1, fits: (f) => f.send >= 2, text: "take back part of your last ask.",
    check: (t, c) => /\b(back|instead|anymore|no longer|undo|revert|again|not)\b/i.test(t.meant) || (c.lastMeant ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && t.meant.toLowerCase().includes(w)).length >= 2 },
  { id: "pause-fix", weight: 1, fits: always, text: "start a sentence, stop for a long pause of 4 to 8 seconds (a pause step), then correct yourself.",
    check: (t) => t.steps.some((s, i) => "pause" in s && s.pause >= 4 && t.steps.slice(0, i).some((x) => "say" in x) && t.steps.slice(i + 1).some((x) => "say" in x)) },
  { id: "big-small", weight: 0, fits: () => false,
    text: (_, send) => send === 1
      ? "this is your first send: make only the huge, vague ask, a sentence or two, and nothing smaller. Don't narrow it or take any of it back in this send, even if you usually change your mind mid-sentence; you'll press Enter and see what happens first."
      : "first rate the last result honestly. If it gave you what you asked for, stay ambitious and keep building on your big idea. If it disappointed you, scale back one step only: a little smaller or simpler than your last ask, not straight to the minimum, as you slowly realize what it can and can't do.",
    check: (t, c) => c.send > 1 ? says(t).length > 0 : says(t).length >= 1 && says(t).length <= 2 },
  { id: "strange", weight: 1, fits: always, text: "make a mood-like ask instead of naming a part (like \"make it feel like rain\").", check: (t) => says(t).length > 0 },
  // Applies only after a disappointing send (applies()): satisfied drivers have nothing to undo.
  { id: "undo", weight: 2, fits: (f) => f.send >= 2, text: "if the last result wasn't what you meant: undo it first ({\"undo\": true}, alone in a turn), then ask again in other words.",
    check: (t, c) => [...c.looks, t].some((x) => x.steps.some((s) => "undo" in s)) && t.steps.some((s) => "say" in s || "draw" in s) },
  { id: "offscreen", weight: 4, fits: onBoard, text: "refer by name to something on a page you can't see right now.",
    check: (t, c) => c.pages.some((p) => !overlap(p.box, c.view) && new RegExp(`\\b${p.name.replace(/[^\w ]/g, "")}\\b`, "i").test(said(t))) },
  { id: "camera-ask", weight: 4, fits: onBoard, text: "ask the product out loud to show you something.", check: (t) => /\b(show|go to|take me|bring me|jump to)\b/i.test(said(t)) },
  { id: "by-hand", weight: 4, fits: onBoard, text: "scroll or zoom yourself to find what you want first, before you ask.", check: (_, c) => c.looks.some((x) => x.steps.some(isView)) },
  { id: "sketch", weight: 1, fits: pen, text: "sketch a wave, a zigzag or a blob where something goes (a chart, a squiggle, a logo).", check: (t) => draws(t).some((s) => s.draw === "sketch") },
  { id: "no-names", weight: 1.5, fits: (f) => f.clarity <= 0.4, text: "don't name any part of the page; only point and use vague words.", check: (t) => !PART_NOUNS.test(said(t)) },
  { id: "add-new", weight: 1.5, fits: (f) => f.ask === "add", text: "add something that isn't on the page yet, not a change to what's there.",
    check: (t) => PART_NOUNS.test(t.meant) && /\b(add|new|another|extra|put|also)\b/i.test(`${said(t)} ${t.meant}`) },
];
export const beatOf = (id: BeatId) => BEATS.find((b) => b.id === id)!;

export type Planned = { send: number; ask: AskType; beat?: { id: BeatId; text: string; truth?: string } };
const SIDES = ["left", "right", "upper", "lower"];

/** Which ask type and beat each send gets, from the seed alone (the same scenario always gets the same plan). */
export function plan(s: Scenario): Planned[] {
  const r = rng(s.seed ^ 0x2545f491);
  const st = styleOf(s.style);
  // A style that starts big asks for an add on send 1; its other sends take that add out of
  // their share, so its sessions still meet the quotas (as far as an add share allows).
  const q = quotaOf(s.persona);
  const add = st.bigThenSmall && s.sends > 1 ? Math.max(0, (s.sends * q[0] - 1) / (s.sends - 1)) : q[0];
  const rest = q.map((x, i) => (i ? (x * (1 - add)) / (1 - q[0]) : add));
  const used = new Set<BeatId>();
  const out: Planned[] = [];
  for (let send = 1; send <= s.sends; send++) {
    // The same four draws every send, so one choice never reshuffles the next send's.
    const [a, none, pick, side] = [r(), r(), r(), r()];
    const quota = st.bigThenSmall && send > 1 ? rest : q;
    let i = 0;
    for (let acc = quota[0]; acc <= a && i < ASKS.length - 1; acc += quota[++i]);
    let ask = ASKS[i];
    let id: BeatId | undefined;
    if (st.bigThenSmall && send <= 2) {
      // A style that starts too big does so on send 1 (a whole new site: an add) and tones it down on send 2.
      id = "big-small";
      if (send === 1) ask = "add";
    } else if (none >= NO_BEAT) {
      const fit = { send, ask, pen: st.pen, clarity: st.clarity, board: isBoard(s.start) };
      // Board beats may repeat within a session: only the toy-shop starts can carry them.
      const options = BEATS.filter((b) => (!used.has(b.id) || b.fits === onBoard) && b.fits(fit));
      let x = pick * options.reduce((t, b) => t + b.weight, 0);
      id = options.find((b) => (x -= b.weight) < 0)?.id ?? options.at(-1)?.id;
    }
    // Asking again after an undo: the same kind of change.
    if (id === "undo") ask = out[send - 2].ask;
    const b = id && beatOf(id);
    const where = SIDES[Math.floor(side * SIDES.length)];
    out.push({ send, ask, beat: b ? { id: b.id, text: typeof b.text === "string" ? b.text : b.text(where, send), truth: b.id === "two-cand" ? where : undefined } : undefined });
    if (id) used.add(id);
  }
  return out;
}

/** Whether a planned beat is given at all: an undo only after a send rated 3 or less (§2.2); otherwise the send has no beat. */
export const applies = (beat: BeatId | undefined, lastRating?: number) => beat !== "undo" || (lastRating ?? 5) <= 3;

const pad = (n: number) => String(n).padStart(2, "0");
function rows(set: SetId, prefix: string, sends: number, list: [PersonaId, StyleId, StartId, number, TargetId?][]): Scenario[] {
  return list.map(([persona, style, start, seed, target], i) => ({ id: `${prefix}-${target ?? start.replace(":", "-")}-${style.slice(0, 3)}-${pad(i + 1)}`, set, persona, style, target, start, sends, seed }));
}

/** The tuning bank's 32 sessions × 5 sends: first-timers 50% (every tuning target, all styles), explorers and breakers 25% each. */
export const TUNING: Scenario[] = rows("tuning", "t", 5, [
  ["first-timer", "typical", "blank", 1039, "bakery"], ["first-timer", "talker", "blank", 1316, "bakery"], ["first-timer", "pointer", "blank", 1591, "airbnb"],
  ["first-timer", "precise", "blank", 1856, "airbnb"], ["first-timer", "rambler", "blank", 2080, "pricing"], ["first-timer", "typical", "blank", 2499, "pricing"],
  ["first-timer", "talker", "blank", 2705, "music"], ["first-timer", "precise", "blank", 2795, "music"], ["first-timer", "pointer", "blank", 3011, "dentist"],
  ["first-timer", "rambler", "blank", 3250, "dentist"], ["first-timer", "typical", "blank", 3542, "dashboard"], ["first-timer", "precise", "blank", 3821, "dashboard"],
  ["first-timer", "talker", "blank", 4123, "repo"], ["first-timer", "pointer", "blank", 4385, "repo"], ["first-timer", "rambler", "blank", 4670, "bakery"],
  ["first-timer", "typical", "blank", 4798, "music"],
  ["explorer", "typical", "toyshop-home", 5215], ["explorer", "pointer", "toyshop-products", 5264], ["explorer", "talker", "toyshop-zoomed-out", 5567],
  ["explorer", "rambler", "clowns", 5804], ["explorer", "pointer", "clowns", 6000], ["explorer", "typical", "messy", 6417], ["explorer", "rambler", "messy", 6665],
  ["explorer", "talker", "blank", 6770],
  ["breaker", "precise", "toyshop-home", 7083], ["breaker", "typical", "toyshop-products", 7492], ["breaker", "pointer", "toyshop-zoomed-out", 7672],
  ["breaker", "pointer", "toyshop-home", 7924], ["breaker", "typical", "clowns", 8227], ["breaker", "precise", "clowns", 8270], ["breaker", "pointer", "messy", 8519],
  ["breaker", "precise", "messy", 8829],
]);

/**
 * Held-out sessions (8 × 4 sends each): held-out-only targets, starts and seeds, never shown
 * to the optimizer. First-timers come first in each list: the page each has built after send 3
 * becomes the site:<target> start of the explorers and breakers after it (§2.1).
 */
export const HELDOUT_GATE: Scenario[] = rows("heldout-gate", "g", 4, [
  ["first-timer", "typical", "blank", 9055, "notion"], ["first-timer", "rambler", "blank", 9071, "uber"],
  ["explorer", "pointer", "toyshop-cart", 9161], ["explorer", "typical", "messy-zoomed-out", 9232], ["explorer", "talker", "site:notion", 9251],
  ["breaker", "typical", "toyshop-cart", 9350], ["breaker", "precise", "grid", 9427], ["breaker", "pointer", "toyshop-cart", 9436],
]);
/** The chart's held-out line (B1 only, never a decision): explorers and breakers on held-out content only, grid and site:<target>. */
export const HELDOUT_CHART: Scenario[] = rows("heldout-chart", "c", 4, [
  ["first-timer", "pointer", "blank", 9532, "lesson"], ["first-timer", "precise", "blank", 9572, "notion"], ["first-timer", "typical", "blank", 9663, "uber"],
  ["first-timer", "rambler", "blank", 9710, "lesson"],
  ["explorer", "talker", "grid", 9793], ["explorer", "pointer", "site:lesson", 9810],
  ["breaker", "typical", "grid", 9910], ["breaker", "precise", "site:uber", 9944],
]);

/**
 * A weekly refresh's 8 new sessions (40 cases) from the same table: half first-timers (half of
 * them on their own resume:<target> page), a quarter each explorers and breakers; seeds ≥ 20000.
 */
export function fresh(refresh: number): Scenario[] {
  const r = rng(0x51ed270b ^ refresh);
  const of = <T>(list: T[]) => list[Math.floor(r() * list.length)];
  const targets = TARGETS.filter((t) => !t.heldOut).map((t) => t.id);
  const list: [PersonaId, StyleId, StartId, number, TargetId?][] = [];
  for (let i = 0; i < 8; i++) {
    const persona: PersonaId = i < 4 ? "first-timer" : i < 6 ? "explorer" : "breaker";
    const target = persona === "first-timer" ? of(targets) : undefined;
    const start = target ? (i % 2 ? `resume:${target}` as const : "blank") : of(COHERENT[persona].starts);
    list.push([persona, of(COHERENT[persona].styles), start, 20000 + refresh * 100 + i, target]);
  }
  return rows("fresh", `f${refresh}`, 5, list);
}

/** Why a scenario breaks the coherence table (§2.2), or undefined when it holds. */
export function incoherent(s: Scenario): string | undefined {
  const c = COHERENT[s.persona];
  const held = s.set === "heldout-gate" || s.set === "heldout-chart";
  if (!c.styles.includes(s.style)) return `a ${s.persona} isn't ${s.style}`;
  if (s.persona === "breaker" && styleOf(s.style).pen < PEN_MIN) return "a breaker needs the pen";
  if (s.persona === "first-timer") {
    if (!s.target) return "a first-timer has a target";
    if (targetOf(s.target).heldOut !== held) return `${s.target} is ${held ? "not " : ""}a held-out target`;
    if (s.start !== "blank" && !(s.set === "fresh" && s.start === `resume:${s.target}`)) return `a first-timer starts blank (or on its own resume page in a refresh), not on ${s.start}`;
    return;
  }
  if (s.target) return "only first-timers have a target";
  if (!(held ? c.heldOutStarts : c.starts).includes(s.start)) return `${s.start} isn't a ${held ? "held-out" : "tuning"} start for a ${s.persona}`;
  if (s.set === "heldout-chart" && s.start !== "grid" && !s.start.startsWith("site:")) return "the chart's explorers and breakers start on held-out content only";
}

/** Why a held-out list can't be built in order: a site:<target> start before a first-timer of that target has made it. */
export function outOfOrder(list: Scenario[]): string | undefined {
  const made = new Set<string>();
  for (const s of list) {
    if (s.start.startsWith("site:") && !made.has(s.start.slice(5))) return `${s.id} starts on ${s.start} before any first-timer built it`;
    if (s.persona === "first-timer" && s.target) made.add(s.target);
  }
}

// ---- The §2.3 gates: checked at bank build and refresh; the bank is refused if any fails.

/** One banked case as the gates read it (drive.ts and bank.ts fill it from the case files). */
export type GateCase = {
  set: SetId; persona: PersonaId; start: StartId; send: number; ask: AskType;
  /** The beat given (after applies()), and whether its check passed. */
  beat?: BeatId; complied: boolean;
  hedged: boolean; void: boolean;
  /** The driver's first words this send. */
  opener: string;
  /** The shape the send's first mark or the resolver's answer points at (first asks on a non-blank start). */
  firstTarget?: string;
};
export const GATES = { beatT: 6, beatH: 2, askT: 10, personaT: 30, familyT: 15, compliance: 0.8, targetShare: 0.4, targetMinAsks: 5, askBand: 0.1, opener: 0.15, hedged: 0.1, voids: 0.05 };
export const familyOf = (s: StartId) => (s.startsWith("toyshop") ? "toyshop" : s.startsWith("messy") ? "messy" : s.split(":")[0]);
const OPENER = /^(okay|ok)\b[\s,.]*so\b/i;

/** Every §2.3 gate the cases fail (none: the bank may be used). */
export function gates(cases: GateCase[]): string[] {
  const fails: string[] = [];
  const ok = cases.filter((c) => !c.void);
  const T = ok.filter((c) => c.set === "tuning" || c.set === "fresh");
  const H = ok.filter((c) => c.set === "heldout-gate" || c.set === "heldout-chart");
  const share = (n: number, of: number) => (of ? n / of : 0);
  for (const b of BEATS) {
    const n = (cs: GateCase[]) => cs.filter((c) => c.beat === b.id && c.complied).length;
    if (n(T) < GATES.beatT) fails.push(`beat ${b.id}: ${n(T)} complied tuning cases (< ${GATES.beatT})`);
    if (H.length && n(H) < GATES.beatH) fails.push(`beat ${b.id}: ${n(H)} complied held-out cases (< ${GATES.beatH})`);
  }
  for (const a of ASKS) if (T.filter((c) => c.ask === a).length < GATES.askT) fails.push(`ask ${a}: < ${GATES.askT} tuning cases`);
  for (const p of ["first-timer", "explorer", "breaker"] as PersonaId[]) if (T.filter((c) => c.persona === p).length < GATES.personaT) fails.push(`persona ${p}: < ${GATES.personaT} tuning cases`);
  for (const f of ["blank", "toyshop", "clowns", "messy"]) if (T.filter((c) => familyOf(c.start) === f).length < GATES.familyT) fails.push(`start ${f}: < ${GATES.familyT} tuning cases`);
  const beaten = ok.filter((c) => c.beat);
  if (share(beaten.filter((c) => c.complied).length, beaten.length) < GATES.compliance) fails.push(`beat compliance ${beaten.filter((c) => c.complied).length}/${beaten.length} (< ${GATES.compliance})`);
  // Target spread: a start screen whose first asks pile on one shape (measured once it has enough first asks).
  for (const start of new Set(ok.map((c) => c.start))) {
    const firsts = ok.filter((c) => c.start === start && c.send === 1 && c.firstTarget);
    const top = Math.max(0, ...[...new Set(firsts.map((c) => c.firstTarget))].map((t) => firsts.filter((c) => c.firstTarget === t).length));
    if (firsts.length >= GATES.targetMinAsks && share(top, firsts.length) > GATES.targetShare) fails.push(`start ${start}: one shape is the target of ${top}/${firsts.length} first asks`);
  }
  ASKS.forEach((a, i) => {
    const want = share(T.reduce((s, c) => s + quotaOf(c.persona)[i], 0), T.length);
    const got = share(T.filter((c) => c.ask === a).length, T.length);
    if (Math.abs(got - want) > GATES.askBand) fails.push(`ask ${a}: ${Math.round(got * 100)}% of tuning cases against a quota of ${Math.round(want * 100)}%`);
  });
  if (share(ok.filter((c) => OPENER.test(c.opener.trim())).length, ok.length) >= GATES.opener) fails.push(`"okay so" opens ${ok.filter((c) => OPENER.test(c.opener.trim())).length}/${ok.length} sends`);
  if (share(ok.filter((c) => c.hedged).length, ok.length) > GATES.hedged) fails.push(`hedged meant on ${ok.filter((c) => c.hedged).length}/${ok.length} cases`);
  if (share(cases.length - ok.length, cases.length) > GATES.voids) fails.push(`voids ${cases.length - ok.length}/${cases.length}`);
  return fails;
}
