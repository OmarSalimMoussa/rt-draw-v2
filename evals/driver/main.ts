// Driver demo: watch a model play a user of the product. Pick who it is (and
// the site a first-timer has in mind), how messy and patient it is, and a seed.
// Each turn the driver looks at the screen, says how the last send went, then
// talks and draws (synthesized into timed words and messy ink, played back
// here), presses Enter, and the real product answers. The product is a board:
// the driver sees the screen's part of it and can scroll and zoom by hand.
import type { SendResult } from "../../src/core/draw.ts";
import { strokePath } from "../../src/core/ink.ts";
import { MODELS, type ModelName, callModel } from "../../src/core/model.ts";
import { render } from "../../src/core/render.ts";
import type { Scene } from "../../src/core/scene.ts";
import { send } from "../../src/core/send.ts";
import { takeShot } from "../../src/core/shot.ts";
import { span } from "../../src/core/trace.ts";
import { DEFAULTS, tune, tuningId } from "../../src/core/tuning.ts";
import type { View } from "../../src/core/board.ts";
import { boardStage } from "../../src/boardStage.ts";
import { $, download, fontsReady, shell } from "../../src/ui.ts";
import { FIXTURES, loadFixture } from "../fixtures/fixtures.ts";
import { DRIVE_VIEW } from "../loop/config.ts";
import type { StartId } from "../loop/types.ts";
import { type Card, type Past, type Turn, describeMarks, describeMove, describeStep, isLook, moveView, parseTurn, systemPrompt, userMessage } from "../core/driver.ts";
import { type Planned, plan } from "../core/scenarios.ts";
import { PERSONAS, STYLES, type Style, TARGETS, randomStyle } from "../core/personas.ts";
import { type Step, type Timeline, type Token, type Traits, type Voiced, isView, lineText, lines, rng, synthesize } from "../core/synth.ts";

shell("", "Driver demo: a model plays a user. It sees only its screen (part of the board), scrolls and zooms by hand, talks and scribbles (synthesized into timed words and messy ink), presses Enter, and the real product answers. Each send is a few calls on your Claude subscription: the driver, then the product (resolver, drawing model, pictures).");
// The eval's starts (evals/fixtures), their doodles baked, so a session start draws no pictures.
const st = boardStage($("#left"), loadFixture("blank").start);
const { canvas, ink } = st;
const INK = "#e03131";
const tuning = DEFAULTS;
/** What the driver sees: the screen as a user sees it (no id tags or grid), framed by the eval's DRIVE_VIEW, not the product's shot knobs. */
const userView = tune({ "shot.tagPx": 0, "shot.gridCellPx": 0, "shot.jpegQuality": DRIVE_VIEW.jpegQuality, "ink.size": DRIVE_VIEW.inkSize }, tuning);
const screenW = DRIVE_VIEW.screenW;

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
    <select id="persona">${PERSONAS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}<option value="random">Who: random from the seed</option></select>
    <select id="target">${TARGETS.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}<option value="random">Site: random from the seed</option></select>
    <select id="style">${STYLES.map((x) => `<option value="${x.id}">${x.name}</option>`).join("")}<option value="random">How: random from the seed</option><option value="custom">Custom (the sliders)</option></select>
    ${slider("words", "how much they say", 0.5)}
    ${slider("clarity", "how clearly they describe", 0.5)}
    ${slider("pen", "uses the marker", 0.5)}
    ${slider("mess", "messy ink", 0.5)}
    ${slider("disfluency", "ums and restarts", 0.5)}
    ${slider("patience", "patience", 0.5)}
    ${slider("changeMind", "changes their mind", 0.3)}
    <label style="font-size:12px"><input type="checkbox" id="bigThenSmall"> asks for too much, then tones it down</label>
    <div class="row" style="font-size:12px">seed <input id="seed" type="number" value="1" style="width:70px"><button id="dice" title="a new seed">🎲</button> sends <input id="maxSends" type="number" min="1" max="20" value="6" style="width:50px"></div>
    <div class="row" style="font-size:12px">driver model <select id="model">${MODELS.map((m) => `<option${m === "sonnet" ? " selected" : ""}>${m}</option>`).join("")}</select> start <select id="fixture">${FIXTURES.map((f) => `<option>${f.id}</option>`).join("")}</select></div>
    <div class="row" style="font-size:12px">playback <select id="speed"><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="0">instant</option></select><button id="voice" title="Speaks the driver's lines with ElevenLabs (eleven_v4), paid per character; each line is bought once and kept in .data/tts/. Its words then time the ink and the transcript. Off by default: it costs money.">voice: off</button><select id="voiceName"><option value="will">Will</option><option value="sarah">Sarah</option></select></div>
    <div class="muted stat" id="voiceStat"></div>
    <div class="row"><button class="primary" id="run">Run</button><button id="step">One send</button><button id="stop" disabled>Stop after this send</button></div>
    <div class="row"><button id="reset">Reset</button><button id="save" disabled>Download the session record</button></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card"><h2>What the driver is told</h2><div class="stat" id="who">Set when a run starts.</div><details><summary class="muted">system prompt (fixed for the run)</summary><pre class="log" id="sys"></pre></details><div class="muted stat">It never sees our prompts, ops, knobs or code. Its last reply is in Model calls.</div></div>`;

