// Driver demo: watch a model play a user of the product. Pick who it is (and
// the site a first-timer has in mind), how messy and patient it is, and a seed.
// Each turn the driver looks at the screen, says how the last send went, then
// talks and draws (synthesized into timed words and messy ink, played back
// here), presses Enter, and the real product answers.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import messy from "../../src/fixtures/messy.ops.txt?raw";
import { type SendResult, buildPrompt, run } from "../../src/core/draw.ts";
import { strokePath } from "../../src/core/ink.ts";
import { MODELS, type ModelName } from "../../src/core/model.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import type { Scene } from "../../src/core/scene.ts";
import { takeShot } from "../../src/core/shot.ts";
import { span } from "../../src/core/trace.ts";
import { DEFAULTS, tune, tuningId } from "../../src/core/tuning.ts";
import { $, download, fontsReady, shell, stage } from "../../src/ui.ts";
import { type Behaviour, type Past, type Turn, describeStep, driverTurn, systemPrompt } from "../core/driver.ts";
import { PERSONAS, TARGETS } from "../core/personas.ts";
import { type Step, type Timeline, type Traits, synthesize } from "../core/synth.ts";

shell("", "Driver demo: a model plays a user. It sees only the screen, talks and scribbles (synthesized into timed words and messy ink), presses Enter, and the real product answers. Each send is two or three calls on your Claude subscription: the driver, then the product (resolver and drawing model).");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const INK = "#e03131";
const tuning = DEFAULTS;
/** What the driver sees: the canvas as a user sees it, no id tags or grid. */
const userView = tune({ "shot.tagPx": 0, "shot.gridCellPx": 0 }, tuning);
const fixtures: Record<string, string> = { "Empty canvas": "", "Clowns.com": clowns, "Messy shop": messy };

const now = document.createElement("div");
now.className = "card";
now.style.marginTop = "12px";
now.innerHTML = `<div class="stat" id="status">Pick a driver and press Run.</div><div id="caption" style="font:22px Excalifont, cursive;min-height:32px"></div>`;
const log = document.createElement("div");
log.style.cssText = "display:grid;gap:12px;margin-top:12px";
$("#left").append(now, log);

const slider = (id: string, label: string, value: number) => `<label title="${label}" style="display:grid;grid-template-columns:120px 1fr 36px;font-size:12px"><span>${label}</span><input type="range" id="${id}" min="0" max="1" step="0.1" value="${value}"><span class="stat" data-for="${id}">${value}</span></label>`;
$("#side").innerHTML = `
  <div class="card">
    <h2>Driver</h2>
    <select id="persona">${PERSONAS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select>
    <select id="target">${TARGETS.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}</select>
    ${slider("mess", "messy ink", 0.5)}
    ${slider("disfluency", "ums and restarts", 0.5)}
    ${slider("patience", "patience", 0.5)}
    ${slider("changeMind", "changes their mind", 0.3)}
    <label style="font-size:12px"><input type="checkbox" id="bigThenSmall"> asks for too much, then tones it down</label>
    <div class="row" style="font-size:12px">seed <input id="seed" type="number" value="1" style="width:70px"><button id="dice" title="a new seed">🎲</button> sends <input id="maxSends" type="number" min="1" max="20" value="6" style="width:50px"></div>
    <div class="row" style="font-size:12px">driver model <select id="model">${MODELS.map((m) => `<option${m === "sonnet" ? " selected" : ""}>${m}</option>`).join("")}</select> start <select id="fixture">${Object.keys(fixtures).map((k) => `<option>${k}</option>`).join("")}</select></div>
    <div class="row" style="font-size:12px">playback <select id="speed"><option value="1">1×</option><option value="2" selected>2×</option><option value="4">4×</option><option value="0">instant</option></select></div>
    <div class="row"><button class="primary" id="run">Run</button><button id="step">One send</button><button id="stop" disabled>Stop after this send</button></div>
    <div class="row"><button id="reset">Reset</button><button id="save" disabled>Download the session record</button></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card"><h2>What the driver is told</h2><details><summary class="muted">system prompt (fixed for the run)</summary><pre class="log" id="sys"></pre></details><div class="muted stat">It never sees our prompts, ops, knobs or code. Its last reply is in Model calls.</div></div>`;

for (const id of ["mess", "disfluency", "patience", "changeMind"]) $(`#${id}`).addEventListener("input", () => ($(`[data-for="${id}"]`).textContent = $<HTMLInputElement>(`#${id}`).value));
const syncTarget = () => ($<HTMLSelectElement>("#target").disabled = $<HTMLSelectElement>("#persona").value !== "first-timer");
$("#persona").addEventListener("change", syncTarget);
syncTarget();
$("#dice").addEventListener("click", () => ($<HTMLInputElement>("#seed").value = String(Math.floor(Math.random() * 10000))));

