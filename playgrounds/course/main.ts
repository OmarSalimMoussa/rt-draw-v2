// Course playground: the Eval Harness Course forked into a player redesigned for following along. It plays silently
// on the narration's own timings, so the pacing is the voice's. Each line names one thing in the picture; a laser
// travels to it, the rest dims, and the words that name it are underlined in the line. Tweaks (T) switch the variants.
import "./course.css";
import "./fork/stages.css";
import { type Box, CH, COURSE, G, GROUPS, POINT_DELAY, STAGE, boxOf as boxIn, clamp, esc, fmtT, hash, labelSpot as spotIn, loopPath, loopPoints, mentions, nameOf as nameIn, saidHtml, store as storeAt, targetOf as targetIn } from "./lesson.ts";

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const store = storeAt("course:");

/* ---------- tweaks ---------- */
const TWEAKS = [
  { id: "pointer", label: "Pointer", def: "laser", options: [["laser", "Laser"], ["pen", "Pen loop"], ["both", "Both"]] },
  { id: "dim", label: "Dim the rest", def: "soft", options: [["off", "Off"], ["soft", "Soft"], ["strong", "Strong"]] },
  { id: "reveal", label: "Reveal the picture", def: "progressive", options: [["progressive", "As it's mentioned"], ["all", "All at once"]] },
  { id: "captions", label: "The line being said", def: "under", options: [["under", "Under the picture"], ["on", "On the picture"], ["off", "Hidden"]] },
  { id: "notes", label: "New words column", def: "on", options: [["on", "Show"], ["off", "Hide"]] },
  { id: "auto", label: "When a chapter ends", def: "next", options: [["next", "Go on by itself"], ["stop", "Wait for me"]] },
  { id: "theme", label: "Theme", def: "auto", options: [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]] },
] as const;
type TweakId = (typeof TWEAKS)[number]["id"];
const TW = Object.fromEntries(TWEAKS.map((t) => [t.id, store.get("tw:" + t.id, t.def as string)])) as Record<TweakId, string>;
const DIM: Record<string, number> = { off: 0, soft: 0.5, strong: 0.8 };
function applyTweaks() {
  const root = document.documentElement;
  for (const id of ["pointer", "reveal", "captions", "notes"] as const) root.dataset[id] = TW[id];
  if (TW.theme === "auto") delete root.dataset.theme; else root.dataset.theme = TW.theme;
  root.style.setProperty("--dim", String(DIM[TW.dim]));
}
function renderTweaks() {
  $("#tweakList").innerHTML = TWEAKS.map((t) => `<div class="tw"><span class="lbl">${t.label}</span><div class="seg" role="radiogroup" aria-label="${t.label}">${t.options.map(([v, l]) => `<button role="radio" data-tw="${t.id}" data-v="${v}" aria-checked="${TW[t.id] === v}">${l}</button>`).join("")}</div></div>`).join("");
}

/* ---------- player state ---------- */
const P = {
  i: 0, t: 0, playing: false, started: false, last: 0, raf: 0, line: -2, cue: -2, k: 1,
  pace: store.get("pace", 1), done: new Set<string>(store.get<string[]>("done", [])), endTimer: 0,
};
const cur = () => CH[P.i];
const stage = $("#stage"), canvas = $("#canvas"), canvasIn = $("#canvasIn"), laser = $("#laser"), spot = $("#spot");
const SVGNS = "http://www.w3.org/2000/svg";

/* ---------- geometry ---------- */
const boxOf = (el: Element) => boxIn(el, canvas, P.k);
const targetOf = (key?: string) => targetIn(canvasIn, key);
const nameOf = (key: string, max?: number) => nameIn(canvasIn, key, max);