const TRAITS = ["words", "clarity", "pen", "mess", "disfluency", "patience", "changeMind"] as const;
for (const id of TRAITS)
  $(`#${id}`).addEventListener("input", () => {
    $(`[data-for="${id}"]`).textContent = $<HTMLInputElement>(`#${id}`).value;
    // Moving a slider by hand makes the style a custom one.
    $<HTMLSelectElement>("#style").value = "custom";
  });
/** Puts a style on the sliders. */
function showStyle(st: Style) {
  for (const id of TRAITS) {
    $<HTMLInputElement>(`#${id}`).value = String(st[id]);
    $(`[data-for="${id}"]`).textContent = String(st[id]);
  }
  $<HTMLInputElement>("#bigThenSmall").checked = st.bigThenSmall;
}
$("#style").addEventListener("change", () => {
  const preset = STYLES.find((x) => x.id === $<HTMLSelectElement>("#style").value);
  if (preset) showStyle(preset.style);
});
const syncTarget = () => ($<HTMLSelectElement>("#target").disabled = !["first-timer", "random"].includes($<HTMLSelectElement>("#persona").value));
$("#persona").addEventListener("change", syncTarget);
syncTarget();
$("#dice").addEventListener("click", () => ($<HTMLInputElement>("#seed").value = String(Math.floor(Math.random() * 10000))));

type Record_ = {
  n: number; turn: Turn; timeline: Timeline; transcript: string; result: SendResult; pics?: { drawn: number; failed: string[]; ms: number }; before: string; after?: string;
  /** View moves by hand before this send, the camera at Enter, the pictures the product sent its model. */
  looks: string[]; camera: View; views: string;
  /** The driver's rating of this send, from the first turn after it that gives one (a look turn too). */
  rating?: { satisfaction: number; feeling?: string; saw?: string };
};
let scene: Scene = loadFixture("blank").scene;
let past: Past[] = [];
let sends: Record_[] = [];
let setup: { persona: string; target?: string; style: string; traits: Traits; card: Card; plans: Planned[]; seed: number; maxSends: number; model: ModelName; system: string; fixture: string } | undefined;
/** The screen at the last Enter with the ink, the driver's "before" picture. */
let lastEnter: string | undefined;
let stopAsked = false;
let voiceOn = false;
const spent = { bought: 0, cached: 0 };
let busy = false;
let finished = "";

const draw = () => render(canvas, scene, { tuning, view: st.view() });
const status = (s: string) => ($("#status").textContent = s);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const num = (id: string) => Number($<HTMLInputElement>(`#${id}`).value);
const stars = (n?: number) => (n ? `${"★".repeat(n)}${"☆".repeat(5 - n)}` : "");

