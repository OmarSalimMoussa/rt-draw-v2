// Hit-test playground: what does each stroke touch, go around, start on, end on?
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import { HitIndex } from "../../src/core/hittest.ts";
import { readArrow } from "../../src/core/arrow.ts";
import { type Stroke, attachInk } from "../../src/core/ink.ts";
import { boxOf, groupStrokes } from "../../src/core/marks.ts";
import { DEFAULTS, type Tuning } from "../../src/core/tuning.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { $, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("hittest", "Draw over the page. Orange = touched, green = enclosed (enough of its 5 sample points inside your loop), blue = where the stroke starts and ends. Arrows ring their tip (green) and tail (grey) and say what they point at. Shapes are tested front to back by layer.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const { scene } = runScript(clowns);

$("#side").innerHTML = `
  <div class="card">
    <h2>Last mark</h2>
    <div class="row"><button id="clear">Clear</button><label><input type="checkbox" id="tags" checked> id tags</label></div>
    <table class="marks"><tbody id="result"><tr><td class="muted">Draw a stroke. Strokes drawn close together count as one mark, so an arrowhead can be its own stroke.</td></tr></tbody></table>
    <div class="stat" id="stat"></div>
  </div>`;

let index: HitIndex;
let tuning: Tuning = DEFAULTS;
tuningPanel($("#side"), ["hit", "arrow", "marks"], (t) => {
  tuning = t;
  if (strokes.length) readLast();
});
let highlight = new Map<string, string>();
let strokes: Stroke[] = [];
const draw = () => render(canvas, scene, { tags: $<HTMLInputElement>("#tags").checked, highlight });

function ring(p: [number, number], color: string, r: number) {
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [k, v] of Object.entries({ cx: p[0], cy: p[1], r, fill: "none", stroke: color, "stroke-width": 3 })) c.setAttribute(k, String(v));
  c.classList.add("anno");
  ink!.append(c);
}

attachInk(ink!, (s) => {
  strokes.push(s);
  readLast();
});

function readLast() {
  // Keep only the mark the newest stroke belongs to; older marks' ink goes.
  const mark = groupStrokes(strokes, tuning).at(-1)!;
  strokes = mark.strokes;
  const keep = new Set(strokes.map((x) => String(x.id)));
  for (const el of [...ink!.children]) if (!keep.has((el as SVGElement).dataset.stroke ?? "")) el.remove();

  const t0 = performance.now();
  const all = mark.strokes.flatMap((x) => x.points);
  const first = mark.strokes[0].points[0];
  const last = mark.strokes.at(-1)!.points.at(-1)!;
  const touched = index.touched(all, tuning);
  const enclosed = mark.strokes.length === 1 ? index.enclosed(mark.strokes[0].points, tuning) : [];
  const from = index.top(first[0], first[1], tuning);
  const to = index.top(last[0], last[1], tuning);
  const arrow = readArrow(mark.strokes.map((x) => x.points), tuning);
  const tailOn = arrow.tail && index.top(arrow.tail[0], arrow.tail[1], tuning);
  const tipOn = arrow.tip && index.top(arrow.tip[0], arrow.tip[1], tuning);
  const ms = performance.now() - t0;

  highlight = new Map();
  for (const id of touched) highlight.set(id, "#e8590c");
  for (const id of enclosed) highlight.set(id, "#2b8a3e");
  for (const id of [from, to]) if (id) highlight.set(id, "#1971c2");
  if (arrow.arrow && tipOn) highlight.set(tipOn, "#2b8a3e");
  draw();
  if (arrow.tip) ring(arrow.tip, "#2b8a3e", 12);
  if (arrow.tail) ring(arrow.tail, "#adb5bd", 8);

  const row = (k: string, v: string) => `<tr><th>${k}</th><td>${v || '<span class="muted">nothing</span>'}</td></tr>`;
  const arrowCell = arrow.arrow ? `<b class="ok">yes</b> ${arrow.confidence} · ${arrow.why}` : `<b class="muted">no</b> · ${arrow.why}`;
  $("#result").innerHTML =
    row("arrow?", arrowCell) +
    (arrow.arrow ? row("points from", tailOn ?? "empty space") + row("points at", tipOn ?? `empty space (${Math.round(arrow.tip![0])}, ${Math.round(arrow.tip![1])})`) : "") +
    row("starts on", from ?? "") + row("ends on", to ?? "") + row("touched", touched.join(", ")) + row("enclosed", enclosed.join(", ")) + row("drawn inside", index.container(boxOf(all)) ?? "");
  $("#stat").textContent = `${mark.strokes.length} stroke(s), ${all.length} points, tested against ${scene.shapes.size} shapes in ${(ms * 1000).toFixed(0)} µs`;
}

$("#clear").addEventListener("click", () => {
  strokes = [];
  ink!.replaceChildren();
  highlight = new Map();
  draw();
});
$("#tags").addEventListener("change", draw);
fontsReady().then(() => {
  index = new HitIndex(scene);
  draw();
});
