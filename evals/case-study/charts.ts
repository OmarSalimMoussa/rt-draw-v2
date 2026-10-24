// The case study's charts (evals/README.md): static SVGs drawn from the eval/history branch, a light and a
// dark copy of each for GitHub's <picture>; and the latency and quality charts again as small cards for imagine's
// welcome page. No model call, no DOM: run it from the repo root after the history moves, and commit what it
// writes next to it.
//
//   node evals/case-study/charts.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dirname;
/** Hour 0: checkpoint ck-01, the loop's first measure of era 2, just before epoch 1. */
const T0 = Date.parse("2026-10-19T03:47:54.442Z");
const hours = (at: string) => (Date.parse(at) - T0) / 3_600_000;

function history(name: string): string {
  for (const ref of ["eval/history", "origin/eval/history"]) {
    try {
      return execFileSync("git", ["show", `${ref}:${name}`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch {}
  }
  throw new Error(`no ${name} on eval/history (git fetch origin eval/history:eval/history)`);
}
const rows = <T>(name: string): T[] => history(name).trim().split("\n").map((l) => JSON.parse(l) as T);

type Band = { share: number; lo90: number; hi90: number; n: number };
type Checkpoint = {
  id: string; at: string; era: number; share: { all: Band };
  latency: { champion: { ttfcP50: number; ttdP50: number }; anchor: { ttfcP50: number; ttdP50: number }; ratioTtfc: { est: number }; ratioTtd: { est: number } };
};
type Decision = { id: string; epoch: number; verdict: "keep" | "revert" | "void" | "owner"; kind: string };
type Epoch = { epoch: number; at: string };

// Era 1 (ck-00) had another judge and measure; the loop's own run starts at ck-01.
const checkpoints = rows<Checkpoint>("checkpoints.jsonl").filter((c) => c.era >= 2);
const decisions = rows<Decision>("decisions.jsonl");
const epochAt = new Map(rows<Epoch>("epochs.jsonl").map((e) => [e.epoch, e.at]));
/** Each decision's area, from the ledger's headings ("## e1-h2 · draw · revert (Q, latency)"). */
const area = new Map([...history("ledger.md").matchAll(/^## (\S+) · ([^·]+) · /gm)].map((m) => [m[1], m[2].trim()]));
/** The loop stopped between epochs 29 and 30 (the critic's cards ran dry) until the owner restarted it. */
const PAUSE: [number, number] = [hours(epochAt.get(29)!), hours(epochAt.get(30)!)];

// The dataviz palette (validated light and dark), chrome and ink per mode.
const THEMES = {
  light: { surface: "#fcfcfb", border: "rgba(11,11,11,0.10)", primary: "#0b0b0b", secondary: "#52514e", muted: "#898781",
    grid: "#e1e0d9", axis: "#c3c2b7", pause: "#f1f0ec", s1: "#2a78d6", s2: "#eb6834" },
  dark: { surface: "#1a1a19", border: "rgba(255,255,255,0.10)", primary: "#f0efec", secondary: "#c3c2b7", muted: "#898781",
    grid: "#2c2c2a", axis: "#383835", pause: "#232322", s1: "#3987e5", s2: "#d95926" },
};
type Theme = (typeof THEMES)["light"];
const FONT = `system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (v: number) => Math.round(v * 10) / 10;

/** `k` scales the type: the landing page's cards (CARD) are narrower with larger words. */
type Plot = { w: number; h: number; l: number; r: number; t: number; b: number; x: [number, number]; y: [number, number]; k?: number };
const sx = (p: Plot, v: number) => r1(p.l + ((v - p.x[0]) / (p.x[1] - p.x[0])) * (p.w - p.l - p.r));
const sy = (p: Plot, v: number) => r1(p.h - p.b - ((v - p.y[0]) / (p.y[1] - p.y[0])) * (p.h - p.t - p.b));

/** The card, title and subtitle, legend keys, gridlines with y ticks, and the hours axis. */
function frame(p: Plot, th: Theme, o: { title: string; subtitle?: string; legend?: string[]; yTicks: number[]; yFormat: (v: number) => string; pause?: boolean; axis?: string }) {
  const k = p.k ?? 1;
  const out = [
    `<rect x="0.5" y="0.5" width="${p.w - 1}" height="${p.h - 1}" rx="8" fill="${th.surface}" stroke="${th.border}"/>`,
    `<text x="20" y="${r1(30 * k)}" font-size="${r1(15 * k)}" font-weight="600" fill="${th.primary}">${esc(o.title)}</text>`,
  ];
  if (o.subtitle) out.push(`<text x="20" y="${r1(50 * k)}" font-size="${r1(12 * k)}" fill="${th.secondary}">${esc(o.subtitle)}</text>`);
  if (o.legend) out.push(`<g transform="translate(20 ${r1((o.subtitle ? 72 : 54) * k)})" font-size="${r1(12 * k)}" fill="${th.secondary}">${o.legend.join("")}</g>`);
  if (o.pause) {
    const [a, b] = PAUSE.map((v) => sx(p, v));
    out.push(`<rect x="${a}" y="${p.t}" width="${r1(b - a)}" height="${p.h - p.t - p.b}" fill="${th.pause}"/>`,
      `<text x="${r1((a + b) / 2)}" y="${p.t + 14}" font-size="${r1(11 * k)}" fill="${th.muted}" text-anchor="middle">loop stopped, 9 h</text>`);
  }
  for (const v of o.yTicks) {
    const y = sy(p, v);
    out.push(`<line x1="${p.l}" x2="${p.w - p.r}" y1="${y}" y2="${y}" stroke="${v === o.yTicks[0] ? th.axis : th.grid}" stroke-width="1"/>`,
      `<text x="${p.l - 8}" y="${r1(y + 4 * k)}" font-size="${r1(11 * k)}" fill="${th.muted}" text-anchor="end" style="font-variant-numeric: tabular-nums">${o.yFormat(v)}</text>`);
  }
  for (let v = 0; v <= p.x[1]; v += 4)
    out.push(`<text x="${sx(p, v)}" y="${r1(p.h - p.b + 18 * k)}" font-size="${r1(11 * k)}" fill="${th.muted}" text-anchor="middle">${v} h</text>`);
  const axis = o.axis ?? "hours since the loop started (19 October 2026, 03:47 UTC)";
  if (axis) out.push(`<text x="${r1((p.l + p.w - p.r) / 2)}" y="${r1(p.h - 10 * k)}" font-size="${r1(11 * k)}" fill="${th.muted}" text-anchor="middle">${esc(axis)}</text>`);
  return out;
}

const key = (x: number, color: string, label: string, mark: "line" | "band" | "dot" | "ring" | "diamond", th: Theme) => {
  const m = {
    line: `<line x1="${x}" x2="${x + 18}" y1="-4" y2="-4" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`,
    band: `<rect x="${x}" y="-10" width="18" height="12" rx="2" fill="${color}" fill-opacity="0.15"/>`,
    dot: `<circle cx="${x + 5}" cy="-4" r="4.5" fill="${color}"/>`,
    ring: `<circle cx="${x + 5}" cy="-4" r="4" fill="${th.surface}" stroke="${color}" stroke-width="1.5"/>`,
    diamond: `<path d="M${x + 5} -9.5 L${x + 10.5} -4 L${x + 5} 1.5 L${x - 0.5} -4 Z" fill="${color}"/>`,
  }[mark];
  return `${m}<text x="${x + (mark === "line" || mark === "band" ? 24 : 15)}" y="0">${esc(label)}</text>`;
};
const line = (pts: [number, number][], color: string) =>
  `<polyline points="${pts.map(([x, y]) => `${x},${y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
const dots = (pts: [number, number][], color: string, th: Theme) =>
  pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="${color}" stroke="${th.surface}" stroke-width="2"/>`).join("");
const svg = (p: Plot, label: string, body: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}" font-family='${FONT}' role="img" aria-label="${esc(label)}">\n${body.join("\n")}\n</svg>\n`;

/**
 * How a chart is drawn: at the case study's width, or as a card on the imagine landing page (app/src/access/Welcome.tsx):
 * short, to stack in a narrow column; no subtitle or axis title, and larger type for being drawn small.
 */
type Size = { w: number; h?: number; k: number; card: boolean };
const PAGE: Size = { w: 760, k: 1, card: false };
const CARD: Size = { w: 480, h: 230, k: 1.25, card: true };

const X: [number, number] = [0, 23];
const xs = checkpoints.map((c) => hours(c.at));

/** The headline: median seconds to the first change, the original against the loop's best, at every checkpoint. */
function latency(th: Theme, s = PAGE) {
  const { k } = s;
  const p: Plot = s.card ? { w: s.w, h: s.h!, l: 44 * k, r: 96 * k, t: 72 * k, b: 28 * k, x: X, y: [0, 7], k } : { w: s.w, h: 380, l: 52, r: 116, t: 96, b: 52, x: X, y: [0, 7] };
  const best = checkpoints.map((c, i): [number, number] => [sx(p, xs[i]), sy(p, c.latency.champion.ttfcP50 / 1000)]);
  const orig = checkpoints.map((c, i): [number, number] => [sx(p, xs[i]), sy(p, c.latency.anchor.ttfcP50 / 1000)]);
  const last = checkpoints.at(-1)!.latency;
  const end = (pt: [number, number], v: number, name: string) =>
    `<text x="${pt[0] + 12}" y="${pt[1] - 2}" font-size="${r1(13 * k)}" font-weight="600" fill="${th.primary}">${r1(v / 1000).toFixed(1)} s</text>` +
    `<text x="${pt[0] + 12}" y="${r1(pt[1] + 13 * k)}" font-size="${r1(11 * k)}" fill="${th.secondary}">${name}</text>`;
  return svg(p, `Line chart: median seconds until the first change appears. The original stays between 5.1 and 5.8 seconds; the loop's best version falls from 5.4 to 2.4 seconds over 21 hours.`, [
    ...frame(p, th, {
      title: s.card ? "Seconds until the first change appears" : "Seconds until the first change appears on screen",
      subtitle: s.card ? undefined : "Median over the same 62 benchmark requests at each checkpoint, both versions measured side by side",
      legend: [key(0, th.s1, "The loop's best version", "line", th), key(196 * k, th.muted, "The original", "line", th)],
      yTicks: s.card ? [0, 2, 4, 6] : [0, 1, 2, 3, 4, 5, 6, 7], yFormat: (v) => `${v} s`, axis: s.card ? "" : undefined,
    }),
    line(orig, th.muted), line(best, th.s1), dots(orig, th.muted, th), dots(best, th.s1, th),
    end(orig.at(-1)!, last.anchor.ttfcP50, "the original"), end(best.at(-1)!, last.champion.ttfcP50, "the loop's best"),
  ]);
}

/** Quality: the judge's share of held-out comparisons won by the champion, with its 90% interval. */
function quality(th: Theme, s = PAGE) {
  const { k } = s;
  const p: Plot = s.card ? { w: s.w, h: s.h!, l: 44 * k, r: 20, t: 72 * k, b: 28 * k, x: X, y: [0.3, 0.7], k } : { w: s.w, h: 340, l: 52, r: 24, t: 70, b: 52, x: X, y: [0.3, 0.7] };
  const pts = checkpoints.map((c, i): [number, number] => [sx(p, xs[i]), sy(p, c.share.all.share)]);
  const hi = checkpoints.map((c, i) => `${sx(p, xs[i])},${sy(p, c.share.all.hi90)}`);
  const lo = checkpoints.map((c, i) => `${sx(p, xs[i])},${sy(p, c.share.all.lo90)}`).reverse();
  const tie = sy(p, 0.5);
  return svg(p, "Line chart with an interval band: the judge preferred the loop's version on 45% to 56% of comparisons; every 90% interval includes 50%, a tie.", [
    ...frame(p, th, {
      title: s.card ? "How often the judge picked the new version" : "How often the judge preferred the loop's version to the original",
      subtitle: s.card ? undefined : "Share of the 62 benchmark requests at each checkpoint, a tie counting half; the band is the 90% interval",
      legend: s.card ? [key(0, th.s1, "Share of 62 requests", "line", th), key(176 * k, th.s1, "90% interval", "band", th)] : undefined,
      yTicks: s.card ? [0.3, 0.5, 0.7] : [0.3, 0.4, 0.5, 0.6, 0.7], yFormat: (v) => `${Math.round(v * 100)}%`, axis: s.card ? "" : undefined,
    }),
    `<polygon points="${[...hi, ...lo].join(" ")}" fill="${th.s1}" fill-opacity="0.12"/>`,
    `<line x1="${p.l}" x2="${p.w - p.r}" y1="${tie}" y2="${tie}" stroke="${th.secondary}" stroke-width="1"/>`,
    // Labelled in the stopped stretch, where no checkpoint sits on the line (under it on a card, where the line runs close above).
    `<text x="${sx(p, 12)}" y="${s.card ? r1(tie + 15 * k) : tie - 6}" font-size="${r1(11 * k)}" fill="${th.secondary}" text-anchor="middle">50%: a tie</text>`,
    line(pts, th.s1), dots(pts, th.s1, th),
  ]);
}

/** Every decision as a dot in time, by the area it changed, and the owner's commits merged in. */
function timeline(th: Theme) {
  const ROWS = ["draw", "resolve", "picture", "ops", "camera", "render", "tidy", "board", "owner's commits"];
  const p: Plot = { w: 760, h: 430, l: 128, r: 24, t: 96, b: 52, x: X, y: [ROWS.length - 0.5, -0.5] };
  const placed = new Map<string, number>();
  const marks = decisions.map((d) => {
    const row = d.kind === "owner-step" ? "owner's commits" : area.get(d.id) === "owner" ? "picture" : area.get(d.id) ?? "draw";
    const at = d.kind === "owner-step" ? checkpoints.find((c) => c.id === d.id.replace("owner-", ""))!.at : epochAt.get(d.epoch)!;
    // Decisions of one epoch on one row sit side by side, a dot apart.
    const slot = `${row}@${d.epoch}`;
    const n = placed.get(slot) ?? 0;
    placed.set(slot, n + 1);
    const x = r1(sx(p, hours(at)) + n * 9), y = sy(p, ROWS.indexOf(row));
    if (d.kind === "owner-step") return { top: false, svg: `<path d="M${x} ${y - 6} L${x + 6} ${y} L${x} ${y + 6} L${x - 6} ${y} Z" fill="${th.secondary}"/>` };
    if (d.verdict === "void") return { top: false, svg: `<circle cx="${x}" cy="${y}" r="4" fill="${th.surface}" stroke="${th.muted}" stroke-width="1.5"/>` };
    const fill = { keep: th.s1, owner: th.s2, revert: th.muted }[d.verdict];
    return { top: d.verdict !== "revert", svg: `<circle cx="${x}" cy="${y}" r="${d.verdict === "revert" ? 4 : 5}" fill="${fill}" stroke="${th.surface}" stroke-width="2"/>` };
  });
  const count = (v: Decision["verdict"]) => decisions.filter((d) => d.kind !== "owner-step" && d.verdict === v).length;
  const cards = decisions.filter((d) => d.kind !== "owner-step").length;
  // Kept and handed-over dots go last, so a grey neighbour never covers one.
  marks.sort((a, b) => Number(a.top) - Number(b.top));
  return svg(p, `Dot timeline of ${cards} changes the loop tried over 22 hours, by area: ${count("keep")} kept, ${count("owner")} handed to the owner, ${count("revert")} reverted, ${count("void")} void.`, [
    ...frame(p, th, {
      title: "Every change the loop tried",
      subtitle: `${cards} changes in ${epochAt.size} rounds, each a dot in the row of the part of rt-draw it changed`,
      legend: [key(0, th.s1, `kept (${count("keep")})`, "dot", th), key(92, th.s2, `handed to the owner (${count("owner")})`, "dot", th),
        key(262, th.muted, `reverted (${count("revert")})`, "dot", th), key(374, th.muted, `void (${count("void")})`, "ring", th),
        key(458, th.secondary, "owner's commits merged in", "diamond", th)],
      yTicks: [], yFormat: String, pause: true,
    }),
    ...ROWS.map((r, i) => `<line x1="${p.l}" x2="${p.w - p.r}" y1="${sy(p, i)}" y2="${sy(p, i)}" stroke="${th.grid}" stroke-width="1"/>` +
      `<text x="${p.l - 10}" y="${sy(p, i) + 4}" font-size="12" fill="${th.secondary}" text-anchor="end">${esc(r)}</text>`),
    ...marks.map((m) => m.svg),
  ]);
}

/** The paired ratios against the original, first change and done, with the steps the key changes made. */
function steps(th: Theme) {
  const p: Plot = { w: 760, h: 400, l: 52, r: 24, t: 96, b: 52, x: X, y: [0, 1.2] };
  const ttfc = checkpoints.map((c, i): [number, number] => [sx(p, xs[i]), sy(p, c.latency.ratioTtfc.est)]);
  const ttd = checkpoints.map((c, i): [number, number] => [sx(p, xs[i]), sy(p, c.latency.ratioTtd.est)]);
  // When each key change was decided (README's table, A to E). C and D are half an hour apart, so D's tag sits lower.
  const at = (id: string) => hours(epochAt.get(decisions.find((d) => d.id === id)!.epoch)!);
  const notes: [string, string, number][] = [["A", "e2-h1", 1.12], ["B", "e5-h3", 1.12], ["C", "e15-h7", 1.12], ["D", "e23-h1", 1.02], ["E", "e45-h1", 1.12]];
  return svg(p, "Line chart: time to the first change and time to done, as a share of the original's, fall from about 100% to under 50% in steps marked A to E.", [
    ...frame(p, th, {
      title: "Time as a share of the original's, request by request",
      subtitle: "Median of paired ratios on the 62 benchmark requests at each checkpoint; letters mark the key changes",
      legend: [key(0, th.s1, "first change on screen", "line", th), key(176, th.s2, "sketch finished", "line", th)],
      yTicks: [0, 0.25, 0.5, 0.75, 1], yFormat: (v) => `${Math.round(v * 100)}%`,
    }),
    ...notes.map(([n, id, tagY]) => {
      const x = sx(p, at(id)), y = sy(p, tagY);
      return `<line x1="${x}" x2="${x}" y1="${y + 9}" y2="${p.h - p.b}" stroke="${th.axis}" stroke-width="1"/>` +
        `<circle cx="${x}" cy="${y}" r="9" fill="${th.surface}" stroke="${th.secondary}" stroke-width="1"/>` +
        `<text x="${x}" y="${y + 4}" font-size="11" font-weight="600" fill="${th.primary}" text-anchor="middle">${n}</text>`;
    }),
    line(ttd, th.s2), line(ttfc, th.s1), dots(ttd, th.s2, th), dots(ttfc, th.s1, th),
  ]);
}

for (const [mode, th] of Object.entries(THEMES))
  for (const [name, draw] of Object.entries({ latency, quality, timeline, steps })) writeFileSync(join(OUT, `${name}-${mode}.svg`), draw(th));
// The landing page is paper-coloured in every mode: its cards come in light only.
writeFileSync(join(OUT, "latency-card.svg"), latency(THEMES.light, CARD));
writeFileSync(join(OUT, "quality-card.svg"), quality(THEMES.light, CARD));

// The numbers behind the charts, for the README's tables.
for (const c of checkpoints)
  console.log([c.id, hours(c.at).toFixed(1), c.latency.anchor.ttfcP50, c.latency.champion.ttfcP50, c.latency.anchor.ttdP50, c.latency.champion.ttdP50,
    c.latency.ratioTtfc.est.toFixed(2), c.latency.ratioTtd.est.toFixed(2), c.share.all.share.toFixed(2), c.share.all.lo90.toFixed(2), c.share.all.hi90.toFixed(2)].join("\t"));
