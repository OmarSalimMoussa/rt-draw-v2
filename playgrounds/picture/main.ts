// Picture playground: a doodle inside a shape from a few words. Six subjects
// from the Clowns.com page side by side, a custom one, and one in place inside
// the page's hero photo. The model is only called when you press a Draw button.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import { makeSet } from "../../src/core/labels.ts";
import { modelOf } from "../../src/core/model.ts";
import { runScript } from "../../src/core/ops.ts";
import { type El, type Picture, drawPicture, renderPicture } from "../../src/core/picture.ts";
import { render } from "../../src/core/render.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { $, download, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("picture", "A few words become a doodle that fills a shape's box, drawn by a model as small SVG and redrawn with rough.js so it wobbles like the canvas. Press Draw all (6 calls), rate each picture, save the set. Nothing calls the model until you press a Draw button.");

/** Subjects from the Clowns.com page, at sizes like the shapes they'd fill. */
const PRESETS: { subject: string; w: number; h: number }[] = [
  { subject: "toy robot", w: 160, h: 160 },
  { subject: "teddy bear", w: 160, h: 160 },
  { subject: "red toy car", w: 200, h: 130 },
  { subject: "rubber duck", w: 160, h: 160 },
  { subject: "smiling clown portrait", w: 240, h: 180 },
  { subject: "kite", w: 160, h: 200 },
];

type Slot = { subject: string; w: number; h: number; picture?: Picture; model?: string; rating?: "ok" | "bad"; error?: string; busy?: boolean; els: El[] };
const slots: Slot[] = PRESETS.map((p) => ({ ...p, els: [] }));
const custom: Slot = { subject: "a birthday cake with three candles", w: 200, h: 160, els: [] };

$("#left").innerHTML = `
  <div class="card"><h2>Subjects</h2><div id="grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px"></div></div>
  <div class="card"><h2>Your own</h2>
    <div class="row"><input id="subject" value="${custom.subject}" style="flex:1;min-width:200px;font:16px Excalifont, cursive;padding:5px 8px;border:1.5px solid var(--ink);border-radius:8px">
      <label>w <input id="cw" type="number" value="${custom.w}" min="40" max="800" style="width:70px"></label>
      <label>h <input id="ch" type="number" value="${custom.h}" min="40" max="800" style="width:70px"></label>
      <button id="drawCustom">Draw (1 call)</button></div>
    <div id="customSlot"></div></div>
  <div class="card"><h2>In the page</h2>
    <div class="row"><span class="muted">The hero photo's picture, drawn into its own box (800 × 380), over the page.</span><button id="drawHero">Draw in hero-photo (1 call)</button></div>
    <div id="heroStage"></div><div class="stat" id="heroStat"></div></div>`;

$("#side").innerHTML = `
  <div class="card">
    <h2>Draw</h2>
    <div class="row"><button class="primary" id="drawAll">Draw all (6 calls)</button><button id="save" disabled>Save set</button></div>
    <div class="stat" id="stat">No calls yet.</div>
    <pre class="log" id="log"></pre>
    <pre class="log bad" id="errors"></pre>
  </div>`;

let tuning: Tuning = DEFAULTS;
tuningPanel($("#side"), ["picture"], (t) => {
  // Knob changes redraw what's there (roughness) but never call the model.
  tuning = t;
  drawAllSlots();
  drawHero();
});

const NS = "http://www.w3.org/2000/svg";
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const log: string[] = [];
const say = (line: string) => {
  log.push(line);
  $("#log").textContent = log.slice(-14).join("\n");
};

/** A slot's frame: the box at its real size (scaled down to fit the column), the doodle inside, its numbers and rating. */
function slotHtml(s: Slot, i: number | "custom") {
  const f = s.picture?.features;
  const nums = f ? `${s.model} · first ${f.firstMs} ms · ${f.ms} ms · ${f.paths} paths · ${f.colors} colors · ${f.bytes} B${f.clipped ? " · clipped" : ""}${f.dropped ? ` · ${f.dropped} dropped` : ""}${f.refused ? ` · ${f.refused} refused` : ""}${f.remapped ? ` · ${f.remapped} recolored` : ""}` : s.busy ? "drawing…" : s.error ? "" : "not drawn yet";
  const rate = f ? `<div class="row"><button data-rate="ok" data-i="${i}"${s.rating === "ok" ? ' class="primary"' : ""}>👍</button><button data-rate="bad" data-i="${i}"${s.rating === "bad" ? ' class="primary"' : ""}>👎</button></div>` : "";
  return `<div><div style="font:17px Excalifont, cursive">${esc(s.subject)} <span class="muted stat">${s.w}×${s.h}</span></div>
    <svg data-slot="${i}" viewBox="-4 -4 ${s.w + 8} ${s.h + 8}" style="width:100%;max-height:220px;background:#fff;border:1.5px solid var(--line);border-radius:8px"></svg>
    <div class="stat">${nums}</div>${s.error ? `<div class="stat bad">${esc(s.error)}</div>` : ""}${rate}</div>`;
}

function paintSlot(svg: SVGSVGElement, s: Slot) {
  svg.replaceChildren();
  const frame = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: s.w, height: s.h, fill: "none", stroke: "#dcd8cf", "stroke-dasharray": "6 4" })) frame.setAttribute(k, String(v));
  svg.append(frame);
  if (s.els.length) renderPicture(svg, s.els, { x: 0, y: 0, w: s.w, h: s.h }, tuning);
}

