// Arrow or not: the local geometry check, with its tip and tail, on marks you label.
import { type ArrowReading, readArrow } from "../../src/core/arrow.ts";
import { type Stroke, attachInk, strokePath } from "../../src/core/ink.ts";
import { type Mark, TUNING, groupStrokes } from "../../src/core/marks.ts";
import { render } from "../../src/core/render.ts";
import { Scene } from "../../src/core/scene.ts";
import { $, download, shell, stage } from "../../src/ui.ts";

shell("arrow", "Draw a mark. The local check answers at once and marks the tip (green) and tail (grey). Label each mark to score it, save the set, and reload it after changing the rules.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
render(canvas, new Scene());

$("#side").innerHTML = `
  <div class="card">
    <h2>Set</h2>
    <div class="row"><button id="clear">Clear</button><button id="save">Save set</button><label class="row"><span>Load set</span><input type="file" id="load" accept=".json"></label></div>
    <div class="stat" id="score"></div>
  </div>
  <div class="card"><h2>Marks</h2><table class="marks"><thead><tr><th>#</th><th>reading</th><th>you say</th></tr></thead><tbody id="rows"></tbody></table></div>`;

type Row = { mark: Mark; local: ArrowReading; localUs: number };
let strokes: Stroke[] = [];
let rows: Row[] = [];
let labels = new Map<number, "arrow" | "not">();

function classify() {
  const marks = groupStrokes(strokes, TUNING);
  rows = marks.map((mark) => {
    const t0 = performance.now();
    const local = readArrow(mark.strokes.map((s) => s.points));
    return { mark, local, localUs: (performance.now() - t0) * 1000 };
  });
}

function draw() {
  ink!.querySelectorAll(".anno").forEach((e) => e.remove());
  const dot = (p: [number, number], color: string, r: number) => {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(p[0]));
    c.setAttribute("cy", String(p[1]));
    c.setAttribute("r", String(r));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", color);
    c.setAttribute("stroke-width", "3");
    c.classList.add("anno");
    ink!.append(c);
  };
  for (const r of rows) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(r.mark.box.x + r.mark.box.w + 8));
    t.setAttribute("y", String(r.mark.box.y + 6));
    t.setAttribute("font-size", "22");
    t.setAttribute("font-family", "Excalifont, cursive");
    t.setAttribute("fill", r.local.arrow ? "#2b8a3e" : "#868e96");
    t.classList.add("anno");
    t.textContent = String(r.mark.n);
    ink!.append(t);
    if (r.local.tip) dot(r.local.tip, "#2b8a3e", 12);
    if (r.local.tail) dot(r.local.tail, "#adb5bd", 8);
  }

  let right = 0;
  let judged = 0;
  $("#rows").innerHTML = rows
    .map((r) => {
      const want = labels.get(r.mark.n);
      const got = r.local.arrow ? "arrow" : "not";
      if (want) {
        judged++;
        if (want === got) right++;
      }
      const ok = !want ? "" : got === want ? ' <span class="ok">✓</span>' : ' <span class="bad">✗</span>';
      const reading = `<b style="color:${r.local.arrow ? "#2b8a3e" : "#868e96"}">${got}</b>${r.local.arrow ? ` ${r.local.confidence}` : ""}${ok}<div class="muted">${r.local.why} · ${r.localUs.toFixed(0)} µs</div>`;
      return `<tr><td>${r.mark.n}</td><td>${reading}</td><td><select data-n="${r.mark.n}"><option value="">?</option><option value="arrow"${want === "arrow" ? " selected" : ""}>arrow</option><option value="not"${want === "not" ? " selected" : ""}>not</option></select></td></tr>`;
    })
    .join("");
  $("#score").textContent = judged ? `${right} / ${judged} labeled marks read right · ${rows.length} marks` : `${rows.length} marks · label them to score the rules`;
}

function update() {
  classify();
  draw();
}

$("#rows").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  const n = Number(sel.dataset.n);
  if (sel.value) labels.set(n, sel.value as "arrow" | "not");
  else labels.delete(n);
  draw();
});

attachInk(ink!, (s) => {
  strokes.push(s);
  update();
}, { color: "#495057" });

$("#clear").addEventListener("click", () => {
  strokes = [];
  labels = new Map();
  ink!.replaceChildren();
  update();
});
$("#save").addEventListener("click", () => download("arrow-set.json", JSON.stringify({ strokes, labels: Object.fromEntries(labels) }, null, 1)));
$<HTMLInputElement>("#load").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const set = JSON.parse(await file.text()) as { strokes: Stroke[]; labels: Record<string, "arrow" | "not"> };
  strokes = set.strokes;
  labels = new Map(Object.entries(set.labels).map(([n, l]) => [Number(n), l]));
  ink!.replaceChildren();
  for (const s of strokes) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", strokePath(s.points));
    p.setAttribute("fill", "#495057");
    ink!.append(p);
  }
  update();
});
update();
