// Board shots playground: what a model can be shown of an infinite board. Move
// around (scroll, ctrl-scroll, space-drag), draw, type what you'd say, and
// Capture: the pictures worth sending are picked (from the resolver's answers
// when the knob says so, else by rules) and captured side by side, next to the
// site map as text, each with what it costs. The view cases score the picking:
// what must come out legible, and the tokens it took.
import board from "../../src/fixtures/board.ops.txt?raw";
import cases from "../../src/fixtures/view-cases.json";
import { type BoardShot, type NamedView, type ViewCase, boardShots, fitView, pagesOf, pickViews, scoreViews, siteMap, union } from "../../src/core/board.ts";
import { startView } from "../../src/core/camera.ts";
import { typedWords } from "../../src/core/draw.ts";
import { HitIndex } from "../../src/core/hittest.ts";
import { type Stroke, attachInk, strokePath } from "../../src/core/ink.ts";
import { groupStrokes } from "../../src/core/marks.ts";
import { modelOf } from "../../src/core/model.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { type Ref, caseInput, resolve } from "../../src/core/resolve.ts";
import { imageTokens, takeShot } from "../../src/core/shot.ts";
import { span } from "../../src/core/trace.ts";
import { DEFAULTS, type Tuning, tune, tuningId } from "../../src/core/tuning.ts";
import type { Word } from "../../src/core/link.ts";
import { boardStage } from "../../src/boardStage.ts";
import { $, fontsReady, shell, tuningPanel } from "../../src/ui.ts";

shell("board", "An infinite board of five pages. Scroll to pan, ctrl-scroll to zoom, hold space and drag to pan; draw with the pen. Type what you'd say and press Capture: the pictures worth sending a model are picked (from the resolver's answers, one model call unless your ink settles it, or by rules) and captured side by side, next to the site map as text. The view cases score the picking.");
const { scene } = runScript(board);
const CASES = cases as ViewCase[];
const hits = new HitIndex(scene);
const all = () => fitView(union(pagesOf(scene).map((p) => p.box)), 0.03);
const st = boardStage($("#left"), startView({ from: "home" }, scene));
let tuning: Tuning = DEFAULTS;
let strokes: Stroke[] = [];
const INK = "#e03131";
let epoch = performance.now();
let detach = attachInk(st.ink, (s) => strokes.push(s), { epoch, color: INK });
const draw = () => render(st.canvas, scene, { tuning, view: st.view() });

const out = document.createElement("div");
out.className = "card";
out.style.marginTop = "12px";
out.innerHTML = `<h2>What the model would get</h2><div class="stat" id="sum">Press Capture, or pick a case.</div><div class="stat muted" id="refs"></div><div id="views" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px"></div>
  <h3 style="margin:8px 0 0">Site map, as text <span class="stat muted" id="mapStat"></span></h3><pre class="log" id="map" style="max-height:480px;background:#faf9f6;padding:8px;border-radius:6px"></pre>`;
$("#left").append(out);

$("#side").innerHTML = `
  <div class="card">
    <h2>Capture</h2>
    <input id="said" placeholder="what you'd say, e.g. make the page with the robot like this one" style="font:16px Excalifont, cursive;padding:6px 8px;border:1.5px solid var(--ink);border-radius:8px">
    <div class="row"><button class="primary" id="capture">Capture</button><button id="oneByOne" title="The same pictures, captured one after another, to compare with side by side">One at a time</button></div>
    <div class="row"><button id="fit">Show everything</button><button id="clear">Clear ink</button></div>
    <div class="stat" id="camera"></div>
  </div>
  <div class="card">
    <h2>View cases</h2>
    <div class="row"><button id="runRules">Rules (free)</button><button class="primary" id="runRefs"></button></div>
    <div class="stat" id="caseScore">Not run yet. A case passes when everything it needs comes out legible in some picture.</div>
    <div style="max-height:420px;overflow:auto"><table class="marks"><thead><tr><th>#</th><th>said</th><th>rules</th><th>resolver</th></tr></thead><tbody id="rows"></tbody></table></div>
  </div>`;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function showMap() {
  const text = siteMap(scene, tuning);
  $("#map").textContent = text;
  $("#mapStat").textContent = `· ${text.length} chars · ~${Math.ceil(text.length / 4)} tokens · depth ${tuning["board.mapDepth"]}, ${tuning["board.mapWords"]} words per description`;
  return text;
}

