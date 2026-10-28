// Mockup, low fidelity: courses inside imagine, end to end. imagine's own chrome is unchanged (app/src/styles.css,
// its icons and its preview); what a course adds is marked "new". A strip on top tells the story a step at a time:
// bring in documents, ask for a course, imagine plans it and draws it as ordinary pages, you change it by talking,
// Preview plays it with a voice and a red dot, and a question asked while it plays is answered as a new page that
// stays in the course. The board's drawings are placeholders: grey lines stand for words.
import "../../app/src/styles.css";
import "../../app/src/preview/preview.css";
import "./flow.css";
import rough from "roughjs";
import { installCursors } from "../../app/src/sketch/cursors.ts";
import { type Stroke, seedOf, sketchArrow, sketchBox, sketchMark } from "../../app/src/sketch/rough.ts";
import { type AnyIcon, icon, logo } from "../course-imagine/sketch.ts";

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const gen = rough.generator();
const INK = "#1e1e1e", GREY = "#ced4da", RED = "#e03131", BLUE = "#1971c2", GREEN = "#2f9e44";
const YELLOW = "#fff3bf", SKY = "#e7f5ff", MINT = "#ebfbee", NOTE = "#fff9db";

/* ---------- drawing the board: rough.js, as imagine draws its pages ---------- */
const paths = (ss: Stroke[], extra = "") => ss.map((s) => `<path d="${s.d}" stroke="${s.stroke}" stroke-width="${s.strokeWidth}" fill="${s.fill ?? "none"}"${extra}/>`).join("");
const text = (x: number, y: number, s: string, size = 13, cls = "", anchor = "start") => `<text x="${x}" y="${y}" font-size="${size}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
function box(x: number, y: number, w: number, h: number, seed: string, o: { fill?: string; stroke?: string; dashed?: boolean } = {}) {
  return `<g transform="translate(${x} ${y})">${paths(sketchBox(w, h, { seed: seedOf(seed), stroke: o.stroke ?? INK, strokeWidth: 1.4, fill: o.fill, radius: 6 }), o.dashed ? ' stroke-dasharray="5 4"' : "")}</g>`;
}
const line = (x1: number, y1: number, x2: number, y2: number, seed: string, stroke = INK, w = 1.4) =>
  paths(gen.toPaths(gen.line(x1, y1, x2, y2, { seed: seedOf(seed), stroke, strokeWidth: w, roughness: 0.9 })));
const arrow = (x1: number, y1: number, x2: number, y2: number, seed: string, stroke = INK) =>
  paths(sketchArrow(`M${x1} ${y1}L${x2} ${y2}`, [{ x: x1, y: y1 }, { x: x2, y: y2 }], { seed: seedOf(seed), stroke, strokeWidth: 1.4, head: 10 }));
/** Grey lines standing for words. */
function words(x: number, y: number, w: number, n: number, seed: string, gap = 11) {
  let s = "";
  for (let i = 0; i < n; i++) s += line(x, y + i * gap, x + w * (i === n - 1 ? 0.55 : 0.82 + 0.18 * ((seedOf(seed + i) % 100) / 100)), y + i * gap, `${seed}:${i}`, GREY, 2);
  return s;
}
/** A circled mark in imagine's red pencil, with its number beside it, as imagine numbers your marks. */
function redLoop(cx: number, cy: number, a: number, b: number, seed: string, zoom: number, n?: number) {
  const pts = Array.from({ length: 30 }, (_, i) => { const t = -2.3 + (i / 29) * 2.1 * Math.PI; return { x: cx + a * Math.cos(t) * (1 + i * 0.002), y: cy + b * Math.sin(t) }; });
  const m = sketchMark(pts, { seed: seedOf(seed), closed: true, zoom });
  return m.fill.map((d) => `<path d="${d}" stroke="${RED}" stroke-width="1" opacity=".25" fill="none"/>`).join("")
    + m.outline.map((d) => `<path d="${d}" stroke="${RED}" stroke-width="2.4" fill="none"/>`).join("")
    + (n ? text(cx + a + 6, cy - b + 4, String(n), 18 / zoom, "red") : "");
}
/** Where the red dot will point, numbered as the script's lines are. */
const cue = (x: number, y: number, n: number) => `<g class="cf-cue"><circle cx="${x}" cy="${y}" r="8" fill="${RED}"/><text x="${x}" y="${y + 4}" font-size="11" fill="#fff" text-anchor="middle">${n}</text></g>`;
/** A dashed blue outline and a "new" tag: something a course adds to imagine. */
const fresh = (x: number, y: number, w: number, h: number, z: number) =>
  `<g class="cf-newsvg"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="${BLUE}" stroke-width="2" stroke-dasharray="6 5"/>${text(x + w, y - 6 / z, "new", 15 / z, "blue", "end")}</g>`;

/* ---------- what's drawn on the pages: a page is 400x250 ---------- */
type Art = { title: string; dur: string; draw(o: { simpler?: boolean }): string; cues: [number, number][] };
const CHAPTERS: Art[] = [
  { title: "The job and your rules", dur: "1:03", cues: [[90, 92], [82, 178], [202, 178], [322, 178]], draw: () =>
    text(20, 36, "The job and your rules", 20) + line(30, 92, 370, 92, "c0t") + [30, 150, 370].map((x, i) => line(x, 84, x, 100, "c0k" + i)).join("")
    + text(30, 118, "Enter", 11, "muted") + text(150, 118, "first stroke", 11, "muted") + text(370, 118, "done", 11, "muted", "end")
    + box(30, 140, 105, 72, "c0a", { fill: SKY, stroke: BLUE }) + text(42, 168, "Speed", 15) + text(42, 188, "decides", 11, "muted")
    + box(150, 140, 105, 72, "c0b") + text(162, 168, "Quality", 15) + text(162, 188, "must hold", 11, "muted")
    + box(270, 140, 105, 72, "c0c", { fill: YELLOW }) + text(282, 168, "Budget", 15) + text(282, 188, "half a week", 11, "muted") },
  { title: "The bank of recorded sends", dur: "1:07", cues: [[95, 120], [305, 120], [200, 206]], draw: () =>
    text(20, 36, "The bank of recorded sends", 20) + box(52, 92, 120, 80, "c1a") + box(46, 86, 120, 80, "c1b") + box(40, 80, 120, 80, "c1c", { fill: "#fff" })
    + text(52, 112, "recorded", 14) + text(52, 130, "sends", 14) + arrow(180, 122, 238, 122, "c1d")
    + box(245, 80, 120, 80, "c1e", { fill: MINT, stroke: GREEN }) + text(257, 112, "cases", 14) + text(257, 130, "a frozen bench", 11, "muted")
    + words(40, 200, 320, 2, "c1w") },
  { title: "Replaying a send", dur: "1:02", cues: [[85, 102], [85, 177], [302, 140]], draw: () =>
    text(20, 36, "Replaying a send", 20) + box(30, 75, 110, 55, "c2a") + text(42, 100, "A", 15) + text(42, 118, "champion", 11, "muted")
    + box(30, 150, 110, 55, "c2b") + text(42, 175, "B", 15) + text(42, 193, "candidate", 11, "muted")
    + arrow(145, 102, 230, 128, "c2c") + arrow(145, 177, 230, 152, "c2d") + box(235, 105, 135, 70, "c2e", { fill: YELLOW }) + text(247, 136, "same fork point", 13) + text(247, 156, "both replay it", 11, "muted") },
  { title: "The judge", dur: "1:04", cues: [[77, 117], [200, 117], [200, 202]], draw: ({ simpler }) =>
    text(20, 36, "The judge", 20) + box(30, 80, 95, 75, "c3a") + text(42, 102, "drawing A", 12) + words(42, 118, 70, 2, "c3aw", 10)
    + box(275, 80, 95, 75, "c3b") + text(287, 102, "drawing B", 12) + words(287, 118, 70, 2, "c3bw", 10)
    + box(150, 95, 100, 45, "c3c", { fill: SKY, stroke: BLUE }) + text(162, 115, "judge", 15) + text(162, 132, "doesn't know which", 9, "muted")
    + arrow(127, 117, 148, 117, "c3d") + arrow(273, 117, 252, 117, "c3e") + arrow(200, 142, 200, 176, "c3f")
    + box(140, 180, 120, 45, "c3g") + text(152, 200, simpler ? "the better one" : "fidelity · craft", 13) + text(152, 216, simpler ? "or a tie" : "vs. your labels", 10, "muted")
    + (simpler ? box(285, 172, 100, 62, "c3h", { fill: NOTE }) + text(295, 192, "e.g. two cats:", 11) + text(295, 208, "which looks", 11) + text(295, 222, "more like a cat?", 11) : "") },
  { title: "The free gates", dur: "1:11", cues: [[90, 140], [200, 140], [310, 140]], draw: () =>
    text(20, 36, "The free gates", 20) + [60, 170, 280].map((x, i) => box(x, 80, 60, 120, "c4g" + i) + text(x + 30, 130, `G${i + 1}`, 15, "", "middle") + line(x + 18, 160, x + 28, 172, "c4c" + i, GREEN, 2) + line(x + 28, 172, x + 44, 148, "c4d" + i, GREEN, 2)).join("")
    + arrow(40, 220, 360, 220, "c4e") + text(366, 224, "keep", 12, "green") },
  { title: "Testers' sends become cases", dur: "1:10", cues: [[62, 128], [220, 130], [345, 130]], draw: () =>
    text(20, 36, "Testers' sends become cases", 20) + `<circle cx="62" cy="100" r="12" fill="none" stroke="${INK}" stroke-width="1.4"/>`
    + line(62, 112, 62, 150, "c5a") + line(62, 125, 46, 140, "c5b") + line(62, 125, 78, 140, "c5c") + line(62, 150, 50, 172, "c5d") + line(62, 150, 74, 172, "c5e")
    + arrow(95, 130, 170, 130, "c5f") + box(175, 95, 90, 70, "c5g") + text(187, 125, "their send", 13) + text(187, 142, "triaged", 10, "muted")
    + arrow(270, 130, 300, 130, "c5h") + box(305, 95, 82, 70, "c5i", { fill: MINT, stroke: GREEN }) + text(315, 125, "new case", 13) },
];
const CONTENTS = { title: "Course contents", draw: () =>
  text(24, 40, "How the eval loop decides", 19) + text(24, 62, "what to keep", 19) + text(24, 84, "6 chapters · about 7 minutes", 11, "muted")
  + CHAPTERS.map((c, i) => text(30, 112 + i * 19, `${i + 1}  ${c.title}`, 13, "link")).join("")
  + box(262, 196, 118, 36, "home-start", { fill: INK }) + text(321, 219, "Start the course", 12, "on-ink", "middle") };
const DETOUR = { title: "Why the judge doesn't know", draw: () =>
  text(20, 36, "Why the judge doesn't know", 19) + text(20, 58, "which drawing is new", 19)
  + box(30, 90, 90, 70, "d1") + text(75, 132, "?", 26, "", "middle") + box(140, 90, 90, 70, "d2") + text(185, 132, "?", 26, "", "middle")
  + arrow(235, 125, 275, 125, "d3") + box(280, 100, 95, 50, "d4", { fill: SKY, stroke: BLUE }) + text(292, 124, "judge", 15) + text(292, 140, "no favourite", 10, "muted")
  + words(30, 190, 330, 3, "dw") };

/* ---------- the board's layout, in board units ---------- */
const HOME = { x: 300, y: 70 }, PW = 400, PH = 250;
const chapterAt = (i: number) => ({ x: 800 + (i % 3) * 470, y: 70 + Math.floor(i / 3) * 420 });
const DET = { x: 330, y: 560, w: 320, h: 200 };
function page(x: number, y: number, w: number, name: string, seed: string, inner: string, o: { cls?: string; delay?: number } = {}) {
  const h = (w * PH) / PW;
  const frame = paths(gen.toPaths(gen.rectangle(x, y, w, h, { seed: seedOf(seed), roughness: 0.6, stroke: INK, strokeWidth: 1.4, fill: "#ffffff", fillStyle: "solid" })));
  return `<g class="${o.cls ?? ""}" style="animation-delay:${o.delay ?? 0}s">${text(x, y - 12, name, 24, "name")}${frame}<g transform="translate(${x} ${y}) scale(${w / PW})">${inner}</g></g>`;
}
function doc(x: number, y: number, rot: number, title: string, sub: string, delay: number | null) {
  const w = 210, h = 130, seed = "doc:" + title;
  const paper = paths(gen.toPaths(gen.path(`M0 0H${w - 24}L${w} 24V${h}H0Z`, { seed: seedOf(seed), roughness: 0.7, stroke: INK, strokeWidth: 1.4, fill: "#ffffff", fillStyle: "solid" })))
    + paths(gen.toPaths(gen.path(`M${w - 24} 0V24H${w}`, { seed: seedOf(seed) + 1, roughness: 0.5, stroke: INK, strokeWidth: 1.2 })));
  return `<g transform="translate(${x} ${y}) rotate(${rot})"><g class="${delay === null ? "" : "cf-drop"}" style="animation-delay:${delay ?? 0}s">${paper}${text(14, 30, title, 15)}${text(14, 48, sub, 11, "muted")}${words(14, 72, 180, 4, seed)}</g></g>`;
}
const DOCS = (drop: boolean, z: number) =>
  doc(10, 40, -2, "evals/README.md", "the case study", drop ? 0.1 : null) + doc(24, 210, 1.5, "LOOP-V2.md", "your rules", drop ? 0.35 : null) + doc(6, 380, -1, "RUNBOOK.md", "how to run it", drop ? 0.6 : null)
  + fresh(-10, 22, 250, 520, z);
/** A chapter's narration, under its page: a line per place the red dot goes, numbered as the page's marks are. */
function script(i: number, z: number, simpler = false) {
  const { x, y } = chapterAt(i), c = CHAPTERS[i], n = c.cues.length;
  return box(x, y + PH + 14, PW, 30 + n * 16, `script${i}${simpler}`, { fill: "#fffdf8" }) + text(x + 12, y + PH + 34, `Narration · ${c.dur} · ${n} lines`, 13, "muted")
    + c.cues.map((_, k) => `<circle cx="${x + 20}" cy="${y + PH + 50 + k * 16}" r="6" fill="${RED}"/>${text(x + 20, y + PH + 54 + k * 16, String(k + 1), 9, "on-ink", "middle")}${words(x + 34, y + PH + 50 + k * 16, PW - 60, 1, `s${i}${k}${simpler}`)}`).join("")
    + fresh(x - 8, y + PH + 6, PW + 16, 46 + n * 16, z);
}
function chapter(i: number, z: number, o: { drawn?: boolean; drawing?: boolean; simpler?: boolean; delay?: number } = {}) {
  const { x, y } = chapterAt(i), c = CHAPTERS[i];
  const inner = o.drawn || o.drawing ? c.draw({ simpler: o.simpler }) + (o.drawn ? c.cues.map(([cx, cy], k) => cue(cx, cy, k + 1)).join("") : "") : "";
  return page(x, y, PW, `${i + 1} · ${c.title}`, "ch" + i, inner, { cls: o.drawing ? "cf-pulse" : o.delay !== undefined ? "cf-appear" : "", delay: o.delay })
    + (o.drawn ? script(i, z, o.simpler) : "");
}
/** The contents page links to the start of each row of chapters, and each chapter to the next. */
const links = () => [0, 3].map((i) => { const c = chapterAt(i); return arrow(HOME.x + PW + 6, HOME.y + (i ? 200 : 110), c.x - 8, c.y + 60, "link" + i, "#868e96"); }).join("")
  + [0, 1, 3, 4].map((i) => { const a = chapterAt(i), b = chapterAt(i + 1); return arrow(a.x + PW + 8, a.y + 125, b.x - 8, b.y + 125, "next" + i, "#868e96"); }).join("");

/* ---------- the story ---------- */
type Row = { name: string; depth: number; home?: boolean };
type Preview = { page: string; art: string; hint?: string; building?: string; line: [string, string]; playing: boolean; ask?: string; back?: string; dot?: [number, number][]; loop?: [number, number, number, number] };
type Step = {
  title: string; say: string; project: string; pages: Row[]; history: string[];
  status?: [cls: string, glyph: AnyIcon, word: string, detail: string];
  bar?: string; tip?: string; cam: [number, number, number, number];
  world(z: number): string;
  preview?: Preview; fresh?: string[];
};
const CH_ROWS: Row[] = [{ name: "Course contents", depth: 0, home: true }, ...CHAPTERS.map((c, i) => ({ name: `${i + 1} · ${c.title}`, depth: 1 }))];
const WITH_DETOUR: Row[] = [...CH_ROWS.slice(0, 5), { name: "Why the judge doesn't know", depth: 2 }, ...CH_ROWS.slice(5)];
const ALL_DRAWN = (z: number, simpler = true) => CHAPTERS.map((_, i) => chapter(i, z, { drawn: true, simpler: i === 3 && simpler })).join("");
const homePage = (o: { delay?: number } = {}) => page(HOME.x, HOME.y, PW, "Course contents", "home", CONTENTS.draw(), { cls: o.delay !== undefined ? "cf-appear" : "", delay: o.delay });
const LINE_JUDGE: [string, string] = ["Each arm's drawing goes to a judge, side by side.", "The judge sees both drawings, but not which one is new."];

const STEPS: Step[] = [
  {
    title: "Bring in what it should know",
    say: "Someone who likes imagine wants an explainer. They drop their documents on the board, or paste links. Each lands as a document card: something imagine reads, not a page.",
    project: "Untitled", pages: [{ name: "Home", depth: 0, home: true }], history: [],
    cam: [-40, -20, 790, 600], fresh: ["#clip"],
    world: (z) => page(HOME.x, HOME.y, PW, "Home", "home0", "") + DOCS(true, z),
  },
  {
    title: "Ask for a course, in plain words",
    say: "There's no course mode to find. They say what they want. \"Course\", \"explain\" and the documents tell imagine it's a course, not a website. If it isn't sure, it asks.",
    project: "Untitled", pages: [{ name: "Home", depth: 0, home: true }], history: [],
    bar: "Make me a course from these: how the eval loop decides what to keep, for someone new to it.",
    tip: "Ask for a website, a drawing, or a course from what you've brought in.",
    cam: [-40, -20, 790, 600], fresh: ["#clip", "#tip"],
    world: (z) => page(HOME.x, HOME.y, PW, "Home", "home0", "") + DOCS(false, z),
  },
  {
    title: "It plans the course before drawing it",
    say: "First the outline: a contents page, and an empty page per chapter, linked from it the way a site's pages are. Changing the plan is cheap now: \"merge 2 and 3\", or circle a chapter and say \"skip this\".",
    project: "The eval loop, a course", pages: CH_ROWS, history: ["Course plan, from 3 documents"],
    status: ["drawing", "pencil", "Planning a course", "from 3 documents"],
    tip: "Say what to change in the plan, or Send to draw it.",
    cam: [-40, -10, 2250, 900], fresh: ["#tip"],
    world: (z) => DOCS(false, z) + homePage({ delay: 0 }) + links() + CHAPTERS.map((_, i) => chapter(i, z, { delay: 0.25 + i * 0.18 })).join(""),
  },
  {
    title: "It draws each chapter, and writes what it will say",
    say: "Every chapter is an ordinary page. What's new is its narration: a script under the page, a line for each place the red dot goes, numbered like the marks on the page.",
    project: "The eval loop, a course", pages: CH_ROWS, history: ["Drew chapters 1 to 3", "Course plan, from 3 documents"],
    status: ["drawing", "pencil", "Drawing", "chapter 4 of 6"],
    cam: [-40, -10, 2250, 900],
    world: (z) => DOCS(false, z) + homePage() + links() + [0, 1, 2].map((i) => chapter(i, z, { drawn: true })).join("") + chapter(3, z, { drawing: true }) + chapter(4, z) + chapter(5, z),
  },
  {
    title: "Change it the way you change anything in imagine",
    say: "Circle chapter 4 and say what's wrong. imagine redraws the page, and rewrites its narration to match. The history keeps every version.",
    project: "The eval loop, a course", pages: CH_ROWS, history: ["Chapter 4: simpler, with an example", "Drew chapters 4 to 6", "Drew chapters 1 to 3", "Course plan, from 3 documents"],
    status: ["drawing", "pencil", "Changing", "chapter 4"],
    bar: "1 has too much jargon. Say it simpler, with an example.",
    cam: [740, 380, 1010, 560],
    world: (z) => DOCS(false, z) + homePage() + links() + ALL_DRAWN(z) + redLoop(chapterAt(3).x + 200, chapterAt(3).y + 125, 225, 150, "mine1", z, 1),
  },
  {
    title: "Preview plays it",
    say: "The same Preview button. For a course it plays: a voice reads each line, the red dot moves to what's being said, and the words are underlined. Space pauses, and ← → go a line at a time.",
    project: "The eval loop, a course", pages: CH_ROWS, history: ["Chapter 4: simpler, with an example", "Drew chapters 4 to 6", "Drew chapters 1 to 3", "Course plan, from 3 documents"],
    cam: [-40, -10, 2250, 900], world: (z) => ALL_DRAWN(z),
    preview: { page: "4 · The judge", art: CHAPTERS[3].draw({ simpler: true }), hint: "Chapter 4 of 6 · 0:21 / 1:04", line: LINE_JUDGE, playing: true, dot: CHAPTERS[3].cues },
  },
  {
    title: "Pause, circle, ask",
    say: "Just as on the board: circle anything in red pencil and ask. The answer is built as a new page, the way Preview already builds the page for a link that leads nowhere yet.",
    project: "The eval loop, a course", pages: CH_ROWS, history: ["Chapter 4: simpler, with an example", "Drew chapters 4 to 6", "Drew chapters 1 to 3", "Course plan, from 3 documents"],
    cam: [-40, -10, 2250, 900], world: (z) => ALL_DRAWN(z),
    preview: { page: "4 · The judge", art: CHAPTERS[3].draw({ simpler: true }), building: "Why the judge doesn't know", line: LINE_JUDGE, playing: false, ask: "Why doesn't the judge get told which one is new?", loop: [200, 122, 72, 40] },
  },
  {
    title: "It answers, then goes back to where you were",
    say: "The answer is a short narrated page of its own. When it ends, the course picks up at the line you paused on.",
    project: "The eval loop, a course", pages: WITH_DETOUR, history: ["Answered: why the judge doesn't know", "Chapter 4: simpler, with an example", "Drew chapters 4 to 6", "Drew chapters 1 to 3", "Course plan, from 3 documents"],
    cam: [-40, -10, 2250, 900], world: (z) => ALL_DRAWN(z),
    preview: { page: "4 · The judge › Why the judge doesn't know", art: DETOUR.draw(), hint: "Your question · 0:12 / 0:40", line: ["If the judge knew which drawing was new, it might favour it.", "So it only sees two drawings, and says which is better, or that they tie."], playing: true, back: "Back to chapter 4, line 2", dot: [[75, 125], [185, 125], [327, 125]] },
  },
  {
    title: "Your question stays in the course",
    say: "Back on the board, the answer is a page linked from what you circled, under chapter 4 in the sidebar, and a version in the history. Whoever plays the course next can open it too.",
    project: "The eval loop, a course", pages: WITH_DETOUR, history: ["Answered: why the judge doesn't know", "Chapter 4: simpler, with an example", "Drew chapters 4 to 6", "Drew chapters 1 to 3", "Course plan, from 3 documents"],
    status: ["done", "check", "Done", ""],
    cam: [-40, -10, 2250, 1000],
    world: (z) => ALL_DRAWN(z) + homePage() + links() + DOCS(false, z)
      + redLoop(chapterAt(3).x + 200, chapterAt(3).y + 122, 80, 42, "mine2", z)
      + arrow(chapterAt(3).x + 122, chapterAt(3).y + 140, DET.x + DET.w + 8, DET.y + 70, "detour", RED)
      + page(DET.x, DET.y, DET.w, "Why the judge doesn't know", "detour", DETOUR.draw(), { cls: "cf-appear", delay: 0.2 }),
  },
];

/* ---------- rendering a step ---------- */
const S = { i: 0, cam: [...STEPS[0].cam] as number[], anim: 0 };
function renderSide(s: Step) {
  $("#side").innerHTML = `<div class="lp-project">${logo(26)}<button class="lp-name">${esc(s.project)}</button></div>
    <div class="lp-head"><span>Pages</span><button title="Click through the site as a visitor would">Preview</button></div>
    <ul class="lp-tree"><li><button class="on">All pages</button></li>${s.pages.map((p) => `<li style="padding-left:${p.depth * 14}px"><button><span class="lp-glyph">${icon(p.home ? "home" : "branch")}</span><span class="lp-label">${esc(p.name)}</span></button></li>`).join("")}</ul>
    <div class="lp-head"><span>History</span></div>
    ${s.history.length ? `<ul class="lp-history">${s.history.map((h, k) => `<li><button class="${k ? "" : "on"}"><span class="lp-n">V${s.history.length - k}</span><span class="lp-label">${esc(h)}</span><span class="lp-ago">${k ? `${k * 2} min` : "latest"}</span></button></li>`).join("")}</ul>` : `<p class="lp-empty">Nothing yet. Start talking and every change shows up here.</p>`}`;
}
function renderChrome(s: Step) {
  renderSide(s);
  const st = $("#state");
  st.hidden = !s.status;
  if (s.status) {
    const [cls, glyph, word, detail] = s.status;
    st.className = "pg-state " + cls;
    st.innerHTML = `${icon(glyph, glyph === "pencil" ? "pg-pencil" : "")}<span>${esc(word)}</span>${detail ? `<span class="pg-state-detail">${esc(detail)}</span>` : ""}`;
  }
  const say = $("#say") as HTMLTextAreaElement;
  say.value = s.bar ?? "";
  say.placeholder = "Think out loud about your page, e.g. \"a landing page for rubber ducks, big yellow hero with a duck photo...\"";
  ($("#send") as HTMLButtonElement).disabled = !(s.bar || s.tip);
  $("#tip").hidden = !s.tip;
  $("#tip").innerHTML = s.tip ? `<span>${esc(s.tip)}</span>` : "";
}
function renderPreview(p?: Preview) {
  $("#pv").hidden = !p;
  if (!p) return;
  $("#pvBar").innerHTML = `<select aria-label="Page"><option>${esc(p.page)}</option></select>`
    + (p.building ? `<span class="pv-status"><span class="pv-spinner" aria-hidden="true"></span> Building “${esc(p.building)}”…</span>` : `<span class="pv-hint cf-new-inline">${esc(p.hint ?? "")}</span>`)
    + `<button class="pv-edit">${icon("pencil")} Edit<span class="pv-long"> this page</span></button><button class="pv-full">Full screen</button><button class="pv-exit">${icon("close")} Exit<span class="pv-long"> preview</span></button>`;
  const loop = p.loop ? redLoop(p.loop[0], p.loop[1], p.loop[2], p.loop[3], "pvloop", 2.4, 1) : "";
  $("#pvStage").innerHTML = `<svg class="cf-page" viewBox="0 0 ${PW} ${PH}" aria-hidden="true">${p.art}${loop}</svg>${p.dot ? `<div class="cf-dot" style="animation-name:${dotPath(p.dot)}"></div>` : ""}`;
  const [prev, now] = p.line;
  const said = now.replace(/(judge|tie)/, `<mark class="said">$1</mark>`);
  $("#narr").innerHTML = `<p class="cf-prev">${esc(prev)}</p><p class="cf-now">${p.ask ? esc(now) : said}</p>
    <div class="cf-beats">${[1, 1.3, 0.9, 1.1].map((w, k) => `<i style="--w:${w}"><b style="width:${k < 1 ? 100 : k === 1 ? (p.playing ? 55 : 30) : 0}%"></b></i>`).join("")}<span>${p.hint?.split("· ")[1] ?? "0:21 / 1:04"}</span></div>
    <div class="pg-row">
      <button class="cf-ib">${icon("prev")}</button><button class="pg-send cf-play">${p.playing ? `${icon("pause")} Pause` : `${icon("play")} Play`}</button><button class="cf-ib">${icon("next")}</button><button class="cf-ib">${icon("again")}</button>
      ${p.back ? `<button class="cf-back">${icon("back")} ${esc(p.back)}</button>` : `<textarea rows="1" readonly placeholder="Pause and ask, or circle something first">${esc(p.ask ?? "")}</textarea><button class="pg-mic">${icon("mic")}</button><button class="pg-send"${p.ask ? "" : " disabled"}>Ask</button>`}
    </div>`;
}
/** Keyframes taking the red dot through a page's marks, a third of a loop on each, as the narration would. */
function dotPath(pts: [number, number][]) {
  const name = "cf-dot-" + pts.map((p) => p.join("_")).join("-").replace(/\./g, "");
  if (!document.getElementById(name)) {
    const n = pts.length, at = (k: number) => `left:${(pts[k][0] / PW) * 100}%;top:${(pts[k][1] / PH) * 100}%`;
    const frames = pts.map((_, k) => `${((k / n) * 100).toFixed(1)}%,${(((k + 0.8) / n) * 100).toFixed(1)}%{${at(k)}}`).join("") + `100%{${at(0)}}`;
    document.head.insertAdjacentHTML("beforeend", `<style id="${name}">@keyframes ${name}{${frames}}</style>`);
  }
  return name;
}
function markNew(s: Step) {
  document.querySelectorAll(".cf-new").forEach((e) => e.classList.remove("cf-new"));
  const sel = [...(s.fresh ?? []), ...(s.preview ? ["#narr"] : [])];
  for (const q of sel) document.querySelectorAll(q).forEach((e) => e.classList.add("cf-new"));
}

/* ---------- the board's camera: it glides between steps, as imagine glides to a page ---------- */
function area() {
  const side = document.querySelector(".pg-panel")!.getBoundingClientRect(), app = $("#app").getBoundingClientRect(), bar = $("#bar").getBoundingClientRect();
  return { left: side.right + 16 - app.left, top: 72, right: 16, bottom: app.bottom - bar.top + 18 };
}
function place() {
  const a = area(), app = $("#app").getBoundingClientRect();
  Object.assign($("#world").style, { left: `${a.left}px`, top: `${a.top}px`, width: `${app.width - a.left - a.right}px`, height: `${app.height - a.top - a.bottom}px` });
}
const zoomOf = (cam: number[]) => { const r = $("#world").getBoundingClientRect(); return Math.min(r.width / cam[2], r.height / cam[3]); };
function glide(to: number[]) {
  cancelAnimationFrame(S.anim);
  const from = [...S.cam], t0 = performance.now();
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / 650), e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
    S.cam = from.map((v, k) => v + (to[k] - v) * e);
    $("#world").setAttribute("viewBox", S.cam.map((v) => v.toFixed(1)).join(" "));
    $("#zoom .cv-pct").textContent = `${Math.round(zoomOf(S.cam) * 100)}%`;
    if (u < 1) S.anim = requestAnimationFrame(step);
  };
  S.anim = requestAnimationFrame(step);
}
function go(i: number) {
  S.i = Math.max(0, Math.min(STEPS.length - 1, i));
  const s = STEPS[S.i];
  history.replaceState(null, "", `#${S.i + 1}`);
  $("#stepTitle").textContent = `${S.i + 1}. ${s.title}`;
  $("#stepSay").textContent = s.say;
  document.querySelectorAll<HTMLElement>("#steps button").forEach((b, k) => { b.classList.toggle("on", k === S.i); b.classList.toggle("past", k < S.i); });
  renderChrome(s);
  renderPreview(s.preview);
  place();
  $("#world").innerHTML = s.world(zoomOf(s.cam));
  glide(s.cam);
  markNew(s);
}

