// The search's building blocks (LOOP-V2.md D): knob literals in tuning.ts, sweeps run as knob cards with pruning,
// combos of tried patches, and the near wins the analyst reads. run.ts calls them; t18 checks them at 0 calls.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROMPT_KNOB } from "../../src/core/prompts.ts";
import { LOOP } from "./config.ts";
import type { CardState } from "./state.ts";
import type { Code, DecisionRow, HypothesisCard } from "./types.ts";

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** Vetoes (verdict.ts): the change did harm somewhere, whatever its score. */
const VETO: Code[] = ["latency", "empty", "pictures", "deferred", "heldout", "direction", "continuation", "schedule"];
/** A latency value's clear loss: a veto on speed, empty sends or failed pictures (not G3's direction rule). */
const LAT_VETO: Code[] = ["latency", "empty", "pictures"];
/** A decision's codes: its own, or for a row written before them (2026-10-26), read off its reasons' words as the loop then read them. */
function codesOf(d: DecisionRow): Code[] {
  if (d.codes) return d.codes;
  const said = (re: RegExp) => d.reasons.some((r) => re.test(r));
  return [
    ...(said(/latency veto/) ? (["latency"] as const) : []), ...(said(/empty sends/) ? (["empty"] as const) : []),
    ...(said(/failed pictures/) ? (["pictures"] as const) : []), ...(said(/held-out/) ? (["heldout"] as const) : []),
    ...(said(/no change/) ? (["no-change"] as const) : []), ...(said(/fidelity Z|costs fidelity/) ? (["floor"] as const) : []),
  ];
}
const has = (d: DecisionRow, codes: Code[]) => codesOf(d).some((c) => codes.includes(c));

/** A knob's default as tuning.ts writes it: its text, value and range, and the text that sets it to v. Undefined when it has no literal default. */
export function knobLiteral(src: string, key: string): { text: string; value: number; min: number; max: number; set: (v: number) => string } | undefined {
  const k = key.replace(/\./g, "\\.");
  const lit = new RegExp(`(\\b(K|B)\\("${k}",\\s*)(-?[\\d.]+)(,\\s*(-?[\\d.]+),\\s*(-?[\\d.]+))?`).exec(src);
  if (lit) {
    const [min, max] = lit[2] === "B" ? [0, 1] : [Number(lit[5]), Number(lit[6])];
    return { text: lit[0], value: Number(lit[3]), min, max, set: (v) => `${lit[1]}${v}${lit[4] ?? ""}` };
  }
  // A prompt knob's default is P("role") or P("role", n) (older trees: { ...P("role"), value: n }).
  const role = Object.entries(PROMPT_KNOB).find(([, x]) => x === key)?.[0];
  const variant = role && new RegExp(`\\{ \\.\\.\\.P\\("${role}"\\), value: ([\\d.]+) \\}|\\bP\\("${role}"(?:,\\s*([\\d.]+))?\\)`).exec(src);
  if (variant) return { text: variant[0], value: Number(variant[1] ?? variant[2] ?? 0), min: 0, max: Infinity, set: (v) => `P("${role}", ${v})` };
}

/** A knob card's commit: the defaults in tuning.ts set to the card's values, within each knob's range. */
export function applyKnobs(wt: string, knobs: Record<string, number>) {
  const file = join(wt, "src/core/tuning.ts");
  let src = readFileSync(file, "utf8");
  for (const [key, v] of Object.entries(knobs)) {
    const lit = knobLiteral(src, key);
    if (!lit) throw new Error(`no knob ${key} with a literal default in src/core/tuning.ts`);
    if (!(v >= lit.min && v <= lit.max)) throw new Error(`knob ${key} = ${v} is outside its range ${lit.min}–${lit.max}`);
    src = src.replace(lit.text, lit.set(v));
  }
  writeFileSync(file, src);
}

/**
 * A combo card's change (LOOP-V2.md D4): the tried cards' patches (history's tried/<id>.patch) applied in turn on
 * the champion, each with a three-way merge, as they were measured. One that no longer applies drops the card.
 */
