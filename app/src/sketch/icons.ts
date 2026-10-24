// Hand-drawn icons for the app's controls, so they match the sketchbook look
// (Excalifont has no arrows or symbols, which used to fall back to another font).
// Simple shapes on a 24-unit grid, drawn with rough.js like the pages and arrows,
// in one wobbly pen line ("ink").
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import { seedOf } from "./rough.ts";

const circle = (cx: number, cy: number, r: number) => `M${cx + r} ${cy}a${r} ${r} 0 1 1 ${-2 * r} 0a${r} ${r} 0 1 1 ${2 * r} 0`;

/** A gear's outline: eight teeth around a ring (its hole is drawn separately, steadier). */
function gear(): string {
  const at = (r: number, t: number) => `${(12 + r * Math.cos(t)).toFixed(2)} ${(12 + r * Math.sin(t)).toFixed(2)}`;
  const half = Math.PI / 8;
  const outline = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI;
    return [at(6.6, a - half * 0.62), at(9.6, a - half * 0.36), at(9.6, a + half * 0.36), at(6.6, a + half * 0.62)].join("L");
  });
  return `M${outline.join("L")}Z`;
}

/** Each icon's shape: `d` is drawn by hand, and `fine` (small details that would wobble out of shape) with a steadier hand. */
export const ICONS = {
  back: { d: "M19 12H5M11 6l-6 6 6 6" },
  home: { d: "M3.5 11.5L12 4l8.5 7.5M6 9.5V20h12V9.5M10 20v-5.5h4V20" },
  branch: { d: "M7 4v8.5q0 3.5 3.5 3.5H19M15 12l4 4-4 4" },
  state: { d: "M12 3.5L20.5 12 12 20.5 3.5 12Z" },
  close: { d: "M6.5 6.5l11 11M17.5 6.5l-11 11" },
  warn: { d: "M12 3.5L21 19.5H3ZM12 9.5V14M12 16.9v.1" },
  check: { d: "M4.5 12.5l5 5L19.5 7" },
  plus: { d: "M12 5v14M5 12h14" },
  newProject: { d: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M12 10.5v6M9 13.5h6" },
  projects: { d: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" },
  locate: { d: `${circle(12, 12, 6.5)}M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4`, fine: circle(12, 12, 1.4) },
  minus: { d: "M5 12h14" },
  pencil: { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4zM14.5 5.5l3 3" },
  mic: { d: "M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" },
  gear: {
    d: gear(),
    fine: circle(12, 12, 3),
  },
  feedback: { d: "M4 5h16v11h-8.5L7 20v-4H4zM8 9.5h8M8 12.5h5" },
  // GitHub's mark (Octicons' mark-github, MIT) as a line, on this grid: the ring by hand, the cat steadier so it stays a cat.
  github: {
    d: "M12 2C17.52 2 22 6.47 22 12C22 16.3 19.26 20.11 15.19 21.49M8.84 21.49C4.75 20.13 2 16.31 2 12C2 6.47 6.47 2 12 2",
    fine:
      "M15.19 21.49C14.69 21.59 14.5 21.27 14.5 21.01C14.5 20.68 14.51 19.6 14.51 18.26C14.51 17.32 14.2 16.72 13.84 16.41C16.06 16.16 18.4 15.31 18.4 11.47C18.4 10.37 18.01 9.49 17.38 8.79C17.47 8.54 17.82 7.51 17.27 6.14C17.27 6.14 16.44 5.86 14.52 7.16C13.72 6.94 12.88 6.82 12.02 6.82C11.18 6.82 10.32 6.94 9.52 7.16C7.61 5.87 6.77 6.14 6.77 6.14C6.22 7.51 6.57 8.54 6.67 8.79C6.04 9.49 5.65 10.39 5.65 11.47C5.65 15.3 7.97 16.16 10.2 16.41C9.91 16.66 9.65 17.1 9.56 17.75C8.99 18.01 7.55 18.44 6.65 16.92C6.46 16.62 5.9 15.89 5.11 15.9C4.28 15.91 4.77 16.38 5.13 16.56C5.55 16.8 6.04 17.69 6.15 17.97C6.35 18.54 7 19.61 9.51 19.15C9.51 19.99 9.52 20.77 9.52 21.01C9.52 21.27 9.34 21.57 8.84 21.49",
  },
  hand: {
    d: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-8a1.5 1.5 0 0 1 3 0V12M14 11.5V5a1.5 1.5 0 0 1 3 0v7M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.4a7 7 0 0 1-5.2-2.3l-3-3.4a1.6 1.6 0 0 1 2.4-2.1L8 16",
  },
} satisfies Record<string, { d: string; fine?: string }>;

export type IconName = keyof typeof ICONS;

const gen = rough.generator();
const drawn = new Map<string, string[]>();

/** How many drawings of each icon there are: hovering flips through them (a "boil", as in hand-drawn animation). */
export const ICON_FRAMES = 3;

/** The icon's hand-drawn strokes, as SVG path data: drawing `frame` of ICON_FRAMES, the same every time. */
export function iconPaths(name: IconName, frame = 0): string[] {
  const key = `${name}:${frame}`;
  let paths = drawn.get(key);
  if (!paths) {
    const opts: Options = {
      seed: seedOf(`icon:${name}`) + frame * 7919,
      roughness: 0.9,
      bowing: 2.5,
      strokeWidth: 1,
      // One line, like a pen (rough.js otherwise goes over each stroke twice, like a pencil).
      disableMultiStroke: true,
      preserveVertices: true,
    };
    const icon: { d: string; fine?: string } = ICONS[name];
    paths = [icon.d, icon.fine]
      .flatMap((d, i) => (d ? gen.toPaths(gen.path(d, i ? { ...opts, roughness: opts.roughness! * 0.3 } : opts)) : []))
      .map((p) => p.d);
    drawn.set(key, paths);
  }
  return paths;
}
