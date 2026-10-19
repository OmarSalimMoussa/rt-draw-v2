// Words plus ink → the shape ids they mean ("this headline" + a loop → hero-title).
// Two steps: plan() is free and instant (hit-test, word overlap, and the ink-first
// rule that settles clear pointing without a model); resolve() asks a small model
// only when the plan can't settle it: Claude, or Jev (one yes/no per candidate
// shape, src/core/decide.ts), or Jev with Claude for the shapes it's unsure of
// (resolve.engine).
import type { TraceContext } from "./trace.ts";
import type { HitIndex } from "./hittest.ts";
import type { Stroke } from "./ink.ts";
import { DEICTIC, type Word, linkInk } from "./link.ts";
import { type Mark, type Reading, readMark } from "./marks.ts";
import { type Decision, type YesNo, decide } from "./decide.ts";
import { type ModelStats, callModel, jevOf, modelOf } from "./model.ts";
import type { Scene } from "./scene.ts";
import { pageName, pageOf, pagesOf } from "./board.ts";
import { promptOf, thinkingOf } from "./prompts.ts";
import { takeShot } from "./shot.ts";
import type { Tuning } from "./tuning.ts";

/** Plural pointing words: a loop around several shapes means all of them. */
const PLURAL = new Set(["these", "those"]);
const STOP = new Set(["the", "a", "an", "and", "to", "of", "on", "in", "it", "this", "that", "these", "those", "here", "there", "make", "be", "should", "bit", "more", "one", "some", "all", "put", "move", "change", "my", "me", "is", "with", "at", "by", "for", "over", "so"]);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 -]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/s$/, ""));
const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");

export type Ref = { phrase: string; ids: string[] };
export type Plan = {
  /** The [ink n] transcript and each mark's reading, as the model would get them. */
  transcript: string;
  readings: Reading[];
  /** Shapes offered to the model: ink hits first, then by word overlap. */
  candidates: string[];
  /** The same, as many as Jev is asked about (resolve.jevMaxCandidates). */
  jevCandidates: string[];
  /** Set when the ink settles it with no model call. */
  inkIds?: string[];
  why: string;
  features: Record<string, number | string>;
};
/** Jev's part: each candidate's probability, the ones it was unsure of, and the call. */
export type JevPart = { yes: Record<string, number | undefined>; unsure: string[]; error?: string } & Partial<Pick<Decision, "stats" | "reply" | "prompt">>;
export type Resolution = Plan & {
  ids: string[]; refs: Ref[]; via: "ink" | "model" | "jev"; prompt?: { system: string; user: string; images: number }; reply?: string; stats?: ModelStats;
  /** Set when Jev was asked (resolve.engine 1 or 2), whoever decided. */
  jev?: JevPart;
  /** Shapes Jev was unsure of, most likely first, when it decided and resolve.jevHints is on. */
  hints?: { id: string; p: number }[];
};

/** What a mark clearly points at, or nothing when it's not clear. */
function clearTargets(r: Reading, plural: boolean): string[] | undefined {
  if (r.kind !== "pointing") return undefined;
  if (r.how === "tap" && r.targets.length === 1) return r.targets;
  if (r.how === "loop" && (r.targets.length === 1 || (plural && r.targets.length > 1))) return r.targets;
  if (r.how === "arrow" && r.from) return typeof r.to === "string" ? [r.from, r.to] : [r.from];
  return undefined;
}

