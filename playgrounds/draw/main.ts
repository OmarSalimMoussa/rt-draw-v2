// Drawing model playground: the product's send on an infinite board. Move
// around (scroll, ctrl-scroll, space-drag), draw, say (or type) what you want,
// press Send or Enter. The model gets the pictures picked for the send and the
// site map; its ops stream back and land one by one, camera(...) lines glide the screen.
import board from "../../src/fixtures/board.ops.txt?raw";
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import grid from "../../src/fixtures/grid.ops.txt?raw";
import messy from "../../src/fixtures/messy.ops.txt?raw";
import { type OpResult, type Prompt, type SendResult, cloneScene } from "../../src/core/draw.ts";
import { type Stroke, attachInk } from "../../src/core/ink.ts";
import { makeSet } from "../../src/core/labels.ts";
import type { Word } from "../../src/core/link.ts";
import { modelOf } from "../../src/core/model.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import type { Scene } from "../../src/core/scene.ts";
import { send as sendScene } from "../../src/core/send.ts";
import { Mic, ScribeEngine } from "../../src/core/speech.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { span } from "../../src/core/trace.ts";
import { SCREEN, type View, asPage, boardBounds, fitView, pageTop, pagesOf, union } from "../../src/core/board.ts";
import { boardStage } from "../../src/boardStage.ts";
import { $, download, fontsReady, shell, tuningPanel } from "../../src/ui.ts";

shell("draw", "The product's send, on an infinite board: scroll to pan, ctrl-scroll to zoom, hold space and drag to pan. Draw, then say or type what you want and press Send (or Enter). The model gets your words with [ink n] markers, the pictures picked for this send (what you see, what you referred to, the whole board) and the site map; its ops land as each line arrives, and camera(...) lines move the screen. Each send is a resolver call and a drawing call on your Claude subscription, plus one per picture.");
const fixtures: Record<string, string> = { "Toy shop (5 pages)": board, "Clowns.com": asPage(clowns, "page", "Home"), "Settings screen (grid)": asPage(grid, "page", "Settings"), "Messy shop": asPage(messy, "page", "Home"), "Blank page": asPage("", "page", "Home") };
/** Where the camera starts on a board: the top of its first page. */
const startOf = (sc: Scene): View => (pagesOf(sc)[0] ? pageTop(pagesOf(sc)[0]) : fitView(boardBounds(sc)));
const st = boardStage($("#left"), startOf(runScript(fixtures[Object.keys(fixtures)[0]]).scene));
const { canvas, ink } = st;
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
    <div class="row"><button class="primary" id="send">Send (Enter)</button><button id="talk">Talk (Scribe, paid)</button><button id="clearInk">Clear ink</button><button id="undo" disabled>Undo send</button><button id="fit">Show everything</button></div>
    <div class="stat" id="camera"></div>
    <div class="muted" id="interim" style="font:17px Excalifont, cursive;min-height:22px"></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card">
    <h2>What was sent</h2>
    <div class="stat" id="anatomy">Send to see the prompt.</div>
    <details><summary class="muted">system prompt</summary><pre class="log" id="sys"></pre></details>
    <details><summary class="muted">user message</summary><pre class="log" id="usr"></pre></details>
    <details><summary class="muted">pictures</summary><div id="pics" style="display:grid;gap:8px"></div></details>
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

