// Board shots playground: what a model can be shown of an infinite board. Move
// around (scroll, ctrl-scroll, space-drag), draw, type what you'd say, and
// Capture: the views worth sending are picked for you and captured side by
// side (what you see, close-ups of marks, pages you named, the whole board),
// next to the site map as text, each with its size and token cost. No model call.
import board from "../../src/fixtures/board.ops.txt?raw";
import { type BoardShot, type NamedView, autoViews, boardShots, fitView, pagesOf, siteMap, union } from "../../src/core/board.ts";
import { type Stroke, attachInk } from "../../src/core/ink.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { imageTokens, takeShot } from "../../src/core/shot.ts";
import { DEFAULTS, type Tuning, tune } from "../../src/core/tuning.ts";
import { boardStage } from "../../src/boardStage.ts";
import { $, fontsReady, shell, tuningPanel } from "../../src/ui.ts";

shell("board", "An infinite board of five pages. Scroll to pan, ctrl-scroll to zoom, hold space and drag to pan; draw with the pen. Type what you'd say and press Capture: the views worth sending a model are picked and captured side by side, next to the site map as text, with what each costs. No model is called.");
const { scene } = runScript(board);
const all = () => fitView(union(pagesOf(scene).map((p) => p.box)), 0.03);
const st = boardStage($("#left"), { x: -40, y: -100, w: 1500, h: 1500 / (1280 / 800) });
let tuning: Tuning = DEFAULTS;
let strokes: Stroke[] = [];
const INK = "#e03131";
const epoch = performance.now();
let detach = attachInk(st.ink, (s) => strokes.push(s), { epoch, color: INK });
const draw = () => render(st.canvas, scene, { tuning, view: st.view() });

const out = document.createElement("div");
out.className = "card";
out.style.marginTop = "12px";
out.innerHTML = `<h2>What the model would get</h2><div class="stat" id="sum">Press Capture.</div><div id="views" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px"></div>
  <h3 style="margin:8px 0 0">Site map, as text <span class="stat muted" id="mapStat"></span></h3><pre class="log" id="map" style="max-height:480px;background:#faf9f6;padding:8px;border-radius:6px"></pre>`;
$("#left").append(out);

$("#side").innerHTML = `
  <div class="card">
    <h2>Capture</h2>
    <input id="said" placeholder="what you'd say, e.g. move this to the shop page" style="font:16px Excalifont, cursive;padding:6px 8px;border:1.5px solid var(--ink);border-radius:8px">
    <div class="row"><button class="primary" id="capture">Capture</button><button id="oneByOne" title="The same views, captured one after another, to compare with side by side">One at a time</button></div>
    <div class="row"><button id="fit">Show everything</button><button id="clear">Clear ink</button></div>
    <div class="stat" id="camera"></div>
  </div>`;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function showMap() {
  const text = siteMap(scene, tuning);
  $("#map").textContent = text;
  $("#mapStat").textContent = `· ${text.length} chars · ~${Math.ceil(text.length / 4)} tokens · depth ${tuning["board.mapDepth"]}, ${tuning["board.mapWords"]} words per description`;
  return text;
}

function show(shots: BoardShot[], ms: number, sumMs: number, how: string) {
  const imgTokens = shots.reduce((a, s) => a + imageTokens(s.shot.width, s.shot.height), 0);
  const mapTokens = Math.ceil(showMap().length / 4);
  $("#sum").textContent = `${shots.length} pictures ${how} in ${ms} ms (each on its own: ${sumMs} ms in all) · ~${imgTokens} image tokens + ~${mapTokens} for the map = ~${imgTokens + mapTokens} tokens · ${kb(shots.reduce((a, s) => a + s.shot.bytes, 0))}`;
  $("#views").innerHTML = shots
    .map((s) => `<figure style="margin:0;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff">
      <a href="${URL.createObjectURL(s.shot.blob)}" target="_blank"><img src="${s.shot.dataUrl}" style="width:100%;border-radius:4px;display:block"></a>
      <figcaption class="stat"><b>${esc(s.name)}</b> · ${s.shot.width}×${s.shot.height} · ~${imageTokens(s.shot.width, s.shot.height)} tokens · ${kb(s.shot.bytes)} · ${Math.round(s.shot.ms.total)} ms<br><span class="muted">${esc(s.why)} · board ${Math.round(s.view.w)}×${Math.round(s.view.h)} at ${Math.round(s.view.x)},${Math.round(s.view.y)}</span></figcaption></figure>`)
    .join("");
}

function views(): NamedView[] {
  return autoViews(scene, st.view(), strokes, $<HTMLInputElement>("#said").value, tuning);
}

$("#capture").addEventListener("click", async () => {
  const { shots, ms, sumMs } = await boardShots(scene, strokes, views(), tuning);
  show(shots, ms, sumMs, "side by side");
});
$("#oneByOne").addEventListener("click", async () => {
  const t0 = performance.now();
  const shots: BoardShot[] = [];
  for (const v of views()) shots.push({ ...v, shot: await takeShot(scene, strokes, v.tags ? tuning : tune({ "shot.tagPx": 0 }, tuning), { view: v.view, width: v.width }) });
  show(shots, Math.round(performance.now() - t0), Math.round(shots.reduce((a, s) => a + s.shot.ms.total, 0)), "one after another");
});
$("#fit").addEventListener("click", () => void st.setView(all(), tuning["camera.easeMs"]));
$("#clear").addEventListener("click", () => {
  strokes = [];
  st.ink.replaceChildren();
  detach();
  detach = attachInk(st.ink, (s) => strokes.push(s), { epoch, color: INK });
});
st.onMove((v) => ($("#camera").textContent = `camera ${Math.round(v.x)},${Math.round(v.y)} · ${Math.round(v.w)}×${Math.round(v.h)} board px · zoom ${(1280 / v.w).toFixed(2)}×`));

tuningPanel($("#side"), ["board", "shot"], (t) => {
  tuning = t;
  draw();
  showMap();
});
fontsReady().then(() => {
  draw();
  showMap();
});
