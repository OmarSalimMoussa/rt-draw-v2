// Shape descriptions playground: each shape's crop goes to a small vision model,
// which writes the id map. Compare with what the ops said, thumb each one up or
// down, and save the set to tune the prompt, the model and the crop knobs.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import grid from "../../src/fixtures/grid.ops.txt?raw";
import messy from "../../src/fixtures/messy.ops.txt?raw";
import { type Crop, type DescribeRun, check, cropShapes, describeAll } from "../../src/core/describe.ts";
import { makeSet } from "../../src/core/labels.ts";
import { type ModelStats, modelOf } from "../../src/core/model.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { $, download, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("describe", "Every shape needs a description good enough for words like \"the photo of me\" to find it. Here a small vision model writes them from each shape's crop; compare with the ones the ops wrote, mark each 👍 or 👎, and save the set. The model is only called when you press Describe.");
const fixtures: Record<string, [string, string]> = { "Clowns.com": ["clowns", clowns], "Settings screen": ["grid", grid], "Messy shop": ["messy", messy] };
const { canvas } = stage($("#left"));
const table = document.createElement("div");
table.className = "card";
table.style.marginTop = "16px";
table.innerHTML = `<h2>Id map</h2><table class="marks"><thead><tr><th>id</th><th>crop</th><th>the ops said</th><th>the model says</th><th>you</th></tr></thead><tbody id="rows"></tbody></table>`;
$("#left").append(table);

$("#side").innerHTML = `
  <div class="card">
    <h2>Describe</h2>
    <div class="row"><select id="fixture">${Object.keys(fixtures).map((k) => `<option>${k}</option>`).join("")}</select></div>
    <div class="row"><button class="primary" id="go">Describe all</button><button id="save" disabled>Save set</button></div>
    <div class="stat" id="stat">Pick a scene, then press Describe all.</div>
    <pre class="log" id="calls"></pre>
    <pre class="log muted" id="stream" style="max-height:140px"></pre>
    <pre class="log bad" id="errors"></pre>
  </div>`;

let tuning: Tuning = DEFAULTS;
let fixture = Object.keys(fixtures)[0];
let scene = runScript(fixtures[fixture][1]).scene;
let crops: Crop[] = [];
let run: DescribeRun | undefined;
/** Your verdicts, by id: "good" or "bad". */
let verdicts = new Map<string, "good" | "bad">();
let busy = false;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const button = () => {
  const n = scene.shapes.size;
  const model = modelOf(tuning["describe.model"]);
  $("#go").textContent = busy ? "Describing…" : `Describe all (${model}, ${tuning["describe.batch"] >= 1 ? "1 call" : `${n} calls`})`;
  $<HTMLButtonElement>("#go").disabled = busy;
};

function rows() {
  // Word limits are rechecked under the current knobs; the model's text stays as it came.
  const byId = new Map((run?.results ?? []).map((r) => [r.id, check(r.id, r.text || undefined, tuning)]));
  $("#rows").innerHTML = crops
    .map((c) => {
      const s = scene.get(c.id)!;
      const r = byId.get(c.id);
      const v = verdicts.get(c.id);
      const model = r ? `${r.text ? esc(r.text) : '<span class="muted">-</span>'}<div class="${r.ok ? "muted" : "bad"} stat">${r.words} words · ${r.why}</div>` : '<span class="muted">not run</span>';
      const thumbs = r ? `<button data-id="${c.id}" data-v="good" class="${v === "good" ? "primary" : ""}">👍</button> <button data-id="${c.id}" data-v="bad" class="${v === "bad" ? "primary" : ""}">👎</button>` : "";
      return `<tr><td><b>${esc(c.id)}</b></td><td><img src="${c.dataUrl}" style="max-width:120px;max-height:90px;border:1px solid var(--line);border-radius:4px"><div class="muted stat">${c.w}×${c.h}</div></td><td>${esc(s.description)}</td><td>${model}</td><td style="white-space:nowrap">${thumbs}</td></tr>`;
    })
    .join("");
}

// Hover an id tag on the canvas to read that shape's descriptions there, instead of in the table.
const tip = document.createElement("div");
tip.style.cssText = "position:fixed;z-index:10;max-width:340px;padding:8px 10px;background:#fff;border:1.5px solid var(--ink);border-radius:8px;box-shadow:2px 3px 0 #0002;font:13px/1.45 system-ui,sans-serif;pointer-events:none;display:none";
document.body.append(tip);

/** Invisible boxes over the id tags (render's tags ignore the mouse), carrying the shape's id. */
function tagTargets() {
  for (const s of scene.stacked()) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    // Same place and size as render's tag.
    for (const [k, v] of Object.entries({ x: s.box.x + 2, y: s.box.y + 2, width: s.id.length * 7 + 10, height: 16, fill: "transparent", "data-tag": s.id, style: "cursor:help" })) r.setAttribute(k, String(v));
    canvas.append(r);
  }
}