/* ---------- the laser ---------- */
const L = { x: 480, y: 660, shown: false, anim: 0, trail: [] as { x: number; y: number; t: number }[], trailRaf: 0 };
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
function laserAt(x: number, y: number) { L.x = x; L.y = y; laser.style.transform = `translate(${x}px, ${y}px)`; }
function pushTrail(x: number, y: number) {
  L.trail.push({ x, y, t: performance.now() });
  if (!L.trailRaf) L.trailRaf = requestAnimationFrame(drawTrail);
}
// A short comet tail behind the dot while it moves, so the eye can follow where it went.
function drawTrail() {
  const now = performance.now(), life = 260;
  L.trail = L.trail.filter((p) => now - p.t < life);
  $("#trail").innerHTML = L.trail.map((p) => { const a = 1 - (now - p.t) / life; return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${((6 * a) / P.k).toFixed(2)}" opacity="${(0.42 * a).toFixed(2)}"/>`; }).join("");
  L.trailRaf = L.trail.length ? requestAnimationFrame(drawTrail) : 0;
}
function fly(to: { x: number; y: number }, ms: number, arc: number, then?: () => void) {
  cancelAnimationFrame(L.anim);
  laser.classList.remove("rest");
  const from = { x: L.x, y: L.y }, dx = to.x - from.x, dy = to.y - from.y;
  const c = { x: (from.x + to.x) / 2 - dy * arc, y: (from.y + to.y) / 2 + dx * arc };
  const t0 = performance.now();
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / ms), e = ease(u), v = 1 - e;
    const x = v * v * from.x + 2 * v * e * c.x + e * e * to.x, y = v * v * from.y + 2 * v * e * c.y + e * e * to.y;
    laserAt(x, y); pushTrail(x, y);
    if (u < 1) L.anim = requestAnimationFrame(step);
    else { laser.classList.add("rest"); then?.(); }
  };
  L.anim = requestAnimationFrame(step);
}
/** Where the dot lands on a box: its left edge, level with its heading. A wide box is swept along its foot instead. */
function landing(b: Box) {
  const wide = b.w >= 420;
  const y = wide ? Math.min(b.y + b.h + 5, 594) : b.y + Math.min(b.h / 2, 24);
  return { wide, from: { x: Math.max(6, b.x + (wide ? 10 : 0)), y }, to: { x: Math.min(954, b.x + b.w - 10), y } };
}
function laserTo(b: Box, animate: boolean) {
  const { wide, from, to } = landing(b);
  laser.hidden = false;
  if (!L.shown || !animate) {
    cancelAnimationFrame(L.anim);
    if (!L.shown && animate) laserAt(480, 640); // the first point of a chapter comes up from the line being said
    else { laserAt(wide ? to.x : from.x, from.y); laser.classList.add("rest"); L.shown = true; return; }
  }
  L.shown = true;
  const d = Math.hypot(from.x - L.x, from.y - L.y);
  fly(from, clamp(300 + d * 0.55, 420, 900), 0.18, wide ? () => sweep(from, to) : undefined);
}
function sweep(from: { x: number; y: number }, to: { x: number; y: number }) {
  const line = document.createElementNS(SVGNS, "line");
  for (const [k, v] of [["x1", from.x], ["y1", from.y], ["x2", from.x], ["y2", from.y]] as const) line.setAttribute(k, String(v));
  $("#sweep").replaceChildren(line);
  const ms = clamp((to.x - from.x) * 1.4, 600, 1200), t0 = performance.now();
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / ms), x = from.x + (to.x - from.x) * ease(u);
    laserAt(x, to.y); line.setAttribute("x2", x.toFixed(1));
    if (u < 1) L.anim = requestAnimationFrame(step);
    else { laser.classList.add("rest"); setTimeout(() => line.classList.add("gone"), 900); }
  };
  laser.classList.remove("rest");
  L.anim = requestAnimationFrame(step);
}
function hidePointer() {
  cancelAnimationFrame(L.anim);
  laser.hidden = true; L.shown = false;
  spot.hidden = true;
  $("#pen").innerHTML = ""; $("#sweep").innerHTML = "";
}

/* ---------- the red pen (forked from the course: a hand-drawn loop, and a label wherever it covers least) ---------- */
const labelSpot = (cx: number, cy: number, a: number, b: number, tw: number, target: Box) => spotIn(cx, cy, a, b, tw, target, canvasIn, canvas, P.k);
function penMark(key: string, b: Box, label: string | undefined, animate: boolean, loopToo: boolean) {
  const g = $("#pen");
  g.innerHTML = "";
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const a = Math.min(b.w / 2 + 10, cx - 4, 956 - cx), bb = Math.min(b.h / 2 + 9, cy - 4, 596 - cy);
  if (loopToo) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", loopPath(loopPoints(cx, cy, a, bb, hash(key))));
    g.appendChild(p);
    if (animate) {
      const len = p.getTotalLength();
      p.style.strokeDasharray = String(len); p.style.strokeDashoffset = String(len);
      p.getBoundingClientRect();
      p.style.transition = "stroke-dashoffset .7s ease-out"; p.style.strokeDashoffset = "0";
    }
  }
  if (!label) return;
  const t = document.createElementNS(SVGNS, "text");
  t.setAttribute("text-anchor", "middle"); t.textContent = label;
  g.appendChild(t);
  const tw = t.getComputedTextLength() || label.length * 12.5;
  const [lx, ly] = labelSpot(cx, cy, a, bb, tw, b);
  t.setAttribute("x", String(lx)); t.setAttribute("y", String(ly));
  if (animate) { t.style.opacity = "0"; t.style.transition = "opacity .4s ease .55s"; requestAnimationFrame(() => { t.style.opacity = "1"; }); }
}