export function plan(words: Word[], marks: Mark[], scene: Scene, hits: HitIndex, t: Tuning): Plan {
  const { text: transcript } = linkInk(words, marks, t);
  const readings = marks.map((m) => readMark(m, hits, t));
  const said = words.map((w) => clean(w.word));
  const deictic = said.filter((w) => DEICTIC.has(w));
  const plural = said.some((w) => PLURAL.has(w));

  // Candidates: what the ink hit, front first, then every other shape by how many of the words it shares.
  const fromInk = [...new Set(readings.flatMap((r) => [...r.targets, ...(typeof r.to === "string" ? [r.to] : [])]))];
  const want = new Set(tokens(said.join(" ")));
  const overlap = (id: string) => {
    const s = scene.get(id)!;
    const have = new Set(tokens(`${id} ${s.description} ${s.drawing ?? ""} ${s.text?.words ?? ""}`));
    return [...want].filter((w) => have.has(w)).length;
  };
  const rest = scene.stacked().map((s) => s.id).filter((id) => !fromInk.includes(id)).map((id) => ({ id, score: overlap(id) })).sort((a, b) => b.score - a.score);
  // On a board, every page is offered too: there are few, and "where you pay" may share no word with the cart page.
  const pages = pagesOf(scene).map((p) => p.id).filter((id) => !fromInk.includes(id));
  const ranked = [...fromInk, ...rest.map((r) => r.id).filter((id) => !pages.includes(id))];
  const candidates = ranked.slice(0, t["resolve.maxCandidates"]).concat(pages);
  const jevCandidates = ranked.slice(0, t["resolve.jevMaxCandidates"]).concat(pages);
  const features: Record<string, number | string> = { marks: marks.length, deictic: deictic.length, plural: plural ? 1 : 0, inkHits: fromInk.length, topOverlap: rest[0]?.score ?? 0, candidates: candidates.length, readings: readings.map((r) => r.how).join(" ") };

  // Ink first: pointing words, and every mark clearly on its shape(s).
  if (t["resolve.inkFirst"] && marks.length && deictic.length) {
    const clear = readings.map((r) => clearTargets(r, plural));
    if (clear.every(Boolean)) {
      const ids = [...new Set(clear.flatMap((c) => c!))];
      return { transcript, readings, candidates, jevCandidates, inkIds: ids, why: `ink settles it: ${readings.map((r, i) => `${r.how} → ${clear[i]!.join(", ")}`).join("; ")}, with "${deictic.join('", "')}"`, features };
    }
    features.unclear = readings.filter((_, i) => !clear[i]).map((r) => r.how).join(" ");
  }
  const why = !marks.length ? "no ink: the words decide" : !deictic.length ? "ink but no pointing word: ask the model" : `ink not clear (${features.unclear}): ask the model`;
  return { transcript, readings, candidates, jevCandidates, why, features };
}

/** One candidate as the model reads it: id (kind, box) page: description. */
function shapeLine(id: string, scene: Scene): string {
  const s = scene.get(id)!;
  const { x, y, w, h } = s.box;
  const page = s.kind === "frame" ? ` page "${pageName(s)}"` : pageOf(scene, s) ? ` on page ${pageOf(scene, s)!.id}` : "";
  return `${id} (${s.kind === "frame" ? "page" : s.kind}, ${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)})${page}: ${s.description}`;
}

/** The model's question, built from the plan (Jev's request lists its own candidates). */
export function prompt(p: Plan, scene: Scene, candidates = p.candidates): string {
  const shapes = candidates.map((id) => `- ${shapeLine(id, scene)}`);
  const ink = p.readings.map((r, i) => {
    const what = r.how === "arrow" ? `arrow from ${r.from ?? "empty space"} to ${typeof r.to === "string" ? r.to : r.to ? `empty space at ${Math.round(r.to.x)} ${Math.round(r.to.y)}` : "?"}` : r.how === "loop" ? `loop around ${r.targets.join(", ") || "nothing"}` : r.how === "tap" ? `tap on ${r.targets[0] ?? "empty space"}` : `${r.how}${r.targets.length ? ` over ${r.targets.join(", ")}` : ""}${r.inside ? ` inside ${r.inside}` : ""}`;
    return `[ink ${i + 1}] ${what}`;
  });
  return `Shapes:\n${shapes.join("\n")}\n\nSaid: ${p.transcript}\n\nInk:\n${ink.join("\n") || "(none)"}`;
}