function freshSetup() {
  // Anything set to random is drawn from the seed (its own stream), so a seed always gives the same driver.
  const pick = rng(num("seed") ^ 0x2f6b9a1d);
  const choose = <T,>(list: T[]) => list[Math.floor(pick() * list.length)];
  const personaId = $<HTMLSelectElement>("#persona").value;
  const persona = personaId === "random" ? choose(PERSONAS) : PERSONAS.find((p) => p.id === personaId)!;
  const targetId = $<HTMLSelectElement>("#target").value;
  const target = persona.id === "first-timer" ? (targetId === "random" ? choose(TARGETS) : TARGETS.find((t) => t.id === targetId)) : undefined;
  if ($<HTMLSelectElement>("#style").value === "random") showStyle(randomStyle(pick));
  const style: Style = { mess: num("mess"), disfluency: num("disfluency"), words: num("words"), clarity: num("clarity"), pen: num("pen"), patience: num("patience"), changeMind: num("changeMind"), bigThenSmall: $<HTMLInputElement>("#bigThenSmall").checked };
  // One shared system prompt; who and how go in each turn's message, with the seed's ask type and beat per send.
  const system = systemPrompt();
  const styleId = STYLES.find((x) => x.id === $<HTMLSelectElement>("#style").value)?.id ?? "typical";
  const start = $<HTMLSelectElement>("#fixture").value as StartId;
  const plans = plan({ id: "demo", set: "fresh", persona: persona.id, style: styleId, target: target?.id, start, sends: Math.max(1, num("maxSends")), seed: num("seed") });
  $("#sys").textContent = system;
  const styleName = STYLES.find((x) => x.id === $<HTMLSelectElement>("#style").value)?.name.split(":")[0] ?? $<HTMLSelectElement>("#style").value;
  $("#who").textContent = `${persona.name}${target ? ` · ${target.name}` : ""} · ${styleName} · ${TRAITS.map((id) => `${id} ${num(id)}`).join(" · ")}${style.bigThenSmall ? " · big then small" : ""}`;
  return { persona: persona.id, target: target?.id, style: $<HTMLSelectElement>("#style").value, traits: { mess: num("mess"), disfluency: num("disfluency") }, card: { persona, style, target }, plans, seed: num("seed"), maxSends: Math.max(1, num("maxSends")), model: $<HTMLSelectElement>("#model").value as ModelName, system, fixture: $<HTMLSelectElement>("#fixture").value };
}

/** Each say step's line spoken by the voice (ElevenLabs, via the dev server), with its word times. */
async function speak(said: Map<number, Token[]>, voice: string) {
  const voiced = new Map<number, Voiced>();
  const audio = new Map<number, HTMLAudioElement>();
  await Promise.all(
    [...said].map(async ([i, toks]) => {
      const text = lineText(toks);
      if (!text) return;
      const r = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }) });
      const j = (await r.json()) as { audio: string; words: { start: number; end: number }[]; cached: boolean; chars: number; error?: string };
      if (!r.ok) throw new Error(j.error ?? `voice: HTTP ${r.status}`);
      spent[j.cached ? "cached" : "bought"] += j.chars;
      const a = new Audio(`data:audio/mpeg;base64,${j.audio}`);
      await new Promise((ok) => {
        a.onloadedmetadata = ok;
        a.onerror = ok;
      });
      const last = j.words.at(-1)?.end ?? 0;
      voiced.set(i, { words: j.words, ms: Math.round((Number.isFinite(a.duration) ? a.duration : last) * 1000) });
      audio.set(i, a);
    }),
  );
  $("#voiceStat").textContent = `voice this run: ${spent.bought} characters bought, ${spent.cached} replayed from the cache`;
  return { voiced, audio };
}

/** Plays the person's words, ink and view moves on the stage, on their own clock (speed 0: all at once), with the voice's audio when there is some. */
async function play(tl: Timeline, speed: number, audio = new Map<number, HTMLAudioElement>()): Promise<void> {
  ink!.replaceChildren();
  // Each move from where the last one left the camera.
  let v = st.view();
  const views = tl.moves.map((m) => (v = moveView(m.move, v)));
  const moved = new Set<number>();
  const glide = (t: number) => tl.moves.forEach((m, i) => {
    if (moved.has(i) || t < m.at) return;
    moved.add(i);
    void st.setView(views[i], speed ? m.ms / speed : 0);
  });
  await playOn(tl, speed, audio, glide);
  // Settled where the hand left it before Enter.
  if (views.length) await st.setView(views.at(-1)!);
}

