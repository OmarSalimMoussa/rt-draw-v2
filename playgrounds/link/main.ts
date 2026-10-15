// Ink ↔ words playground: talk while you draw (Scribe, as on the Speech page)
// and see [ink n] land at the word you were saying.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import { HitIndex } from "../../src/core/hittest.ts";
import { type Stroke, attachInk, strokePath } from "../../src/core/ink.ts";
import { makeSet } from "../../src/core/labels.ts";
import { Mic, ScribeEngine } from "../../src/core/speech.ts";
import { type Link, type Word, linkInk, withMarkers } from "../../src/core/link.ts";
import { groupStrokes, kindLabel, markKey, readMark } from "../../src/core/marks.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { DEFAULTS, type Tuning, tuningId } from "../../src/core/tuning.ts";
import { $, download, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("link", "Press Talk, then say what you want while you draw: \"make this bigger\" as you circle something. Your words come back from Scribe with their times, on the same clock as the pen, and the transcript shows [ink n] at the word each mark goes with. Demo plays a ready-made session for free.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const { scene } = runScript(clowns);
const INK = "#e03131";

$("#side").innerHTML = `
  <div class="card">
    <h2>Words</h2>
    <div class="row"><button class="primary" id="talk">Talk (Scribe, paid)</button><button id="demo">Demo</button><button id="clear">Clear</button><button id="save">Save set</button></div>
    <div class="muted" id="interim" style="font:17px Excalifont, cursive;min-height:24px"></div>
    <div class="stat" id="stat"></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card"><h2>Transcript</h2><div id="text" style="font:19px/1.6 Excalifont, cursive"></div></div>
  <div class="card"><h2>Links</h2><table class="marks"><thead><tr><th>ink</th><th>linked to</th><th>you say</th></tr></thead><tbody id="rows"></tbody></table></div>`;

let strokes: Stroke[] = [];
let words: Word[] = [];
/** Your corrections: mark (its stroke ids) → word index. */
let labels = new Map<string, number>();
let tuning: Tuning = DEFAULTS;
let index: HitIndex;
let epoch = performance.now();
let detach = attachInk(ink!, onStroke, { epoch, color: INK });

function onStroke(s: Stroke) {
  strokes.push(s);
  update();
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function update() {
  const marks = groupStrokes(strokes, tuning);
  const { links } = linkInk(words, marks, tuning);
  const readings = index ? marks.map((m) => readMark(m, index, tuning)) : [];
  const highlight = new Map<string, string>();
  readings.forEach((r) => r.targets.forEach((id) => highlight.set(id, "#1971c2")));
  render(canvas, scene, { highlight, tags: true });

  // Mark numbers on the ink layer.
  ink!.querySelectorAll(".anno").forEach((t) => t.remove());
  for (const m of marks) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    for (const [k, v] of Object.entries({ x: m.box.x + m.box.w + 6, y: m.box.y + 4, "font-size": 24, "font-family": "Excalifont, cursive", fill: "#1971c2" })) t.setAttribute(k, String(v));
    t.classList.add("anno");
    t.textContent = String(m.n);
    ink!.append(t);
  }

  // What you corrected wins in the transcript, so it reads as what you meant.
  const shown: Pick<Link, "n" | "word">[] = links.map((l, i) => ({ n: l.n, word: labels.get(markKey(marks[i])) ?? l.word }));
  $("#text").innerHTML = words.length || marks.length ? esc(withMarkers(words, shown)).replace(/\[ink (\d+)\]/g, '<b style="color:#e03131">[ink $1]</b>') : '<span class="muted">nothing yet</span>';

  let right = 0;
  let judged = 0;
  $("#rows").innerHTML = links
    .map((l, i) => {
      const m = marks[i];
      const want = labels.get(markKey(m));
      if (want !== undefined) {
        judged++;
        if (want === l.word) right++;
      }
      const tick = want === undefined ? "" : want === l.word ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
      const w = words[l.word];
      const reading = readings[i] ? `<div class="muted">${kindLabel(readings[i])}${readings[i].targets.length ? ` → ${readings[i].targets.join(", ")}` : ""}</div>` : "";
      const options = words.map((x, j) => `<option value="${j}"${j === (want ?? -2) ? " selected" : ""}>${j}: ${esc(x.word)}</option>`).join("");
      return `<tr><td><b>${l.n}</b>${reading}</td><td>${w ? `<b>"${esc(w.word)}"</b> ${l.offsetMs > 0 ? "+" : ""}${l.offsetMs} ms` : "-"} ${tick}<div class="muted">${esc(l.why)}</div><div class="muted stat">${esc(String(l.features.considered || "no candidates"))}</div></td><td><select data-key="${markKey(m)}"><option value="">(looks right)</option>${options}</select></td></tr>`;
    })
    .join("");
  $("#stat").textContent = `${words.length} words · ${marks.length} marks from ${strokes.length} strokes${judged ? ` · links ${right} / ${judged} right` : ""}`;
}

$("#rows").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (sel.value === "") labels.delete(sel.dataset.key!);
  else labels.set(sel.dataset.key!, Number(sel.value));
  update();
});

