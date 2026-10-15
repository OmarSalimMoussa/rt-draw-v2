// Drawing model playground: draw on the page, say (or type) what you want, press
// Send or Enter. The ops stream back and land on the canvas one by one.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import grid from "../../src/fixtures/grid.ops.txt?raw";
import messy from "../../src/fixtures/messy.ops.txt?raw";
import { type OpResult, type Prompt, type SendResult, buildPrompt, cloneScene, run } from "../../src/core/draw.ts";
import { type Stroke, attachInk } from "../../src/core/ink.ts";
import { makeSet } from "../../src/core/labels.ts";
import type { Word } from "../../src/core/link.ts";
import { modelOf } from "../../src/core/model.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import type { Scene } from "../../src/core/scene.ts";
import { Mic, ScribeEngine } from "../../src/core/speech.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { $, download, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("draw", "Draw on the page, then say or type what you want and press Send (or Enter). The model gets your words with [ink n] markers, a screenshot with your numbered ink and the id map, and its ops land on the canvas as each line arrives. Each send is one model call on your Claude subscription.");
const fixtures: Record<string, string> = { "Clowns.com": clowns, "Settings screen (grid)": grid, "Messy shop": messy, "Empty canvas": "" };
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const INK = "#e03131";

const logCard = document.createElement("div");
logCard.className = "card";
logCard.style.marginTop = "16px";
logCard.innerHTML = `<h2>Ops, as they landed</h2><div class="stat" id="sendStat">Nothing sent yet.</div><pre class="log" id="opLog"></pre>`;
$("#left").append(logCard);

$("#side").innerHTML = `
  <div class="card">
    <h2>Send</h2>
    <div class="row"><select id="fixture">${Object.keys(fixtures).map((k) => `<option>${k}</option>`).join("")}</select><button id="reset">Reset scene</button></div>
    <textarea id="words" rows="3" placeholder="type what you want (draw first), or press Talk… e.g. make this toy bigger"></textarea>
    <div class="row"><button class="primary" id="send">Send (Enter)</button><button id="talk">Talk (Scribe, paid)</button><button id="clearInk">Clear ink</button><button id="undo" disabled>Undo send</button></div>
    <div class="muted" id="interim" style="font:17px Excalifont, cursive;min-height:22px"></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card">
    <h2>What was sent</h2>
    <div class="stat" id="anatomy">Send to see the prompt.</div>
    <details><summary class="muted">system prompt</summary><pre class="log" id="sys"></pre></details>
    <details><summary class="muted">user message</summary><pre class="log" id="usr"></pre></details>
    <details><summary class="muted">screenshot</summary><img id="shotImg" alt="" style="max-width:100%;border:1px solid var(--line);border-radius:6px"></details>
  </div>
  <div class="card"><h2>Sends</h2><table class="marks"><thead><tr><th>#</th><th>send</th><th>you say</th></tr></thead><tbody id="sends"></tbody></table><div class="row"><button id="save" disabled>Save set</button></div></div>`;

let tuning: Tuning = DEFAULTS;
let scene: Scene = runScript(fixtures[$<HTMLSelectElement>("#fixture").value]).scene;
let strokes: Stroke[] = [];
let words: Word[] = [];
let epoch = performance.now();
let detach = attachInk(ink!, (s) => strokes.push(s), { epoch, color: INK });
/** Scene before each send, for undo. */
const undo: Scene[] = [];
type Send = { n: number; request: string; prompt: Prompt; result: SendResult; strokes: Stroke[]; model: string; verdict?: "good" | "bad"; note?: string };
const sends: Send[] = [];
let sending = false;

const draw = () => render(canvas, scene, { tags: true, tuning });

