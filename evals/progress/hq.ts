// Eval HQ's frame (evals/README.md, served on the PGX by evals/pages.vite.config.ts): the header its views share, each
// view's link, and under them one sentence on what the view's stage does, what it needs from the owner and what happens
// next. The views are the progress page's sections, the intake and review page, and the judge's labeling page.
import "../../src/ui.css";

export const VIEWS = [
  ["needs", "Needs you", "/evals/progress/#needs"],
  ["review", "Intake and review", "/evals/review/"],
  ["loop", "Loop", "/evals/progress/#loop"],
  ["benchmarks", "Benchmarks", "/evals/progress/#benchmarks"],
  ["judge", "Judge", "/evals/label/"],
  ["playgrounds", "Playgrounds", "/evals/progress/#playgrounds"],
] as const;
export type View = (typeof VIEWS)[number][0];

/** The header, with `current`'s link marked. */
export function hq(current: View | "home", blurb: string) {
  const header = document.createElement("header");
  header.className = "bar";
  header.innerHTML = `<h1><a href="/evals/progress/" style="color:inherit;text-decoration:none">Eval HQ</a></h1><nav>${VIEWS.map(([v, name, href]) => `<a href="${href}"${v === current ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav><p></p>`;
  header.querySelector("p")!.textContent = blurb;
  document.body.prepend(header);
}
