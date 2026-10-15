// Router playground: 50 labeled sends routed by the rules, scored live as you
// move the knobs (free, no model). "Check with model" asks the fast model to
// route the selected sends too, one call each, only when pressed.
import sends from "../../src/fixtures/router-sends.json";
import { makeSet } from "../../src/core/labels.ts";
import { type ModelStats, callModel, modelOf } from "../../src/core/model.ts";
import { CHECK_SYSTEM, type Lane, type Send, checkPrompt, parseLane, route } from "../../src/core/router.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { $, download, shell, tuningPanel } from "../../src/ui.ts";

shell("router", "Each send takes the fast lane (a small model, no picture: small edits to shapes that exist) or the full lane (the drawing model with the screenshot). The rules decide in well under a millisecond. Move the knobs and the 50 labeled sends rescore for free; fix any label you disagree with, or check selected sends with the fast model.");

type Labeled = { words: string; marks: string[]; sceneShapes: number; lane: Lane; why: string };
const SENDS = sends as Labeled[];
const MARKS = ["loop", "arrow", "tap", "line", "scribble", "sketch"];
const toSend = (s: { words: string; marks: string[]; sceneShapes: number }): Send => ({
  words: s.words,
  marks: s.marks.map((m) => (m === "sketch" ? { kind: "sketch", how: "sketch" } : { kind: "pointing", how: m as Send["marks"][number]["how"] })),
  sceneShapes: s.sceneShapes,
});

$("#left").innerHTML = `
  <div class="card"><h2>Sends</h2>
    <table class="marks"><thead><tr><th><input type="checkbox" id="all" title="select all"></th><th>send</th><th>rules say</th><th>label</th><th>model says</th></tr></thead><tbody id="rows"></tbody></table>
  </div>`;
$("#side").innerHTML = `
  <div class="card"><h2>Score</h2><div class="stat" id="score"></div><table class="marks" id="matrix"></table>
    <div class="row"><button id="save">Save set</button></div></div>
  <div class="card"><h2>Try it</h2>
    <input id="tryWords" value="make this bigger" style="font:16px Excalifont, cursive;padding:6px 8px;border:1.5px solid var(--ink);border-radius:8px">
    <div class="row">${MARKS.map((m) => `<button data-add="${m}">+ ${m}</button>`).join("")}</div>
    <div class="row"><span class="stat" id="tryMarks"></span><button id="tryClear">no marks</button><label>shapes <input id="tryShapes" type="number" value="18" min="0" style="width:60px"></label></div>
    <div id="tryOut" style="font:18px Excalifont, cursive"></div></div>
  <div class="card"><h2>Check with model</h2>
    <div class="muted">Asks the fast lane's model to route the selected sends, one call each, to compare against the rules.</div>
    <div class="row"><button class="primary" id="check" disabled>Check 0 selected (0 calls)</button></div>
    <div class="stat" id="checkStat"></div><pre class="log bad" id="errors"></pre></div>`;

let tuning: Tuning = DEFAULTS;
/** Your relabels, by send index; unset means the fixture's label stands. */
const relabel = new Map<number, Lane>();
const selected = new Set<number>();
const modelSaid = new Map<number, { lane?: Lane; stats: ModelStats; reply: string }>();
let tryMarks: string[] = ["loop"];

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const labelOf = (i: number) => relabel.get(i) ?? SENDS[i].lane;
const pill = (lane: string) => `<b style="color:${lane === "fast" ? "#2b8a3e" : "#1971c2"}">${lane}</b>`;

function update() {
  const routes = SENDS.map((s) => route(toSend(s), tuning));
  const m = { fast: { fast: 0, full: 0 }, full: { fast: 0, full: 0 } };
  let right = 0;
  routes.forEach((r, i) => {
    m[labelOf(i)][r.lane]++;
    if (r.lane === labelOf(i)) right++;
  });
  const fast = routes.filter((r) => r.lane === "fast").length;
  const modelRight = [...modelSaid].filter(([i, x]) => x.lane === labelOf(i)).length;
  $("#score").textContent = `rules ${right} / ${SENDS.length} right (${Math.round((right / SENDS.length) * 100)}%) · ${fast} of ${SENDS.length} go fast (${Math.round((fast / SENDS.length) * 100)}%) · ${tuningId(tuning)}${modelSaid.size ? ` · model ${modelRight} / ${modelSaid.size}` : ""}`;
  $("#matrix").innerHTML = `<tr><th>label ↓ / rules →</th><th>fast</th><th>full</th></tr>${(["fast", "full"] as const).map((l) => `<tr><th>${l}</th><td>${m[l].fast}</td><td>${m[l].full}</td></tr>`).join("")}`;
  $("#rows").innerHTML = SENDS.map((s, i) => {
    const r = routes[i];
    const want = labelOf(i);
    const ok = r.lane === want ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
    const said = modelSaid.get(i);
    const modelCell = said
      ? `${said.lane ? pill(said.lane) : `<span class="bad">?</span>`} ${said.lane === want ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}<div class="muted stat">${said.stats.model} · first ${said.stats.firstMs ?? "-"} ms · ${said.stats.ms} ms · ${said.stats.inTokens ?? "?"}→${said.stats.outTokens ?? "?"} tok</div>`
      : '<span class="muted">-</span>';
    const marks = s.marks.length ? s.marks.join(", ") : "no marks";
    return `<tr><td><input type="checkbox" data-sel="${i}"${selected.has(i) ? " checked" : ""}></td><td>"${esc(s.words)}"<div class="muted">${marks} · ${s.sceneShapes} shapes</div></td><td>${pill(r.lane)} ${ok}<div class="muted">${esc(r.why)}</div></td><td><select data-label="${i}">${(["fast", "full"] as const).map((l) => `<option${l === want ? " selected" : ""}>${l}</option>`).join("")}</select>${relabel.has(i) ? ' <span class="muted">(yours)</span>' : ""}<div class="muted">${esc(s.why)}</div></td><td>${modelCell}</td></tr>`;
  }).join("");
  const n = selected.size;
  const btn = $<HTMLButtonElement>("#check");
  if (!checking) {
    btn.textContent = `Check ${n} selected with ${modelOf(tuning["router.fastModel"])} (${n} call${n === 1 ? "" : "s"})`;
    btn.disabled = !n;
  }
  tryIt();
}

