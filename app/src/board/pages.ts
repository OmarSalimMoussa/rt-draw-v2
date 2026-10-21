// The sidebar's Pages: v2's pages (frame shapes) in the site map's reading order,
// each indented by how many link arrows lead to it from the first page, as v1
// nested a page under the one whose button opened it.
import { centerOf, linksOf, pageName, pageOf, pagesOf } from "../../../src/core/board.ts";
import type { Scene } from "../../../src/core/scene.ts";
import { DEFAULTS, type Tuning } from "../../../src/core/tuning.ts";

export type PageRow = { id: string; name: string; depth: number; home: boolean };

/** The board's pages top to bottom, then left to right (as siteMap reads them). */
const reading = (scene: Scene) => pagesOf(scene).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

export function pageRows(scene: Scene, t: Tuning = DEFAULTS): PageRow[] {
  const pages = reading(scene);
  if (!pages.length) return [];
  // Breadth first from the first page along the links: each page's fewest arrows away.
  const next = new Map<string, string[]>();
  for (const l of linksOf(scene, t)) next.set(l.from.id, [...(next.get(l.from.id) ?? []), l.to.id]);
  const depth = new Map([[pages[0].id, 0]]);
  for (const queue = [pages[0].id]; queue.length; ) {
    const id = queue.shift()!;
    for (const to of next.get(id) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, depth.get(id)! + 1);
      queue.push(to);
    }
  }
  return pages.map((p, i) => ({ id: p.id, name: pageName(p), depth: depth.get(p.id) ?? 0, home: i === 0 }));
}

/** A project's name until it's renamed: the topmost words on its first page, else "Untitled". */
export function siteName(scene: Scene): string {
  const first = reading(scene)[0];
  if (!first) return "Untitled";
  const top = scene
    .stacked()
    .filter((s) => s.kind !== "frame" && s.text?.words.trim() && pageOf(scene, s) === first)
    .sort((a, b) => centerOf(a.box)[1] - centerOf(b.box)[1])[0];
  return top ? top.text!.words.trim().replace(/\s+/g, " ").slice(0, 40) : "Untitled";
}
