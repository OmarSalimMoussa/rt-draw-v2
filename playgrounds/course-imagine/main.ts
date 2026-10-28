// Course playground, imagine's version: the same forked course (../course/lesson.ts), built from imagine's own
// stylesheet and sketch helpers (app/src), so it looks and moves like imagine. The chapter is a page on the board,
// drawn by hand; the course is the sidebar; the narration and your questions share the bar. A red dot goes to what
// each line is about. Paused, you circle or tap anything on the page in red pencil to ask about it, as in imagine.
import "../../app/src/styles.css";
import "../course/fork/stages.css";
import "./imagine.css";
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import { type Point, isLoop, simplify, strokeLength } from "../../app/src/canvas/marks.ts";
import { installCursors } from "../../app/src/sketch/cursors.ts";
import { seedOf, sketchBox, sketchMark } from "../../app/src/sketch/rough.ts";
import { icon, logo } from "./sketch.ts";
import { type Box, CH, COURSE, G, GROUPS, POINT_DELAY, STAGE, boxOf as boxIn, clamp, esc, fmtT, labelSpot as spotIn, loopPoints, mentions, nameOf as nameIn, saidHtml, store as storeAt, targetOf as targetIn } from "../course/lesson.ts";

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const store = storeAt("course-imagine:");
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
const gen = rough.generator();

/* ---------- tweaks, in imagine's settings menu ---------- */
const TWEAKS = [
  { id: "pointer", label: "Pointer", def: "dot", options: [["dot", "A red dot that moves to it"], ["pencil", "A red pencil loop around it"], ["both", "Both"]] },
  { id: "dim", label: "Dim the rest of the page", def: "soft", options: [["off", "Off"], ["soft", "Soft"], ["strong", "Strong"]] },
  { id: "reveal", label: "Reveal the page", def: "progressive", options: [["progressive", "As each thing is mentioned"], ["all", "All at once"]] },
  { id: "sketch", label: "The drawing", def: "rough", options: [["rough", "Hand-drawn, like imagine's pages"], ["clean", "Clean lines"]] },
  { id: "notes", label: "New words", def: "on", options: [["on", "Sticky notes beside the page"], ["off", "Hidden"]] },
  { id: "auto", label: "When a chapter ends", def: "next", options: [["next", "Go on by itself"], ["stop", "Wait for me"]] },
] as const;
type TweakId = (typeof TWEAKS)[number]["id"];
const TW = Object.fromEntries(TWEAKS.map((t) => [t.id, store.get("tw:" + t.id, t.def as string)])) as Record<TweakId, string>;
const DIM: Record<string, number> = { off: 0, soft: 0.45, strong: 0.75 };
function applyTweaks() {
  document.documentElement.dataset.reveal = TW.reveal;
  document.documentElement.style.setProperty("--dim", String(DIM[TW.dim]));
}
function renderTweaks() {
  $("#tweaks").innerHTML = TWEAKS.map((t) => `<div class="st-title">${t.label}</div><div class="st-models">${t.options.map(([v, l]) => `<label class="${TW[t.id] === v ? "on" : ""}"><input type="radio" name="${t.id}" value="${v}" ${TW[t.id] === v ? "checked" : ""}> ${l}</label>`).join("")}</div>`).join("")
    + `<p class="st-note">Saved in this browser. T opens and closes this.</p>`;
}

/* ---------- state ---------- */
const P = {
  i: 0, t: 0, playing: false, started: false, ended: false, last: 0, raf: 0, line: -2, cue: -2, k: 1,
  pace: store.get("pace", 1), done: new Set<string>(store.get<string[]>("done", [])), endTimer: 0,
};
const cur = () => CH[P.i];
const page = $("#page"), stage = $("#stage"), canvas = $("#canvas"), canvasIn = $("#canvasIn"), dot = $("#dot"), spot = $("#spot");
const boxOf = (el: Element) => boxIn(el, canvas, P.k);
const targetOf = (key?: string) => targetIn(canvasIn, key);
const nameOf = (key: string, max?: number) => nameIn(canvasIn, key, max);

/* ---------- the board's layout: sidebar left, page in the middle, notes right, bar below ---------- */
const compact = matchMedia("(max-width: 640px), (max-height: 500px)");
const NOTES_W = 230;
const notesShown = () => TW.notes === "on" && !compact.matches && innerWidth >= 1180;
function layout() {
  const small = compact.matches, W = innerWidth, bar = $("#bar");
  const left = small ? 12 : $("#side").getBoundingClientRect().right + 36;
  const right = W - (notesShown() ? 28 + NOTES_W + 28 : 28);
  const top = small ? 128 : 112;
  bar.style.width = small ? "" : `${clamp(right - left, 520, 900)}px`;
  const bottom = bar.getBoundingClientRect().top - 22;
  const w = Math.max(220, Math.min(right - left, (bottom - top) * 1.6));
  const x = left + (right - left - w) / 2;
  Object.assign(page.style, { left: `${x}px`, top: `${top}px`, width: `${w}px` });
  if (!small) bar.style.left = `${clamp(x + w / 2, bar.offsetWidth / 2 + 8, W - bar.offsetWidth / 2 - 8)}px`;
  else bar.style.left = "";
  P.k = w / 960;
  canvas.style.setProperty("--k", String(P.k));
  Object.assign($("#notes").style, { left: `${x + w + 28}px`, top: `${top}px` });
  $("#notes").hidden = !notesShown();
  const name = $("#pageName");
  Object.assign($("#hint").style, { left: `${x + Math.min(name.scrollWidth, w * 0.6) + 20}px`, top: `${top - 50}px` });
  edge(w, w / 1.6);
  update(true);
}
/** The page's own outline: drawn by hand, steadier than the shapes on it, as imagine draws a page. */
function edge(w: number, h: number) {
  const e = $("#edge");
  e.setAttribute("viewBox", `0 0 ${w} ${h}`);
  e.innerHTML = gen.toPaths(gen.rectangle(1.5, 1.5, w - 3, h - 3, { seed: seedOf("page:" + cur().id), roughness: 0.6, bowing: 1, stroke: "#1e1e1e", strokeWidth: 1.5 }))
    .map((p) => `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}"/>`).join("");
}

