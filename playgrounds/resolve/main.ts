// Reference resolver playground: hand-written cases (words + ink → the ids meant),
// scored per tuning, plus free play. The model is only called when you press a
// run button, and only for what the ink can't settle on its own.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import cases from "../../src/fixtures/resolve-cases.json";
import { HitIndex } from "../../src/core/hittest.ts";
import { type Stroke, attachInk, strokePath } from "../../src/core/ink.ts";
import { type Example, makeSet } from "../../src/core/labels.ts";
import type { Word } from "../../src/core/link.ts";
import { groupStrokes } from "../../src/core/marks.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { type Case, type Resolution, caseInput, plan, resolve, sameIds } from "../../src/core/resolve.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { $, download, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("resolve", "Words plus ink → the shapes they mean. Clear pointing (a loop, a tap or an arrow with \"this\") is settled by the ink alone, for free; everything else asks a small model. Run the 40 cases to score a tuning, pick one to see its ink, or draw and type your own.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const { scene } = runScript(clowns);
const CASES = cases as Case[];
const INK = "#e03131";

const detail = document.createElement("div");
detail.className = "card";
detail.style.marginTop = "16px";
detail.innerHTML = `<h2>Result</h2><div id="detail" class="muted">Pick a case, or draw and type a phrase, then press Resolve.</div>`;
$("#left").append(detail);

$("#side").innerHTML = `
  <div class="card">
    <h2>Cases</h2>
    <div class="row"><button class="primary" id="runAll"></button><button id="runOne" disabled>Resolve this case</button><button id="save">Save set</button></div>
    <div class="stat" id="score">Not run yet.</div>
    <div style="max-height:420px;overflow:auto"><table class="marks"><thead><tr><th>#</th><th>said</th><th>expected</th><th>got</th></tr></thead><tbody id="rows"></tbody></table></div>
  </div>
  <div class="card">
    <h2>Free play</h2>
    <div class="muted">Draw on the page, then type what you'd say ("make this bigger") and press Resolve.</div>
    <input id="phrase" placeholder="make this bigger" style="font:16px Excalifont, cursive;padding:6px 8px;border:1.5px solid var(--ink);border-radius:8px">
    <input id="answer" placeholder="right answer, if it's wrong: toy-l1, toy-l2" style="font:13px var(--mono);padding:5px 8px;border:1.5px solid var(--line);border-radius:8px">
    <div class="row"><button class="primary" id="resolveFree">Resolve</button><button id="clearInk">Clear ink</button></div>
  </div>`;

let tuning: Tuning = DEFAULTS;
let index: HitIndex;
let selected: number | undefined;
/** Results by case number, under the tuning they ran with. */
const results = new Map<number, { r?: Resolution; error?: string; tuning: string }>();
/** Run-all scores per tuning: exact matches out of cases. */
const scores = new Map<string, { right: number; total: number; calls: number }>();
let free: { r: Resolution; words: Word[]; strokes: Stroke[] } | undefined;
let freeStrokes: Stroke[] = [];
let running = false;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const stat = (r: Resolution) => (r.stats ? `${r.stats.model} · first text ${r.stats.firstMs ?? "-"} ms · ${r.stats.ms} ms · ${r.stats.inTokens ?? "?"} → ${r.stats.outTokens ?? "?"} tokens` : "no model call");

function drawInk(strokes: Stroke[]) {
  ink!.replaceChildren(...strokes.map((s) => {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", strokePath(s.points, tuning["ink.size"], tuning));
    p.setAttribute("fill", INK);
    return p;
  }));
}

function show(ids: string[] = [], expect: string[] = []) {
  const highlight = new Map<string, string>();
  for (const id of expect) highlight.set(id, "#2b8a3e");
  for (const id of ids) highlight.set(id, expect.length && !expect.includes(id) ? "#c92a2a" : "#1971c2");
  render(canvas, scene, { highlight, tags: true });
}

/** How many cases would need the model under the current knobs (planning is free). */
function callsNeeded() {
  return CASES.filter((c) => {
    const { words, strokes } = caseInput(c);
    return !plan(words, groupStrokes(strokes, tuning), scene, index, tuning).inkIds;
  }).length;
}

function renderRows() {
  const need = index ? callsNeeded() : CASES.length;
  $("#runAll").textContent = `Run all (≈${need} model calls, ${CASES.length - need} settled by ink)`;
  $("#runAll").toggleAttribute("disabled", running);
  $("#rows").innerHTML = CASES.map((c, i) => {
    const res = results.get(i);
    const got = res?.r ? `${res.r.ids.join(", ") || "-"} ${sameIds(res.r.ids, c.expect) ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} <span class="muted">${res.r.via}</span>` : res?.error ? `<span class="bad">${esc(res.error)}</span>` : '<span class="muted">-</span>';
    return `<tr data-i="${i}" style="cursor:pointer${i === selected ? ";background:#fff4e6" : ""}"><td>${i + 1}</td><td>${esc(c.words)}${c.ink.length ? ` <span class="muted">(${c.ink.length} ink)</span>` : ""}</td><td>${c.expect.join(", ")}</td><td>${got}</td></tr>`;
  }).join("");
  $("#score").innerHTML = scores.size ? [...scores].map(([id, s]) => `${id === tuningId(tuning) ? "<b>" : ""}${id}: ${s.right} / ${s.total} exact (${Math.round((s.right / s.total) * 100)}%), ${s.calls} model calls${id === tuningId(tuning) ? "</b>" : ""}`).join("<br>") : "Not run yet.";
}

function showDetail(r: Resolution | undefined, error?: string, expect?: string[]) {
  if (error) return void ($("#detail").innerHTML = `<span class="bad">${esc(error)}</span>`);
  if (!r) return void ($("#detail").innerHTML = '<span class="muted">Not resolved yet: press Resolve.</span>');
  const verdict = expect ? (sameIds(r.ids, expect) ? '<span class="ok">✓ matches</span>' : `<span class="bad">✗ expected ${expect.join(", ")}</span>`) : "";
  $("#detail").innerHTML = `
    <div><b style="font-size:16px">${r.ids.join(", ") || "nothing"}</b> ${verdict} · via ${r.via} · <span class="stat">${stat(r)}</span></div>
    <div class="muted">${esc(r.why)}</div>
    <div>Said: <span style="font:17px Excalifont, cursive">${esc(r.transcript)}</span></div>
    ${r.refs.length && r.via === "model" ? `<div>Refs: ${r.refs.map((x) => `"${esc(x.phrase)}" → ${x.ids.join(", ") || "nothing"}`).join(" · ")}</div>` : ""}
    <div class="muted">Candidates: ${r.candidates.join(", ")}</div>
    <div class="stat muted">${esc(Object.entries(r.features).map(([k, v]) => `${k}=${v}`).join(" "))}</div>
    ${r.prompt ? `<details><summary class="muted">Prompt (${r.prompt.images} image${r.prompt.images === 1 ? "" : "s"}) and reply</summary><pre class="log">${esc(r.prompt.system)}\n\n---\n${esc(r.prompt.user)}\n\n--- reply\n${esc(r.reply ?? "")}</pre></details>` : ""}`;
}

function select(i: number) {
  selected = i;
  const c = CASES[i];
  drawInk(caseInput(c).strokes);
  const res = results.get(i);
  show(res?.r?.ids, c.expect);
  if (res) showDetail(res.r, res.error, c.expect);
  else {
    // What the free planning step says, before any model call.
    const { words, strokes } = caseInput(c);
    const p = plan(words, groupStrokes(strokes, tuning), scene, index, tuning);
    $("#detail").innerHTML = `<div class="muted">${p.inkIds ? `The ink settles it (no model call): <b>${p.inkIds.join(", ")}</b>` : "Needs a model call."} ${esc(p.why)}</div><div>Said: <span style="font:17px Excalifont, cursive">${esc(p.transcript)}</span></div><div class="muted">Candidates: ${p.candidates.join(", ")}</div>`;
  }
  $<HTMLButtonElement>("#runOne").disabled = false;
  renderRows();
}

async function runCase(i: number) {
  const c = CASES[i];
  const { words, strokes } = caseInput(c);
  try {
    const r = await resolve(words, strokes, groupStrokes(strokes, tuning), scene, index, tuning, "resolve");
    results.set(i, { r, tuning: tuningId(tuning) });
  } catch (err) {
    results.set(i, { error: err instanceof Error ? err.message : String(err), tuning: tuningId(tuning) });
  }
}

$("#rows").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest("tr");
  if (row?.dataset.i) select(Number(row.dataset.i));
});