/* ---------- wiring ---------- */
installCursors();
$("#steps").innerHTML = STEPS.map((s, k) => `<li><button title="${esc(s.title)}" aria-label="Step ${k + 1}: ${esc(s.title)}">${k + 1}</button></li>`).join("");
$("#steps").addEventListener("click", (e) => { const b = (e.target as Element).closest("button"); if (b) go([...document.querySelectorAll("#steps button")].indexOf(b)); });
$("#prevStep").addEventListener("click", () => go(S.i - 1));
$("#nextStep").addEventListener("click", () => go(S.i + 1));
$("#tools").innerHTML = `<button class="pg-tool" title="New project">${icon("newProject")}</button><button class="pg-tool" title="All projects">${icon("projects")}</button><div class="st"><button class="st-gear" title="Settings">${icon("gear")}</button></div>`;
$("#zoom").innerHTML = `<button class="cv-hand">${icon("hand")}</button><button>${icon("minus")}</button><button class="cv-pct">100%</button><button>${icon("plus")}</button><button>Fit</button>`;
$("#clip").innerHTML = icon("clip");
$("#mic").innerHTML = icon("mic");
const showNew = $("#showNew") as HTMLInputElement;
const syncNew = () => document.body.classList.toggle("show-new", showNew.checked);
showNew.addEventListener("change", syncNew);
syncNew();
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "ArrowRight") go(S.i + 1);
  else if (e.key === "ArrowLeft") go(S.i - 1);
  else if (/^[1-9]$/.test(e.key)) go(+e.key - 1);
});
addEventListener("resize", () => go(S.i));
new ResizeObserver(() => { document.documentElement.style.setProperty("--strip", `${$(".cf-strip").offsetHeight}px`); go(S.i); }).observe($(".cf-strip"));
document.fonts.ready.then(() => go(S.i));
go((parseInt(location.hash.slice(1)) || 1) - 1);