/* ---------- the page, drawn by hand: its SVG shapes redrawn with rough.js, its outlined boxes outlined by hand ---------- */
type Sketched = { g: SVGGElement; el: Element; rv: Element | null };
let SK: Sketched[] = [];
function paintStage() {
  canvasIn.innerHTML = STAGE[cur().stage]();
  $("#sk").innerHTML = ""; SK = [];
  if (TW.sketch === "rough") { roughenSvgs(); outlineBoxes(); }
  hover(null);
}
const transparent = (c: string) => c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
function roughenSvgs() {
  let n = 0;
  for (const svg of $$<SVGSVGElement>("svg", canvasIn)) {
    for (const shape of $$<SVGGraphicsElement>("line, rect, circle, ellipse, polyline, polygon, path", svg)) {
      const cs = getComputedStyle(shape), a = (k: string) => parseFloat(shape.getAttribute(k) ?? "0") || 0;
      const stroke = cs.stroke === "none" || transparent(cs.stroke) ? "none" : cs.stroke;
      const fill = cs.fill === "none" || transparent(cs.fill) ? undefined : cs.fill;
      const sw = parseFloat(cs.strokeWidth) || 1, dash = cs.strokeDasharray === "none" ? "" : cs.strokeDasharray.replace(/px/g, "");
      const o: Options = { seed: seedOf(`${cur().id}:svg:${n++}`), roughness: 0.7, bowing: 1, stroke, strokeWidth: sw, ...(fill && { fill, fillStyle: "solid" }) };
      const pts = () => (shape.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number).reduce<[number, number][]>((acc, v, i, all) => (i % 2 ? acc : [...acc, [v, all[i + 1]]]), []);
      let d: Drawable;
      switch (shape.tagName) {
        case "line": d = gen.line(a("x1"), a("y1"), a("x2"), a("y2"), o); break;
        case "rect": if (a("width") < 6 || a("height") < 6) continue; d = gen.rectangle(a("x"), a("y"), a("width"), a("height"), o); break;
        case "circle": if (a("r") < 6) continue; d = gen.circle(a("cx"), a("cy"), a("r") * 2, o); break;
        case "ellipse": d = gen.ellipse(a("cx"), a("cy"), a("rx") * 2, a("ry") * 2, o); break;
        case "polyline": d = gen.linearPath(pts(), o); break;
        case "polygon": d = gen.polygon(pts(), o); break;
        default: d = gen.path(shape.getAttribute("d") ?? "", o);
      }
      const g = svgEl("g", {});
      for (const at of [...shape.attributes]) if (/^(class|data-|transform|opacity|style)/.test(at.name)) g.setAttribute(at.name, at.value);
      for (const p of gen.toPaths(d)) g.append(svgEl("path", { d: p.d, stroke: p.stroke, "stroke-width": p.strokeWidth, fill: p.fill ?? "none", ...(dash && p.stroke !== "none" && { "stroke-dasharray": dash }) }));
      shape.replaceWith(g);
    }
  }
}
function outlineBoxes() {
  let n = 0;
  for (const el of $$<HTMLElement>("*", canvasIn)) {
    if (el instanceof SVGElement) continue;
    const cs = getComputedStyle(el), bw = parseFloat(cs.borderTopWidth);
    const sides = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
    if (bw < 1 || sides.includes("none") || transparent(cs.borderTopColor)) continue;
    const b = boxOf(el);
    if (b.w < 6 || b.h < 6) continue;
    const color = cs.borderTopColor, radius = parseFloat(cs.borderTopLeftRadius) || 0, dashed = sides[0] === "dashed" || sides[0] === "dotted";
    el.style.borderColor = "transparent";
    const g = svgEl("g", { class: "sk-box", transform: `translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})` }) as SVGGElement;
    for (let f = 0; f < 3; f++) {
      const fg = svgEl("g", { class: "sk-f" });
      for (const s of sketchBox(b.w, b.h, { seed: seedOf(`${cur().id}:box:${n}`) + f * 7919, stroke: color, strokeWidth: Math.max(1.4, bw), radius })) {
        fg.append(svgEl("path", { d: s.d, stroke: s.stroke, "stroke-width": s.strokeWidth, fill: "none", ...(dashed && { "stroke-dasharray": "6 5" }) }));
      }
      g.append(fg);
    }
    n++;
    $("#sk").append(g);
    SK.push({ g, el, rv: el.closest(".rv") });
  }
}
/** The hand-drawn outlines fade with what they outline, as the page reveals itself. */
function syncOutlines() {
  const live = stage.classList.contains("live") && TW.reveal === "progressive";
  for (const s of SK) s.g.style.opacity = !live || !s.rv || s.rv.classList.contains("seen") ? "1" : "0.2";
}
/** While paused, the thing under the pointer boils: its outlines flip through their drawings, and it jitters. */
let hovered: Element | null = null;
function hover(el: Element | null) {
  if (el === hovered) return;
  hovered?.classList.remove("ci-boil");
  hovered = el;
  el?.classList.add("ci-boil");
  for (const s of SK) s.g.classList.toggle("boil", !!el && (el === s.el || el.contains(s.el)));
}

