// Free checks for a real-use case (evals/real/README.md): code that reads a result board and says whether it
// did a thing triage saw it fail at, so a case can fail without a judge call. Gold picks them from CHECK_MENU;
// each is about what the person asked for, never about how gold itself drew it.
import type { SceneJSON } from "../loop/types.ts";

type Shape = SceneJSON["shapes"][number];
type Box = Shape["box"];

export type Check =
  | { type: "picture-for"; words: string[] }
  | { type: "single-picture"; words: string[] }
  | { type: "no-parts"; words: string[] }
  | { type: "pictures-complete"; min?: number }
  | { type: "no-color"; color: string }
  | { type: "removed"; ids: string[] }
  | { type: "page-filled"; page: string; min: number }
  | { type: "aspect"; words: string[]; ratio: number };

export const CHECK_MENU = `  {"type": "picture-for", "words": ["duck"]}: some drawing() describes one of these words (any one matches)
  {"type": "single-picture", "words": ["duck"]}: exactly one drawing() describes these words: the subject isn't split into parts
  {"type": "no-parts", "words": ["duck"]}: no plain shape (no drawing(), no text) is described by these words: the subject isn't built from boxes and circles
  {"type": "pictures-complete", "min": 8}: every drawing() has a finished picture of at least min elements
  {"type": "no-color", "color": "#e03131"}: no shape and no picture uses this color (the person's pen is #e03131)
  {"type": "removed", "ids": ["shape-id"]}: these shapes from the before board are gone
  {"type": "page-filled", "page": "page-id", "min": 6}: the page has at least min shapes inside it
  {"type": "aspect", "words": ["duck"], "ratio": 1.2}: the drawing() for these words has width ÷ height within 35% of ratio`;

const wordsIn = (s: string, words: string[]) => words.some((w) => new RegExp(`\\b${w.replace(/[^\p{L}\p{N} ]/gu, "")}`, "iu").test(s));
const about = (s: Shape, words: string[]) => wordsIn(`${s.drawing ?? ""} ${s.description}`, words);
const drawings = (j: SceneJSON) => j.shapes.filter((s) => s.drawing);
const inside = (a: Box, b: Box) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
const colorOf = (c: string | undefined) => c?.toLowerCase().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3");

/** Whether `after` passes the check, and why not when it doesn't. */
export function runCheck(c: Check, after: SceneJSON, before: SceneJSON): { pass: boolean; why: string } {
  const r = (pass: boolean, why: string) => ({ pass, why: pass ? "" : why });
  switch (c.type) {
    case "picture-for":
      return r(drawings(after).some((s) => about(s, c.words)), `no drawing() for ${c.words.join("/")}`);
    case "single-picture": {
      const n = drawings(after).filter((s) => about(s, c.words)).length;
      return r(n === 1, `${n} drawings for ${c.words.join("/")}`);
    }
    case "no-parts": {
      const parts = after.shapes.filter((s) => !s.drawing && !s.text && s.kind !== "frame" && about(s, c.words));
      return r(!parts.length, `built from ${parts.length} plain shapes: ${parts.slice(0, 3).map((s) => s.id).join(", ")}`);
    }
    case "pictures-complete": {
      const short = drawings(after).filter((s) => !s.picture?.done || s.picture.els.length < (c.min ?? 1));
      return r(!short.length, `unfinished or thin pictures: ${short.slice(0, 3).map((s) => `${s.id} (${s.picture?.els.length ?? 0})`).join(", ")}`);
    }
    case "no-color": {
      const want = colorOf(c.color);
      const hit = after.shapes.filter(
        (s) => [s.style.fill, s.style.stroke, s.text?.color].some((x) => colorOf(x) === want) || s.picture?.els.some((e) => colorOf(e.attrs.fill) === want || colorOf(e.attrs.stroke) === want),
      );
      // Only what the send added or changed: a color already on the before board is theirs.
      const had = new Set(before.shapes.filter((s) => JSON.stringify(s) === JSON.stringify(after.shapes.find((a) => a.id === s.id))).map((s) => s.id));
      const fresh = hit.filter((s) => !had.has(s.id));
      return r(!fresh.length, `${c.color} in ${fresh.slice(0, 3).map((s) => s.id).join(", ")}`);
    }
    case "removed": {
      const left = c.ids.filter((id) => after.shapes.some((s) => s.id === id));
      return r(!left.length, `still there: ${left.join(", ")}`);
    }
    case "page-filled": {
      const page = after.shapes.find((s) => s.id === c.page);
      const n = page ? after.shapes.filter((s) => s.id !== page.id && inside(s.box, page.box)).length : 0;
      return r(n >= c.min, page ? `${n} shapes on ${c.page}, wanted ${c.min}` : `no page ${c.page}`);
    }
    case "aspect": {
      const s = drawings(after).find((x) => about(x, c.words));
      if (!s) return r(false, `no drawing() for ${c.words.join("/")}`);
      const ratio = s.box.w / s.box.h;
      return r(ratio / c.ratio <= 1.35 && c.ratio / ratio <= 1.35, `${s.id} is ${ratio.toFixed(2)}, wanted ${c.ratio}`);
    }
  }
}

/** Reads gold's <checks> JSON, keeping only well-formed checks. */
export function readChecks(text: string): Check[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const strs = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every((w) => typeof w === "string" && w.trim());
  return raw.filter((c): c is Check => {
    if (!c || typeof c !== "object") return false;
    const o = c as Record<string, unknown>;
    switch (o.type) {
      case "picture-for":
      case "single-picture":
      case "no-parts":
        return strs(o.words);
      case "pictures-complete":
        return o.min === undefined || typeof o.min === "number";
      case "no-color":
        return typeof o.color === "string" && /^#[0-9a-f]{3,6}$/i.test(o.color);
      case "removed":
        return strs(o.ids);
      case "page-filled":
        return typeof o.page === "string" && typeof o.min === "number";
      case "aspect":
        return strs(o.words) && typeof o.ratio === "number" && o.ratio > 0;
      default:
        return false;
    }
  });
}