export function applyTried(wt: string, ids: string[], history: string, tmp: string) {
  for (const id of ids) {
    const f = join(history, "tried", `${id}.patch`);
    if (!existsSync(f)) throw new Error(`no tried card ${id}`);
    const text = readFileSync(f, "utf8");
    const body = text.slice(text.indexOf("\n---\n") + 5);
    if (!body.startsWith("From ")) throw new Error(`tried card ${id} changed nothing`);
    const patch = join(tmp, `combo-${id}.patch`);
    mkdirSync(dirname(patch), { recursive: true });
    writeFileSync(patch, body);
    try {
      git(wt, "apply", "--3way", patch);
    } catch (err) {
      throw new Error(`tried card ${id} doesn't apply on today's champion: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    } finally {
      rmSync(patch, { force: true });
    }
  }
}

/**
 * The epoch's cards as the coordinator runs them: a sweep becomes one knob card per value (LOOP-V2.md D3), nearest
 * the champion's value first, each knowing its side of it and how far, so a keep ends the sweep and a clear loss
 * prunes the values beyond it on its side. `tuning` is the champion's tuning.ts. A sweep of a knob with no literal
 * default comes back in `dropped`.
 */
export function cardStates(epoch: number, cards: HypothesisCard[], tuning: string): { cards: CardState[]; dropped: string[] } {
  const dropped: string[] = [];
  const out = cards.flatMap((card, i): CardState[] => {
    const id = `e${epoch}-h${i + 1}`;
    if (card.kind !== "sweep" || !card.sweep) return [{ id, card, branch: `cand/${id}`, status: "todo" }];
    const { knob, values } = card.sweep;
    const base = knobLiteral(tuning, knob)?.value;
    if (base === undefined) {
      dropped.push(`${id}: a sweep of ${knob}, which has no literal default in tuning.ts`);
      return [];
    }
    const near = [...new Set(values)].filter((v) => v !== base).sort((a, b) => Math.abs(a - base) - Math.abs(b - base));
    return near.map((v, j) => {
      const vid = `${id}${String.fromCharCode(97 + j)}`;
      // The values run (the champion's aside): how many share the sweep's error (verdict.ts familyOf).
      return { id: vid, card: { ...card, id: vid, kind: "knob", knobs: { [knob]: v }, sweep: { knob, values: near }, change: `${card.change} (${knob} = ${v})` }, branch: `cand/${vid}`, status: "todo", sweep: { of: id, side: Math.sign(v - base), distance: Math.abs(v - base) } };
    });
  });
  return { cards: out, dropped };
}

/**
 * Why a sweep's value isn't run: another value already kept, or one nearer the champion's on its side lost clearly (a
 * veto, or a quality card's fidelity Z at or under LOOP.search.pruneZ at the first look: Rule F's own first-look revert,
 * at -0.2, takes a neutral value 40% of the time). A latency value prunes only on a veto (LAT_VETO): its first-look
 * revert (every ratio over 1.0 at 16 cases) takes a value with no effect 44% of the time and one 5% faster 23%, and G3's
 * direction rule isn't a clear loss either.
 */
export function sweepSkip(cards: CardState[], c: CardState, decisions: DecisionRow[]): string | undefined {
  if (!c.sweep) return undefined;
  const sibs = cards.filter((x) => x !== c && x.sweep?.of === c.sweep!.of && x.status === "done");
  const kept = sibs.find((x) => x.verdict === "keep");
  if (kept) return `the sweep kept ${kept.id}`;
  const lost = sibs.find((x) => {
    const d = decisions.findLast((r) => r.id === x.id);
    const clear = !!d && d.verdict === "revert" && d.class !== "N" && (d.goal === "latency" ? has(d, LAT_VETO) : has(d, VETO) || (d.looks.length === 1 && d.looks[0].z <= LOOP.search.pruneZ));
    return x.sweep!.side === c.sweep!.side && x.sweep!.distance < c.sweep!.distance && clear;
  });
  return lost ? `pruned: ${lost.id}, nearer the champion's value on this side, lost clearly` : undefined;
}

/**
 * Reverted cards that leaned the right way without proving it (LOOP-V2.md D1), newest first: more wins than losses,
 * or a latency card faster on its metric, with no veto against them. The critic may combine or retry them.
 */
export function nearWins(decisions: DecisionRow[]): string[] {
  return decisions
    // Not one a veto, a fidelity floor or "no change" reverted: those leaned the wrong way, or nowhere.
    .filter((d) => d.kind === "card" && d.verdict === "revert" && d.class !== "N" && !has(d, [...VETO, "floor", "no-change"]))
    .filter((d) => (d.goal === "latency" ? (d.latency[d.card?.metric === "render" ? "render" : "ttfd"]?.est ?? 1) < 1 : d.counts.wins > d.counts.losses))
    .slice(-LOOP.search.nearWins)
    .reverse()
    .map((d) => {
      const lat = [d.latency.ttfd && `first drawing ×${d.latency.ttfd.est.toFixed(2)}`, d.latency.render && `render ×${d.latency.render.est.toFixed(2)}`].filter(Boolean).join(", ");
      return `${d.id} (${d.card?.kind} ${d.card?.component}, ${d.goal}) ${d.card?.change}: ${d.counts.wins}-${d.counts.losses}-${d.counts.ties} at look ${d.looks.at(-1)?.n ?? "-"}${lat ? `, ${lat}` : ""} → ${d.reasons.join("; ")}`;
    });
}
