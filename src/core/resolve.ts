// Words plus ink → the shape ids they mean ("this headline" + a loop → hero-title).
// Two steps: plan() is free and instant (hit-test, word overlap, and the ink-first
// rule that settles clear pointing without a model); resolve() asks a small model
// only when the plan can't settle it.
import type { HitIndex } from "./hittest.ts";
import type { Stroke } from "./ink.ts";
import { DEICTIC, type Word, linkInk } from "./link.ts";
import { type Mark, type Reading, readMark } from "./marks.ts";
import { type ModelStats, callModel, modelOf } from "./model.ts";
import type { Scene } from "./scene.ts";
import { takeShot } from "./shot.ts";
import type { Tuning } from "./tuning.ts";

export const RESOLVE_SYSTEM = `You work out which shapes on a canvas a person means.
You get: the shapes that could be meant (id, kind, box as x y w h in pixels, and a description), what the person said with [ink n] at the moment they drew mark n, and what each mark is (a loop around shapes, an arrow from one place to another, a tap on a shape, a line).
Return only JSON, no prose: {"refs": [{"phrase": "this headline", "ids": ["hero-title"]}]}
One entry per phrase that refers to shapes on the canvas ("this", "that one", "the photo", "these three", "over there"), with every id it means. Use only ids from the list. Ink settles which one; words settle how many and what kind. Leave out phrases that refer to nothing on the canvas.`;

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
  /** Set when the ink settles it with no model call. */
  inkIds?: string[];
  why: string;
  features: Record<string, number | string>;
};
export type Resolution = Plan & { ids: string[]; refs: Ref[]; via: "ink" | "model"; prompt?: { system: string; user: string; images: number }; reply?: string; stats?: ModelStats };

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
  const candidates = [...fromInk, ...rest.map((r) => r.id)].slice(0, t["resolve.maxCandidates"]);
  const features: Record<string, number | string> = { marks: marks.length, deictic: deictic.length, plural: plural ? 1 : 0, inkHits: fromInk.length, topOverlap: rest[0]?.score ?? 0, candidates: candidates.length, readings: readings.map((r) => r.how).join(" ") };

  // Ink first: pointing words, and every mark clearly on its shape(s).
  if (t["resolve.inkFirst"] && marks.length && deictic.length) {
    const clear = readings.map((r) => clearTargets(r, plural));
    if (clear.every(Boolean)) {
      const ids = [...new Set(clear.flatMap((c) => c!))];
      return { transcript, readings, candidates, inkIds: ids, why: `ink settles it: ${readings.map((r, i) => `${r.how} → ${clear[i]!.join(", ")}`).join("; ")}, with "${deictic.join('", "')}"`, features };
    }
    features.unclear = readings.filter((_, i) => !clear[i]).map((r) => r.how).join(" ");
  }
  const why = !marks.length ? "no ink: the words decide" : !deictic.length ? "ink but no pointing word: ask the model" : `ink not clear (${features.unclear}): ask the model`;
  return { transcript, readings, candidates, why, features };
}

/** The model's question, built from the plan. */
export function prompt(p: Plan, scene: Scene): string {
  const shapes = p.candidates.map((id) => {
    const s = scene.get(id)!;
    const { x, y, w, h } = s.box;
    return `- ${id} (${s.kind}, ${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}): ${s.description}`;
  });
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

export async function resolve(words: Word[], strokes: Stroke[], marks: Mark[], scene: Scene, hits: HitIndex, t: Tuning, from = "resolve"): Promise<Resolution> {
  const p = plan(words, marks, scene, hits, t);
  if (p.inkIds) return { ...p, ids: p.inkIds, refs: [{ phrase: "(ink)", ids: p.inkIds }], via: "ink" };
  const user = prompt(p, scene);
  const images = t["resolve.sendScreenshot"] ? [(await takeShot(scene, strokes, t)).dataUrl] : [];
  const { text, stats } = await callModel({ model: modelOf(t["resolve.model"]), system: RESOLVE_SYSTEM, user, images, from });
  const { refs, dropped } = parseReply(text, scene);
  const ids = [...new Set(refs.flatMap((r) => r.ids))];
  return { ...p, ids, refs, via: "model", prompt: { system: RESOLVE_SYSTEM, user, images: images.length }, reply: text, stats, features: { ...p.features, refs: refs.length, droppedIds: dropped } };
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