/** Point at what a line is about: the laser and/or the pen, a lit window around it, and its handwritten label. */
function pointAt(key: string | undefined, label: string | undefined, animate: boolean) {
  const el = targetOf(key);
  if (!key || !el) { hidePointer(); return; }
  const b = boxOf(el);
  if (!b.w) return;
  if (TW.pointer !== "pen") laserTo(b, animate);
  else { cancelAnimationFrame(L.anim); laser.hidden = true; L.shown = false; }
  if (animate) $("#sweep").innerHTML = "";
  penMark(key, b, label, animate, TW.pointer !== "laser");
  spot.hidden = TW.dim === "off";
  const pad = 9, x = Math.max(2, b.x - pad), y = Math.max(2, b.y - pad);
  Object.assign(spot.style, { left: x + "px", top: y + "px", width: Math.min(958, b.x + b.w + pad) - x + "px", height: Math.min(598, b.y + b.h + pad) - y + "px" });
}

/* ---------- the line being said ---------- */
function renderLine() {
  const ch = cur(), li = P.line;
  if (!P.started || li < 0) {
    $("#subPrev").textContent = "";
    $("#subNow").innerHTML = `<span class="hint">${esc(ch.title)}. Press play, or Space, when you're ready.</span>`;
    $("#subOn").innerHTML = "";
    return;
  }
  const html = saidHtml(ch.lines[li], canvasIn);
  $("#subPrev").textContent = li > 0 ? ch.lines[li - 1].text : "";
  $("#subNow").innerHTML = html;
  $("#subOn").innerHTML = html;
}

/* ---------- new words, as the lines first mention them ---------- */
let MENT: Record<string, number> = {};
const opened = new Set<string>();
function renderNotes() {
  const ch = cur(), li = P.started ? P.line : -1;
  const shown = Object.entries(MENT).filter(([, j]) => j <= li).sort((a, b) => b[1] - a[1]);
  const total = Object.keys(MENT).length;
  $("#noteCount").textContent = total ? `${shown.length} of ${total}` : "";
  if (!shown.length) {
    $("#noteList").innerHTML = `<div class="note-empty">${total ? `This chapter brings in ${total} new word${total > 1 ? "s" : ""}. Each one appears here, in plain English, as it's said.` : "No new words in this chapter."}</div>`;
    return;
  }
  const cards = shown.slice(0, 3), rest = shown.slice(3);
  $("#noteList").innerHTML = cards.map(([k, j]) => {
    const g = G[k], open = opened.has(k);
    return `<div class="note${j === li ? " now" : ""}${j === li && P.playing ? " fresh" : ""}"><b>${esc(g[1])}</b><p>${esc(g[2])}</p>${open ? `<p class="deep">${esc(g[3])}</p>` : `<button class="linkish more" data-more="${k}">Tell me more</button>`}</div>`;
  }).join("") + (rest.length ? `<div class="lbl" style="margin-top:4px">Earlier in this chapter</div><div class="earlier">${rest.map(([k]) => `<button data-word="${k}">${esc(G[k][1])}</button>`).join("")}</div>` : "");
}