/** The refs in a reply; ids not on the canvas are dropped (and counted). */
export function parseReply(reply: string, scene: Scene): { refs: Ref[]; dropped: number } {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let refs: Ref[] = [];
  try {
    refs = ((JSON.parse(json) as { refs?: Ref[] }).refs ?? []).map((r) => ({ phrase: String(r.phrase ?? ""), ids: (r.ids ?? []).map(String) }));
  } catch {
    return { refs: [], dropped: 0 };
  }
  let dropped = 0;
  for (const r of refs) {
    const before = r.ids.length;
    r.ids = r.ids.filter((id) => scene.get(id));
    dropped += before - r.ids.length;
  }
  return { refs, dropped };
}

export async function resolve(words: Word[], strokes: Stroke[], marks: Mark[], scene: Scene, hits: HitIndex, t: Tuning, from = "resolve", parent?: TraceContext): Promise<Resolution> {
  const p = plan(words, marks, scene, hits, t);
  if (p.inkIds) return { ...p, ids: p.inkIds, refs: [{ phrase: "(ink)", ids: p.inkIds }], via: "ink" };
  const engine = Math.round(t["resolve.engine"]);
  if (engine !== 1 && engine !== 2) return askClaude(p, strokes, scene, t, from, parent);
  // Racing: Claude starts now, and its answer is only used if Jev turns out unsure.
  const raced = engine === 2 && t["resolve.jevRace"] ? askClaude(p, strokes, scene, t, from, parent) : undefined;
  const jev = await askJev(p, scene, t, `${from}-jev`, parent);
  const features = { ...p.features, engine, jevShapes: p.jevCandidates.length, jevUnsure: jev.unsure.length, jevMs: jev.stats?.ms ?? 0, jevError: jev.error ? 1 : 0 };
  // Jev failed, or (engine 2) was unsure of a shape: Claude decides.
  if (jev.error || (engine === 2 && jev.unsure.length)) {
    const c = await (raced ?? askClaude(p, strokes, scene, t, from, parent));
    return { ...c, jev, features: { ...c.features, ...features } };
  }
  raced?.catch(() => {});
  const ids = p.jevCandidates.filter((id) => (jev.yes[id] ?? 0) >= t["resolve.jevYes"]);
  const hints = t["resolve.jevHints"] ? jev.unsure.filter((id) => !ids.includes(id) && (jev.yes[id] ?? 0) >= t["resolve.jevHintMin"]).map((id) => ({ id, p: jev.yes[id]! })).sort((a, b) => b.p - a.p) : undefined;
  return { ...p, ids, refs: ids.length ? [{ phrase: "(their words and ink)", ids }] : [], via: "jev", jev, hints, prompt: { system: "", user: jev.prompt!.user, images: 0 }, reply: jev.reply, stats: jev.stats, features: { ...features, refs: ids.length ? 1 : 0, droppedIds: 0 } };
}

/** Jev's yes/no per candidate; a failed call comes back as its error (Claude then decides). */
async function askJev(p: Plan, scene: Scene, t: Tuning, from: string, parent?: TraceContext): Promise<JevPart> {
  const v = promptOf("resolveJev", t);
  const questions: Record<string, YesNo> = Object.fromEntries(p.jevCandidates.map((id) => [id, { type: "noul", instructions: v.question(shapeLine(id, scene)), criteria: { yes: v.yes, no: v.no } }]));
  try {
    const d = await decide(jevOf(t["resolve.jevModel"]), { task: v.task, request: prompt(p, scene, p.jevCandidates) }, questions, from, parent);
    const unsure = p.jevCandidates.filter((id) => d.yes[id] === undefined || Math.abs(d.yes[id]! - t["resolve.jevYes"]) < t["resolve.jevSure"]);
    return { yes: d.yes, unsure, stats: d.stats, reply: d.reply, prompt: d.prompt };
  } catch (err) {
    return { yes: {}, unsure: [...p.jevCandidates], error: err instanceof Error ? err.message : String(err) };
  }
}