const draw = () => render(canvas, scene, { tags: true, tuning, view: st.view() });
/** With ?record=1 each send is also posted to /api/eval/record: the owner's real sends, the eval's human benchmark (opt-in). */
const record = new URLSearchParams(location.search).get("record") === "1";

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
  // From pressing Send to the last op on screen, as one trace: the Latency modal shows its parts.
  await span(`send ${sends.length + 1}`, undefined, async (ctx) => {
    if (talking) await span("finish listening (Scribe)", ctx, () => stopTalking());
    const input = words.length ? words : typed;
    const view = st.view();
    // The human benchmark's copy (spec §2.8), taken before the send changes the scene.
    const human = record ? { input, strokes: [...strokes], scene: structuredClone(scene.toJSON()), view, at: new Date().toISOString() } : undefined;
    const model = modelOf(tuning["draw.model"]);
    const lines: string[] = [];
    let prompt: Prompt;
    const { pics } = await sendScene(scene, { strokes, words: input }, tuning, {
      parent: ctx,
      draw,
      setView: st.setView,
      onPrompt: (p) => {
        prompt = p;
        showPrompt(p);
        undo.push(cloneScene(scene));
        $<HTMLButtonElement>("#undo").disabled = false;
        $("#opLog").textContent = "";
        $("#sendStat").textContent = `Sending to ${model}…`;
      },
      onOp: (r) => {
        lines.push(logLine(r));
        $("#opLog").textContent = lines.join("\n");
      },
      onReply: (result) => {
        sends.push({ n: sends.length + 1, request: prompt.transcript, prompt, result, strokes, model });
        const s = result.stats;
        const okOps = result.ops.filter((o) => o.ok).length;
        $("#sendStat").textContent = result.error
          ? `✗ ${result.error}`
          : `${model} · first text ${s?.firstMs ?? "-"} ms · first op ${result.firstOpMs ?? "-"} ms · done ${result.ms} ms · ${okOps}/${result.ops.length} ops applied · tokens in ${s?.inTokens ?? "?"} / out ${s?.outTokens ?? "?"}`;
        if (result.error) $("#errors").textContent = result.error;
        clearInk();
        $<HTMLTextAreaElement>("#words").value = "";
      },
    }, view);
    if (pics && (pics.drawn || pics.failed.length)) $("#sendStat").textContent += ` · ${pics.drawn} pictures, all done ${pics.ms} ms after Send${pics.failed.length ? ` (${pics.failed.length} failed)` : ""}`;
    listSends();
    // Fire and forget: the typed text or timed words, the ink, the scene before and the view.
    if (human) void fetch("/api/eval/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(human) }).catch(() => {});
  });
  sending = false;
  $<HTMLButtonElement>("#send").disabled = false;
}

function showPrompt(p: Prompt) {
  const f = p.features;
  const pics = f.pictures ? `${f.pictures} picture${f.pictures === 1 ? "" : "s"}, ~${f.imageTokens} tokens${f.board ? ` (${f.earlyShots} captured while the resolver thought${f.unusedShots ? `, ${f.unusedShots} not kept` : ""}; all in ${f.shotsMs} ms)` : ""}` : "no pictures";
  $("#anatomy").textContent = `system ${p.system.length} chars · user ${p.user.length} chars · ~${Math.round(f.chars / 4)} text tokens · ${pics} · ${f.board ? `site map ${f.mapChars} chars` : `${f.idMap} ids`} · ${f.ops} op lines · ${f.marks} marks (${f.marksSent ? "described" : "not described"}) · references: ${f.refs === "off" ? "off" : f.refs === "ink" ? "from the ink" : `resolver call, ${f.resolveMs} ms`}`;
  $("#sys").textContent = p.system;
  $("#usr").textContent = p.user;
  const shots = p.shots ?? (p.shot ? [{ name: "screenshot", why: "the canvas", shot: p.shot }] : []);
  $("#pics").innerHTML = shots.map((s, i) => `<figure style="margin:0"><img src="${s.shot.dataUrl}" style="width:100%;border:1px solid var(--line);border-radius:6px"><figcaption class="stat muted">${i + 1}. ${esc(s.name)} · ${s.shot.width}×${s.shot.height} · ${esc(s.why)}</figcaption></figure>`).join("");
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
  void st.setView(startOf(scene));
  draw();
};
$("#fit").addEventListener("click", () => void st.setView(fitView(pagesOf(scene).length ? union(pagesOf(scene).map((p) => p.box)) : boardBounds(scene), 0.03), tuning["camera.easeMs"]));
st.onMove((v) => ($("#camera").textContent = `camera ${Math.round(v.x)},${Math.round(v.y)} · ${Math.round(v.w)}×${Math.round(v.h)} board px · zoom ${(SCREEN.w / v.w).toFixed(2)}×`));
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

tuningPanel($("#side"), ["draw", "board", "resolve", "picture", "shot", "camera", "link", "speech"], (t) => {
  tuning = t;
  draw();
});

fontsReady().then(draw);
