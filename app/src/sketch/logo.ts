// The logo: a thought bubble, where the site is being imagined. Hand-drawn in
// the same ink line as the icons (rough.js), three times over, so it can boil.
// On a 64-unit grid: the cloud, and two little bubbles trailing down from it.
import rough from "roughjs";
import { seedOf } from "./rough.ts";

export const LOGO_FRAMES = 3;

/** The cloud: bumps around an ellipse. */
function cloud(cx = 37, cy = 24, rx = 21, ry = 14, bumps = 7): string {
  const at = (i: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / bumps + 0.25;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  };
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < bumps; i++) {
    const [px, py] = at(i);
    const [x, y] = at(i + 1);
    const r = Math.hypot(x - px, y - py) * 0.6;
    d += `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y)}`;
  }
  return `${d}Z`;
}

/** The bubbles trailing from the cloud, biggest first (nearest the cloud). */
const DOTS = [
  { cx: 15.5, cy: 46, r: 4.8 },
  { cx: 7.5, cy: 56.5, r: 2.8 },
];

export type LogoDrawing = { cloud: string; dots: string[] };

const drawn: LogoDrawing[] = [];

/** Drawing `frame` of LOGO_FRAMES: path data on the 64-unit grid, the same every time. */
export function logoDrawing(frame = 0): LogoDrawing {
  if (!drawn[frame]) {
    const gen = rough.generator();
    const opts = { seed: seedOf("logo") + frame * 101, roughness: 0.9, bowing: 2, disableMultiStroke: true, preserveVertices: true };
    // One continuous line: rough.js starts each piece with a move to where the last one ended; dropping those
    // lets the load screen draw it in one stroke (a dash animation restarts at every move).
    const one = (d: { sets: { type: string }[] }) =>
      gen
        .opsToPath((d.sets as Parameters<typeof gen.opsToPath>[0][]).find((s) => s.type === "path")!, 1)
        .replace(/(?!^)M-?[\d.]+ -?[\d.]+ ?/g, "");
    drawn[frame] = {
      cloud: one(gen.path(cloud(), opts)),
      dots: DOTS.map((c, i) => one(gen.ellipse(c.cx, c.cy, c.r * 2, c.r * 2, { ...opts, seed: opts.seed + i + 1, roughness: 0.5 }))),
    };
  }
  return drawn[frame];
}

/** The logo as a standalone SVG (the favicon), on a white tile so it shows up on dark browser tabs too. */
export function logoSvg(frame = 0, ink = "#1e1e1e"): string {
  const { cloud: c, dots } = logoDrawing(frame);
  const shape = (d: string) => `<path d="${d}" fill="#fff" stroke="${ink}" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 68 68"><rect x="-2" y="-2" width="68" height="68" rx="14" fill="#fff"/>${shape(c)}${dots.map(shape).join("")}</svg>`;
}
