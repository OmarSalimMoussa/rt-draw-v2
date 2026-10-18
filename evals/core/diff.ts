// What a send changed, from the before and after scenes alone: the frozen change
// list judges read (spec §4.2) and the visible work it did (§5.1). Shapes are named
// the way a person sees them (their text, else the first words of their
// description), never by id or op name, so both arms are described the same way.
// No node or DOM APIs: the judge pages and the harness share it.
import type { View } from "../../src/core/board.ts";
import type { Shape } from "../../src/core/scene.ts";
import type { SceneJSON } from "../loop/types.ts";

/** Frozen numbers of the change list and the work count. */
export const DIFF = {
  /** Items a judge gets per arm, the last one "+N more changes" when there are more. */
  maxItems: 12,
  /** Words of a shape's text or description it is named by. */
  nameWords: 4,
  /** Text characters worth one shape of visible work. */
  charsPerWork: 40,
  /** A camera side that moved less than this (board px) didn't move: the glide ends on floats. */
  cameraPx: 1,
};

export type SceneDiff = {
  /** The §4.2 change list, at most DIFF.maxItems. */
  changes: string[];
  /** Shapes the send changed (added, removed, or visibly edited): not shown to judges, it has ids. */
  changed: string[];
  /** Shapes whose picture differs after the send, changed or not (a picture for an unchanged shape is a stray). */
  pictured: string[];
  /** Shapes visibly changed + pictures changed on them + text characters / 40, on the after-scene only. */
  work: number;
  /** Every ask asks for a change, so a send with no visible work is empty. */
  empty: boolean;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A shape as the change list names it. */
export function nameOf(s: Shape): string {
  const words = (s.text?.words || s.description || s.kind).trim().split(/\s+/);
  const cut = words.slice(0, DIFF.nameWords).join(" ").replace(/[,.;:!?]+$/, "");
  return words.length > DIFF.nameWords ? `${cut}…` : cut;
}

const overlap = (a: Shape["box"], b: Shape["box"]) => {
  const span = (x: number, w: number) => [Math.min(x, x + w), Math.max(x, x + w)];
  const [ax0, ax1] = span(a.x, a.w), [ay0, ay1] = span(a.y, a.h), [bx0, bx1] = span(b.x, b.w), [by0, by1] = span(b.y, b.h);
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
};

/**
 * Shapes brought in front of or behind a shape they overlap. Of each flipped pair, the one
 * whose place in the stack moved most is the one that was moved (a layer(front) lifts one shape
 * past many, the others each shift by one).
 */
function restacked(before: SceneJSON, after: SceneJSON): Set<string> {
  const inBoth = new Set(after.shapes.map((s) => s.id).filter((id) => before.shapes.some((s) => s.id === id)));
  const rank = (sc: SceneJSON) => new Map(sc.shapes.filter((s) => inBoth.has(s.id)).map((s, i) => [s.id, i]));
  const rb = rank(before), ra = rank(after);
  const shapes = after.shapes.filter((s) => inBoth.has(s.id));
  const moved = new Set<string>();
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      const [a, b] = [shapes[i], shapes[j]];
      if (rb.get(a.id)! < rb.get(b.id)! || !overlap(a.box, b.box)) continue;
      const shift = (s: Shape) => Math.abs(ra.get(s.id)! - rb.get(s.id)!);
      moved.add(shift(a) > shift(b) ? a.id : b.id);
    }
  return moved;
}

/** The change list, work and empty flag of one arm's send. Cameras are [before, after]. */
export function sceneDiff(before: SceneJSON, after: SceneJSON, cameras?: [View, View]): SceneDiff {
  const was = new Map(before.shapes.map((s) => [s.id, s]));
  const now = new Set(after.shapes.map((s) => s.id));
  const stack = restacked(before, after);
  const items: string[] = [];
  const changed: string[] = [];
  const pictured: string[] = [];
  let pictures = 0;
  let chars = 0;
  for (const s of after.shapes) {
    const b = was.get(s.id);
    const name = `'${nameOf(s)}'`;
    if (!same(b?.picture, s.picture) && s.picture) pictured.push(s.id);
    if (!b) {
      items.push(s.kind === "frame" ? `new page ${name}` : `added ${s.kind} ${name}`);
      changed.push(s.id);
      chars += s.text?.words.length ?? 0;
      if (s.picture) pictures++;
      continue;
    }
    const mine: string[] = [];
    if (b.box.w !== s.box.w || b.box.h !== s.box.h) mine.push(`resized ${name}`);
    else if (b.box.x !== s.box.x || b.box.y !== s.box.y || stack.has(s.id)) mine.push(`moved ${name}`);
    // The vocabulary is frozen: any change to how the shape itself looks reads as a recolour.
    if (b.kind !== s.kind || !same(b.style, s.style)) mine.push(`recoloured ${name}`);
    if (!same(b.text, s.text)) {
      mine.push(`text changed in ${name}`);
      chars += s.text?.words.length ?? 0;
    }
    if (b.drawing !== s.drawing) mine.push(`picture added in ${name}`);
    if (!mine.length) continue;
    items.push(...mine);
    changed.push(s.id);
    if (pictured.at(-1) === s.id) pictures++;
  }
  for (const b of before.shapes)
    if (!now.has(b.id)) {
      items.push(`removed '${nameOf(b)}'`);
      changed.push(b.id);
    }
  const [cb, ca] = cameras ?? [];
  if (cb && ca && (["x", "y", "w", "h"] as const).some((k) => Math.abs(cb[k] - ca[k]) >= DIFF.cameraPx)) items.push("camera moved");
  const changes = items.length > DIFF.maxItems ? [...items.slice(0, DIFF.maxItems - 1), `+${items.length - DIFF.maxItems + 1} more changes`] : items;
  const work = changed.length + pictures + chars / DIFF.charsPerWork;
  return { changes, changed, pictured, work, empty: work === 0 };
}

/**
 * The board area a send changed in any of `afters` (changed shapes where they are now, and where they were), padded
 * and widened to `aspect`; undefined when nothing changed. One frame for both arms, so their framed captures compare.
 */
export function changeFrame(before: SceneJSON, afters: SceneJSON[], aspect: number, pad = 40): View | undefined {
  const was = new Map(before.shapes.map((s) => [s.id, s.box]));
  const boxes = afters.flatMap((after) => {
    const now = new Map(after.shapes.map((s) => [s.id, s.box]));
    return sceneDiff(before, after).changed.flatMap((id) => [now.get(id), was.get(id)].filter((b): b is View => !!b));
  });
  if (!boxes.length) return;
  let x = Math.min(...boxes.map((b) => b.x)) - pad, y = Math.min(...boxes.map((b) => b.y)) - pad;
  let w = Math.max(...boxes.map((b) => b.x + b.w)) + pad - x, h = Math.max(...boxes.map((b) => b.y + b.h)) + pad - y;
  if (w / h < aspect) [x, w] = [x - (h * aspect - w) / 2, h * aspect];
  else [y, h] = [y - (w / aspect - h) / 2, w / aspect];
  return { x, y, w, h };
}

/** Whether a send changed a shape wholly off `camera` (where it is now; a removed one where it was): the screen left it. */
export function hidden(before: SceneJSON, after: SceneJSON, camera: View): boolean {
  const box = new Map([...before.shapes, ...after.shapes].map((s) => [s.id, s.box]));
  return sceneDiff(before, after).changed.some((id) => {
    const b = box.get(id)!;
    return b.x >= camera.x + camera.w || b.x + b.w <= camera.x || b.y >= camera.y + camera.h || b.y + b.h <= camera.y;
  });
}
