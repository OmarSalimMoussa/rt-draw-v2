// Coordinates playground: drag a box (or click a point) and see how each scheme
// would name it, what it costs, and where its name reads back to.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import { type Naming, SCHEMES, type Scheme, error, name, read } from "../../src/core/coords.ts";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import type { Box } from "../../src/core/scene.ts";
import { DEFAULTS, type Tuning } from "../../src/core/tuning.ts";
import { $, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("coords", "Drag a box or click a point on the page. Each scheme writes the place its own way; its name is read back (dashed) and the gap from your box is the error. Random 50 compares the schemes on many boxes at once.");
const { canvas, ink } = stage($("#left"), 1280, 800, true);
const { scene } = runScript(clowns);
const COLORS: Record<Scheme, string> = { pixels: "#1971c2", cells: "#2b8a3e", relative: "#e8590c", percent: "#9c36b5" };
const NS = "http://www.w3.org/2000/svg";

$("#side").innerHTML = `
  <div class="card">
    <h2>Your place</h2>
    <div class="stat" id="place">Drag a box or click a point.</div>
    <table class="marks"><thead><tr><th>show</th><th>scheme</th><th>name</th><th>tokens</th><th>error</th></tr></thead><tbody id="rows"></tbody></table>
  </div>
  <div class="card">
    <h2>Compare</h2>
    <div class="row"><button id="random">Random 50</button><span class="stat" id="seed"></span></div>
    <table class="marks"><thead><tr><th>scheme</th><th>mean error</th><th>max error</th><th>mean tokens</th><th>unreadable</th></tr></thead><tbody id="compare"></tbody></table>
  </div>`;

let tuning: Tuning = DEFAULTS;
let place: Box | undefined;
/** Which scheme's read-back is shown; all of them when none is picked. */
let only: Scheme | undefined;
let seed = 0;

const el = (tag: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** Read a name back, or say why it can't be. */
function readBack(n: Naming): Box | string {
  try {
    return read(n.scheme, n.text, scene, tuning);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function drawBox(b: Box, color: string, dashed: boolean) {
  if (b.w === 0 && b.h === 0) ink!.append(el("circle", { cx: b.x, cy: b.y, r: dashed ? 9 : 5, fill: dashed ? "none" : color, stroke: color, "stroke-width": 2.5, "stroke-dasharray": dashed ? "5 4" : "" }));
  else ink!.append(el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: dashed ? "none" : `${color}22`, stroke: color, "stroke-width": dashed ? 2.5 : 3, "stroke-dasharray": dashed ? "8 5" : "" }));
}

function update() {
  render(canvas, scene, { tags: true, grid: only === "cells" ? tuning["coords.cellPx"] : undefined });
  ink!.replaceChildren();
  if (!place) {
    $("#rows").innerHTML = "";
    return;
  }
  drawBox(place, "#e03131", false);
  const names = name(place, scene, tuning);
  $("#rows").innerHTML = names
    .map((n) => {
      const back = readBack(n);
      const shown = !only || only === n.scheme;
      if (shown && typeof back !== "string") drawBox(back, COLORS[n.scheme], true);
      const err = typeof back === "string" ? `<span class="bad">${back}</span>` : `${error(place!, back).toFixed(1)} px`;
      const feats = Object.entries(n.features).map(([k, v]) => `${k} ${v}`).join(" · ");
      return `<tr><td><input type="radio" name="only" value="${n.scheme}"${only === n.scheme ? " checked" : ""}></td><td><b style="color:${COLORS[n.scheme]}">${n.scheme}</b></td><td><code>${n.text}</code><div class="muted">${feats}</div></td><td>${n.tokens}</td><td>${err}</td></tr>`;
    })
    .join("") + `<tr><td><input type="radio" name="only" value=""${only ? "" : " checked"}></td><td colspan="4" class="muted">show all</td></tr>`;
  const r = (v: number) => Math.round(v);
  $("#place").textContent = place.w || place.h ? `box ${r(place.x)} ${r(place.y)} ${r(place.w)} × ${r(place.h)}` : `point ${r(place.x)}, ${r(place.y)}`;
}

$("#rows").addEventListener("change", (e) => {
  only = ((e.target as HTMLInputElement).value || undefined) as Scheme | undefined;
  update();
});

// Drag a box; a click (under 4 px of drag) is a point.
let start: [number, number] | undefined;
const toCanvas = (e: PointerEvent): [number, number] => {
  const p = ink!.createSVGPoint();
  p.x = e.clientX;
  p.y = e.clientY;
  const q = p.matrixTransform(ink!.getScreenCTM()!.inverse());
  return [q.x, q.y];
};
const boxFrom = (a: [number, number], b: [number, number]): Box => {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) return { x: a[0], y: a[1], w: 0, h: 0 };
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
};
ink!.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  ink!.setPointerCapture(e.pointerId);
  start = toCanvas(e);
});
ink!.addEventListener("pointermove", (e) => {
  if (!start) return;
  place = boxFrom(start, toCanvas(e));
  update();
});
ink!.addEventListener("pointerup", (e) => {
  if (!start) return;
  place = boxFrom(start, toCanvas(e));
  start = undefined;
  update();
});

/** A small seeded random, so a run can be repeated. */
function rng(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** 50 places (one in ten a point), named and read back by every scheme. */
function compare() {
  const rand = rng(++seed);
  const places: Box[] = Array.from({ length: 50 }, () => {
    if (rand() < 0.1) return { x: rand() * scene.width, y: rand() * scene.height, w: 0, h: 0 };
    const w = 20 + rand() * 360;
    const h = 20 + rand() * 240;
    return { x: rand() * (scene.width - w), y: rand() * (scene.height - h), w, h };
  });
  const stats = new Map<Scheme, { errs: number[]; tokens: number[]; bad: number }>(SCHEMES.map((s) => [s, { errs: [], tokens: [], bad: 0 }]));
  for (const p of places) {
    for (const n of name(p, scene, tuning)) {
      const s = stats.get(n.scheme)!;
      s.tokens.push(n.tokens);
      const back = readBack(n);
      if (typeof back === "string") s.bad++;
      else s.errs.push(error(p, back));
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  $("#compare").innerHTML = SCHEMES.map((sc) => {
    const s = stats.get(sc)!;
    return `<tr><td><b style="color:${COLORS[sc]}">${sc}</b></td><td>${mean(s.errs).toFixed(1)} px</td><td>${Math.max(0, ...s.errs).toFixed(1)} px</td><td>${mean(s.tokens).toFixed(1)}</td><td${s.bad ? ' class="bad"' : ""}>${s.bad}</td></tr>`;
  }).join("");
  $("#seed").textContent = `run ${seed} · 50 places`;
}
$("#random").addEventListener("click", compare);

tuningPanel($("#side"), ["coords"], (t) => {
  tuning = t;
  update();
  if (seed) {
    seed--;
    compare();
  }
});

fontsReady().then(update);
