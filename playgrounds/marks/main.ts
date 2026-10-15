// Marks playground: strokes grouped into marks and read as pointing or sketch.
// Correct the readings, save the set, and rerun it after changing the rules.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import { HitIndex } from "../../src/core/hittest.ts";
import { type Stroke, attachInk, strokePath } from "../../src/core/ink.ts";
import { type Mark, type Reading, TUNING, type Tuning, groupStrokes, readMark } from "../../src/core/marks.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { $, download, fontsReady, shell, stage } from "../../src/ui.ts";

shell("marks", "Draw loops, arrows, taps, underlines and little sketches over the page. Each mark gets a number and a reading. Fix any wrong reading in the table, save the set, then tune the rules and watch the score.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const { scene } = runScript(clowns);
/** Your ink: the same bright red as the Ink page. */
const INK = "#e03131";
const LABELS = ["pointing:loop", "pointing:arrow", "pointing:tap", "pointing:line", "pointing:scribble", "sketch"];
const COLORS: Record<string, string> = { pointing: "#1971c2", sketch: "#c2255c" };

const knobs: [keyof Tuning, string, number, number, number][] = [
  ["gapMs", "same mark if within (ms)", 100, 2000, 50],
  ["nearPx", "and within (px)", 0, 200, 5],
  ["closeRatio", "closed if end gap < length ×", 0.05, 0.5, 0.01],
  ["straightRatio", "straight if span / length ≥", 0.6, 0.99, 0.01],
];

$("#side").innerHTML = `
  <div class="card">
    <h2>Rules</h2>
    ${knobs.map(([k, label, min, max, step]) => `<label>${label} <input type="range" id="k-${k}" min="${min}" max="${max}" step="${step}" value="${TUNING[k]}"> <span class="stat" id="v-${k}">${TUNING[k]}</span></label>`).join("")}
    <div class="row"><button id="clear">Clear</button><button id="save">Save set</button><label class="row"><span>Load set</span><input type="file" id="load" accept=".json"></label></div>
    <div class="stat" id="score"></div>
  </div>
  <div class="card"><h2>Marks</h2><table class="marks"><thead><tr><th>#</th><th>reading</th><th>you say</th></tr></thead><tbody id="rows"></tbody></table></div>`;

let strokes: Stroke[] = [];
/** Your corrections, by mark number. Survive regrouping only while the grouping stays the same. */
let labels = new Map<number, string>();
/** Your arrow / not-arrow corrections, by mark number. */
let arrowLabels = new Map<number, "arrow" | "not">();
const arrowOf = (r: Reading) => (r.arrow.arrow ? "arrow" : "not");
let index: HitIndex;
const tuning: Tuning = { ...TUNING };

const labelOf = (r: Reading) => (r.kind === "sketch" ? "sketch" : `pointing:${r.how}`);

/** A mark's own crop, the way a sketch would be sent to the model. */
function crop(m: Mark) {
  const pad = 8;
  const { x, y, w, h } = m.box;
  const paths = m.strokes.map((s) => `<path d="${strokePath(s.points, 4)}" fill="#c2255c"/>`).join("");
  return `<svg viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}" width="72" height="54" style="border:1px solid #dcd8cf;border-radius:6px;background:#fff">${paths}</svg>`;
}

function update() {
  const marks = groupStrokes(strokes, tuning);
  const readings = marks.map((m) => readMark(m, index, tuning));
  const highlight = new Map<string, string>();
  readings.forEach((r) => r.targets.forEach((id) => highlight.set(id, COLORS[r.kind])));
  render(canvas, scene, { highlight, tags: true });

  // Number each mark on the ink layer, colored by its reading; ring an arrow's tip (green) and tail (grey).
  ink!.querySelectorAll(".anno").forEach((t) => t.remove());
  const ring = (p: [number, number], color: string, r: number) => {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [k, v] of Object.entries({ cx: p[0], cy: p[1], r, fill: "none", stroke: color, "stroke-width": 3 })) c.setAttribute(k, String(v));
    c.classList.add("anno");
    ink!.append(c);
  };
  readings.forEach((r) => {
    if (r.arrow.tip) ring(r.arrow.tip, "#2b8a3e", 12);
    if (r.arrow.tail) ring(r.arrow.tail, "#adb5bd", 8);
  });
  marks.forEach((m, i) => {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(m.box.x + m.box.w + 6));
    t.setAttribute("y", String(m.box.y + 4));
    t.setAttribute("font-size", "22");
    t.setAttribute("font-family", "Excalifont, cursive");
    t.setAttribute("fill", COLORS[readings[i].kind]);
    t.classList.add("anno");
    t.textContent = String(m.n);
    ink!.append(t);
  });

  let right = 0;
  let judged = 0;
  let arrowRight = 0;
  let arrowJudged = 0;
  $("#rows").innerHTML = marks
    .map((m, i) => {
      const r = readings[i];
      const got = labelOf(r);
      const want = labels.get(m.n);
      if (want) {
        judged++;
        if (want === got) right++;
      }
      const tick = (w: string | undefined, g: string) => (w ? (w === g ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') : "");
      const mark = tick(want, got);
      const isArrow = arrowOf(r);
      const wantArrow = arrowLabels.get(m.n);
      if (wantArrow) {
        arrowJudged++;
        if (wantArrow === isArrow) arrowRight++;
      }
      const arrowLine = `<div>arrow? <b style="color:${r.arrow.arrow ? "#2b8a3e" : "#868e96"}">${r.arrow.arrow ? `yes ${r.arrow.confidence}` : "no"}</b> ${tick(wantArrow, isArrow)} <span class="muted">${r.arrow.why}</span></div>`;
      const extra = r.kind === "sketch" ? `<div>${crop(m)}</div>` : `<div class="muted">${r.targets.map((id) => `→ <b>${id}</b>: ${index.scene.get(id)?.description ?? ""}`).join("<br>") || "→ -"}</div>`;
      return `<tr><td>${m.n}</td><td><b style="color:${COLORS[r.kind]}">${got}</b> ${mark}<div class="muted">${r.why}</div>${arrowLine}${extra}</td><td><select data-n="${m.n}" data-field="kind"><option value="">(looks right)</option>${LABELS.map((l) => `<option${l === want ? " selected" : ""}>${l}</option>`).join("")}</select><select data-n="${m.n}" data-field="arrow"><option value="">arrow? (looks right)</option><option value="arrow"${wantArrow === "arrow" ? " selected" : ""}>is an arrow</option><option value="not"${wantArrow === "not" ? " selected" : ""}>not an arrow</option></select></td></tr>`;
    })
    .join("");
  const scores = [judged && `readings ${right} / ${judged} right`, arrowJudged && `arrow? ${arrowRight} / ${arrowJudged} right`].filter(Boolean);
  $("#score").textContent = `${scores.length ? `${scores.join(" · ")} · ` : ""}${marks.length} marks from ${strokes.length} strokes${scores.length ? "" : " · label some to score the rules"}`;
}

$("#rows").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  const n = Number(sel.dataset.n);
  if (sel.dataset.field === "arrow") {
    if (sel.value) arrowLabels.set(n, sel.value as "arrow" | "not");
    else arrowLabels.delete(n);
  } else if (sel.value) labels.set(n, sel.value);
  else labels.delete(n);
  update();
});