function playOn(tl: Timeline, speed: number, audio: Map<number, HTMLAudioElement>, glide: (t: number) => void): Promise<void> {
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
  if (!speed) return Promise.resolve((glide(Number.POSITIVE_INFINITY), show(Number.POSITIVE_INFINITY)));
  const start = performance.now();
  const started = new Set<number>();
  return new Promise((done) => {
    const frame = () => {
      const t = (performance.now() - start) * speed;
      show(t);
      glide(t);
      for (const c of tl.clips) {
        const a = audio.get(c.step);
        if (!a || started.has(c.step) || t < c.at) continue;
        started.add(c.step);
        a.playbackRate = speed;
        a.preservesPitch = true;
        void a.play().catch(() => {});
      }
      const talking = [...started].some((i) => !audio.get(i)!.ended && !audio.get(i)!.paused);
      if (t >= tl.ms + 200 && !talking) done();
      else requestAnimationFrame(frame);
    };
    frame();
  });
}

function card(r: Record_) {
  const t = r.turn;
  const ok = r.result.ops.filter((o) => o.ok).length;
  const bad = r.result.ops.length - ok;
  return `<div class="card" data-n="${r.n}">
    <h2>Send ${r.n}</h2>
    ${r.looks.length ? `<div><b>Looked around first</b>: ${esc(r.looks.join(" → "))}</div>` : ""}
    <div><b>Wants</b> <span class="muted">(private)</span>: ${esc(t.meant)}</div>
    <div><b>Says</b>: <span style="font:18px Excalifont, cursive">${esc(r.timeline.spoken || "(nothing)")}</span></div>
    <div><b>Does</b>: ${t.steps.map((s) => esc(describeStep(s as Step))).join(" → ")}</div>
    <div class="stat muted">the product got: ${esc(r.transcript || "(no words)")} · pictures: ${esc(r.views || "none")}</div>
    <div class="stat">${r.result.error ? `<span class="bad">✗ ${esc(r.result.error)}</span>` : `${ok} ops applied${bad ? `, <span class="bad">${bad} failed</span>` : ""} · first op ${r.result.firstOpMs ?? "-"} ms · done ${r.result.ms} ms`}${r.pics?.drawn || r.pics?.failed.length ? ` · ${r.pics.drawn} picture${r.pics.drawn === 1 ? "" : "s"} in ${r.pics.ms} ms${r.pics.failed.length ? ` <span class="bad">(${r.pics.failed.length} failed)</span>` : ""}` : ""}</div>
    <div class="row" style="align-items:start"><figure style="margin:0;flex:1"><img src="${r.before}" style="width:100%;border:1px solid var(--line);border-radius:6px"><figcaption class="muted stat">before</figcaption></figure>${r.after ? `<figure style="margin:0;flex:1"><img src="${r.after}" style="width:100%;border:1px solid var(--line);border-radius:6px"><figcaption class="muted stat">after</figcaption></figure>` : ""}</div>
    ${r.rating ? `<div><b>Then</b>: <span style="color:var(--accent)">${stars(r.rating.satisfaction)}</span> ${esc(r.rating.feeling ?? "")}<div class="muted">saw: ${esc(r.rating.saw ?? "")}</div></div>` : ""}
  </div>`;
}
const showLog = () => (log.innerHTML = [...sends].reverse().map(card).join(""));

