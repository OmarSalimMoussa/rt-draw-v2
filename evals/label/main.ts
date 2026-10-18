// The owner's labeling page (§4.5): the packet the judge saw, labelled by key
// (1/2 clearly left/right, q/w slightly, 3 tie or both bad, s skip, u undo), then a
// craft pass on the screens only; and "your sends", where he writes what he meant
// in each send he recorded with /playgrounds/draw/?record=1 (§2.8). Everything is
// kept on the server: the page stores nothing in the browser and never learns
// which side is which arm.
import { type Stroke, strokePath } from "../../src/core/ink.ts";
import { render } from "../../src/core/render.ts";
import { Scene, type Shape } from "../../src/core/scene.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";
import { $, fontsReady, shell } from "../../src/ui.ts";

shell("", "Labels for the eval's judges: pick the better result the way the judge is asked to, one key per pair (~15 s each, ~25–30 min once). Your labels and your recorded sends stay on the server. No model call.");

type Side = { image: string; changed?: string; changes?: string[]; framed?: boolean };
type Pair = { id: string; question: "fidelity" | "craft"; said?: string; meant?: string; hedged?: boolean; targetParts?: string; before?: string; left: Side; right: Side };
type Pairs = { total: number; progress: { clear: number; clearGoal: number; craft: number; craftGoal: number; labelled: number }; pairs: Pair[]; error?: string };
type Send = { id: string; at?: string; recordedAt: string; input: { word: string }[] | string; strokes: Stroke[]; scene: { width: number; height: number; shapes: Shape[]; groups?: Record<string, string[]> }; view?: { x: number; y: number; w: number; h: number }; meant?: string };

const KEYS: Record<string, { side: "left" | "right" | "tie" | "skip"; strength?: "clear" | "slight"; name: string }> = {
  "1": { side: "left", strength: "clear", name: "clearly left" },
  "2": { side: "right", strength: "clear", name: "clearly right" },
  q: { side: "left", strength: "slight", name: "slightly left" },
  w: { side: "right", strength: "slight", name: "slightly right" },
  "3": { side: "tie", name: "tie or both bad" },
  s: { side: "skip", name: "skip" },
};
const QUESTION = { fidelity: "Which result does what they meant in this step, better?", craft: "Which is the better wireframe?" };
const INK = "#e03131";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

let tab: "pairs" | "sends" = "pairs";
let data: Pairs | undefined;
let shownAt = performance.now();
const openedAt = performance.now();
let busy = false;

// ---- Pairs

async function loadPairs() {
  data = await fetch("/api/eval/pairs").then((r) => r.json());
  showPair();
}

function showPair() {
  const host = $("#pairs");
  const p = data?.progress;
  const head = p ? `${p.clear} of ${p.clearGoal} clear fidelity labels · ${p.craft} of ${p.craftGoal} craft · ${data!.pairs.length} pairs left` : "";
  const pair = data?.pairs[0];
  if (!pair) {
    host.innerHTML = `<div class="card"><h2>${data?.error ? "Can't load the pairs" : data?.total ? "All labelled" : "No pairs yet"}</h2><p class="muted">${esc(data?.error ?? (data?.total ? `${head}. Next: rte calib --check.` : "They appear after checkpoint 0 and the contrast run: rte calib --contrast draw.model=0 --cap 200."))}</p></div>`;
    return;
  }
  const side = (name: string, s: Side) => `<figure><figcaption>${name}${s.framed ? ", where the board changed (a screen moved away)" : ""}</figcaption><img src="${esc(s.image)}" alt="${name} result">${s.changed ? `<figcaption>${name}, where it changed (the screen moved away)</figcaption><img src="${esc(s.changed)}" alt="${name} result where it changed">` : ""}${s.changes ? `<ul>${s.changes.map((c) => `<li>${esc(c)}</li>`).join("") || "<li>nothing changed</li>"}</ul>` : ""}</figure>`;
  const words = pair.question === "fidelity"
    ? `<div><b>They said:</b> ${esc(pair.said)}</div><div><b>They meant:</b> ${esc(pair.meant)}${pair.hedged ? " <i>(they were unsure)</i>" : ""}</div>${pair.targetParts ? `<div class="muted">The site they have in mind, as context only: ${esc(pair.targetParts)}</div>` : ""}<figure class="before"><figcaption>before, with their ink</figcaption><img src="${esc(pair.before)}" alt="before"></figure>`
    : `<div class="muted">The screens only: ignore what was asked.</div>`;
  const keys = [...Object.entries(KEYS), ["u", { name: "undo" }] as const].map(([k, v]) => `<button data-key="${k}"><kbd>${k}</kbd>${v.name}</button>`).join("");
  host.innerHTML = `<div class="card" data-pair="${esc(pair.id)}" data-question="${pair.question}"><div class="row"><b>${pair.question === "craft" ? "Craft pass" : "Fidelity"}</b><span class="stat">${head}</span><span class="stat" id="timer"></span></div><h2>${QUESTION[pair.question]}</h2>${words}<div class="sides">${side("left", pair.left)}${side("right", pair.right)}</div><div class="row keys">${keys}</div></div>`;
  shownAt = performance.now();
  tick();
}