/* ---------- the narrator's red dot ---------- */
const D = { x: 480, y: 640, shown: false, anim: 0, trail: [] as { x: number; y: number; t: number }[], trailRaf: 0 };
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
function dotAt(x: number, y: number) { D.x = x; D.y = y; dot.style.transform = `translate(${x}px, ${y}px)`; }
// Behind the moving dot, a short red pencil line that fades, so the eye can follow where it went.
function drawTrail() {
  const now = performance.now(), life = 320;
  D.trail = D.trail.filter((p) => now - p.t < life);
  $("#trail").innerHTML = D.trail.slice(1).map((p, i) => { const q = D.trail[i]; return `<line x1="${q.x.toFixed(1)}" y1="${q.y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" opacity="${(0.8 * (1 - (now - p.t) / life)).toFixed(2)}"/>`; }).join("");
  D.trailRaf = D.trail.length ? requestAnimationFrame(drawTrail) : 0;
}
function move(to: { x: number; y: number }, ms: number, arc: number, each?: (u: number) => void, then?: () => void) {
  cancelAnimationFrame(D.anim);
  dot.classList.remove("rest");
  const from = { x: D.x, y: D.y }, dx = to.x - from.x, dy = to.y - from.y;
  const c = { x: (from.x + to.x) / 2 - dy * arc, y: (from.y + to.y) / 2 + dx * arc }, t0 = performance.now();
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / ms), e = ease(u), v = 1 - e;
    dotAt(v * v * from.x + 2 * v * e * c.x + e * e * to.x, v * v * from.y + 2 * v * e * c.y + e * e * to.y);
    D.trail.push({ x: D.x, y: D.y, t: now });
    if (!D.trailRaf) D.trailRaf = requestAnimationFrame(drawTrail);
    each?.(e);
    if (u < 1) D.anim = requestAnimationFrame(step);
    else { dot.classList.add("rest"); then?.(); }
  };
  D.anim = requestAnimationFrame(step);
}
/** The dot lands on a box's left edge, level with its heading; a wide box it underlines in red pencil instead. */
function dotTo(key: string, b: Box, animate: boolean) {
  const wide = b.w >= 420, y = wide ? Math.min(b.y + b.h + 5, 594) : b.y + Math.min(b.h / 2, 24);
  const from = { x: Math.max(6, b.x + (wide ? 10 : 0)), y }, to = { x: Math.min(954, b.x + b.w - 10), y };
  dot.hidden = false;
  const underline = () => {
    const line = gen.toPaths(gen.line(from.x, from.y, to.x, to.y, { seed: seedOf("under:" + key), roughness: 0.9, bowing: 1.2, strokeWidth: 2, disableMultiStroke: true }))[0];
    const p = svgEl("path", { d: line.d }) as SVGPathElement;
    $("#under").replaceChildren(p);
    return p;
  };
  if (!animate || !D.shown) {
    cancelAnimationFrame(D.anim);
    if (!animate) { dotAt(wide ? to.x : from.x, y); dot.classList.add("rest"); if (wide) underline(); D.shown = true; return; }
    dotAt(480, 640); // a chapter's first point comes up from the bar, where the words are
  }
  D.shown = true;
  const d = Math.hypot(from.x - D.x, from.y - D.y);
  move(from, clamp(320 + d * 0.55, 440, 920), 0.18, undefined, wide ? () => {
    const p = underline(), len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`; p.style.strokeDashoffset = `${len}`;
    move(to, clamp((to.x - from.x) * 1.4, 600, 1200), 0, (e) => { p.style.strokeDashoffset = `${len * (1 - e)}`; });
  } : undefined);
}
function hidePointer() {
  cancelAnimationFrame(D.anim);
  dot.hidden = true; D.shown = false; spot.hidden = true;
  for (const g of ["#under", "#pen"]) $(g).innerHTML = "";
}
/** The red pencil loop, as imagine draws a circled mark: a sketchy outline with light hatching inside, drawn in. */
function pencilLoop(key: string, b: Box, label: string | undefined, animate: boolean, loopToo: boolean) {
  const g = $("#pen");
  g.innerHTML = "";
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const a = Math.min(b.w / 2 + 12, cx - 4, 956 - cx), bb = Math.min(b.h / 2 + 10, cy - 4, 596 - cy);
  if (loopToo) {
    const pts = loopPoints(cx, cy, a, bb, seedOf(key)).slice(0, 64).map(([x, y]) => ({ x, y }));
    const m = sketchMark(pts, { seed: seedOf("loop:" + key), closed: true, zoom: P.k });
    for (const d of m.fill) g.append(svgEl("path", { d, class: "mk-fill" }));
    for (const d of m.outline) {
      const p = svgEl("path", { d }) as SVGPathElement;
      g.append(p);
      if (animate) {
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len}`; p.style.strokeDashoffset = `${len}`;
        p.getBoundingClientRect();
        p.style.transition = "stroke-dashoffset .7s ease-out"; p.style.strokeDashoffset = "0";
      }
    }
    if (animate) for (const f of $$<SVGPathElement>(".mk-fill", g)) { f.style.opacity = "0"; f.style.transition = "opacity .4s ease .6s"; requestAnimationFrame(() => { f.style.opacity = ""; }); }
  }
  if (!label) return;
  const t = svgEl("text", { "text-anchor": "middle" }) as SVGTextElement;
  t.textContent = label;
  g.append(t);
  const [lx, ly] = spotIn(cx, cy, a, bb, t.getComputedTextLength() || label.length * 12, b, canvasIn, canvas, P.k);
  t.setAttribute("x", String(lx)); t.setAttribute("y", String(ly));
  if (animate) { t.style.opacity = "0"; t.style.transition = "opacity .4s ease .55s"; requestAnimationFrame(() => { t.style.opacity = "1"; }); }
}
function pointAt(key: string | undefined, label: string | undefined, animate: boolean) {
  const el = targetOf(key);
  if (!key || !el) { hidePointer(); return; }
  const b = boxOf(el);
  if (!b.w) return;
  if (animate) $("#under").innerHTML = "";
  if (TW.pointer !== "pencil") dotTo(key, b, animate);
  else { cancelAnimationFrame(D.anim); dot.hidden = true; D.shown = false; }
  pencilLoop(key, b, label, animate, TW.pointer !== "dot");
  spot.hidden = TW.dim === "off";
  const pad = 9, x = Math.max(2, b.x - pad), y = Math.max(2, b.y - pad);
  Object.assign(spot.style, { left: `${x}px`, top: `${y}px`, width: `${Math.min(958, b.x + b.w + pad) - x}px`, height: `${Math.min(598, b.y + b.h + pad) - y}px` });
}