/* ---------- chapter map, line beats and contents ---------- */
function parts() {
  const out: { name: string; idx: number[] }[] = [];
  CH.forEach((c, i) => { if (c.part || !out.length) out.push({ name: c.part ?? "", idx: [] }); out[out.length - 1].idx.push(i); });
  return out;
}
function renderMap() {
  $("#map").innerHTML = parts().map((p) => {
    const dur = p.idx.reduce((s, i) => s + CH[i].duration, 0);
    return `<div class="m-part${p.idx.includes(P.i) ? " on" : ""}" style="flex:${dur.toFixed(1)} 1 0"><span class="lbl">${esc(p.name)}</span><div class="m-row">${p.idx.map((i) => `<button class="m-ch${P.done.has(CH[i].id) ? " done" : ""}${i === P.i ? " cur" : ""}" data-ch="${i}" style="flex:${CH[i].duration.toFixed(1)} 1 0" aria-label="Chapter ${i + 1}: ${esc(CH[i].title)}"><i><b></b></i></button>`).join("")}</div></div>`;
  }).join("");
}
function renderBeats() {
  $("#beats").innerHTML = cur().lines.map((l, j) => `<button class="beat" data-line="${j}" style="--w:${(l.end - l.t).toFixed(2)}" title="${esc(l.text)}" aria-label="Line ${j + 1}"><i><b></b></i></button>`).join("");
}
function renderToc() {
  $("#toc").innerHTML = `<ol class="toc">${CH.map((c, i) => `${c.part ? `<li class="part">${esc(c.part)}</li>` : ""}<li><button data-ch="${i}" class="${P.done.has(c.id) ? "done" : ""}" ${i === P.i ? 'aria-current="true"' : ""}><span class="n">${P.done.has(c.id) ? "✓" : String(i + 1).padStart(2, "0")}</span><span class="t">${esc(c.title)}</span><span class="d">${fmtT(c.duration)}</span></button></li>`).join("")}</ol>`;
}

