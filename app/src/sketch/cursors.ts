// Hand-drawn mouse cursors, in the same ink line as the icons: the arrow, the
// hand over things you can click, the drawing crosshair (a pencil while the
// button is down and a stroke is being drawn), the open and closed
// hands for moving around, the text bar, and "not allowed". Each is drawn once
// with rough.js into a small SVG and handed to CSS as a variable (--cur-<name>),
// with the browser's own cursor as the fallback. A white halo keeps them
// visible on dark backgrounds.
import rough from "roughjs";
import { ICONS } from "./icons.ts";
import { seedOf } from "./rough.ts";

type Cursor = {
  /** Strokes, on a 24-unit grid. */
  d: string;
  /** A shape to fill white under the strokes (the arrow's body). */
  fill?: string;
  /** Where it points, on the 24-unit grid. */
  at: [number, number];
  fallback: string;
};

const ARROW = "M5 3L5 19.5 9.6 15.4 12.6 21.6 15.1 20.4 12.1 14.3H18.3Z";

const CURSORS: Record<string, Cursor> = {
  default: { d: ARROW, fill: ARROW, at: [5, 3], fallback: "default" },
  pointer: {
    d: "M9 11V4.5a1.5 1.5 0 0 1 3 0V10M12 9.5V8.5a1.5 1.5 0 0 1 3 0V10M15 10a1.5 1.5 0 0 1 3 0v.5M18 10.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.4a7 7 0 0 1-5.2-2.3l-3-3.4a1.6 1.6 0 0 1 2.4-2.1L9 15",
    at: [10.5, 3],
    fallback: "pointer",
  },
  crosshair: { d: "M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M11.6 12h.8", at: [12, 12], fallback: "crosshair" },
  // Drawing: the pencil from the icons, its tip where the line goes.
  pencil: { d: ICONS.pencil.d, fill: "M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z", at: [4.2, 18.8], fallback: "crosshair" },
  grab: { d: ICONS.hand.d, at: [12, 12], fallback: "grab" },
  grabbing: {
    d: "M8 11.5V10a1.5 1.5 0 0 1 3 0v1M11 10.5V9a1.5 1.5 0 0 1 3 0v1.5M14 10.5V9.5a1.5 1.5 0 0 1 3 0V11M17 11a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1.4a7 7 0 0 1-5.2-2.3l-2-2.5a1.6 1.6 0 0 1 2.4-2.1L8 15",
    at: [12, 12],
    fallback: "grabbing",
  },
  text: { d: "M9.5 4.5q2.5 0 2.5 2v11q0 2-2.5 2M14.5 4.5q-2.5 0-2.5 2M14.5 19.5q-2.5 0-2.5-2", at: [12, 12], fallback: "text" },
  "not-allowed": { d: "M18.5 12a6.5 6.5 0 1 1-13 0 6.5 6.5 0 1 1 13 0M7.4 16.6L16.6 7.4", at: [12, 12], fallback: "not-allowed" },
};

/** Drawn at 32px; the 24-unit grid scales by this. */
const SIZE = 32;

function svgFor(name: string, c: Cursor): string {
  const gen = rough.generator();
  const lines = gen
    .toPaths(gen.path(c.d, { seed: seedOf(`cursor:${name}`), roughness: 0.7, bowing: 2, strokeWidth: 1, disableMultiStroke: true, preserveVertices: true }))
    .map((p) => `<path d="${p.d}"/>`)
    .join("");
  const stroke = (color: string, width: number) =>
    `<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${lines}</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">` +
    (c.fill ? `<path d="${c.fill}" fill="#fff"/>` : "") +
    stroke("#fff", 3.6) +
    stroke("#1e1e1e", 1.6) +
    `</svg>`
  );
}

/** Sets --cur-<name> on the page for every cursor, once. */
export function installCursors() {
  const root = document.documentElement;
  if (root.style.getPropertyValue("--cur-default")) return;
  for (const [name, c] of Object.entries(CURSORS)) {
    const [x, y] = c.at.map((v) => Math.round((v * SIZE) / 24));
    root.style.setProperty(`--cur-${name}`, `url("data:image/svg+xml,${encodeURIComponent(svgFor(name, c))}") ${x} ${y}, ${c.fallback}`);
  }
}