function showTip(id: string, x: number, y: number) {
  const s = scene.get(id);
  if (!s) return;
  const r = run?.results.find((x) => x.id === id);
  const said = r ? check(id, r.text || undefined, tuning) : undefined;
  const model = said?.text ? `<div style="font:16px/1.35 Excalifont, cursive">${esc(said.text)}</div><div class="${said.ok ? "muted" : "bad"} stat">${said.words} words${said.ok ? "" : ` · ${esc(said.why)}`}</div>` : `<div class="muted">${run ? "no description came back" : "not described yet: press Describe all"}</div>`;
  tip.innerHTML = `<b>${esc(id)}</b>${model}<div class="muted" style="margin-top:6px;border-top:1px solid var(--line);padding-top:4px">the ops said: ${esc(s.description)}</div>`;
  tip.style.display = "block";
  // Beside the pointer, kept on screen.
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  tip.style.top = `${Math.min(window.innerHeight - h - 8, y + 14)}px`;
}

canvas.addEventListener("mousemove", (e) => {
  const id = (e.target as Element).getAttribute?.("data-tag");
  if (id) showTip(id, e.clientX, e.clientY);
  else tip.style.display = "none";
});
canvas.addEventListener("mouseleave", () => (tip.style.display = "none"));

/** Crops are free (no model): shown as soon as the scene or a crop knob changes. */
async function recrop() {
  render(canvas, scene, { tags: true, tuning });
  tagTargets();
  crops = (await cropShapes(scene, tuning)).crops;
  rows();
  button();
}

const callLine = (s: ModelStats, i: number) => `call ${i + 1}  ${s.model}  first text ${s.firstMs ?? "-"} ms  total ${s.ms} ms  tokens ${s.inTokens ?? "?"} in / ${s.outTokens ?? "?"} out`;

async function go() {
  if (busy) return;
  busy = true;
  button();
  $("#errors").textContent = "";
  $("#calls").textContent = "";
  $("#stream").textContent = "";
  verdicts = new Map();
  const done: ModelStats[] = [];
  try {
    run = await describeAll(scene, tuning, {
      onCall: (s) => {
        done.push(s);
        $("#calls").textContent = done.map(callLine).join("\n");
      },
      onText: (soFar) => ($("#stream").textContent = soFar.slice(-600)),
    });
    crops = run.crops;
    const ok = run.results.filter((r) => r.ok).length;
    const tin = run.calls.reduce((a, s) => a + (s.inTokens ?? 0), 0);
    const tout = run.calls.reduce((a, s) => a + (s.outTokens ?? 0), 0);
    $("#stat").textContent = `${run.results.length} shapes · ${ok} within word limits · ${run.calls.length} call(s) · ${run.ms} ms · ${tin} tokens in / ${tout} out · ${tuningId(tuning)}`;
    $<HTMLButtonElement>("#save").disabled = false;
  } catch (err) {
    $("#errors").textContent = err instanceof Error ? err.message : String(err);
  }
  busy = false;
  button();
  rows();
}

$("#go").addEventListener("click", () => void go());
$("#rows").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
  if (!b) return;
  const id = b.dataset.id!;
  const v = b.dataset.v as "good" | "bad";
  if (verdicts.get(id) === v) verdicts.delete(id);
  else verdicts.set(id, v);
  rows();
});
$<HTMLSelectElement>("#fixture").addEventListener("change", (e) => {
  fixture = (e.target as HTMLSelectElement).value;
  scene = runScript(fixtures[fixture][1]).scene;
  run = undefined;
  verdicts = new Map();
  $<HTMLButtonElement>("#save").disabled = true;
  $("#stat").textContent = "Press Describe all.";
  void recrop();
});

$("#save").addEventListener("click", () => {
  if (!run) return;
  // One example per shape: the model's text, judged good (accepted) or bad by you; unjudged ones count as accepted.
  const examples = run.results.map((r) => {
    const c = check(r.id, r.text || undefined, tuning);
    const v = verdicts.get(r.id);
    return { decision: "describe.text", strokes: [], predicted: r.text, features: { ...c.features, id: r.id, opsDescription: scene.get(r.id)!.description }, label: v ?? "good", corrected: v !== undefined };
  });
  download(`describe-${fixtures[fixture][0]}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(makeSet("playground", fixtures[fixture][0], tuning, tuningId(tuning), examples), null, 1));
});

// Knob changes never call the model: they recrop (if a crop knob moved) and recheck the word limits.
let lastCrop = "";
tuningPanel($("#side"), ["describe", "shot"], (t) => {
  tuning = t;
  const cropKey = `${t["describe.cropPadPx"]}|${t["describe.cropMaxPx"]}|${t["shot.scale"]}|${t["shot.tagPx"]}|${t["shot.jpegQuality"]}`;
  if (cropKey !== lastCrop && !busy) {
    lastCrop = cropKey;
    void recrop();
  } else {
    rows();
    button();
  }
});

fontsReady().then(() => {
  lastCrop = `${tuning["describe.cropPadPx"]}|${tuning["describe.cropMaxPx"]}|${tuning["shot.scale"]}|${tuning["shot.tagPx"]}|${tuning["shot.jpegQuality"]}`;
  void recrop();
});