// Talking: Scribe's words come on the page clock; strokes count from `epoch`, so words are moved onto that.
const mic = new Mic();
let engine: ScribeEngine | undefined;
let talking = false;
async function talk() {
  clear();
  $("#errors").textContent = "";
  engine = new ScribeEngine(
    {
      onInterim: (text) => ($("#interim").textContent = text),
      onFinal: (u) => {
        $("#interim").textContent = "";
        words.push(...u.words.map((w) => ({ word: w.word, t0: Math.round(w.t0 - epoch), t1: Math.round(w.t1 - epoch) })));
        update();
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
  $("#talk").textContent = "Stop";
}
async function stopTalking() {
  talking = false;
  $("#talk").textContent = "Finishing…";
  await engine?.stop();
  mic.stop();
  $("#talk").textContent = "Talk (Scribe, paid)";
}
$("#talk").addEventListener("click", () => void (talking ? stopTalking() : talk()));

function clear() {
  strokes = [];
  words = [];
  labels = new Map();
  ink!.replaceChildren();
  // A fresh clock, so new words and strokes start together.
  detach();
  epoch = performance.now();
  detach = attachInk(ink!, onStroke, { epoch, color: INK });
  update();
}
$("#clear").addEventListener("click", clear);

/** A scripted session: words and strokes with their times, drawn as if live. */
async function demo() {
  if (talking) await stopTalking();
  clear();
  const said = "make this toy a bit bigger and draw an arrow from the photo to that one over there".split(" ");
  // About 280 ms a word, starting at 300 ms.
  const script: Word[] = said.map((w, i) => ({ word: w, t0: 300 + i * 280, t1: 300 + i * 280 + 220 }));
  const pts = (list: [number, number][], t0: number, msEach = 12) => list.map(([x, y], i) => [x, y, t0 + i * msEach] as [number, number, number]);
  const loop = (cx: number, cy: number, r: number) => Array.from({ length: 34 }, (_, i) => [cx + r * Math.cos((i / 30) * 2 * Math.PI), cy + r * Math.sin((i / 30) * 2 * Math.PI)] as [number, number]);
  const line = (x1: number, y1: number, x2: number, y2: number, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n] as [number, number]);
  const mk = (id: number, p: [number, number, number][]): Stroke => ({ id, points: p, t0: p[0][2], t1: p.at(-1)![2] });
  // "this" is word 1 (~580 ms); "photo" 11 (~3380 ms); "that" 13 (~3940 ms); "there" 17 (~5060 ms).
  const demoStrokes = [
    mk(1, pts(loop(100, 160, 78), 520)),
    mk(2, pts(line(640, 300, 1160, 420), 3300)),
    mk(3, pts([...line(1130, 395, 1160, 420, 5), ...line(1160, 420, 1125, 440, 5)], 3780)),
    mk(4, pts([[1180, 560], [1181, 561]], 5000, 40)),
  ];
  words = script;
  strokes = demoStrokes;
  ink!.replaceChildren(...strokes.map((s) => {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", strokePath(s.points));
    p.setAttribute("fill", INK);
    p.dataset.stroke = String(s.id);
    return p;
  }));
  update();
}
$("#demo").addEventListener("click", () => void demo());

$("#save").addEventListener("click", () => {
  const marks = groupStrokes(strokes, tuning);
  const { links } = linkInk(words, marks, tuning);
  const said = words.map((w) => `${w.word}@${Math.round(w.t0)}`).join(" ");
  const examples = links.map((l, i) => {
    const want = labels.get(markKey(marks[i]));
    return { decision: "link.word", strokes: marks[i].strokes, predicted: String(l.word), features: { ...l.features, offsetMs: l.offsetMs, words: said }, label: String(want ?? l.word), corrected: want !== undefined };
  });
  download(`link-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(makeSet("playground", "clowns", tuning, tuningId(tuning), examples), null, 1));
});

tuningPanel($("#side"), ["link", "marks", "speech"], (t) => {
  tuning = t;
  update();
});

fontsReady().then(() => {
  index = new HitIndex(scene);
  update();
});
