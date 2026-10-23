// The background of the pages before the app (Welcome, Join): cute doodles scattered at random and
// turned every which way. The pictures were drawn once by imagine's own picture model and are kept in
// public/doodles; with them, the logo and a few pen scribbles. Faint where the page's words are.
import { useMemo } from "react";
import { logoDrawing } from "../sketch/logo.ts";

const PICTURES = ["duck", "chicken", "bread", "croissant", "pencil", "coffee", "rocket", "cat", "plant", "bulb", "plane", "cupcake"];
/** Pen scribbles in a 100×100 box, each with its ink. */
const SCRIBBLES: [string, string][] = [
  ["M52 50c4-6 12-2 10 6c-3 10-18 10-21-2c-4-15 14-24 26-14c14 12 4 34-14 34c-22 0-32-24-18-40", "#1c7ed6"],
  ["M8 62c10-30 22-30 18 0c-4 22 14 22 18-2c4-24 22-24 20 2c-2 22 16 20 22-6", "#e8590c"],
  ["M8 42l12 18 12-18 12 18 12-18 12 18 12-18", "#2f9e44"],
  ["M50 12l10 28h30L66 58l9 30-25-18-25 18 9-30-24-18h30z", "#f08c00"],
  ["M50 84C18 62 8 40 24 26c12-10 24-2 26 10 2-12 14-20 26-10 16 14 6 36-26 58z", "#d6336c"],
  ["M12 72C30 22 70 22 70 50c0 20-25 20-22 2 4-20 32-22 42-12m-11-9 11 9-12 7", "#1e1e1e"],
];

type Doodle = { kind: "picture" | "logo" | "scribble"; i: number; x: number; y: number; size: number; turn: number; faint: boolean };

/** Half the page's column of words (.ac's max width), and a margin around it. */
const WORDS_HALF = 360 + 30;

/** Each doodle at a random spot in its own cell of a grid over a `width`-wide screen, so they spread out without piling up. */
function scatter(width: number): Doodle[] {
  const wide = width >= 900;
  const all: Pick<Doodle, "kind" | "i">[] = [
    ...PICTURES.map((_, i) => ({ kind: "picture" as const, i })),
    { kind: "logo", i: 0 },
    { kind: "logo", i: 1 },
    ...SCRIBBLES.map((_, i) => ({ kind: "scribble" as const, i })),
  ];
  const cols = wide ? 6 : 4;
  const rows = Math.ceil(all.length / cols);
  const cells = Array.from({ length: cols * rows }, (_, n) => n).sort(() => Math.random() - 0.5);
  const r = (a: number, b: number) => a + Math.random() * (b - a);
  return all.map((d, k) => {
    const col = cells[k] % cols;
    const row = Math.floor(cells[k] / cols);
    const size = Math.round((d.kind === "picture" ? r(70, 120) : r(50, 85)) * (wide ? 1 : 0.7));
    const x = ((col + r(0.15, 0.85)) / cols) * 100;
    // Faint wherever it would be behind the words: on a narrow screen, that's everywhere.
    const fromMiddle = Math.abs((x / 100) * width - width / 2);
    return {
      ...d,
      x,
      y: ((row + r(0.15, 0.85)) / rows) * 100,
      size,
      turn: Math.round(d.kind === "scribble" ? r(-180, 180) : r(-40, 40)),
      faint: !wide || fromMiddle - size / 2 < WORDS_HALF,
    };
  });
}

export function Doodles() {
  const items = useMemo(() => scatter(innerWidth), []);
  return (
    <div className="ac-doodles" aria-hidden="true">
      {items.map((d, k) => {
        const cls = d.faint ? "ac-doodle faint" : "ac-doodle";
        const style = { left: `${d.x}%`, top: `${d.y}%`, width: d.size, height: d.size, transform: `translate(-50%, -50%) rotate(${d.turn}deg)` };
        if (d.kind === "picture") return <img key={k} className={cls} style={style} src={`/doodles/${PICTURES[d.i]}.svg`} alt="" loading="lazy" />;
        if (d.kind === "logo") {
          const l = logoDrawing(d.i);
          return (
            <svg key={k} className={`${cls} ac-doodle-logo`} style={style} viewBox="-2 -2 68 68">
              {[l.cloud, ...l.dots].map((p, j) => <path key={j} d={p} />)}
            </svg>
          );
        }
        const [path, ink] = SCRIBBLES[d.i];
        return (
          <svg key={k} className={`${cls} ac-scribble`} style={{ ...style, color: ink }} viewBox="0 0 100 100">
            <path d={path} />
          </svg>
        );
      })}
    </div>
  );
}