$("#runOne").addEventListener("click", async () => {
  if (selected === undefined) return;
  $("#detail").textContent = "Resolving…";
  await runCase(selected);
  select(selected);
});

$("#runAll").addEventListener("click", async () => {
  running = true;
  renderRows();
  const id = tuningId(tuning);
  // Three at a time; the ink-settled cases come back at once.
  const queue = CASES.map((_, i) => i);
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      await runCase(i);
      renderRows();
    }
  }));
  const done = CASES.map((c, i) => ({ c, r: results.get(i)?.r }));
  scores.set(id, { right: done.filter((d) => d.r && sameIds(d.r.ids, d.c.expect)).length, total: CASES.length, calls: done.filter((d) => d.r?.via === "model").length });
  running = false;
  renderRows();
  if (selected !== undefined) select(selected);
});

// Free play: your strokes keep their shape; each mark is moved in time to the pointing word it goes with,
// as if you'd drawn it while saying it.
function onStroke(s: Stroke) {
  // Drawing after picking a case starts free play: the case's ink goes, yours stays.
  if (selected !== undefined) {
    selected = undefined;
    freeStrokes = [];
    for (const p of [...ink!.children]) if (p !== ink!.lastElementChild) p.remove();
    renderRows();
  }
  freeStrokes.push(s);
}
let epoch = performance.now();
let detach = attachInk(ink!, onStroke, { epoch, color: INK });