function show(shots: BoardShot[], ms: number, sumMs: number, how: string, before = "") {
  const imgTokens = shots.reduce((a, s) => a + imageTokens(s.shot.width, s.shot.height), 0);
  const mapTokens = Math.ceil(showMap().length / 4);
  $("#sum").textContent = `${before}${shots.length} pictures ${how} in ${ms} ms (each on its own: ${sumMs} ms in all) · ~${imgTokens} image tokens + ~${mapTokens} for the map = ~${imgTokens + mapTokens} tokens · ${kb(shots.reduce((a, s) => a + s.shot.bytes, 0))}`;
  $("#views").innerHTML = shots
    .map((s) => `<figure style="margin:0;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff">
      <a href="${URL.createObjectURL(s.shot.blob)}" target="_blank"><img src="${s.shot.dataUrl}" style="width:100%;border-radius:4px;display:block"></a>
      <figcaption class="stat"><b>${esc(s.name)}</b> · ${s.shot.width}×${s.shot.height} · ~${imageTokens(s.shot.width, s.shot.height)} tokens · ${kb(s.shot.bytes)} · ${Math.round(s.shot.ms.total)} ms<br><span class="muted">${esc(s.why)} · board ${Math.round(s.view.w)}×${Math.round(s.view.h)} at ${Math.round(s.view.x)},${Math.round(s.view.y)}</span></figcaption></figure>`)
    .join("");
}

/** The pictures for these words and ink: through the resolver when board.fromRefs is on (a model call unless the ink settles it). */
async function pick(words: Word[], said: string, ink: Stroke[], t: Tuning, parent?: Parameters<typeof resolve>[7]): Promise<{ views: NamedView[]; refs?: Ref[]; resolveMs?: number; via?: string }> {
  if (!t["board.fromRefs"]) return { views: pickViews(scene, st.view(), ink, said, t) };
  const t0 = performance.now();
  const r = await resolve(words, ink, groupStrokes(ink, t), scene, hits, t, "views", parent);
  return { views: pickViews(scene, st.view(), ink, said, t, r.refs), refs: r.refs, resolveMs: Math.round(performance.now() - t0), via: r.via };
}

const showRefs = (refs?: Ref[], ms?: number, via?: string) =>
  ($("#refs").textContent = refs ? `resolver (${via === "ink" ? "the ink settled it, no call" : `one call, ${ms} ms`}): ${refs.map((r) => `"${r.phrase}" → ${r.ids.join(", ") || "nothing"}`).join(" · ") || "no references"}` : "picked by rules (no resolver)");

$("#capture").addEventListener("click", async () => {
  const said = $<HTMLInputElement>("#said").value.trim();
  await span("capture", undefined, async (ctx) => {
    const p = await pick(typedWords(said, groupStrokes(strokes, tuning)), said, strokes, tuning, ctx);
    showRefs(p.refs, p.resolveMs, p.via);
    const { shots, ms, sumMs } = await boardShots(scene, strokes, p.views, tuning, ctx);
    show(shots, ms, sumMs, "side by side", p.resolveMs !== undefined && p.via !== "ink" ? `resolver ${p.resolveMs} ms, then ` : "");
  });
});
$("#oneByOne").addEventListener("click", async () => {
  const said = $<HTMLInputElement>("#said").value.trim();
  const p = await pick(typedWords(said, groupStrokes(strokes, tuning)), said, strokes, tuning);
  showRefs(p.refs, p.resolveMs, p.via);
  const t0 = performance.now();
  const shots: BoardShot[] = [];
  for (const v of p.views) shots.push({ ...v, shot: await takeShot(scene, strokes, v.tags ? tuning : tune({ "shot.tagPx": 0 }, tuning), { view: v.view, width: v.width }) });
  show(shots, Math.round(performance.now() - t0), Math.round(shots.reduce((a, s) => a + s.shot.ms.total, 0)), "one after another");
});

function clearInk() {
  strokes = [];
  st.ink.replaceChildren();
  detach();
  epoch = performance.now();
  detach = attachInk(st.ink, (s) => strokes.push(s), { epoch, color: INK });
}
$("#fit").addEventListener("click", () => void st.setView(all(), tuning["camera.easeMs"]));
$("#clear").addEventListener("click", clearInk);
st.onMove((v) => ($("#camera").textContent = `camera ${Math.round(v.x)},${Math.round(v.y)} · ${Math.round(v.w)}×${Math.round(v.h)} board px · zoom ${(1280 / v.w).toFixed(2)}×`));

// ---- View cases: rules against the resolver, on the same cases.
type Result = { ok: boolean; covered: string[]; missed: string[]; tokens: number; views: NamedView[]; refs?: Ref[]; resolveMs?: number; via?: string; error?: string };
const results = { rules: new Map<number, Result>(), refs: new Map<number, Result>() };
let picked: number | undefined;