/* ---------- your red pencil: paused, circle or tap anything on the page to ask about it ---------- */
const M = { drawing: false, pts: [] as Point[], key: "" };
const toCanvas = (e: PointerEvent): Point => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / P.k, y: (e.clientY - r.top) / P.k }; };
function inside(p: Point, poly: Point[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
/** What a mark is about: for a loop, the biggest thing whose middle it circles; for a line, the smallest thing it crosses. */
function markedBy(pts: Point[], loop: boolean): HTMLElement | null {
  const things = $$("[data-k]", canvasIn).map((el) => ({ el, b: boxOf(el) }));
  if (loop) {
    const hit = things.filter(({ b }) => inside({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, pts));
    return hit.sort((p, q) => q.b.w * q.b.h - p.b.w * p.b.h)[0]?.el ?? null;
  }
  const hit = things.filter(({ b }) => pts.some((p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h));
  return hit.sort((p, q) => p.b.w * p.b.h - q.b.w * q.b.h)[0]?.el ?? null;
}
function clearMine() { $("#mine").innerHTML = ""; setAbout(""); }
function setAbout(key: string) {
  M.key = key;
  const chip = $("#about");
  chip.hidden = !key;
  if (key) chip.innerHTML = `<span>${esc(nameOf(key, 40))}</span><button id="aboutX" aria-label="Forget this mark">${icon("close")}</button>`;
  ($("#askInput") as HTMLTextAreaElement).placeholder = key ? `Ask about ${nameOf(key, 40)}` : "Ask about it, or circle something first";
}
function finishMark(e: PointerEvent) {
  const pts = M.pts, g = $("#mine");
  g.innerHTML = "";
  let el: HTMLElement | null;
  if (strokeLength(pts) < 4) {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const term = under?.closest<HTMLElement>(".term");
    if (term && canvasIn.contains(term)) { openWords(term.dataset.term); return; }
    g.append(svgEl("circle", { cx: pts[0].x, cy: pts[0].y, r: 5 / P.k }));
    el = under?.closest<HTMLElement>("[data-k]") ?? null;
    if (el && !canvasIn.contains(el)) el = null;
  } else {
    const s = simplify(pts), loop = isLoop(s);
    const m = sketchMark(s, { seed: seedOf(`mine:${performance.now()}`), closed: loop, zoom: P.k });
    for (const d of m.fill) g.append(svgEl("path", { d, class: "mk-fill" }));
    for (const d of m.outline) g.append(svgEl("path", { d }));
    el = markedBy(s, loop);
  }
  setAbout(el?.dataset.k ?? "");
  if (el) ($("#askInput") as HTMLTextAreaElement).focus();
}

/* ---------- the bar: the line being said, and asking ---------- */
function renderLine() {
  const ch = cur(), li = P.line;
  if (!P.started || li < 0) {
    $("#prev").textContent = "";
    $("#now").innerHTML = `<span class="ci-hint">${esc(ch.title)}. Press play, or Space, when you're ready.</span>`;
    return;
  }
  $("#prev").textContent = li > 0 ? ch.lines[li - 1].text : "";
  $("#now").innerHTML = saidHtml(ch.lines[li], canvasIn);
}
function renderBeats() {
  $("#beats").innerHTML = cur().lines.map((l, j) => `<button class="ci-beat" data-line="${j}" style="--w:${(l.end - l.t).toFixed(2)}" title="${esc(l.text)}" aria-label="Line ${j + 1}"><i><b></b></i></button>`).join("");
}
function ask(q: string) {
  if (!q.trim()) return;
  const about = M.key ? nameOf(M.key, 60) : P.started && P.line >= 0 ? "this line" : cur().title;
  $("#answer").innerHTML = `<span>You asked about <b>${esc(about)}</b>: “${esc(q.trim())}”. This is a mockup, so nothing answers yet. In imagine, Claude would answer in the course's plain words and could draw on the page while it explains.</span><button id="answerX" aria-label="Close">${icon("close")}</button>`;
  $("#answer").hidden = false;
  ($("#askInput") as HTMLTextAreaElement).value = "";
}

/* ---------- new words: sticky notes beside the page ---------- */
let MENT: Record<string, number> = {};
const opened = new Set<string>();
const TILTS = ["-1.4deg", "0.9deg", "-0.6deg"];
function renderNotes() {
  const li = P.started ? P.line : -1;
  const shown = Object.entries(MENT).filter(([, j]) => j <= li).sort((a, b) => b[1] - a[1]);
  const total = Object.keys(MENT).length;
  if (!shown.length) {
    $("#notes").innerHTML = total ? `<div class="ci-empty-note">${total} new word${total > 1 ? "s" : ""} in this chapter. Each one sticks here as it's said.</div>` : "";
    return;
  }
  const cards = shown.slice(0, 3), rest = shown.slice(3);
  $("#notes").innerHTML = cards.map(([k, j], n) => {
    const g = G[k];
    return `<div class="ci-note${j === li ? " now" : ""}${j === li && P.playing ? " fresh" : ""}" style="--tilt:${TILTS[(j + n) % 3]}"><b>${esc(g[1])}</b><p>${esc(g[2])}</p>${opened.has(k) ? `<p class="deep">${esc(g[3])}</p>` : `<button class="more" data-more="${k}">Tell me more</button>`}</div>`;
  }).join("") + (rest.length ? `<div class="ci-earlier">Earlier: ${rest.map(([k]) => `<button data-word="${k}">${esc(G[k][1])}</button>`).join("")}</div>` : "");
}

/* ---------- the sidebar: chapters as pages, and what's been said as history ---------- */
function renderChapters() {
  $("#chapters").innerHTML = CH.map((c, i) => `${c.part ? `<li class="ci-part">${esc(c.part)}</li>` : ""}<li><button data-ch="${i}" class="${i === P.i ? "on" : ""}"><span class="lp-glyph">${P.done.has(c.id) ? icon("check") : i + 1}</span><span class="lp-label">${esc(c.title)}</span><span class="lp-ago">${fmtT(c.duration)}</span></button></li>`).join("");
}
function renderLines() {
  const ch = cur(), li = P.started ? P.line : -1;
  $("#saidCount").textContent = `${Math.max(0, li + 1)} of ${ch.lines.length}`;
  $("#lines").innerHTML = li < 0 ? `<li class="lp-empty">Nothing yet. Press play and every line shows up here.</li>`
    : ch.lines.slice(0, li + 1).map((l, j) => `<li><button data-line="${j}" class="${j === li ? "on" : ""}"><span class="lp-n">${j + 1}</span><span class="lp-label">${esc(l.text)}</span><span class="lp-ago">${fmtT(l.t)}</span></button></li>`).join("");
  $("#lines .on")?.scrollIntoView({ block: "nearest" });
}

/* ---------- the status, top centre ---------- */
function renderState() {
  const s = $("#state"), ch = cur();
  const [cls, glyph, word, detail] = !P.started
    ? ["", icon("book"), `Chapter ${P.i + 1} of ${CH.length}`, `${fmtT(ch.duration)} · ${ch.lines.length} lines`]
    : P.ended ? ["done", icon("check"), "Done", `chapter ${P.i + 1} of ${CH.length}`]
    : P.playing ? ["drawing", icon("pencil", "pg-pencil"), "Explaining", ""]
    : ["", icon("pause"), "Paused", "circle anything to ask about it"];
  s.className = "pg-state" + (cls ? " " + cls : "");
  s.innerHTML = `${glyph}<span>${word}</span><span class="pg-state-detail" id="stateDetail">${detail}</span>`;
}

/* ---------- the chapter's start and end, over the page ---------- */
function showStart() {
  const ch = cur(), words = Object.keys(MENT).length, first = !store.get("howto", false);
  $("#over").innerHTML = `<div class="ci-card"><span class="ci-kicker">Chapter ${P.i + 1} of ${CH.length}${ch.part ? " · " + esc(ch.part) : ""}</span><h2>${esc(ch.title)}</h2>
    <p>${fmtT(ch.duration)} · ${ch.lines.length} lines${words ? ` · ${words} new word${words > 1 ? "s" : ""}` : ""}</p>
    ${first ? `<p>The red dot shows where to look. Space pauses, ← and → go a line at a time, and R says a line again. While it's paused, circle or tap anything on the page and ask about it.</p>` : ""}
    <div class="ci-go">${P.i > 0 ? `<button class="ci-link" data-act="prevch">${icon("back")} Chapter ${P.i}</button>` : "<span></span>"}<button class="ci-start" data-act="play">${icon("play")} ${P.done.has(ch.id) ? "Watch again" : "Start"}</button></div></div>`;
  $("#over").hidden = false;
}
function showEnd() {
  const ch = cur(), last = P.i === CH.length - 1, auto = TW.auto === "next" && !last;
  const seen = new Map<string, number>();
  ch.lines.forEach((l, j) => { if (l.key && !seen.has(l.key) && targetOf(l.key)) seen.set(l.key, j); });
  $("#over").innerHTML = `<div class="ci-card"><span class="ci-kicker">Chapter ${P.i + 1} of ${CH.length} · done</span><h2>${esc(ch.title)}</h2>
    <p>What the red dot pointed at. Tap one to hear that line again.</p>
    <div class="ci-saw">${[...seen].map(([k, j]) => `<button data-line="${j}">${esc(ch.lines[j].pen || nameOf(k))}</button>`).join("")}</div>
    <div class="ci-go"><span><button class="ci-link" data-act="again">${icon("again")} Watch again</button>${auto ? `<button class="ci-link" data-act="stay">Wait for me</button>` : ""}</span>
    ${last ? `<button class="ci-start" data-act="restart">${icon("again")} Start the course again</button>` : `<button class="ci-start" data-act="next">${icon("play")} Next: ${esc(CH[P.i + 1].title)}${auto ? ` <span id="count">(8)</span>` : ""}</button>`}</div></div>`;
  $("#over").hidden = false;
  if (auto) {
    let left = 8;
    P.endTimer = window.setInterval(() => {
      left--;
      if (left <= 0) load(P.i + 1, true);
      else { const c = document.getElementById("count"); if (c) c.textContent = `(${left})`; }
    }, 1000);
  }
}
function stopCountdown() {
  clearInterval(P.endTimer); P.endTimer = 0;
  document.getElementById("count")?.remove();
  $('[data-act="stay"]')?.remove();
}

/* ---------- the clock ---------- */
function load(i: number, autoplay = false) {
  stopCountdown(); pause();
  P.i = clamp(i, 0, CH.length - 1); P.t = 0; P.line = -2; P.cue = -2; P.started = false; P.ended = false;
  store.set("ch", P.i);
  const ch = cur();
  stage.classList.remove("live");
  hidePointer(); clearMine(); $("#answer").hidden = true;
  paintStage();
  MENT = mentions(ch); opened.clear();
  $("#pageName").textContent = ch.title;
  renderChapters(); renderBeats();
  showStart(); syncPlay();
  layout();
  $("#chapters .on")?.scrollIntoView({ block: "nearest" });
  if (autoplay) play();
}
function begin() {
  if (!P.started) { P.started = true; store.set("howto", true); }
  P.ended = false;
  $("#over").hidden = true;
  stage.classList.add("live");
}
function play() {
  stopCountdown();
  if (P.t >= cur().duration - 0.05) { P.t = 0; P.cue = -2; }
  begin();
  clearMine(); hover(null); $("#answer").hidden = true;
  P.playing = true; P.last = performance.now();
  update(true);
  cancelAnimationFrame(P.raf); P.raf = requestAnimationFrame(tick);
  syncPlay();
}
function pause() {
  P.playing = false;
  cancelAnimationFrame(P.raf);
  syncPlay();
}
function syncPlay() {
  $("#playBtn").innerHTML = P.playing ? `${icon("pause")} Pause` : `${icon("play")} Play`;
  stage.classList.toggle("asking", P.started && !P.playing && $("#over").hidden === true);
  renderState();
}
function tick(now: number) {
  if (!P.playing) return;
  P.t += (Math.max(0, now - P.last) / 1000) * P.pace;
  P.last = now;
  if (P.t >= cur().duration) { P.t = cur().duration; update(); ended(); return; }
  update();
  P.raf = requestAnimationFrame(tick);
}
function ended() {
  P.done.add(cur().id); store.set("done", [...P.done]);
  P.ended = true;
  pause();
  hidePointer(); P.cue = -2;
  renderChapters();
  showEnd();
  syncPlay();
}
function toLine(j: number) {
  stopCountdown();
  // Just past where the line points, so a jump made while paused shows what this line is about, not the last one.
  P.t = cur().lines[clamp(j, 0, cur().lines.length - 1)].t + POINT_DELAY;
  begin();
  update(true);
  syncPlay();
}
const lineNow = () => Math.max(0, P.line);
function back() { const l = cur().lines[lineNow()]; toLine(P.t - (l?.t ?? 0) < 1.5 ? lineNow() - 1 : lineNow()); }
function fwd() { const n = lineNow() + 1; if (n < cur().lines.length) toLine(n); else if (P.started) { P.t = cur().duration; update(); ended(); } }
function again() { toLine(lineNow()); if (!P.playing) play(); }

function update(force = false) {
  const ch = cur(), t = P.t;
  $("#time").textContent = `${fmtT(t)} / ${fmtT(ch.duration)}`;
  if (P.playing) $("#stateDetail").textContent = `${fmtT(t)} / ${fmtT(ch.duration)}`;
  let li = -1;
  if (P.started) ch.lines.forEach((l, j) => { if (l.t <= t + 0.05) li = j; });
  if (li !== P.line || force) { P.line = li; renderLine(); renderNotes(); renderLines(); }
  $$(".ci-beat").forEach((b, j) => {
    const l = ch.lines[j];
    b.style.setProperty("--p", String(j < li ? 1 : j > li ? 0 : clamp((t - l.t) / (l.end - l.t), 0, 1)));
    b.classList.toggle("cur", j === li);
  });
  let qi = -1;
  if (P.started && !P.ended) ch.lines.forEach((l, j) => { if (l.key && l.t + POINT_DELAY <= t + 0.04) qi = j; });
  if (qi !== P.cue || force) {
    const fresh = qi !== P.cue;
    P.cue = qi;
    if (qi >= 0) pointAt(ch.lines[qi].key, ch.lines[qi].pen, fresh); else if (fresh) hidePointer();
  }
  if (P.started) $$("[data-k]", canvasIn).forEach((el) => { const k = el.dataset.k!; el.classList.toggle("seen", !(k in ch.reveal) || ch.reveal[k] <= t + 0.04); });
  syncOutlines();
}

/* ---------- words ---------- */
function renderWords(q = "") {
  const low = q.trim().toLowerCase();
  $("#wordList").innerHTML = GROUPS.map(([g, name]) => {
    const ks = Object.keys(G).filter((k) => G[k][0] === g && (!low || [G[k][1], G[k][2], G[k][3]].some((s) => s.toLowerCase().includes(low))));
    return ks.length ? `<h3>${esc(name)}</h3>${ks.map((k) => `<div class="ci-word" id="w-${k}"><b>${esc(G[k][1])}</b><p>${esc(G[k][2])}</p></div>`).join("")}` : "";
  }).join("") || `<p class="st-note">No word matches “${esc(q)}”.</p>`;
}
function openWords(k?: string) {
  pause();
  ($("#wordSearch") as HTMLInputElement).value = ""; renderWords();
  $("#words").hidden = false;
  const card = k ? document.getElementById("w-" + k) : null;
  if (card) { card.scrollIntoView({ block: "center" }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1600); }
}
function toggleTweaks(show = !!$("#tweaks").hidden) {
  $("#tweaks").hidden = !show;
  $("#gear").classList.toggle("on", show);
  $("#gear").setAttribute("aria-expanded", String(show));
}

/* ---------- wiring ---------- */
function bind() {
  $("#logo").innerHTML = logo(26);
  $("#courseName").textContent = COURSE;
  $("#foldName").textContent = COURSE;
  $("#wordsBtn").innerHTML = icon("book");
  $("#askBtn").innerHTML = icon("feedback");
  $("#gear").innerHTML = icon("gear");
  $("#hintX").innerHTML = icon("close");
  $("#wordsX").innerHTML = icon("close");
  $("#backBtn").innerHTML = icon("prev");
  $("#fwdBtn").innerHTML = icon("next");
  $("#againBtn").innerHTML = icon("again");
  $("#micBtn").innerHTML = icon("mic");
  $("#hint").hidden = store.get("hintGone", false);
  const PACES = [[0.85, "Slower"], [1, "Normal"], [1.15, "Faster"]] as const;
  const renderPace = () => {
    const n = PACES.findIndex(([v]) => v === P.pace);
    $("#pace").innerHTML = `<button data-pace="-1" title="Slower" aria-label="Slower">${icon("minus")}</button><button class="ci-pct cv-pct" data-pace="0" title="Back to normal pace">${PACES[n < 0 ? 1 : n][1]}</button><button data-pace="1" title="Faster" aria-label="Faster">${icon("plus")}</button>`;
  };
  renderPace();
  $("#pace").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-pace]"); if (!b) return;
    const n = PACES.findIndex(([v]) => v === P.pace), step = +b.dataset.pace!;
    P.pace = PACES[step ? clamp(n + step, 0, PACES.length - 1) : 1][0];
    store.set("pace", P.pace); renderPace();
  });

  $("#playBtn").addEventListener("click", () => (P.playing ? pause() : play()));
  $("#backBtn").addEventListener("click", back);
  $("#fwdBtn").addEventListener("click", fwd);
  $("#againBtn").addEventListener("click", again);
  $("#beats").addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-line]"); if (b) toLine(+b.dataset.line!); });
  $("#chapters").addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-ch]"); if (b) { load(+b.dataset.ch!); $("#side").classList.remove("open"); } });
  $("#lines").addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-line]"); if (b) toLine(+b.dataset.line!); });
  $("#fold").addEventListener("click", () => { const open = $("#side").classList.toggle("open"); $("#fold").setAttribute("aria-expanded", String(open)); });
  $("#hintX").addEventListener("click", () => { $("#hint").hidden = true; store.set("hintGone", true); });

  $("#over").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-act], [data-line]");
    if (!b) return;
    if (b.dataset.line) { toLine(+b.dataset.line); play(); return; }
    const act = b.dataset.act;
    if (act === "play") play();
    else if (act === "prevch") load(P.i - 1);
    else if (act === "next") load(P.i + 1, true);
    else if (act === "stay") stopCountdown();
    else if (act === "again") { P.t = 0; P.cue = -2; play(); }
    else if (act === "restart") load(0);
  });

  // The page: playing, a press pauses; paused, you draw on it in red pencil (or tap), and hovering boils what you'd point at.
  canvas.addEventListener("pointerdown", (e) => {
    if (!P.started || !$("#over").hidden) return;
    if (P.playing) pause();
    M.drawing = true; M.pts = [toCanvas(e)];
    canvas.setPointerCapture(e.pointerId);
    $("#mine").innerHTML = `<polyline points=""/>`;
    stage.classList.add("drawing");
    hover(null);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (M.drawing) {
      M.pts.push(toCanvas(e));
      $("#mine polyline")?.setAttribute("points", M.pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
      return;
    }
    if (!P.playing && P.started && $("#over").hidden) {
      const el = (e.target as Element).closest("[data-k]");
      hover(el && canvasIn.contains(el) ? el : null);
    }
  });
  canvas.addEventListener("pointerleave", () => { if (!M.drawing) hover(null); });
  const up = (e: PointerEvent) => {
    if (!M.drawing) return;
    M.drawing = false;
    stage.classList.remove("drawing");
    finishMark(e);
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  const input = $("#askInput") as HTMLTextAreaElement;
  input.addEventListener("focus", () => { if (P.playing) pause(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
  $("#sendBtn").addEventListener("click", () => ask(input.value));
  $("#micBtn").addEventListener("click", () => {
    const on = $("#micBtn").classList.toggle("on");
    if (on) pause();
    input.placeholder = on ? "Mockup: asking out loud comes later. Type for now." : "Ask about it, or circle something first";
  });
  $("#bar").addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t.closest("#aboutX")) { clearMine(); input.focus(); }
    if (t.closest("#answerX")) $("#answer").hidden = true;
  });
  $("#askBtn").addEventListener("click", () => {
    pause();
    const key = cur().lines[P.cue]?.key;
    if (!M.key && key) setAbout(key);
    input.focus();
  });

  $("#notes").addEventListener("click", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-more], [data-word]");
    if (t?.dataset.more) { opened.add(t.dataset.more); renderNotes(); }
    else if (t?.dataset.word) openWords(t.dataset.word);
  });
  $("#wordsBtn").addEventListener("click", () => ($("#words").hidden ? openWords() : ($("#words").hidden = true)));
  $("#wordsBtn2").addEventListener("click", () => openWords());
  $("#wordsX").addEventListener("click", () => { $("#words").hidden = true; });
  $("#wordSearch").addEventListener("input", (e) => renderWords((e.target as HTMLInputElement).value));
  $("#gear").addEventListener("click", () => toggleTweaks());
  $("#tweaks").addEventListener("change", (e) => {
    const r = e.target as HTMLInputElement, id = r.name as TweakId;
    TW[id] = r.value; store.set("tw:" + id, r.value);
    applyTweaks(); renderTweaks();
    if (id === "sketch") { paintStage(); update(true); }
    else if (id === "notes") layout();
    else if (id === "pointer" || id === "dim") { P.cue = -2; update(true); }
    else update(true);
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { $("#words").hidden = true; toggleTweaks(false); clearMine(); $("#answer").hidden = true; (document.activeElement as HTMLElement | null)?.blur(); return; }
    if ((e.target as Element).closest("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); if (P.playing) pause(); else play(); }
    else if (k === "arrowleft") { e.preventDefault(); back(); }
    else if (k === "arrowright") { e.preventDefault(); fwd(); }
    else if (k === "r") again();
    else if (k === "t") toggleTweaks();
    else if (k === "w") ($("#words").hidden ? openWords() : ($("#words").hidden = true));
    else if (k === "a") { e.preventDefault(); $("#askBtn").click(); }
  });
  addEventListener("resize", () => requestAnimationFrame(layout));
  compact.addEventListener("change", () => requestAnimationFrame(layout));
  new ResizeObserver(() => requestAnimationFrame(layout)).observe($("#bar"));
}

installCursors();
applyTweaks();
renderTweaks();
bind();
load(store.get("ch", 0));
// Excalifont changes how the drawing lays out, so the hand-drawn outlines are drawn again once it's in.
document.fonts.ready.then(() => { paintStage(); update(true); layout(); });
