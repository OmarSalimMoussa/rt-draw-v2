// Hit-test playground: what does each stroke touch, go around, start on, end on?
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import { HitIndex } from "../../src/core/hittest.ts";
import { attachInk } from "../../src/core/ink.ts";
import { boxOf } from "../../src/core/marks.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { $, fontsReady, shell, stage } from "../../src/ui.ts";

shell("hittest", "Draw over the page. Orange = touched, green = enclosed (at least 4 of 5 sample points inside your loop), blue = where the stroke starts and ends. Shapes are tested front to back by layer.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const { scene } = runScript(clowns);

$("#side").innerHTML = `
  <div class="card">
    <h2>Last stroke</h2>
    <div class="row"><button id="clear">Clear</button><label><input type="checkbox" id="tags" checked> id tags</label></div>
    <table class="marks"><tbody id="result"><tr><td class="muted">Draw a stroke.</td></tr></tbody></table>
    <div class="stat" id="stat"></div>
  </div>`;

let index: HitIndex;
let highlight = new Map<string, string>();
const draw = () => render(canvas, scene, { tags: $<HTMLInputElement>("#tags").checked, highlight });

attachInk(ink!, (s) => {
  for (const old of [...ink!.children].slice(0, -1)) old.remove();
  const t0 = performance.now();
  const touched = index.touched(s.points);
  const enclosed = index.enclosed(s.points);
  const [sx, sy] = s.points[0];
  const [ex, ey] = s.points.at(-1)!;
  const from = index.top(sx, sy);
  const to = index.top(ex, ey);
  const ms = performance.now() - t0;
  highlight = new Map();
  for (const id of touched) highlight.set(id, "#e8590c");
  for (const id of enclosed) highlight.set(id, "#2b8a3e");
  for (const id of [from, to]) if (id) highlight.set(id, "#1971c2");
  draw();
  const row = (k: string, v: string) => `<tr><th>${k}</th><td>${v || '<span class="muted">nothing</span>'}</td></tr>`;
  $("#result").innerHTML = row("starts on", from ?? "") + row("ends on", to ?? "") + row("touched", touched.join(", ")) + row("enclosed", enclosed.join(", ")) + row("drawn inside", index.container(boxOf(s.points)) ?? "");
  $("#stat").textContent = `${s.points.length} points tested against ${scene.shapes.size} shapes in ${(ms * 1000).toFixed(0)} µs`;
});

$("#clear").addEventListener("click", () => {
  ink!.replaceChildren();
  highlight = new Map();
  draw();
});
$("#tags").addEventListener("change", draw);
fontsReady().then(() => {
  index = new HitIndex(scene);
  draw();
});
