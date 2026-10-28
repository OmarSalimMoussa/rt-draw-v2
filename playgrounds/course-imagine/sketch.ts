// Icons and the logo as imagine draws them (app/src/sketch): imagine's own icons, and the few it doesn't have yet
// drawn with the same pen, three drawings each so they boil on hover. Shared by the course playgrounds in imagine's look.
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import { ICON_FRAMES, type IconName, iconPaths } from "../../app/src/sketch/icons.ts";
import { LOGO_FRAMES, logoDrawing } from "../../app/src/sketch/logo.ts";
import { seedOf } from "../../app/src/sketch/rough.ts";

const gen = rough.generator();

/** Icons imagine doesn't have, drawn with its icons' pen (sketch/icons.ts): one line, three drawings to boil through. */
const MORE_ICONS = {
  clip: "M15.5 7.5l-6.2 6.2a2 2 0 0 0 2.8 2.8l6.6-6.6a3.8 3.8 0 0 0-5.4-5.4l-6.8 6.8a5.6 5.6 0 0 0 7.9 7.9l5.6-5.6",
  play: "M8 5.5v13l10.5-6.5Z",
  pause: "M8.5 5.5v13M15.5 5.5v13",
  prev: "M15 5.5l-6.5 6.5 6.5 6.5",
  next: "M9 5.5l6.5 6.5-6.5 6.5",
  again: "M5.5 12a6.5 6.5 0 1 0 2-4.7M5 3.8v4.2h4.2",
  book: "M12 6.5c-2-1.6-4.6-2-7.5-1.5v13c2.9-.5 5.5-.1 7.5 1.5 2-1.6 4.6-2 7.5-1.5V5c-2.9-.5-5.5-.1-7.5 1.5ZM12 6.5v13",
} as const;
export type AnyIcon = IconName | keyof typeof MORE_ICONS;
const moreDrawn = new Map<string, string[]>();
function iconFrame(name: AnyIcon, f: number): string[] {
  if (!(name in MORE_ICONS)) return iconPaths(name as IconName, f);
  const key = `${name}:${f}`;
  if (!moreDrawn.has(key)) {
    const opts: Options = { seed: seedOf(`icon:${name}`) + f * 7919, roughness: 0.9, bowing: 2.5, strokeWidth: 1, disableMultiStroke: true, preserveVertices: true };
    moreDrawn.set(key, gen.toPaths(gen.path(MORE_ICONS[name as keyof typeof MORE_ICONS], opts)).map((p) => p.d));
  }
  return moreDrawn.get(key)!;
}
export function icon(name: AnyIcon, cls = "") {
  const frames = Array.from({ length: ICON_FRAMES }, (_, f) => `<g class="ic-frame">${iconFrame(name, f).map((d) => `<path d="${d}"/>`).join("")}</g>`).join("");
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="1.1em" height="1.1em" aria-hidden="true">${frames}</svg>`;
}
export function logo(size: number) {
  const frames = Array.from({ length: LOGO_FRAMES }, (_, f) => { const d = logoDrawing(f); return `<g class="lf">${[d.cloud, ...d.dots].map((p) => `<path d="${p}"/>`).join("")}</g>`; }).join("");
  return `<svg class="logo" viewBox="-2 -2 68 68" width="${size}" height="${size}" aria-hidden="true">${frames}</svg>`;
}
