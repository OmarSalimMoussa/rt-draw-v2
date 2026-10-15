// Renderer playground: edit a scene as ops and see it drawn.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import grid from "../../src/fixtures/grid.ops.txt?raw";
import { DEFAULT_CELL, runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { $, fontsReady, shell, stage } from "../../src/ui.ts";

shell("render", "A scene is just layered shapes. Edit the ops and the canvas redraws; click a shape to see what it is.");
const fixtures: Record<string, string> = { "Clowns.com (pixels)": clowns, "Settings screen (grid cells)": grid };
const { canvas } = stage($("#left"));

$("#side").innerHTML = `
  <div class="card">
    <h2>Scene</h2>
    <div class="row"><select id="fixture">${Object.keys(fixtures).map((k) => `<option>${k}</option>`).join("")}</select></div>
    <textarea id="src" rows="18" spellcheck="false"></textarea>
    <div class="row">
      <label><input type="checkbox" id="grid"> grid (${DEFAULT_CELL} px cells)</label>
      <label><input type="checkbox" id="tags"> id tags</label>
      <button id="redraw">Redraw (new wobble check)</button>
    </div>
    <div class="stat" id="stat"></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card"><h2>Clicked shape</h2><pre class="log" id="picked">Click a shape on the canvas.</pre></div>
  <div class="card"><h2>Id map</h2><table class="marks"><tbody id="idmap"></tbody></table></div>`;

const src = $<HTMLTextAreaElement>("#src");
const fixture = $<HTMLSelectElement>("#fixture");
let current = runScript("").scene;

function draw() {
  const { scene, errors } = runScript(src.value);
  current = scene;
  const ms = render(canvas, scene, { grid: $<HTMLInputElement>("#grid").checked ? DEFAULT_CELL : undefined, tags: $<HTMLInputElement>("#tags").checked });
  $("#stat").textContent = `${scene.shapes.size} shapes · ${scene.groups.size} groups · drawn in ${ms.toFixed(1)} ms`;
  $("#errors").textContent = errors.map((e) => `✗ ${e.line}\n   ${e.error}`).join("\n");
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  $("#idmap").innerHTML = scene.stacked().map((sh) => `<tr><th>${esc(sh.id)}</th><td>${esc(sh.description)}</td></tr>`).join("");
}

let timer = 0;
src.addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(draw, 150);
});
fixture.addEventListener("change", () => {
  src.value = fixtures[fixture.value];
  draw();
});
for (const id of ["#grid", "#tags", "#redraw"]) $(id).addEventListener(id === "#redraw" ? "click" : "change", draw);
canvas.addEventListener("click", (e) => {
  const id = (e.target as Element).closest("[data-id]")?.getAttribute("data-id");
  const s = id && current.get(id);
  $("#picked").textContent = s ? JSON.stringify(s, null, 2) : "Nothing there.";
});

src.value = fixtures[fixture.value];
fontsReady().then(draw);