/* ---------- cards over the stage ---------- */
const PLAY_ICON = `<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>`;
function showStart() {
  const ch = cur(), i = P.i, words = Object.keys(MENT).length;
  const first = !store.get("howto", false);
  $("#over").innerHTML = `<div class="oc"><span class="lbl">Chapter ${i + 1} of ${CH.length}${ch.part ? " · " + esc(ch.part) : ""}</span><h1>${esc(ch.title)}</h1>
    <span class="meta">${fmtT(ch.duration)} · ${ch.lines.length} lines${words ? ` · ${words} new word${words > 1 ? "s" : ""}` : ""}</span>
    ${first ? `<p>The red dot always shows where to look. Space pauses, ← and → move a line at a time, and R says the line again. While paused, click anything in the picture to ask about it.</p>` : ""}
    <div class="row"><button class="big" data-act="play">${PLAY_ICON}${P.done.has(ch.id) ? "Watch again" : "Start"}</button>${i > 0 ? `<button class="linkish" data-act="prevch">Back to chapter ${i}</button>` : ""}</div></div>`;
  $("#over").hidden = false;
}
function showEnd() {
  const ch = cur(), i = P.i, last = i === CH.length - 1;
  const seen = new Map<string, number>();
  ch.lines.forEach((l, j) => { if (l.key && !seen.has(l.key) && targetOf(l.key)) seen.set(l.key, j); });
  const auto = TW.auto === "next" && !last, wait = 8;
  $("#over").innerHTML = `<div class="oc"><span class="lbl">Chapter ${i + 1} of ${CH.length} · done</span><h1>${esc(ch.title)}</h1>
    <p>What the red dot pointed at. Tap one to hear that line again.</p>
    <div class="saw">${[...seen].map(([k, j]) => `<button data-line="${j}">${esc(ch.lines[j].pen || nameOf(k))}</button>`).join("")}</div>
    <div class="row">${last ? `<p>That's the whole course.</p><button class="linkish" data-act="restart">Start again from chapter 1</button>` : `<button class="big" data-act="next">${auto ? `<svg class="ring" viewBox="0 0 24 24"><circle class="bg" cx="12" cy="12" r="9"/><circle id="ringArc" cx="12" cy="12" r="9" stroke-dasharray="56.5" stroke-dashoffset="0" transform="rotate(-90 12 12)"/></svg>` : PLAY_ICON}Next: ${esc(CH[i + 1].title)}</button>${auto ? `<button class="linkish" data-act="stay">Wait for me</button>` : ""}`}
    <button class="linkish" data-act="again">Watch again</button></div></div>`;
  $("#over").hidden = false;
  if (auto) {
    const arc = $("#ringArc") as unknown as SVGCircleElement;
    requestAnimationFrame(() => { arc.style.transition = `stroke-dashoffset ${wait}s linear`; arc.style.strokeDashoffset = "56.5"; });
    P.endTimer = window.setTimeout(() => load(P.i + 1, true), wait * 1000);
  }
}
function stopCountdown() {
  clearTimeout(P.endTimer); P.endTimer = 0;
  const arc = document.getElementById("ringArc");
  arc?.closest("svg")?.remove();
  $('[data-act="stay"]')?.remove();
}

/* ---------- clock ---------- */
function load(i: number, autoplay = false) {
  stopCountdown(); pause();
  P.i = clamp(i, 0, CH.length - 1); P.t = 0; P.line = -2; P.cue = -2; P.started = false;
  store.set("ch", P.i);
  const ch = cur();
  canvasIn.innerHTML = STAGE[ch.stage]();
  stage.classList.remove("live");
  hidePointer();
  MENT = mentions(ch); opened.clear();
  $("#courseName").textContent = COURSE;
  $("#where").textContent = `Chapter ${P.i + 1} of ${CH.length} · ${ch.title}`;
  $("#files").innerHTML = ch.files?.length ? `<span class="lbl">Where this lives</span>${ch.files.map((f) => `<span>${esc(f)}</span>`).join("")}` : "";
  renderMap(); renderBeats(); renderToc();
  showStart();
  update(true);
  if (autoplay) play();
}
function begin() {
  if (!P.started) { P.started = true; store.set("howto", true); }
  $("#over").hidden = true;
  stage.classList.add("live");
}
function play() {
  stopCountdown(); closeDrawers();
  if (P.t >= cur().duration - 0.05) { P.t = 0; P.cue = -2; }
  begin();
  P.playing = true; P.last = performance.now();
  document.body.classList.add("playing");
  $("#playBtn").setAttribute("aria-label", "Pause");
  update(true);
  cancelAnimationFrame(P.raf); P.raf = requestAnimationFrame(tick);
  syncPaused();
}
function pause() {
  P.playing = false;
  document.body.classList.remove("playing");
  $("#playBtn").setAttribute("aria-label", "Play");
  cancelAnimationFrame(P.raf);
  syncPaused();
}
function syncPaused() {
  const asking = P.started && !P.playing && $("#over").hidden === true;
  $("#paused").hidden = !asking;
  stage.classList.toggle("asking", asking);
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
  pause();
  hidePointer(); P.cue = -2;
  renderMap(); renderToc();
  showEnd();
}
function toLine(j: number) {
  const ch = cur();
  stopCountdown();
  // Just past where the line points, so a jump made while paused shows what this line is about, not the last one.
  P.t = ch.lines[clamp(j, 0, ch.lines.length - 1)].t + POINT_DELAY;
  begin();
  update(true);
  syncPaused();
}
const lineNow = () => Math.max(0, P.line);
function back() { const l = cur().lines[lineNow()]; toLine(P.t - (l?.t ?? 0) < 1.5 ? lineNow() - 1 : lineNow()); }
function fwd() { const n = lineNow() + 1; if (n < cur().lines.length) toLine(n); else if (P.started) { P.t = cur().duration; update(); ended(); } }
function again() { toLine(lineNow()); if (!P.playing) play(); }

function update(force = false) {
  const ch = cur(), t = P.t;
  $("#time").textContent = fmtT(t) + " / " + fmtT(ch.duration);
  let li = -1; ch.lines.forEach((l, j) => { if (l.t <= t + 0.05) li = j; });
  if (!P.started) li = -1;
  if (li !== P.line || force) { P.line = li; renderLine(); renderNotes(); }
  $$(".beat").forEach((b, j) => {
    const l = ch.lines[j];
    b.style.setProperty("--p", String(j < li ? 1 : j > li ? 0 : clamp((t - l.t) / (l.end - l.t), 0, 1)));
    b.classList.toggle("cur", j === li);
  });
  $(".m-ch.cur")?.style.setProperty("--p", String(t / ch.duration));
  let qi = -1; if (P.started) ch.lines.forEach((l, j) => { if (l.key && l.t + POINT_DELAY <= t + 0.04) qi = j; });
  if (qi !== P.cue || force) {
    const fresh = qi !== P.cue;
    P.cue = qi;
    if (qi >= 0) pointAt(ch.lines[qi].key, ch.lines[qi].pen, fresh); else if (fresh) hidePointer();
  }
  if (P.started) $$("[data-k]", canvasIn).forEach((el) => { const k = el.dataset.k!; el.classList.toggle("seen", !(k in ch.reveal) || ch.reveal[k] <= t + 0.04); });
}
function fit() {
  if (!stage.clientWidth) return;
  P.k = stage.clientWidth / 960;
  canvas.style.setProperty("--k", String(P.k));
  update(true);
}

/* ---------- drawers: contents, words, ask; and the tweaks panel ---------- */
const DRAWERS = { contents: "#contentsBtn", words: "#wordsBtn", ask: "#askBtn" } as const;
type Drawer = keyof typeof DRAWERS;
// Asking keeps the picture in full view, so what you asked about stays lit; the other drawers cover it.
function openDrawer(id: Drawer) {
  pause();
  for (const [d, btn] of Object.entries(DRAWERS)) { $("#" + d).hidden = d !== id; $(btn).setAttribute("aria-expanded", String(d === id)); }
  $("#scrim").hidden = id === "ask";
}
function closeDrawers() {
  for (const [d, btn] of Object.entries(DRAWERS)) { $("#" + d).hidden = true; $(btn).setAttribute("aria-expanded", "false"); }
  $("#scrim").hidden = true;
}
function renderWords(q = "") {
  const low = q.trim().toLowerCase();
  $("#wordList").innerHTML = GROUPS.map(([g, name]) => {
    const ks = Object.keys(G).filter((k) => G[k][0] === g && (!low || [G[k][1], G[k][2], G[k][3]].some((s) => s.toLowerCase().includes(low))));
    return ks.length ? `<div class="wg"><h3>${esc(name)}</h3>${ks.map((k) => `<div class="wc" id="w-${k}"><b>${esc(G[k][1])}</b><p>${esc(G[k][2])}</p><p>${esc(G[k][3])}</p></div>`).join("")}</div>` : "";
  }).join("") || `<p class="note-empty">No word matches “${esc(q)}”.</p>`;
}
function openWord(k: string) {
  ($("#wordSearch") as HTMLInputElement).value = ""; renderWords();
  openDrawer("words");
  const card = document.getElementById("w-" + k);
  if (card) { card.scrollIntoView({ block: "start" }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1600); }
}
const ASK = { about: "" };
function openAsk(key?: string) {
  const ch = cur(), li = lineNow();
  if (key) {
    const name = nameOf(key, 80) || key;
    ASK.about = name;
    $("#askCtx").innerHTML = `About <b>${esc(name)}</b>, in chapter ${P.i + 1}`;
  } else {
    ASK.about = ch.lines[li]?.text ?? ch.title;
    $("#askCtx").innerHTML = P.started ? `About the line: <b>“${esc(ch.lines[li].text)}”</b>` : `About chapter ${P.i + 1}: <b>${esc(ch.title)}</b>`;
  }
  $("#askSug").innerHTML = ["Say that more simply", "Why does this matter?", "Give me an example", "How does it connect to the last chapter?"].map((s) => `<button class="chip" data-sug="${esc(s)}">${s}</button>`).join("");
  openDrawer("ask");
  ($("#askInput") as HTMLTextAreaElement).focus();
}
function ask(q: string) {
  if (!q.trim()) return;
  const log = $("#askLog");
  log.insertAdjacentHTML("beforeend", `<div class="msg me">${esc(q)}</div>`);
  setTimeout(() => {
    log.insertAdjacentHTML("beforeend", `<div class="msg them">This is a mockup, so no model answers yet. Here Claude would answer in the course's plain words, and could move the red dot in the picture while it explains.</div>`);
    log.scrollTop = log.scrollHeight;
  }, 500);
  ($("#askInput") as HTMLTextAreaElement).value = "";
}
function toggleTweaks(show = !!$("#tweaks").hidden) {
  $("#tweaks").hidden = !show;
  $("#tweaksBtn").setAttribute("aria-expanded", String(show));
}

