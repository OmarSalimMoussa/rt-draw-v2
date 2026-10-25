// Gold for a real send (evals/real/README.md): Opus's reply read into the board it describes. Its ops run on
// the send's before board with the product's own runScript, and every drawing() takes the picture Opus drew,
// read through the product's readPicture with room for detail (picture.maxPaths 80, picture.colors 10), so
// gold renders exactly as a result of the product would.
import rough from "roughjs";
import { Scene, type Shape } from "../../src/core/scene.ts";
import { runScript } from "../../src/core/ops.ts";
import { readPicture } from "../../src/core/picture.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";
import type { SceneJSON } from "../loop/types.ts";
import { type Check, readChecks } from "./checks.ts";

export type Gold = {
  ops: string;
  pictures: { id: string; els: string }[];
  rubric: { should: string[]; mustNot: string[] };
  checks: Check[];
  why: string;
};

const gen = rough.generator();
/** Whether rough.js can draw a path: the sanitizer passes "M10 10 Q Q", and rough.js throws on it, taking the whole render down. */
const drawable = (d: string) => {
  try {
    gen.path(d, { seed: 1 });
    return true;
  } catch {
    return false;
  }
};

/** Gold's pictures: up to 60 elements and 8 colors asked, read with a little room. */
export const GOLD_TUNING = { ...DEFAULTS, "picture.maxPaths": 80, "picture.colors": 10 };

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const r = (n: number) => Math.round(n);
const col = (c: string) => (c === "transparent" ? "none" : c);

/** One shape as the op lines that would make it, so gold can name and keep what's on the board. */
function shapeOps(s: Shape): string[] {
  const st = s.style;
  const style = [
    st.fill && `fill:${col(st.fill)}`, st.stroke && `stroke:${col(st.stroke)}`, st.strokeWidth !== undefined && `strokeWidth:${st.strokeWidth}`,
    st.opacity !== undefined && `opacity:${st.opacity}`, st.fade !== undefined && `fade:${st.fade}`, st.fillStyle && `fillStyle:${st.fillStyle}`,
    s.link && `link:${s.link}`, s.button && "button:yes",
  ].filter(Boolean);
  const out = [`shape(${[s.id, s.kind, `${r(s.box.x)} ${r(s.box.y)} ${r(s.box.w)} ${r(s.box.h)}`, q(s.description), ...style].join(", ")})`];
  if (s.text) {
    const t = s.text;
    out.push(`text(${[s.id, q(t.words), t.size && `size:${t.size}`, t.color && `color:${col(t.color)}`, t.align && `align:${t.align}`, t.weight && `weight:${t.weight}`].filter(Boolean).join(", ")})`);
  }
  if (s.drawing) out.push(`drawing(${s.id}, ${q(s.drawing)})${s.picture?.done ? ` (picture: ${s.picture.els.length} elements)` : ""}`);
  return out;
}

/** A board as op lines, back to front, groups last. */
export function boardOps(j: SceneJSON): string {
  return [...j.shapes.flatMap(shapeOps), ...Object.entries(j.groups).map(([id, ids]) => `group(${id}, [${ids.join(", ")}])`)].join("\n");
}

/** Gold's reply → its parts; undefined with the reason when a part is missing. */
export function readGold(text: string): Gold | { error: string } {
  const tag = (name: string) => new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(text)?.[1];
  const ops = tag("ops");
  if (!ops) return { error: "no <ops>" };
  const pictures = [...text.matchAll(/<picture id="([^"]+)">\s*([\s\S]*?)\s*<\/picture>/g)].map((m) => ({ id: m[1], els: m[2] }));
  let rubric: Gold["rubric"] | undefined;
  try {
    const j = JSON.parse(tag("rubric") ?? "");
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
    rubric = { should: strs(j.should), mustNot: strs(j.mustNot) };
  } catch {
    return { error: "unreadable <rubric>" };
  }
  if (!rubric.should.length) return { error: "a rubric with nothing it should do" };
  return { ops, pictures, rubric, checks: readChecks(tag("checks") ?? "[]"), why: tag("why") ?? "" };
}

/** The gold board: the ops on the before board, each drawing() with its picture. `problems` lists what didn't apply. */
export function applyGold(before: SceneJSON, g: Gold): { after: SceneJSON; problems: string[] } {
  const { scene, errors } = runScript(g.ops, Scene.fromJSON(structuredClone(before)));
  // camera() is the product's own screen move, which only a send on a board makes: gold's is harmless.
  const problems = errors.filter((e) => !/^\s*camera\(/.test(e.line)).map((e) => `${e.line}: ${e.error}`);
  for (const s of scene.stacked()) {
    if (!s.drawing) continue;
    const p = g.pictures.find((x) => x.id === s.id);
    if (!p) {
      // Kept from the before board unchanged: its picture stands.
      if (s.picture?.done && s.picture.subject === s.drawing) continue;
      problems.push(`no picture for drawing ${s.id}`);
      continue;
    }
    const read = readPicture(p.els, s.drawing, r(s.box.w), r(s.box.h), GOLD_TUNING);
    const bad = read.els.filter((e) => e.tag === "path" && !drawable(e.attrs.d));
    if (bad.length) problems.push(`picture ${s.id}: ${bad.length} paths rough.js can't draw, left out`);
    read.els = read.els.filter((e) => !bad.includes(e));
    if (!read.els.length) problems.push(`picture ${s.id} has no elements`);
    if (read.features.refused) problems.push(`picture ${s.id}: ${read.features.refused} attributes or elements the product drops`);
    s.picture = { subject: s.drawing, w: r(s.box.w), h: r(s.box.h), els: read.els, done: true };
  }
  for (const p of g.pictures) if (!scene.get(p.id)?.drawing) problems.push(`picture for ${p.id}, which has no drawing()`);
  return { after: scene.toJSON(), problems };
}