function freeInput(text: string): { words: Word[]; strokes: Stroke[] } {
  const { words } = caseInput({ words: text, ink: [], expect: [] });
  const marks = groupStrokes(freeStrokes, tuning);
  const pointing = words.map((w, i) => (/^(this|that|here|there|these|those|it)$/i.test(w.word.replace(/[^a-z]/gi, "")) ? i : -1)).filter((i) => i >= 0);
  let prevEnd = -Infinity;
  const strokes = marks.flatMap((m, k) => {
    const wi = pointing[k] ?? pointing.at(-1) ?? Math.min(k, words.length - 1);
    const start = Math.max(words[wi]?.t0 ?? 0, prevEnd + 900);
    const shift = start - m.t0;
    prevEnd = m.t1 + shift;
    return m.strokes.map((s) => ({ ...s, t0: s.t0 + shift, t1: s.t1 + shift, points: s.points.map(([x, y, t]) => [x, y, t + shift] as [number, number, number]) }));
  });
  return { words, strokes };
}

$("#resolveFree").addEventListener("click", async () => {
  const text = $<HTMLInputElement>("#phrase").value.trim();
  if (!text) return void ($("#detail").textContent = "Type what you'd say first.");
  selected = undefined;
  renderRows();
  $("#detail").textContent = "Resolving…";
  const { words, strokes } = freeInput(text);
  try {
    const r = await resolve(words, strokes, groupStrokes(strokes, tuning), scene, index, tuning, "resolve-free");
    free = { r, words, strokes };
    show(r.ids);
    showDetail(r);
  } catch (err) {
    showDetail(undefined, err instanceof Error ? err.message : String(err));
  }
});

$("#clearInk").addEventListener("click", () => {
  freeStrokes = [];
  ink!.replaceChildren();
  detach();
  epoch = performance.now();
  detach = attachInk(ink!, onStroke, { epoch, color: INK });
  show();
});

$("#save").addEventListener("click", () => {
  const examples: Example[] = [];
  CASES.forEach((c, i) => {
    const r = results.get(i)?.r;
    if (!r) return;
    examples.push({ decision: "resolve.ids", strokes: caseInput(c).strokes, predicted: r.ids.join(","), features: { ...r.features, via: r.via, words: c.words, case: i + 1 }, label: c.expect.join(","), corrected: true });
  });
  if (free) {
    const answer = $<HTMLInputElement>("#answer").value.split(",").map((s) => s.trim()).filter(Boolean);
    examples.push({ decision: "resolve.ids", strokes: free.strokes, predicted: free.r.ids.join(","), features: { ...free.r.features, via: free.r.via, words: free.words.map((w) => w.word).join(" ") }, label: (answer.length ? answer : free.r.ids).join(","), corrected: answer.length > 0 });
  }
  download(`resolve-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(makeSet("playground", "clowns", tuning, tuningId(tuning), examples), null, 1));
});

tuningPanel($("#side"), ["resolve", "marks", "link"], (t) => {
  tuning = t;
  // Planning only (free): the call count and the selected case's plan follow the knobs.
  if (index) {
    renderRows();
    if (selected !== undefined && !results.has(selected)) select(selected);
  }
});

fontsReady().then(() => {
  index = new HitIndex(scene);
  show();
  renderRows();
});