/* ---------- map tooltip ---------- */
const tip = document.createElement("div");
tip.className = "m-tip"; tip.hidden = true; document.body.appendChild(tip);
function showTip(e: PointerEvent) {
  const b = (e.target as Element).closest<HTMLElement>(".m-ch");
  if (!b) { tip.hidden = true; return; }
  const i = +b.dataset.ch!;
  tip.innerHTML = `${String(i + 1).padStart(2, "0")} · ${esc(CH[i].title)}<span>${P.done.has(CH[i].id) ? "✓ " : ""}${fmtT(CH[i].duration)}</span>`;
  tip.hidden = false;
  const r = b.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + "px";
  tip.style.top = r.bottom + 6 + "px";
}

/* ---------- wiring ---------- */
function bind() {
  $("#playBtn").addEventListener("click", () => (P.playing ? pause() : play()));
  $("#backBtn").addEventListener("click", back);
  $("#fwdBtn").addEventListener("click", fwd);
  $("#againBtn").addEventListener("click", again);
  $("#beats").addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-line]"); if (b) toLine(+b.dataset.line!); });
  $("#pace").innerHTML = [[0.85, "Slower"], [1, "Normal"], [1.15, "Faster"]].map(([v, l]) => `<button role="radio" data-pace="${v}" aria-checked="${P.pace === v}">${l}</button>`).join("");
  $("#pace").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-pace]"); if (!b) return;
    P.pace = +b.dataset.pace!; store.set("pace", P.pace);
    $$("[data-pace]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  });
  $("#map").addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-ch]"); if (b) load(+b.dataset.ch!); });
  $("#map").addEventListener("pointerover", showTip);
  $("#map").addEventListener("pointerleave", () => { tip.hidden = true; });
  $("#toc").addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-ch]"); if (b) { closeDrawers(); load(+b.dataset.ch!); } });

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
  // The picture: a word opens its meaning; while playing, a click pauses; while paused, a click on a thing asks about it.
  canvasIn.addEventListener("click", (e) => {
    if (!P.started) return;
    const term = (e.target as Element).closest<HTMLElement>(".term");
    if (term) { openWord(term.dataset.term!); return; }
    const el = (e.target as Element).closest<HTMLElement>("[data-k]");
    if (P.playing) { pause(); if (!el) return; }
    if (el) { pointAt(el.dataset.k, undefined, true); openAsk(el.dataset.k); }
    else play();
  });

  $("#contentsBtn").addEventListener("click", () => ($("#contents").hidden ? openDrawer("contents") : closeDrawers()));
  $("#wordsBtn").addEventListener("click", () => { if ($("#words").hidden) { renderWords(($("#wordSearch") as HTMLInputElement).value); openDrawer("words"); } else closeDrawers(); });
  $("#askBtn").addEventListener("click", () => ($("#ask").hidden ? openAsk() : closeDrawers()));
  $("#tweaksBtn").addEventListener("click", () => toggleTweaks());
  $("#scrim").addEventListener("click", closeDrawers);
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => (b.closest("#tweaks") ? toggleTweaks(false) : closeDrawers())));
  $("#wordSearch").addEventListener("input", (e) => renderWords((e.target as HTMLInputElement).value));
  $("#noteList").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.more) { opened.add(t.dataset.more); renderNotes(); }
    else if (t.dataset.word) openWord(t.dataset.word);
  });
  $("#askSug").addEventListener("click", (e) => { const s = (e.target as HTMLElement).dataset.sug; if (s) ask(s); });
  $("#askForm").addEventListener("submit", (e) => { e.preventDefault(); ask(($("#askInput") as HTMLTextAreaElement).value); });
  $("#askInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask((e.target as HTMLTextAreaElement).value); } });

  $("#tweakList").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-tw]"); if (!b) return;
    const id = b.dataset.tw as TweakId;
    TW[id] = b.dataset.v!; store.set("tw:" + id, TW[id]);
    applyTweaks(); renderTweaks();
    if (id === "pointer" || id === "dim") { P.cue = -2; update(true); }
    else requestAnimationFrame(fit);
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = (e.target as Element).closest("input, textarea, select");
    if (e.key === "Escape") { closeDrawers(); toggleTweaks(false); return; }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); if (P.playing) pause(); else play(); }
    else if (k === "arrowleft") { e.preventDefault(); back(); }
    else if (k === "arrowright") { e.preventDefault(); fwd(); }
    else if (k === "r") again();
    else if (k === "t") toggleTweaks();
    else if (k === "c") ($("#contents").hidden ? openDrawer("contents") : closeDrawers());
    else if (k === "w") $("#wordsBtn").click();
  });
  new ResizeObserver(() => requestAnimationFrame(fit)).observe(stage);
}

applyTweaks();
renderTweaks();
bind();
document.fonts.ready.then(() => fit());
load(store.get("ch", 0));