async function oneSend(): Promise<boolean> {
  setup ??= freshSetup();
  const n = sends.length + 1;
  if (n > setup.maxSends) {
    finished = "out of sends";
    return false;
  }
  // Turns of only moving the view by hand come first, until the driver acts (or has looked enough).
  const looks: string[] = [];
  let shot: Awaited<ReturnType<typeof takeShot>>;
  let turn: Turn;
  for (let look = 0; ; look++) {
    status(`Send ${n}: the driver looks at the screen…`);
    const v = st.view();
    shot = await takeShot(scene, [], userView, { inkNumbers: false, view: v, width: screenW });
    const planned = setup.plans[n - 1];
    const user = userMessage(setup.card, past, planned?.beat, planned?.ask ?? "add", setup.maxSends - n + 1, looks);
    const { text } = await span(`driver looks (send ${n}${look ? `, look ${look + 1}` : ""})`, undefined, (ctx) => callModel({ model: setup!.model, system: setup!.system, user, images: [lastEnter ?? shot.dataUrl, shot.dataUrl], from: "driver" }, undefined, undefined, ctx));
    ({ turn } = parseTurn(text, v));
    // The first screen it saw after the last send is that send's after; its rating lands on that send, from whichever turn gives it (harness-7).
    const prev = sends.at(-1);
    if (prev && !prev.after) prev.after = shot.dataUrl;
    if (prev && !prev.rating && turn.satisfaction) {
      prev.rating = { satisfaction: turn.satisfaction, feeling: turn.feeling, saw: turn.saw };
      Object.assign(past.at(-1)!, { satisfaction: turn.satisfaction, feeling: turn.feeling });
    }
    if (turn.stop || !turn.steps.length) {
      finished = turn.stop ? "the driver stopped" : "the driver had nothing to do";
      showLog();
      return false;
    }
    if (!isLook(turn)) break;
    if (look >= DRIVE_VIEW.maxLooks) {
      finished = "the driver only looked around";
      showLog();
      return false;
    }
    status(`Send ${n}: the driver moves the view…`);
    looks.push(turn.steps.flatMap((x) => (isView(x) || "undo" in x ? [describeMove(x, v)] : [])).join(", "));
    await play(synthesize(turn.steps, setup.traits, setup.seed * 1000 + n * 10 + look, { view: v }), num("speed"));
  }
  const seed = setup.seed * 1000 + n;
  let spoken: Awaited<ReturnType<typeof speak>> | undefined;
  if (voiceOn && num("speed")) {
    status(`Send ${n}: finding the driver's voice…`);
    spoken = await speak(lines(turn.steps, setup.traits, seed), $<HTMLSelectElement>("#voiceName").value).catch((err) => {
      $("#errors").textContent = `${err instanceof Error ? err.message : String(err)} (playing silently)`;
      return undefined;
    });
  }
  const drawnOn = st.view();
  const timeline = synthesize(turn.steps, setup.traits, seed, { view: drawnOn, voiced: spoken?.voiced });
  status(`Send ${n}: talking and drawing… (wants: ${turn.meant})`);
  await play(timeline, num("speed"), spoken?.audio);
  status(`Send ${n}: Enter. The product is answering…`);
  const camera = st.view();
  lastEnter = (await takeShot(scene, timeline.strokes, userView, { inkNumbers: false, view: camera, width: screenW })).dataUrl;
  // The product's own send (src/core/send.ts), done once its pictures are drawn: the driver looks at what a user would see.
  const result = await span(`send ${n}`, undefined, (ctx) =>
    send(scene, { strokes: timeline.strokes, words: timeline.words }, tuning, { draw, setView: st.setView, onReply: () => status(`Send ${n}: finishing the pictures…`), parent: ctx }, camera),
  );
  ink!.replaceChildren();
  draw();
  sends.push({ n, turn, timeline, transcript: result.prompt.transcript, result: result.result, pics: result.pics, before: shot.dataUrl, looks, camera, views: result.prompt.features.views });
  past.push({ said: timeline.spoken, marks: describeMarks(turn.steps, drawnOn), meant: turn.meant });
  showLog();
  $<HTMLButtonElement>("#save").disabled = false;
  return !result.result.error;
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
  const f = loadFixture($<HTMLSelectElement>("#fixture").value as StartId);
  scene = f.scene;
  past = [];
  lastEnter = undefined;
  sends = [];
  setup = undefined;
  finished = "";
  ink!.replaceChildren();
  log.innerHTML = "";
  $("#caption").textContent = "";
  $<HTMLButtonElement>("#save").disabled = true;
  status("Pick a driver and press Run.");
  void st.setView(f.start);
  draw();
}

$("#voice").addEventListener("click", () => {
  voiceOn = !voiceOn;
  $("#voice").textContent = `voice: ${voiceOn ? "on" : "off"}`;
  $("#voice").classList.toggle("primary", voiceOn);
});
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
    sends: sends.map((s) => ({ n: s.n, looks: s.looks, camera: s.camera, views: s.views, cameraOps: s.result.ops.filter((o) => o.camera).map((o) => o.line), meant: s.turn.meant, steps: s.turn.steps, spoken: s.timeline.spoken, words: s.timeline.words, strokes: s.timeline.strokes, transcript: s.transcript, ops: s.result.ops, reply: s.result.reply, ms: s.result.ms, firstOpMs: s.result.firstOpMs, error: s.result.error, rating: s.rating })),
  };
  download(`driver-${setup?.persona}-${setup?.seed}-${record.meta.at.slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(record, null, 1));
});

fontsReady().then(draw);