function drawAllSlots() {
  $("#grid").innerHTML = slots.map((s, i) => slotHtml(s, i)).join("");
  $("#customSlot").innerHTML = custom.picture || custom.busy || custom.error ? slotHtml(custom, "custom") : "";
  slots.forEach((s, i) => paintSlot(document.querySelector<SVGSVGElement>(`svg[data-slot="${i}"]`)!, s));
  const c = document.querySelector<SVGSVGElement>('svg[data-slot="custom"]');
  if (c) paintSlot(c, custom);
  const drawn = [...slots, custom].filter((s) => s.picture);
  ($("#save") as HTMLButtonElement).disabled = !drawn.length;
}

/** Draws one slot: the doodle appears element by element as the reply streams in. */
async function drawSlot(s: Slot, i: number | "custom") {
  s.busy = true;
  s.error = undefined;
  s.els = [];
  s.picture = undefined;
  s.rating = undefined;
  drawAllSlots();
  const model = modelOf(tuning["picture.model"]);
  try {
    const { picture, stats } = await drawPicture(s.subject, s.w, s.h, tuning, (els) => {
      s.els = els;
      const svg = document.querySelector<SVGSVGElement>(`svg[data-slot="${i}"]`);
      if (svg) paintSlot(svg, s);
    });
    s.picture = picture;
    s.els = picture.els;
    s.model = model;
    say(`${s.subject}: ${model} · first ${stats.firstMs} ms · ${stats.ms} ms · ${stats.inTokens ?? "?"} in / ${stats.outTokens ?? "?"} out`);
  } catch (err) {
    s.error = err instanceof Error ? err.message : String(err);
    say(`${s.subject}: failed (${s.error})`);
  }
  s.busy = false;
  drawAllSlots();
}

$("#drawAll").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#drawAll");
  btn.disabled = true;
  const t0 = performance.now();
  // All six at once: the dev server runs one Claude process per call.
  await Promise.all(slots.map((s, i) => drawSlot(s, i)));
  const done = slots.filter((s) => s.picture);
  const ms = done.map((s) => s.picture!.features.ms).sort((a, b) => a - b);
  $("#stat").textContent = `${done.length} / ${slots.length} drawn in ${Math.round(performance.now() - t0)} ms wall · median ${ms[Math.floor(ms.length / 2)] ?? "-"} ms per picture · ${tuningId(tuning)}`;
  btn.disabled = false;
});

$("#drawCustom").addEventListener("click", () => {
  custom.subject = $<HTMLInputElement>("#subject").value.trim() || custom.subject;
  custom.w = Math.max(40, Number($<HTMLInputElement>("#cw").value) || custom.w);
  custom.h = Math.max(40, Number($<HTMLInputElement>("#ch").value) || custom.h);
  void drawSlot(custom, "custom");
});

$("#left").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rate]");
  if (!b) return;
  const s = b.dataset.i === "custom" ? custom : slots[Number(b.dataset.i)];
  const r = b.dataset.rate as "ok" | "bad";
  s.rating = s.rating === r ? undefined : r;
  drawAllSlots();
});

// Rated pictures are corrections; unrated ones count as accepted. The reply is kept, so any
// sanitizer or palette change can be replayed on it without calling the model again.
$("#save").addEventListener("click", () => {
  const examples = [...slots, custom]
    .filter((s) => s.picture)
    .map((s) => ({ decision: "picture.ok", strokes: [], predicted: "ok", features: { ...s.picture!.features, model: s.model ?? "", reply: s.picture!.reply }, label: s.rating ?? "ok", corrected: !!s.rating }));
  download(`pictures-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(makeSet("playground", undefined, tuning, tuningId(tuning), examples), null, 1));
});

// In the page: the hero photo's own words, drawn into its box over the page (its placeholder hidden).
const page = runScript(clowns).scene;
const heroShape = page.get("hero-photo")!;
const heroSubject = heroShape.drawing ?? "a photo";
const { canvas } = stage($("#heroStage"));
let hero: { els: El[]; picture?: Picture } = { els: [] };

function drawHero() {
  // Placeholder hatch off for the hero only, so the doodle sits on the shape's own fill.
  const shown = runScript(clowns).scene;
  const h = shown.get("hero-photo")!;
  h.drawing = hero.els.length ? undefined : h.drawing;
  render(canvas, shown, { tuning });
  if (!hero.els.length) return;
  const g = renderPicture(canvas, hero.els, heroShape.box, tuning);
  // The shape's fade still applies to its picture.
  if (heroShape.style.fade) g.setAttribute("opacity", String(1 - heroShape.style.fade * tuning["render.fadeOpacity"]));
  // Over the photo but under the headline and the story card, as the layers say.
  const above = canvas.querySelector(`[data-id="${page.order[page.order.indexOf("hero-photo") + 1]}"]`);
  if (above) canvas.insertBefore(g, above);
}

$("#drawHero").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#drawHero");
  btn.disabled = true;
  $("#heroStat").textContent = `drawing "${heroSubject}"…`;
  try {
    const { picture, stats } = await drawPicture(heroSubject, heroShape.box.w, heroShape.box.h, tuning, (els) => {
      hero = { els };
      drawHero();
    });
    hero = { els: picture.els, picture };
    drawHero();
    const f = picture.features;
    $("#heroStat").textContent = `"${heroSubject}" · ${modelOf(tuning["picture.model"])} · first ${f.firstMs} ms · ${f.ms} ms · ${stats.inTokens ?? "?"} in / ${stats.outTokens ?? "?"} out · ${f.paths} paths${f.clipped ? " · clipped" : ""}`;
    say(`hero-photo: first ${f.firstMs} ms · ${f.ms} ms`);
  } catch (err) {
    $("#errors").textContent += `hero-photo: ${err instanceof Error ? err.message : String(err)}\n`;
    $("#heroStat").textContent = "";
  }
  btn.disabled = false;
});

drawAllSlots();
fontsReady().then(drawHero);
