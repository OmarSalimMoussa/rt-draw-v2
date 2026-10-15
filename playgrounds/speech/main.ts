// Speech playground: talk, and each word lands on the waveform at the time you
// said it. Click a word to hear its slice; check the times by ear and by eye.
import { Mic, ScribeEngine, type SpeechEvents, type Utterance, scribeWord } from "../../src/core/speech.ts";
import { DEFAULTS, type Tuning, patchValue, patching, tuningId } from "../../src/core/tuning.ts";
import { $, download, shell, tuningPanel } from "../../src/ui.ts";

shell("speech", "Talk and watch your words land on the waveform at the moment you said them. Click a word to hear just that slice. Words and times come from ElevenLabs Scribe, which costs a little per minute of listening.");

/** Waveform scale: pixels per second of audio. */
const PX_PER_S = 120;
const LANE_H = 140;

$("#left").innerHTML = `
  <div class="card">
    <h2>Waveform</h2>
    <div id="scroll" style="overflow-x:auto;border:1.5px solid var(--ink);border-radius:10px;background:#fff">
      <div id="track" style="position:relative;height:${LANE_H + 92}px;min-width:100%">
        <canvas id="wave" height="${LANE_H}" style="display:block"></canvas>
        <div id="hover" style="position:absolute;top:0;height:${LANE_H}px;background:#e0313122;border-left:1.5px solid #e03131;border-right:1.5px solid #e03131;display:none;pointer-events:none"></div>
        <div id="words"></div>
      </div>
    </div>
    <div class="muted" id="interim" style="font:20px Excalifont, cursive;min-height:30px"></div>
  </div>
  <div class="card"><h2>Utterances</h2><table class="marks"><thead><tr><th>said</th><th>words</th><th>wait after you stopped</th></tr></thead><tbody id="rows"></tbody></table></div>`;

$("#side").innerHTML = `
  <div class="card">
    <h2>Listen</h2>
    <div class="row"><button class="primary" id="go">Start talking</button><button id="save">Save words</button></div>
    <div class="stat" id="stat">Not listening.</div>
    <pre class="log bad" id="errors"></pre>
  </div>`;

let tuning: Tuning = DEFAULTS;
const live = () => tuning;
tuningPanel($("#side"), ["speech"], (t) => {
  tuning = t;
  // Words are re-placed from Scribe's own times under the new knobs.
  utterances = utterances.map((u) => ({ ...u, words: u.words.map((w) => (w.raw ? scribeWord(w.word, w.raw[0], w.raw[1], mic, live()) : w)) }));
  draw();
});

let utterances: Utterance[] = [];
const mic = new Mic();
let engine: ScribeEngine | undefined;
let listening = false;
let timer = 0;

const events: SpeechEvents = {
  onInterim: (text) => ($("#interim").textContent = text),
  onFinal: (u) => {
    $("#interim").textContent = "";
    utterances.push(u);
    draw();
  },
  onError: (e) => ($("#errors").textContent += `${e}\n`),
};

const xOf = (ms: number) => Math.max(0, ((ms - mic.startedAt) / 1000) * PX_PER_S);

