// v1's boil: what a visitor could click jitters while hovered, between three spots
// half a screen pixel apart, 0.15 s each, like a frame of hand-drawn animation. On
// the board and in the preview the clickables are <g>s of v2's rendered <svg>, so it
// moves them by a CSS translate in the drawing's own units (px: half a screen pixel
// at the zoom shown), from a <style> outside the <svg>: nothing in the drawing
// changes, so the eval's clock (which hashes each g[data-id]) never sees a hover.

/** The boil for whatever `selector` picks, `px` drawing units per step; `name` keeps each user's keyframes apart. */
export function boilCss(name: string, selector: string, px: number): string {
  const p = Number(px.toFixed(4));
  return [
    `@keyframes boil-${name} { 0% { translate: ${p}px 0; } 33.33% { translate: ${-p}px ${p}px; } 66.66% { translate: 0 ${-p}px; } }`,
    `${selector} { animation: boil-${name} 0.45s steps(1, end) infinite; }`,
    `@media (prefers-reduced-motion: reduce) { ${selector} { animation: none; } }`,
  ].join("\n");
}

/** A selector for one shape's drawing in an <svg> picked by `svg`. */
export const shapeSelector = (svg: string, id: string) => `${svg} > g[data-id="${id.replace(/["\\]/g, "\\$&")}"]`;