const cell = (r?: Result) => (!r ? '<span class="muted">-</span>' : r.error ? `<span class="bad" title="${esc(r.error)}">error</span>` : `<span class="${r.ok ? "ok" : "bad"}" title="${r.missed.length ? `missed ${r.missed.join(", ")}` : "all legible"}">${r.ok ? "✓" : `✗ ${r.missed.length}`}</span> <span class="stat muted">${r.tokens}</span>`);
function rows() {
  $<HTMLButtonElement>("#runRefs").textContent = `Resolver (up to ${CASES.length} calls, ${modelOf(tuning["resolve.model"])})`;
  $("#rows").innerHTML = CASES.map((c, i) => `<tr data-i="${i}" style="cursor:pointer;${i === picked ? "background:#fff4e6;" : ""}" title="${esc(c.note ?? "")}"><td>${i + 1}</td><td>${esc(c.said)}${c.ink.length ? ` <span class="muted">+ ${c.ink.length} ink</span>` : ""}</td><td>${cell(results.rules.get(i))}</td><td>${cell(results.refs.get(i))}</td></tr>`).join("");
  const line = (name: string, m: Map<number, Result>) => {
    if (!m.size) return "";
    const rs = [...m.values()];
    const ids = CASES.reduce((a, c, i) => a + (m.has(i) ? c.need.length : 0), 0);
    const got = rs.reduce((a, r) => a + r.covered.length, 0);
    return `${name}: ${rs.filter((r) => r.ok).length}/${rs.length} cases, ${got}/${ids} needed shapes legible, ~${Math.round(rs.reduce((a, r) => a + r.tokens, 0) / rs.length)} image tokens a send`;
  };
  const lines = [line("rules", results.rules), line("resolver", results.refs)].filter(Boolean);
  if (lines.length) $("#caseScore").textContent = `${lines.join(" · ")} · ${tuningId(tuning)}`;
}

async function runCase(i: number, mode: "rules" | "refs") {
  const c = CASES[i];
  const from = startView(c, scene);
  await st.setView(from);
  const { words, strokes: ink } = caseInput({ words: c.said, ink: c.ink, expect: [] });
  const t = tune({ "board.fromRefs": mode === "refs" ? 1 : 0 }, tuning);
  try {
    const p = await pick(words, c.said, ink, t);
    results[mode].set(i, { ...scoreViews(c, p.views, scene), views: p.views, refs: p.refs, resolveMs: p.resolveMs, via: p.via });
  } catch (err) {
    results[mode].set(i, { ok: false, covered: [], missed: c.need, tokens: 0, views: [], error: err instanceof Error ? err.message : String(err) });
  }
  rows();
}

async function runAll(mode: "rules" | "refs") {
  for (const id of ["runRules", "runRefs"]) $<HTMLButtonElement>(`#${id}`).disabled = true;
  results[mode].clear();
  // One at a time: each case moves the shared camera.
  for (let i = 0; i < CASES.length; i++) await runCase(i, mode);
  for (const id of ["runRules", "runRefs"]) $<HTMLButtonElement>(`#${id}`).disabled = false;
}
$("#runRules").addEventListener("click", () => void runAll("rules"));
$("#runRefs").addEventListener("click", () => void runAll("refs"));

$("#rows").addEventListener("click", async (e) => {
  const tr = (e.target as HTMLElement).closest("tr");
  if (!tr?.dataset.i) return;
  picked = Number(tr.dataset.i);
  rows();
  const c = CASES[picked];
  clearInk();
  await st.setView(startView(c, scene), tuning["camera.easeMs"]);
  // The case's ink, drawn where it was meant.
  strokes = caseInput({ words: c.said, ink: c.ink, expect: [] }).strokes;
  for (const s of strokes) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", INK);
    p.setAttribute("d", strokePath(s.points));
    st.ink.append(p);
  }
  $<HTMLInputElement>("#said").value = c.said;
  // Show the resolver's pick if it ran, else the rules'.
  const r = results.refs.get(picked) ?? results.rules.get(picked);
  if (!r) return void ($("#sum").textContent = `Needs: ${c.need.join(", ") || "nothing off screen"}. Run the cases, or press Capture.`);
  showRefs(r.refs, r.resolveMs, r.via);
  const { shots, ms, sumMs } = await boardShots(scene, strokes, r.views, tuning);
  show(shots, ms, sumMs, "side by side", `${results.refs.has(picked) ? "resolver" : "rules"}: ${r.ok ? "all legible" : `missed ${r.missed.join(", ")}`} · `);
});

tuningPanel($("#side"), ["board", "resolve", "shot"], (t) => {
  tuning = t;
  rows();
  draw();
  showMap();
});
rows();
fontsReady().then(() => {
  draw();
  showMap();
});