type Record_ = { n: number; turn: Turn; timeline: Timeline; transcript: string; result: SendResult; before: string; after?: string };
let scene: Scene = runScript("").scene;
let past: Past[] = [];
let sends: Record_[] = [];
let setup: { persona: string; target?: string; traits: Traits; behaviour: Behaviour; seed: number; maxSends: number; model: ModelName; system: string; fixture: string } | undefined;
let stopAsked = false;
let busy = false;
let finished = "";

const draw = () => render(canvas, scene, { tuning });
const status = (s: string) => ($("#status").textContent = s);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const num = (id: string) => Number($<HTMLInputElement>(`#${id}`).value);
const stars = (n?: number) => (n ? `${"★".repeat(n)}${"☆".repeat(5 - n)}` : "");

function freshSetup() {
  const persona = PERSONAS.find((p) => p.id === $<HTMLSelectElement>("#persona").value)!;
  const target = persona.id === "first-timer" ? TARGETS.find((t) => t.id === $<HTMLSelectElement>("#target").value) : undefined;
  const behaviour: Behaviour = { patience: num("patience"), changeMind: num("changeMind"), bigThenSmall: $<HTMLInputElement>("#bigThenSmall").checked };
  // The driver's screenshot size, so it can give positions in its own pixels.
  const w = Math.round(scene.width * userView["shot.scale"]);
  const h = Math.round(scene.height * userView["shot.scale"]);
  const system = systemPrompt(persona, target, behaviour, w, h);
  $("#sys").textContent = system;
  return { persona: persona.id, target: target?.id, traits: { mess: num("mess"), disfluency: num("disfluency") }, behaviour, seed: num("seed"), maxSends: Math.max(1, num("maxSends")), model: $<HTMLSelectElement>("#model").value as ModelName, system, fixture: $<HTMLSelectElement>("#fixture").value };
}

/** Plays the person's words and ink on the stage, on their own clock (speed 0: all at once). */
function play(tl: Timeline, speed: number): Promise<void> {
  ink!.replaceChildren();
  const paths = tl.strokes.map(() => {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", INK);
    ink!.append(p);
    return p;
  });
  const show = (t: number) => {
    tl.strokes.forEach((s, i) => {
      const pts = s.points.filter((p) => p[2] <= t);
      if (pts.length) paths[i].setAttribute("d", strokePath(pts, tuning["ink.size"], tuning));
    });
    $("#caption").textContent = tl.words.filter((w) => w.t0 <= t).map((w) => w.word).join(" ");
  };
  if (!speed) return Promise.resolve(show(Number.POSITIVE_INFINITY));
  const start = performance.now();
  return new Promise((done) => {
    const frame = () => {
      const t = (performance.now() - start) * speed;
      show(t);
      if (t >= tl.ms + 200) done();
      else requestAnimationFrame(frame);
    };
    frame();
  });
}

function card(r: Record_) {
  const t = r.turn;
  const ok = r.result.ops.filter((o) => o.ok).length;
  const bad = r.result.ops.length - ok;
  const next = sends[r.n] as Record_ | undefined;
  const reaction = next?.turn ?? (finished && r === sends.at(-1) ? lastReaction : undefined);
  return `<div class="card" data-n="${r.n}">
    <h2>Send ${r.n}</h2>
    <div><b>Wants</b> <span class="muted">(private)</span>: ${esc(t.intent)}</div>
    <div><b>Says</b>: <span style="font:18px Excalifont, cursive">${esc(r.timeline.spoken || "(nothing)")}</span></div>
    <div><b>Does</b>: ${t.steps.map((s) => esc(describeStep(s as Step))).join(" → ")}</div>
    <div class="stat muted">the product got: ${esc(r.transcript || "(no words)")}</div>
    <div class="stat">${r.result.error ? `<span class="bad">✗ ${esc(r.result.error)}</span>` : `${ok} ops applied${bad ? `, <span class="bad">${bad} failed</span>` : ""} · first op ${r.result.firstOpMs ?? "-"} ms · done ${r.result.ms} ms`}</div>
    <div class="row" style="align-items:start"><figure style="margin:0;flex:1"><img src="${r.before}" style="width:100%;border:1px solid var(--line);border-radius:6px"><figcaption class="muted stat">before</figcaption></figure>${r.after ? `<figure style="margin:0;flex:1"><img src="${r.after}" style="width:100%;border:1px solid var(--line);border-radius:6px"><figcaption class="muted stat">after</figcaption></figure>` : ""}</div>
    ${reaction?.satisfaction ? `<div><b>Then</b>: <span style="color:var(--accent)">${stars(reaction.satisfaction)}</span> ${esc(reaction.feeling ?? "")}<div class="muted">saw: ${esc(reaction.saw ?? "")}</div></div>` : ""}
  </div>`;
}
let lastReaction: Turn | undefined;
const showLog = () => (log.innerHTML = [...sends].reverse().map(card).join(""));

