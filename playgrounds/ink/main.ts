// Ink playground: draw, and check every stroke carries usable times.
import { type Stroke, attachInk, pathLength, strokePath } from "../../src/core/ink.ts";
import { Scene } from "../../src/core/scene.ts";
import { render } from "../../src/core/render.ts";
import { $, download, shell, stage } from "../../src/ui.ts";

shell("ink", "Draw anything. Each stroke records its points with a time in ms, so later it can be matched to the word you were saying. Replay redraws them at their real pace.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
render(canvas, new Scene());

$("#side").innerHTML = `
  <div class="card">
    <h2>Strokes</h2>
    <div class="row"><button id="clear">Clear</button><button id="replay">Replay at real speed</button><button id="save">Save as JSON</button></div>
    <div class="stat" id="stat">No strokes yet.</div>
    <table class="marks"><thead><tr><th>#</th><th>start</th><th>length</th><th>points</th><th>pts/s</th></tr></thead><tbody id="rows"></tbody></table>
  </div>`;

let strokes: Stroke[] = [];
const epoch = performance.now();

function list() {
  $("#rows").innerHTML = strokes
    .map((s) => {
      const dur = Math.max(1, s.t1 - s.t0);
      return `<tr><td>${s.id}</td><td>${(s.t0 / 1000).toFixed(2)} s</td><td>${Math.round(pathLength(s.points))} px / ${dur} ms</td><td>${s.points.length}</td><td>${Math.round((s.points.length / dur) * 1000)}</td></tr>`;
    })
    .join("");
  const gaps = strokes.slice(1).map((s, i) => s.t0 - strokes[i].t1);
  $("#stat").textContent = strokes.length ? `${strokes.length} strokes · gaps between strokes: ${gaps.map((g) => `${g} ms`).join(", ") || "-"}` : "No strokes yet.";
}

attachInk(ink!, (s) => {
  strokes.push(s);
  list();
}, { epoch });

$("#clear").addEventListener("click", () => {
  strokes = [];
  ink!.replaceChildren();
  list();
});
$("#save").addEventListener("click", () => download("strokes.json", JSON.stringify(strokes)));
$("#replay").addEventListener("click", () => {
  ink!.replaceChildren();
  const start = performance.now();
  const first = strokes[0]?.t0 ?? 0;
  const paths = strokes.map(() => {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", "#1971c2");
    ink!.append(p);
    return p;
  });
  const tick = () => {
    const now = performance.now() - start + first;
    strokes.forEach((s, i) => {
      const pts = s.points.filter((p) => p[2] <= now);
      paths[i].setAttribute("d", pts.length > 1 ? strokePath(pts) : "");
    });
    if (now < (strokes.at(-1)?.t1 ?? 0)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