for (const [k] of knobs) {
  $(`#k-${k}`).addEventListener("input", (e) => {
    tuning[k] = Number((e.target as HTMLInputElement).value);
    $(`#v-${k}`).textContent = String(tuning[k]);
    update();
  });
}

const epoch = performance.now();
attachInk(ink!, (s) => {
  strokes.push(s);
  update();
}, { epoch, color: INK });

$("#clear").addEventListener("click", () => {
  strokes = [];
  labels = new Map();
  arrowLabels = new Map();
  ink!.replaceChildren();
  update();
});

$("#save").addEventListener("click", () => {
  // Labels are saved for every mark: your correction, or the reading you accepted.
  const marks = groupStrokes(strokes, tuning);
  const readings = marks.map((m) => readMark(m, index, tuning));
  const all = Object.fromEntries(marks.map((m, i) => [m.n, labels.get(m.n) ?? labelOf(readings[i])]));
  const arrows = Object.fromEntries(marks.map((m, i) => [m.n, arrowLabels.get(m.n) ?? arrowOf(readings[i])]));
  download("marks-set.json", JSON.stringify({ scene: "clowns", tuning, strokes, labels: all, arrows }, null, 1));
});

$<HTMLInputElement>("#load").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const set = JSON.parse(await file.text()) as { strokes: Stroke[]; labels: Record<string, string>; arrows?: Record<string, "arrow" | "not"> };
  strokes = set.strokes;
  labels = new Map(Object.entries(set.labels).map(([n, l]) => [Number(n), l]));
  arrowLabels = new Map(Object.entries(set.arrows ?? {}).map(([n, l]) => [Number(n), l]));
  ink!.replaceChildren();
  for (const s of strokes) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", strokePath(s.points));
    p.setAttribute("fill", INK);
    ink!.append(p);
  }
  update();
});

fontsReady().then(() => {
  index = new HitIndex(scene);
  update();
});