function tick() {
  const t = document.querySelector("#timer");
  if (t) t.textContent = `this pair ${clock(performance.now() - shownAt)} · in all ${clock(performance.now() - openedAt)}`;
}
setInterval(tick, 1000);

async function choose(key: string) {
  const pair = data?.pairs[0];
  const k = KEYS[key];
  if (busy || (key !== "u" && !(k && pair))) return;
  busy = true;
  try {
    if (key === "u") await post("/api/eval/label", { undo: true });
    else await post("/api/eval/label", { pair: pair!.id, question: pair!.question, side: k.side, strength: k.strength ?? null, ms: Math.round(performance.now() - shownAt) });
    await loadPairs();
  } finally {
    busy = false;
  }
}

window.addEventListener("keydown", (e) => {
  if (tab !== "pairs" || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, textarea")) return;
  const key = e.key.toLowerCase();
  if (!(key in KEYS) && key !== "u") return;
  e.preventDefault();
  void choose(key);
});
$("#pairs").addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
  if (key) void choose(key);
});

// ---- Your sends

/** A recorded before-scene back into a Scene (Scene.toJSON's shape: size, shapes back to front, groups). */
function sceneOf(j: Send["scene"]) {
  const scene = new Scene(j.width, j.height);
  for (const s of j.shapes) scene.add(s);
  for (const [g, members] of Object.entries(j.groups ?? {})) scene.groups.set(g, members);
  return scene;
}

async function showSends() {
  const host = $("#sends");
  const sends: Send[] = await fetch("/api/eval/human").then((r) => r.json());
  await fontsReady();
  host.innerHTML = sends.length ? "" : '<div class="card"><h2>No recorded sends yet</h2><p class="muted">Open /playgrounds/draw/?record=1 and use it as usual: each send is kept here for you to say what you meant.</p></div>';
  for (const s of sends) {
    const card = document.createElement("div");
    card.className = "card send";
    const said = typeof s.input === "string" ? `typed: ${s.input}` : s.input.map((w) => w.word).join(" ");
    card.innerHTML = `<div class="stage"><svg></svg></div><div style="display:grid;gap:8px"><span class="stat">${esc(new Date(s.recordedAt).toLocaleString())}</span><div><b>You said:</b> ${esc(said) || '<span class="muted">nothing</span>'}</div><label style="display:grid;gap:4px"><span>What you meant, in one line</span><input data-id="${esc(s.id)}" value="${esc(s.meant ?? "")}" placeholder="the hero photo gets twice as big"></label><div class="row"><button data-save="${esc(s.id)}">Save</button><span class="stat" data-saved></span></div></div>`;
    const svg = card.querySelector("svg")!;
    render(svg, sceneOf(s.scene), s.view ? { view: s.view } : {});
    // The ink at the size it had on screen, whatever the zoom.
    const size = (DEFAULTS["ink.size"] * (s.view?.w ?? s.scene.width)) / s.scene.width;
    for (const st of s.strokes ?? []) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", strokePath(st.points, size));
      path.setAttribute("fill", INK);
      svg.append(path);
    }
    host.append(card);
  }
}

async function saveMeant(id: string) {
  const input = document.querySelector<HTMLInputElement>(`input[data-id="${CSS.escape(id)}"]`)!;
  const r = await post("/api/eval/human", { id, meant: input.value });
  input.closest(".send")!.querySelector("[data-saved]")!.textContent = r.ok ? "saved" : `not saved: ${r.error}`;
}
$("#sends").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-save]")?.dataset.save;
  if (id) void saveMeant(id);
});
$("#sends").addEventListener("keydown", (e) => {
  const id = (e.target as HTMLElement).dataset.id;
  if (e.key === "Enter" && id) void saveMeant(id);
});

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  b.addEventListener("click", () => {
    tab = b.dataset.tab as typeof tab;
    for (const o of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) o.classList.toggle("primary", o === b);
    $("#pairs").hidden = tab !== "pairs";
    $("#sends").hidden = tab !== "sends";
    void (tab === "pairs" ? loadPairs() : showSends());
  });

void loadPairs();
