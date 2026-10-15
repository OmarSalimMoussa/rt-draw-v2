// Arrow or not: the local geometry check vs TypeSafe's Jev, on the same marks.
import { type ArrowReading, readArrow } from "../../src/core/arrow.ts";
import { type Stroke, attachInk, strokePath } from "../../src/core/ink.ts";
import { type JevAnswer, askJev } from "../../src/core/jev.ts";
import { type Mark, TUNING, groupStrokes } from "../../src/core/marks.ts";
import { render } from "../../src/core/render.ts";
import { Scene } from "../../src/core/scene.ts";
import { $, download, shell, stage } from "../../src/ui.ts";

shell("arrow", "Draw a mark, then pause. The local check answers at once and marks the tip (green) and tail (grey); Jev answers from the same ink sent as text, its tip in orange. Label each mark, then compare the scores.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
render(canvas, new Scene());

$("#side").innerHTML = `
  <div class="card">
    <h2>Setup</h2>
    <label><input type="checkbox" id="useJev" checked> ask Jev too (about 500 input tokens a mark, roughly $0.00002)</label>
    <label><input type="checkbox" id="measure"> give Jev the local measurements as well as the points</label>
    <div class="row"><button id="clear">Clear</button><button id="save">Save set</button><button id="rerun">Ask Jev again on all</button><label class="row"><span>Load set</span><input type="file" id="load" accept=".json"></label></div>
    <div class="stat" id="score"></div>
  </div>
  <div class="card"><h2>Marks</h2><table class="marks"><thead><tr><th>#</th><th>local</th><th>Jev</th><th>you say</th></tr></thead><tbody id="rows"></tbody></table></div>`;

type Row = { mark: Mark; local: ArrowReading; localUs: number; jev?: JevAnswer | "asking" };
let strokes: Stroke[] = [];
let rows: Row[] = [];
let labels = new Map<number, "arrow" | "not">();
/** Jev answers by mark number and the stroke ids it saw, so a regrouped mark is asked again. */
const jevCache = new Map<string, JevAnswer | "asking">();
const keyOf = (m: Mark) => m.strokes.map((s) => s.id).join(",");

function classify() {
  const marks = groupStrokes(strokes, TUNING);
  rows = marks.map((mark) => {
    const t0 = performance.now();
    const local = readArrow(mark.strokes.map((s) => s.points));
    return { mark, local, localUs: (performance.now() - t0) * 1000, jev: jevCache.get(keyOf(mark)) };
  });
}

function tipOfJev(r: Row): [number, number] | undefined {
  const j = r.jev;
  if (!j || j === "asking" || !j.tip) return;
  const m = /^s(\d+)-(start|end)$/.exec(j.tip);
  const s = m && r.mark.strokes[Number(m[1]) - 1];
  if (!s) return;
  const p = m[2] === "start" ? s.points[0] : s.points.at(-1)!;
  return [p[0], p[1]];
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
    const jt = tipOfJev(r);
    if (jt && r.jev && r.jev !== "asking" && (r.jev.arrow ?? 0) >= 0.5) dot(jt, "#e8590c", 17);
  }

  let localRight = 0;
  let jevRight = 0;
  let jevJudged = 0;
  let judged = 0;
  const jevMs: number[] = [];
  $("#rows").innerHTML = rows
    .map((r) => {
      const want = labels.get(r.mark.n);
      const lv = r.local.arrow ? "arrow" : "not";
      const j = r.jev;
      const jv = j && j !== "asking" && j.arrow !== undefined ? (j.arrow >= 0.5 ? "arrow" : "not") : undefined;
      if (want) {
        judged++;
        if (want === lv) localRight++;
        if (jv) {
          jevJudged++;
          if (want === jv) jevRight++;
        }
      }
      if (j && j !== "asking" && !j.error) jevMs.push(j.ms);
      const ok = (got?: string) => (!want || !got ? "" : got === want ? ' <span class="ok">✓</span>' : ' <span class="bad">✗</span>');
      const local = `<b style="color:${r.local.arrow ? "#2b8a3e" : "#868e96"}">${lv}</b>${r.local.arrow ? ` ${r.local.confidence}` : ""}${ok(lv)}<div class="muted">${r.local.why} · ${r.localUs.toFixed(0)} µs</div>`;
      const jev = !j
        ? '<span class="muted">-</span>'
        : j === "asking"
          ? '<span class="muted">asking…</span>'
          : j.error
            ? `<span class="bad">${j.error}</span>`
            : `<b style="color:${jv === "arrow" ? "#e8590c" : "#868e96"}">${jv}</b> ${j.arrow?.toFixed(2)}${ok(jv)}<div class="muted">kind: ${j.kind} · tip ${j.tip} · ${j.ms} ms</div>`;
      return `<tr><td>${r.mark.n}</td><td>${local}</td><td>${jev}</td><td><select data-n="${r.mark.n}"><option value="">?</option><option value="arrow"${want === "arrow" ? " selected" : ""}>arrow</option><option value="not"${want === "not" ? " selected" : ""}>not</option></select></td></tr>`;
    })
    .join("");
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  $("#score").textContent = judged
    ? `local ${localRight}/${judged} right · Jev ${jevRight}/${jevJudged} right · Jev median ${med(jevMs)} ms`
    : `${rows.length} marks · label them to score both`;
}

async function ask(r: Row) {
  const key = keyOf(r.mark);
  if (jevCache.has(key)) return;
  jevCache.set(key, "asking");
  r.jev = "asking";
  draw();
  const measurements = $<HTMLInputElement>("#measure").checked ? `local check says ${r.local.arrow ? `arrow (confidence ${r.local.confidence})` : "not an arrow"}: ${r.local.why}` : undefined;
  const answer = await askJev(r.mark.strokes.map((s) => s.points), measurements);
  jevCache.set(key, answer);
  classify();
  draw();
}

let pause = 0;
function update() {
  classify();
  draw();
  // Ask Jev once a mark is finished: no new stroke for longer than the grouping gap.
  clearTimeout(pause);
  pause = window.setTimeout(() => {
    if ($<HTMLInputElement>("#useJev").checked) for (const r of rows) void ask(r);
  }, TUNING.gapMs + 100);
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
$("#rerun").addEventListener("click", () => {
  jevCache.clear();
  for (const r of rows) void ask(r);
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
