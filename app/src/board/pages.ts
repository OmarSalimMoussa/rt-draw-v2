// The sidebar's Pages: v2's pages (frame shapes) in the site's tree order, each
// nested under the page whose element leads to it, as v1 nested a page under the
// one whose button opened it (siteTree, src/core/board.ts).
import { centerOf, homeOf, pageName, pageOf, siteTree } from "../../../src/core/board.ts";
import type { Scene } from "../../../src/core/scene.ts";

export type PageRow = { id: string; name: string; depth: number; home: boolean };

export function pageRows(scene: Scene): PageRow[] {
  return siteTree(scene).map((p, i) => ({ id: p.page.id, name: pageName(p.page), depth: p.depth, home: i === 0 }));
}

/** A project's name until it's renamed: the topmost words on its home page, else "Untitled". */
export function siteName(scene: Scene): string {
  const first = homeOf(scene);
  if (!first) return "Untitled";
  const top = scene
    .stacked()
    .filter((s) => s.kind !== "frame" && s.text?.words.trim() && pageOf(scene, s) === first)
    .sort((a, b) => centerOf(a.box)[1] - centerOf(b.box)[1])[0];
  return top ? top.text!.words.trim().replace(/\s+/g, " ").slice(0, 40) : "Untitled";
}
