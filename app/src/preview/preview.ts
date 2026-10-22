// The preview's rules, apart from its look (Preview.tsx): where it is in the URL,
// what a click on a page hits, where that leads, and what a click that leads
// nowhere yet asks the model to build. After v1's src/preview/Preview.tsx, on v2's
// links (Shape.link, Shape.button).
import { clickable, norm, pageName, pageOf, pagesOf, siteTree } from "../../../src/core/board.ts";
import type { Scene, Shape } from "../../../src/core/scene.ts";

/** "#preview=<page id>" is the preview on that page, "#preview" on the home page; undefined: no preview. */
export function previewOfHash(hash: string): string | null | undefined {
  if (hash === "#preview") return null;
  const m = /^#preview=(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export const previewHash = (page?: string | null) => (page ? `#preview=${encodeURIComponent(page)}` : "#preview");

const holds = (s: Shape, p: { x: number; y: number }) => {
  const b = norm(s.box);
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
};

/** What a click at `p` (board pixels) hits: the topmost thing a visitor can click there, on `page` (or on any page). */
export function hitClickable(scene: Scene, page: Shape | undefined, p: { x: number; y: number }): Shape | undefined {
  return scene
    .stacked()
    .reverse()
    .find((s) => clickable(s) && holds(s, p) && (page ? pageOf(scene, s) === page : !!pageOf(scene, s)));
}

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
const same = (a: string, b: string) => tidy(a).toLowerCase() === tidy(b).toLowerCase();

/** The words a visitor clicked: its text, else the topmost words inside it, else what its picture shows, else its id (v1's activate). */
export function clickedWords(scene: Scene, s: Shape): string {
  if (s.text?.words.trim()) return tidy(s.text.words);
  const b = norm(s.box);
  const inner = scene
    .stacked()
    .filter((o) => o !== s && o.text?.words.trim() && o.kind !== "frame" && holds(s, { x: norm(o.box).x + norm(o.box).w / 2, y: norm(o.box).y + norm(o.box).h / 2 }) && norm(o.box).w * norm(o.box).h <= b.w * b.h)
    .sort((x, y) => norm(x.box).y - norm(y.box).y)[0];
  if (inner) return tidy(inner.text!.words);
  return s.drawing?.trim() || s.id;
}

/** A page named as the clicked words are (case and spacing aside), as v1 found the page a forgotten link meant. */
export function existingPage(scene: Scene, s: Shape): Shape | undefined {
  const words = clickedWords(scene, s);
  return siteTree(scene)
    .map((p) => p.page)
    .find((p) => same(pageName(p), words));
}

/** Where a click on `s` goes: its link's page, or a page with its name; undefined when it has no page yet. */
export function targetOf(scene: Scene, s: Shape): Shape | undefined {
  const linked = s.link ? scene.get(s.link) : undefined;
  return linked?.kind === "frame" ? linked : existingPage(scene, s);
}

/** A readable, unused id for a new page, from the clicked words: "contact-us", or "services-2" when that's taken. */
export function freshPageId(scene: Scene, words: string): string {
  const base =
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "page";
  let id = base;
  for (let i = 2; scene.get(id); i++) id = `${base}-${i}`;
  return id;
}

/** What a build asks the model for (v1's build instruction, on v2's board): the page is already made, empty. */
export function buildInstruction(scene: Scene, s: Shape, from: Shape, page: Shape): string {
  const b = norm(page.box);
  const box = [b.x, b.y, b.w, b.h].map(Math.round).join(" ");
  const others = pagesOf(scene).length > 2 ? "the other pages" : `the ${pageName(from)} page`;
  return `Preview click: a visitor clicked “${clickedWords(scene, s)}” (${s.id}) on the ${pageName(from)} page. Its page, ${page.id}, has just been made, empty, at ${box}. They're watching it being built: draw it now, top to bottom, starting with the same header and nav as ${others}, in the site's style.`;
}
