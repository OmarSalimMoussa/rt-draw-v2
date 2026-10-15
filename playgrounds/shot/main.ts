// Model screenshot playground: draw over a page, press Enter, and see the exact
// picture the model would get, with its size, cost in tokens and time to make.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import grid from "../../src/fixtures/grid.ops.txt?raw";
import { type Stroke, attachInk } from "../../src/core/ink.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { type Shot, imageTokens, takeShot } from "../../src/core/shot.ts";
import { DEFAULTS, type Tuning } from "../../src/core/tuning.ts";
import { $, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("shot", "Draw over the page, then press Enter: this is the picture the model gets, with a number by each mark, id tags and an optional grid. It shows at its real size, with bytes, image tokens and how long it took to make.");
const fixtures: Record<string, string> = { "Clowns.com": clowns, "Settings screen": grid };
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const out = document.createElement("div");
out.className = "card";
out.style.marginTop = "16px";
out.innerHTML = `<h2>What the model sees</h2><div class="stat" id="info">Draw something, then press Enter.</div><div style="overflow:auto"><img id="img" alt="" style="display:none;border:1.5px solid var(--line);border-radius:6px"></div>`;
$("#left").append(out);

$("#side").innerHTML = `
  <div class="card">
    <h2>Shot</h2>
    <div class="row"><select id="fixture">${Object.keys(fixtures).map((k) => `<option>${k}</option>`).join("")}</select></div>
    <div class="row"><label><input type="checkbox" id="numbers" checked> ink numbers</label></div>
    <div class="row"><button class="primary" id="take">Take shot (Enter)</button><button id="clear">Clear ink</button><button id="save" disabled>Download</button></div>
    <pre class="log" id="log"></pre>
  </div>`;

let tuning: Tuning = DEFAULTS;
let scene = runScript(clowns).scene;
let strokes: Stroke[] = [];
let last: Shot | undefined;
const draw = () => render(canvas, scene, { tags: tuning["shot.tagPx"] > 0, grid: tuning["shot.gridCellPx"] || undefined, tuning });

async function take() {
  const shot = await takeShot(scene, strokes, tuning, { inkNumbers: $<HTMLInputElement>("#numbers").checked });
  last = shot;
  const img = $<HTMLImageElement>("#img");
  img.src = shot.dataUrl;
  img.style.display = "block";
  img.width = shot.width;
  $<HTMLButtonElement>("#save").disabled = false;
  const kb = (shot.bytes / 1024).toFixed(0);
  $("#info").textContent = `${shot.width}×${shot.height} ${shot.mime.split("/")[1]} · ${kb} KB · ~${imageTokens(shot.width, shot.height)} image tokens · ${shot.ms.total} ms`;
  $("#log").textContent = [
    `size      ${shot.width} × ${shot.height} (scale ${shot.features.scale})`,
    `bytes     ${shot.bytes} (${kb} KB, ${shot.mime})`,
    `tokens    ~${imageTokens(shot.width, shot.height)} (w×h / 750)`,
    `marks     ${shot.features.marks} · shapes ${shot.features.shapes}`,
    `serialize ${shot.ms.serialize} ms`,
    `rasterize ${shot.ms.rasterize} ms`,
    `encode    ${shot.ms.encode} ms`,
    `total     ${shot.ms.total} ms`,
  ].join("\n");
  console.log("shot", JSON.stringify({ ...shot.ms, bytes: shot.bytes, w: shot.width, h: shot.height }));
}

tuningPanel($("#side"), ["shot", "ink", "marks"], (t) => {
  tuning = t;
  draw();
  if (last) take();
});

attachInk(ink!, (s) => strokes.push(s));
$("#take").addEventListener("click", take);
$("#numbers").addEventListener("change", () => last && take());
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    take();
  }
});
$("#clear").addEventListener("click", () => {
  strokes = [];
  ink!.replaceChildren();
});
$("#save").addEventListener("click", () => {
  if (!last) return;
  const a = document.createElement("a");
  a.href = last.dataUrl;
  a.download = `shot.${last.mime === "image/png" ? "png" : "jpg"}`;
  a.click();
});
$<HTMLSelectElement>("#fixture").addEventListener("change", (e) => {
  scene = runScript(fixtures[(e.target as HTMLSelectElement).value]).scene;
  draw();
});
fontsReady().then(draw);