async function askClaude(p: Plan, strokes: Stroke[], scene: Scene, t: Tuning, from: string, parent?: TraceContext): Promise<Resolution> {
  const user = prompt(p, scene);
  const images = t["resolve.sendScreenshot"] ? [(await takeShot(scene, strokes, t)).dataUrl] : [];
  const system = promptOf("resolve", t).system;
  const { text, stats } = await callModel({ model: modelOf(t["resolve.model"]), system, user, images, from, ...thinkingOf("resolve", t) }, undefined, undefined, parent);
  const { refs, dropped } = parseReply(text, scene);
  const ids = [...new Set(refs.flatMap((r) => r.ids))];
  return { ...p, ids, refs, via: "model", prompt: { system, user, images: images.length }, reply: text, stats, features: { ...p.features, refs: refs.length, droppedIds: dropped } };
}

/** Exact match: the same set of ids. */
export const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

// ---- Cases: ink given as simple geometry, turned into timed strokes.

export type InkSpec = { loop: [number, number, number, number] } | { tap: [number, number] } | { arrow: [[number, number], [number, number]] } | { line: [[number, number], [number, number]] };
export type Case = { words: string; ink: InkSpec[]; expect: string[]; note?: string };

/** ms between spoken words in a case. */
const WORD_MS = 380;

/** A case's words with times, and its ink drawn at its pointing words (k-th mark at the k-th pointing word). */
export function caseInput(c: Case): { words: Word[]; strokes: Stroke[] } {
  const words: Word[] = c.words.split(/\s+/).filter(Boolean).map((word, i) => ({ word, t0: 200 + i * WORD_MS, t1: 200 + i * WORD_MS + WORD_MS - 80 }));
  const pointAt = words.map((w, i) => (DEICTIC.has(clean(w.word)) ? i : -1)).filter((i) => i >= 0);
  let id = 1;
  const strokes: Stroke[] = [];
  let prevEnd = -Infinity;
  c.ink.forEach((spec, k) => {
    const wi = pointAt[k] ?? pointAt.at(-1) ?? Math.min(k, words.length - 1);
    // Pen down a little before the word's middle, and never within 900 ms of the last mark (it would join it).
    let at = Math.max(words[wi] ? words[wi].t0 : 0, prevEnd + 900);
    const mk = (pts: [number, number][], msEach = 12) => {
      const s: Stroke = { id: id++, points: pts.map(([x, y], i) => [x, y, at + i * msEach]), t0: at, t1: at + (pts.length - 1) * msEach };
      at = s.t1 + 150;
      strokes.push(s);
    };
    const line = (a: [number, number], b: [number, number], n = 24) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as [number, number]);
    if ("loop" in spec) {
      const [x, y, w, h] = spec.loop;
      const [cx, cy, rx, ry] = [x + w / 2, y + h / 2, (w / 2) * 1.5 + 8, (h / 2) * 1.5 + 8];
      mk(Array.from({ length: 41 }, (_, i) => [cx + rx * Math.cos((i / 40) * 2.06 * Math.PI), cy + ry * Math.sin((i / 40) * 2.06 * Math.PI)] as [number, number]));
    } else if ("tap" in spec) mk([spec.tap, [spec.tap[0] + 0.5, spec.tap[1] + 0.5]], 60);
    else if ("line" in spec) mk(line(spec.line[0], spec.line[1]));
    else {
      const [a, b] = spec.arrow;
      mk(line(a, b));
      // The head: a V back from the tip, about 26 px each side at 30°.
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const barb = (s: number): [number, number] => [b[0] - 26 * Math.cos(ang + s), b[1] - 26 * Math.sin(ang + s)];
      mk([...line(barb(0.5), b, 5), ...line(b, barb(-0.5), 5)]);
    }
    prevEnd = strokes.at(-1)!.t1;
  });
  return { words, strokes };
}
