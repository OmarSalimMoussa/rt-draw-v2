// Camera playground: can a model move the view the way a person means? Run the
// hand-written cases ("zoom out", "go to the shop page", "a little to the
// left"), each from its own starting view and scored by rules, or type your own
// and watch the camera glide there. One model call per case.
import board from "../../src/fixtures/board.ops.txt?raw";
import cases from "../../src/fixtures/camera-cases.json";
import { type View, fitView, pagesOf, union } from "../../src/core/board.ts";
import { type CameraCase, type CameraMove, moveCamera, scoreCamera, startView } from "../../src/core/camera.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { boardStage } from "../../src/boardStage.ts";
import { $, fontsReady, shell, tuningPanel } from "../../src/ui.ts";
import { modelOf } from "../../src/core/model.ts";

shell("camera", "Can a model move the camera the way a person means? Each case starts from its own view; the model gets where the camera is, the site map and a picture (per the knobs) and answers with one camera(...) line, scored by rules. Or type your own and watch it glide there. One model call per case, on your subscription.");
const { scene } = runScript(board);
const CASES = cases as CameraCase[];
const all = () => fitView(union(pagesOf(scene).map((p) => p.box)), 0.03);
const st = boardStage($("#left"), startView(CASES[0], scene));
let tuning: Tuning = DEFAULTS;
const draw = () => render(st.canvas, scene, { tuning, view: st.view() });

const detail = document.createElement("div");
detail.className = "card";
detail.style.marginTop = "12px";
detail.innerHTML = `<h2>Result</h2><div id="detail" class="muted">Pick a case or type a request.</div>`;
$("#left").append(detail);

$("#side").innerHTML = `
  <div class="card">
    <h2>Cases</h2>
    <div class="row"><button class="primary" id="runAll"></button><button id="runOne" disabled>Run this case</button></div>
    <div class="stat" id="score">Not run yet.</div>
    <div style="max-height:440px;overflow:auto"><table class="marks"><thead><tr><th>#</th><th>said</th><th>from</th><th>got</th></tr></thead><tbody id="rows"></tbody></table></div>
  </div>
  <div class="card">
    <h2>Free play</h2>
    <input id="said" placeholder="zoom out a bit" style="font:16px Excalifont, cursive;padding:6px 8px;border:1.5px solid var(--ink);border-radius:8px">
    <div class="row"><button class="primary" id="go">Go (Enter)</button><button id="fit">Show everything</button></div>
    <div class="stat" id="camera"></div>
  </div>`;

type Run = { move?: CameraMove; error?: string; ok?: boolean; checks?: string[]; ms?: number };
const runs = new Map<number, Run>();
let picked: number | undefined;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (v: View) => `${Math.round(v.x)} ${Math.round(v.y)} ${Math.round(v.w)}×${Math.round(v.h)}`;

function rows() {
  $<HTMLButtonElement>("#runAll").textContent = `Run ${CASES.length} cases (${CASES.length} calls, ${modelOf(tuning["camera.model"])})`;
  $("#rows").innerHTML = CASES.map((c, i) => {
    const r = runs.get(i);
    const got = !r ? '<span class="muted">-</span>' : r.error ? `<span class="bad">✗ ${esc(r.error)}</span>` : `<span class="${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✗"}</span> <span class="stat">${esc(r.move!.how)}</span>`;
    return `<tr data-i="${i}" style="cursor:pointer;${i === picked ? "background:#fff4e6;" : ""}"><td>${i + 1}</td><td>${esc(c.said)}</td><td class="stat">${Array.isArray(c.from) ? c.from.join(" ") : c.from}</td><td>${got}</td></tr>`;
  }).join("");
  const done = [...runs.values()].filter((r) => r.ok !== undefined || r.error);
  if (done.length) {
    const ok = done.filter((r) => r.ok).length;
    const ms = done.filter((r) => r.ms).map((r) => r.ms!).sort((a, b) => a - b);
    $("#score").textContent = `${ok}/${done.length} right · median ${ms[Math.floor(ms.length / 2)] ?? "-"} ms a call · ${tuningId(tuning)}`;
  }
}

function showDetail(c: CameraCase | undefined, said: string, from: View, r: Run) {
  $("#detail").innerHTML = `<div><b>${esc(said)}</b></div>
    <div class="stat">from ${fmt(from)}${r.move ? ` → ${fmt(r.move.view)} (${esc(r.move.how)}) · ${r.ms} ms · reply <code>${esc(r.move.reply.trim())}</code>` : ""}</div>
    ${r.error ? `<div class="bad">${esc(r.error)}</div>` : ""}
    ${r.checks ? `<pre class="log">${esc(r.checks.join("\n"))}</pre>` : c ? `<div class="muted stat">expects ${esc(JSON.stringify(c.expect))}</div>` : ""}`;
}

async function runCase(i: number, glide: boolean) {
  const c = CASES[i];
  const from = startView(c, scene);
  const t0 = performance.now();
  let r: Run;
  try {
    const move = await moveCamera(c.said, from, scene, tuning);
    const s = scoreCamera(c, from, move.view, scene);
    r = { move, ok: s.ok, checks: s.checks, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    r = { error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - t0) };
  }
  runs.set(i, r);
  rows();
  if (glide) {
    showDetail(c, c.said, from, r);
    if (r.move) await st.setView(r.move.view, tuning["camera.easeMs"]);
  }
}

$("#rows").addEventListener("click", async (e) => {
  const tr = (e.target as HTMLElement).closest("tr");
  if (!tr?.dataset.i) return;
  picked = Number(tr.dataset.i);
  $<HTMLButtonElement>("#runOne").disabled = false;
  rows();
  const c = CASES[picked];
  const from = startView(c, scene);
  showDetail(c, c.said, from, runs.get(picked) ?? {});
  await st.setView(from, tuning["camera.easeMs"]);
  const r = runs.get(picked);
  if (r?.move) await st.setView(r.move.view, tuning["camera.easeMs"]);
});
$("#runOne").addEventListener("click", async () => {
  if (picked === undefined) return;
  await st.setView(startView(CASES[picked], scene));
  await runCase(picked, true);
});
$("#runAll").addEventListener("click", async () => {
  $<HTMLButtonElement>("#runAll").disabled = true;
  runs.clear();
  rows();
  // Three at a time: the subscription's processes, not the page, set the pace.
  const queue = CASES.map((_, i) => i);
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) await runCase(i, false);
  }));
  $<HTMLButtonElement>("#runAll").disabled = false;
});

async function go() {
  const said = $<HTMLInputElement>("#said").value.trim();
  if (!said) return;
  const from = st.view();
  const t0 = performance.now();
  try {
    const move = await moveCamera(said, from, scene, tuning);
    const r = { move, ms: Math.round(performance.now() - t0) };
    showDetail(undefined, said, from, r);
    await st.setView(move.view, tuning["camera.easeMs"]);
  } catch (err) {
    showDetail(undefined, said, from, { error: err instanceof Error ? err.message : String(err) });
  }
}
$("#go").addEventListener("click", () => void go());
$("#said").addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && void go());
$("#fit").addEventListener("click", () => void st.setView(all(), tuning["camera.easeMs"]));
st.onMove((v) => ($("#camera").textContent = `camera ${fmt(v)} · zoom ${(1280 / v.w).toFixed(2)}×`));

tuningPanel($("#side"), ["camera", "board"], (t) => {
  tuning = t;
  rows();
  draw();
});
rows();
fontsReady().then(draw);