function tryIt() {
  const r = route(toSend({ words: $<HTMLInputElement>("#tryWords").value, marks: tryMarks, sceneShapes: Number($<HTMLInputElement>("#tryShapes").value) || 0 }), tuning);
  $("#tryMarks").textContent = tryMarks.length ? `marks: ${tryMarks.join(", ")}` : "no marks";
  $("#tryOut").innerHTML = `${pill(r.lane)} → ${r.model} · <span class="muted">${esc(r.why)}</span>`;
}

$("#rows").addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (el.dataset.sel !== undefined) {
    const i = Number(el.dataset.sel);
    if ((el as HTMLInputElement).checked) selected.add(i);
    else selected.delete(i);
  }
  if (el.dataset.label !== undefined) {
    const i = Number(el.dataset.label);
    if (el.value === SENDS[i].lane) relabel.delete(i);
    else relabel.set(i, el.value as Lane);
  }
  update();
});
$<HTMLInputElement>("#all").addEventListener("change", (e) => {
  if ((e.target as HTMLInputElement).checked) SENDS.forEach((_, i) => selected.add(i));
  else selected.clear();
  update();
});
$("#side").addEventListener("click", (e) => {
  const add = (e.target as HTMLElement).dataset.add;
  if (add) {
    tryMarks.push(add);
    tryIt();
  }
});
$("#tryClear").addEventListener("click", () => {
  tryMarks = [];
  tryIt();
});
for (const id of ["#tryWords", "#tryShapes"]) $(id).addEventListener("input", tryIt);

// Model check: only on press, one call per selected send, one at a time.
let checking = false;
$("#check").addEventListener("click", async () => {
  if (checking || !selected.size) return;
  checking = true;
  $("#errors").textContent = "";
  const todo = [...selected].sort((a, b) => a - b);
  const btn = $<HTMLButtonElement>("#check");
  btn.disabled = true;
  const model = modelOf(tuning["router.fastModel"]);
  for (const [k, i] of todo.entries()) {
    btn.textContent = `Checking ${k + 1} / ${todo.length}…`;
    try {
      const { text, stats } = await callModel({ model, system: CHECK_SYSTEM, user: checkPrompt(toSend(SENDS[i])), from: "router" });
      modelSaid.set(i, { lane: parseLane(text), stats, reply: text });
    } catch (err) {
      $("#errors").textContent += `send ${i + 1}: ${err instanceof Error ? err.message : String(err)}\n`;
    }
    update();
  }
  const stats = todo.map((i) => modelSaid.get(i)?.stats).filter((s): s is ModelStats => !!s);
  const avg = (f: (s: ModelStats) => number) => Math.round(stats.reduce((a, s) => a + f(s), 0) / (stats.length || 1));
  $("#checkStat").textContent = `${stats.length} call(s) to ${model} · avg first text ${avg((s) => s.firstMs ?? 0)} ms · avg total ${avg((s) => s.ms)} ms · ${stats.reduce((a, s) => a + (s.inTokens ?? 0), 0)} tokens in, ${stats.reduce((a, s) => a + (s.outTokens ?? 0), 0)} out`;
  checking = false;
  update();
});

$("#save").addEventListener("click", () => {
  const examples = SENDS.map((s, i) => {
    const r = route(toSend(s), tuning);
    // Raw input for replay: the words, the mark kinds and the shape count, as features (strokes aren't needed).
    return { decision: "router.lane", strokes: [], predicted: r.lane, features: { ...r.features, text: s.words, markKinds: s.marks.join(","), ...(modelSaid.get(i)?.lane ? { modelLane: modelSaid.get(i)!.lane! } : {}) }, label: labelOf(i), corrected: relabel.has(i) };
  });
  download(`router-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(makeSet("playground", undefined, tuning, tuningId(tuning), examples), null, 1));
});

tuningPanel($("#side"), ["router"], (t) => {
  tuning = t;
  update();
});
update();