async function oneSend(): Promise<boolean> {
  setup ??= freshSetup();
  const n = sends.length + 1;
  if (n > setup.maxSends) {
    finished = "out of sends";
    return false;
  }
  status(`Send ${n}: the driver looks at the screen…`);
  const shot = await takeShot(scene, [], userView, { inkNumbers: false });
  const k = scene.width / shot.width;
  const { turn } = await span(`driver looks (send ${n})`, undefined, (ctx) => driverTurn(setup!.model, setup!.system, shot.dataUrl, past, setup!.maxSends - n + 1, k, ctx));
  // Its reaction is to the last send; the screen it saw is that send's after.
  const prev = sends.at(-1);
  if (prev) {
    prev.after = shot.dataUrl;
    Object.assign(past.at(-1)!, { satisfaction: turn.satisfaction, feeling: turn.feeling });
  }
  if (turn.stop || !turn.steps.length) {
    lastReaction = turn;
    finished = turn.stop ? "the driver stopped" : "the driver had nothing to do";
    showLog();
    return false;
  }
  const timeline = synthesize(turn.steps, setup.traits, setup.seed * 1000 + n);
  status(`Send ${n}: talking and drawing… (wants: ${turn.intent})`);
  await play(timeline, num("speed"));
  status(`Send ${n}: Enter. The product is answering…`);
  const result = await span(`send ${n}`, undefined, async (ctx) => {
    const prompt = await buildPrompt(scene, timeline.strokes, timeline.words, tuning, ctx);
    const res = await run(scene, prompt, tuning, () => draw(), undefined, undefined, ctx);
    return { prompt, res };
  });
  ink!.replaceChildren();
  draw();
  sends.push({ n, turn, timeline, transcript: result.prompt.transcript, result: result.res, before: shot.dataUrl });
  past.push({ said: timeline.spoken, drew: turn.steps.filter((s) => "draw" in s).map((s) => describeStep(s)), intent: turn.intent });
  showLog();
  $<HTMLButtonElement>("#save").disabled = false;
  return !result.res.error;
}

async function go(once: boolean) {
  if (busy) return;
  busy = true;
  stopAsked = false;
  $("#errors").textContent = "";
  for (const id of ["run", "step", "reset"]) $<HTMLButtonElement>(`#${id}`).disabled = true;
  $<HTMLButtonElement>("#stop").disabled = once;
  try {
    while ((await oneSend()) && !once && !stopAsked);
  } catch (err) {
    $("#errors").textContent = err instanceof Error ? err.message : String(err);
  }
  status(finished ? `Finished: ${finished}.` : `Paused after send ${sends.length}.`);
  $("#caption").textContent = "";
  busy = false;
  for (const id of ["run", "step", "reset"]) $<HTMLButtonElement>(`#${id}`).disabled = false;
  $<HTMLButtonElement>("#stop").disabled = true;
}

function reset() {
  scene = runScript(fixtures[$<HTMLSelectElement>("#fixture").value]).scene;
  past = [];
  sends = [];
  setup = undefined;
  finished = "";
  lastReaction = undefined;
  ink!.replaceChildren();
  log.innerHTML = "";
  $("#caption").textContent = "";
  $<HTMLButtonElement>("#save").disabled = true;
  status("Pick a driver and press Run.");
  draw();
}

$("#run").addEventListener("click", () => void go(false));
$("#step").addEventListener("click", () => void go(true));
$("#stop").addEventListener("click", () => {
  stopAsked = true;
  $<HTMLButtonElement>("#stop").disabled = true;
});
$("#reset").addEventListener("click", reset);
$("#fixture").addEventListener("change", () => !sends.length && reset());
$("#save").addEventListener("click", () => {
  const record = {
    meta: { kind: "driver-session", at: new Date().toISOString(), tuningId: tuningId(tuning), ...setup, system: undefined, finished },
    system: setup?.system,
    sends: sends.map((s) => ({ n: s.n, intent: s.turn.intent, steps: s.turn.steps, spoken: s.timeline.spoken, words: s.timeline.words, strokes: s.timeline.strokes, transcript: s.transcript, ops: s.result.ops, reply: s.result.reply, ms: s.result.ms, firstOpMs: s.result.firstOpMs, error: s.result.error, satisfaction: s.n < sends.length ? sends[s.n].turn.satisfaction : lastReaction?.satisfaction, feeling: s.n < sends.length ? sends[s.n].turn.feeling : lastReaction?.feeling })),
  };
  download(`driver-${setup?.persona}-${setup?.seed}-${record.meta.at.slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(record, null, 1));
});

fontsReady().then(draw);