function clearInk() {
  strokes = [];
  words = [];
  ink!.replaceChildren();
  // A fresh clock, so new words and strokes start together.
  detach();
  epoch = performance.now();
  detach = attachInk(ink!, (s) => strokes.push(s), { epoch, color: INK });
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const logLine = (r: OpResult) => `${String(r.ms).padStart(6)} ms ${r.ok ? "✓" : "✗"} ${r.line}${r.error ? `\n            ${r.error}` : ""}`;

async function send() {
  if (sending) return;
  const typed = $<HTMLTextAreaElement>("#words").value.trim();
  if (!typed && !words.length && !strokes.length) return void ($("#errors").textContent = "Draw or say something first.");
  sending = true;
  $("#errors").textContent = "";
  $<HTMLButtonElement>("#send").disabled = true;
  if (talking) await stopTalking();
  const input = words.length ? words : typed;
  const prompt = await buildPrompt(scene, strokes, input, tuning);
  showPrompt(prompt);
  undo.push(cloneScene(scene));
  $<HTMLButtonElement>("#undo").disabled = false;
  const model = modelOf(tuning["draw.model"]);
  const lines: string[] = [];
  $("#opLog").textContent = "";
  $("#sendStat").textContent = `Sending to ${model}…`;
  const result = await run(scene, prompt, tuning, (r) => {
    lines.push(logLine(r));
    $("#opLog").textContent = lines.join("\n");
    draw();
  });
  const sent = { n: sends.length + 1, request: prompt.transcript, prompt, result, strokes, model };
  sends.push(sent);
  const s = result.stats;
  const okOps = result.ops.filter((o) => o.ok).length;
  $("#sendStat").textContent = result.error
    ? `✗ ${result.error}`
    : `${model} · first text ${s?.firstMs ?? "-"} ms · first op ${result.firstOpMs ?? "-"} ms · done ${result.ms} ms · ${okOps}/${result.ops.length} ops applied · tokens in ${s?.inTokens ?? "?"} / out ${s?.outTokens ?? "?"}`;
  if (result.error) $("#errors").textContent = result.error;
  clearInk();
  $<HTMLTextAreaElement>("#words").value = "";
  draw();
  listSends();
  sending = false;
  $<HTMLButtonElement>("#send").disabled = false;
}

function showPrompt(p: Prompt) {
  const f = p.features;
  $("#anatomy").textContent = `system ${p.system.length} chars · user ${p.user.length} chars · ~${Math.round(f.chars / 4)} text tokens · ${f.screenshot ? `screenshot ${p.shot!.width}×${p.shot!.height}, ${Math.round(p.shot!.bytes / 1024)} KB, ~${f.imageTokens} tokens` : "no screenshot"} · ${f.idMap} ids · ${f.ops} op lines · ${f.marks} marks`;
  $("#sys").textContent = p.system;
  $("#usr").textContent = p.user;
  const img = $<HTMLImageElement>("#shotImg");
  img.src = p.shot?.dataUrl ?? "";
  img.style.display = p.shot ? "block" : "none";
}

function listSends() {
  $("#sends").innerHTML = sends
    .map((s) => {
      const ok = s.result.ops.filter((o) => o.ok).length;
      const bad = s.result.ops.length - ok;
      return `<tr><td>${s.n}</td><td>${esc(s.request || "(ink only)")}<div class="muted stat">${s.model} · ${ok} ops${bad ? `, ${bad} ✗` : ""} · ${s.result.ms} ms</div></td><td><div class="row"><button data-n="${s.n}" data-v="good"${s.verdict === "good" ? ' class="primary"' : ""}>👍</button><button data-n="${s.n}" data-v="bad"${s.verdict === "bad" ? ' class="primary"' : ""}>👎</button></div><input data-n="${s.n}" placeholder="note" value="${esc(s.note ?? "")}" style="width:100%"></td></tr>`;
    })
    .join("");
  $<HTMLButtonElement>("#save").disabled = !sends.length;
}

$("#sends").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b?.dataset.v) return;
  const s = sends[Number(b.dataset.n) - 1];
  s.verdict = s.verdict === b.dataset.v ? undefined : (b.dataset.v as "good" | "bad");
  listSends();
});
$("#sends").addEventListener("input", (e) => {
  const i = e.target as HTMLInputElement;
  if (i.dataset.n) sends[Number(i.dataset.n) - 1].note = i.value;
});

$("#save").addEventListener("click", () => {
  const examples = sends.map((s) => ({
    decision: "draw.send",
    strokes: s.strokes,
    predicted: s.result.reply,
    features: { request: s.request, model: s.model, ops: s.result.ops.length, errors: s.result.ops.filter((o) => !o.ok).length, ms: s.result.ms, firstOpMs: s.result.firstOpMs ?? -1, note: s.note ?? "" },
    label: s.verdict ?? "unrated",
    corrected: !!s.verdict,
  }));
  const name = $<HTMLSelectElement>("#fixture").value;
  download(`draw-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(makeSet("playground", name, tuning, tuningId(tuning), examples), null, 1));
});

$("#send").addEventListener("click", () => void send());
$("#words").addEventListener("keydown", (e) => {
  const k = e as KeyboardEvent;
  if (k.key === "Enter" && !k.shiftKey) {
    k.preventDefault();
    void send();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement === document.body) void send();
});
$("#clearInk").addEventListener("click", clearInk);
$("#undo").addEventListener("click", () => {
  const prev = undo.pop();
  if (prev) scene = prev;
  $<HTMLButtonElement>("#undo").disabled = !undo.length;
  draw();
});
const reset = () => {
  scene = runScript(fixtures[$<HTMLSelectElement>("#fixture").value]).scene;
  undo.length = 0;
  $<HTMLButtonElement>("#undo").disabled = true;
  clearInk();
  draw();
};
$("#fixture").addEventListener("change", reset);
$("#reset").addEventListener("click", reset);

// Talking: Scribe's words come on the page clock; strokes count from `epoch`, so words are moved onto that.
const mic = new Mic();
let engine: ScribeEngine | undefined;
let talking = false;
async function talk() {
  clearInk();
  $("#errors").textContent = "";
  engine = new ScribeEngine(
    {
      onInterim: (text) => ($("#interim").textContent = text),
      onFinal: (u) => {
        $("#interim").textContent = u.text;
        words.push(...u.words.map((w) => ({ word: w.word, t0: Math.round(w.t0 - epoch), t1: Math.round(w.t1 - epoch) })));
      },
      onError: (e) => ($("#errors").textContent += `${e}\n`),
    },
    mic,
    () => tuning,
  );
  try {
    await mic.start();
    await engine.start();
  } catch (err) {
    $("#errors").textContent += `${err instanceof Error ? err.message : String(err)}\n`;
    mic.stop();
    return;
  }
  talking = true;
  $("#talk").textContent = "Stop talking";
}
async function stopTalking() {
  talking = false;
  $("#talk").textContent = "Finishing…";
  await engine?.stop();
  mic.stop();
  $("#talk").textContent = "Talk (Scribe, paid)";
}
$("#talk").addEventListener("click", () => void (talking ? stopTalking() : talk()));

tuningPanel($("#side"), ["draw", "shot", "link", "speech"], (t) => {
  tuning = t;
  draw();
});

fontsReady().then(draw);