function draw() {
  const canvas = $<HTMLCanvasElement>("#wave");
  const seconds = Math.max(mic.ms / 1000, ...utterances.map((u) => (u.t1 - mic.startedAt) / 1000), 1);
  const width = Math.max($("#scroll").clientWidth, Math.ceil(seconds * PX_PER_S) + 40);
  $("#track").style.width = `${width}px`;
  canvas.width = width;
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, width, LANE_H);
  // Second ticks.
  g.fillStyle = "#6c6a64";
  g.font = "11px ui-monospace, monospace";
  for (let s = 0; s <= seconds; s++) {
    g.fillRect(s * PX_PER_S, LANE_H - 8, 1, 8);
    g.fillText(`${s}s`, s * PX_PER_S + 3, LANE_H - 2);
  }
  // Each bar is 1000 / PX_PER_S ms of audio: its loudest sample.
  const peaks = mic.peaks(1000 / PX_PER_S);
  g.fillStyle = "#1e1e1e";
  const mid = (LANE_H - 12) / 2;
  peaks.forEach((p, i) => {
    const h = Math.max(1, p * mid * 0.95);
    g.fillRect(i, mid - h, 1, h * 2);
  });

  const words = utterances.flatMap((u) => u.words);
  // Each word takes the first of three rows where it doesn't cover the word before it.
  const rowEnds = [-Infinity, -Infinity, -Infinity];
  $("#words").innerHTML = words
    .map((w, i) => {
      const left = xOf(w.t0);
      const wide = Math.max(14, xOf(w.t1) - left);
      const right = left + Math.max(wide, w.word.length * 9 + 12);
      let row = rowEnds.findIndex((end) => end <= left);
      if (row < 0) row = rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = right + 2;
      const top = LANE_H + 6 + row * 28;
      return `<span data-i="${i}" title="${w.t1 - w.t0} ms${w.raw ? ` · Scribe ${w.raw[0].toFixed(2)}-${w.raw[1].toFixed(2)} s` : ""}" style="position:absolute;left:${left}px;top:${top}px;min-width:${wide}px;padding:1px 4px;border:1.5px solid #e03131;border-radius:6px;background:#fff;font:15px Excalifont, cursive;white-space:nowrap;cursor:pointer">${w.word}</span>`;
    })
    .join("");

  $("#rows").innerHTML = utterances
    .map((u) => `<tr><td>${u.text}</td><td>${u.words.length}</td><td>${Math.round(u.finalAt - u.t1)} ms</td></tr>`)
    .join("");
  const waits = utterances.map((u) => u.finalAt - u.t1).sort((a, b) => a - b);
  $("#stat").textContent = `${listening ? "Listening" : "Not listening"} · ${(mic.ms / 1000).toFixed(1)} s recorded · ${words.length} words${waits.length ? ` · median wait ${Math.round(waits[Math.floor(waits.length / 2)])} ms` : ""} · ${patching(tuning, "scribe") ? `Scribe patched · ${tuningId(tuning)}` : "Scribe as it comes"}`;
}

$("#words").addEventListener("click", (e) => {
  const i = (e.target as HTMLElement).dataset.i;
  const w = i !== undefined && utterances.flatMap((u) => u.words)[Number(i)];
  if (w) mic.play(w.t0 - (patchValue(tuning, "speech.playBeforeMs") ?? 0), w.t1 + (patchValue(tuning, "speech.playAfterMs") ?? 0));
});
$("#words").addEventListener("mouseover", (e) => {
  const i = (e.target as HTMLElement).dataset.i;
  const w = i !== undefined && utterances.flatMap((u) => u.words)[Number(i)];
  const hover = $("#hover");
  hover.style.display = w ? "block" : "none";
  if (w) Object.assign(hover.style, { left: `${xOf(w.t0)}px`, width: `${Math.max(2, xOf(w.t1) - xOf(w.t0))}px` });
});
$("#words").addEventListener("mouseleave", () => ($("#hover").style.display = "none"));

async function start() {
  $("#errors").textContent = "";
  utterances = [];
  try {
    await mic.start();
    engine = new ScribeEngine(events, mic, live);
    await engine.start();
  } catch (err) {
    events.onError(err instanceof Error ? err.message : String(err));
    return stop();
  }
  listening = true;
  $("#go").textContent = "Stop";
  timer = window.setInterval(draw, 100);
}

async function stop() {
  listening = false;
  $("#go").textContent = "Finishing…";
  await engine?.stop();
  mic.stop();
  clearInterval(timer);
  $("#go").textContent = "Start talking";
  draw();
}

$("#go").addEventListener("click", () => void (listening ? stop() : start()));
$("#save").addEventListener("click", () =>
  download("words.json", JSON.stringify({ tuningId: tuningId(tuning), micStartedAt: mic.startedAt, utterances: utterances }, null, 1)),
);
draw();
