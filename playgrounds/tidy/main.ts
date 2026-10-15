// Tidy pass playground: a scene as the model wrote it, and the same scene after
// near-misses are made equal, aligned, evenly spaced and snapped.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import grid from "../../src/fixtures/grid.ops.txt?raw";
import messy from "../../src/fixtures/messy.ops.txt?raw";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import type { Scene } from "../../src/core/scene.ts";
import { type Move, tidy } from "../../src/core/tidy.ts";
import { DEFAULTS, type Tuning } from "../../src/core/tuning.ts";
import { $, fontsReady, shell, stage, tuningPanel } from "../../src/ui.ts";

shell("tidy", "The model places things nearly right. The tidy pass makes almost-equal sizes equal, aligns edges that almost line up, evens out almost-equal gaps, then snaps to a fine grid. The faint ghost is the scene as written; hover a move to see the shape.");
const fixtures: Record<string, string> = { "Messy shop (off by a few px)": messy, "Clowns.com (pixels)": clowns, "Settings screen (grid cells)": grid };

$("#left").innerHTML = `<div class="row" style="margin-bottom:8px"><label><input type="radio" name="view" value="ghost" checked> after, over a ghost of before</label><label><input type="radio" name="view" value="before"> before</label><label><input type="radio" name="view" value="after"> after</label><label><input type="radio" name="view" value="side"> side by side</label></div><div id="stages"></div>`;
const before = stage($("#stages"));
const after = stage($("#stages"), 1280, 800, true);
// The ink layer doubles as the ghost: the scene as written, faint, on top.
const ghost = after.ink!;
ghost.style.pointerEvents = "none";
ghost.style.opacity = "0.3";
ghost.style.cursor = "default";

$("#side").innerHTML = `
  <div class="card">
    <h2>Scene</h2>
    <div class="row"><select id="fixture">${Object.keys(fixtures).map((k) => `<option>${k}</option>`).join("")}</select></div>
    <textarea id="src" rows="10" spellcheck="false"></textarea>
    <div class="stat" id="stat"></div>
    <pre class="log bad" id="errors"></pre>
  </div>
  <div class="card"><h2>Moves</h2><div style="max-height:360px;overflow:auto"><table class="marks"><thead><tr><th>id</th><th>rule</th><th>Δ</th><th>why</th></tr></thead><tbody id="moves"></tbody></table></div></div>`;

const src = $<HTMLTextAreaElement>("#src");
const fixture = $<HTMLSelectElement>("#fixture");
let tuning: Tuning = DEFAULTS;
let current: { written: Scene; tidied: Scene; moves: Move[] } | undefined;
const RULE_COLORS: Record<string, string> = { size: "#7048e8", align: "#1971c2", gap: "#2b8a3e", snap: "#868e96", follow: "#adb5bd" };

const view = () => document.querySelector<HTMLInputElement>('input[name="view"]:checked')!.value;

/** Two renders of the same ids on one page would share clip-path ids; give each svg its own. */
function ownIds(svg: SVGSVGElement, prefix: string) {
  for (const el of svg.querySelectorAll("[id]")) el.id = `${prefix}-${el.id}`;
  for (const el of svg.querySelectorAll("[clip-path]")) el.setAttribute("clip-path", el.getAttribute("clip-path")!.replace("url(#", `url(#${prefix}-`));
}

function paint(hover?: string) {
  if (!current) return;
  const highlight = hover ? new Map([[hover, "#e8590c"]]) : undefined;
  const v = view();
  render(before.canvas, current.written, { tags: true, highlight, tuning });
  ownIds(before.canvas, "before");
  render(after.canvas, current.tidied, { tags: v !== "ghost", highlight, tuning });
  render(ghost, current.written, { tuning });
  ownIds(ghost, "ghost");
  // Drop the ghost's white page so only its shapes show over the tidied scene.
  ghost.querySelector(":scope > rect")?.remove();
  ghost.style.display = v === "ghost" ? "" : "none";
  const [b, a] = [before.canvas.parentElement!, after.canvas.parentElement!];
  b.style.display = v === "before" || v === "side" ? "" : "none";
  a.style.display = v === "before" ? "none" : "";
  const host = $("#stages");
  host.style.display = v === "side" ? "grid" : "";
  host.style.gridTemplateColumns = v === "side" ? "1fr 1fr" : "";
  host.style.gap = "8px";
}

function run() {
  const { scene: written, errors } = runScript(src.value, undefined, tuning);
  const t0 = performance.now();
  const { scene: tidied, moves } = tidy(written, tuning);
  const ms = performance.now() - t0;
  current = { written, tidied, moves };
  const moved = new Set(moves.map((m) => m.id)).size;
  const by = Object.entries(moves.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.rule]: (acc[m.rule] ?? 0) + 1 }), {})).map(([r, n]) => `${n} ${r}`).join(", ");
  $("#stat").textContent = `${moves.length} moves (${by || "none"}) on ${moved} of ${written.shapes.size} shapes · tidied in ${ms.toFixed(1)} ms`;
  $("#errors").textContent = errors.map((e) => `✗ ${e.line}\n   ${e.error}`).join("\n");
  const delta = (m: Move) => {
    const f = m.features;
    return [f.dx && `x${f.dx > 0 ? "+" : ""}${f.dx}`, f.dy && `y${f.dy > 0 ? "+" : ""}${f.dy}`, f.dw && `w${f.dw > 0 ? "+" : ""}${f.dw}`, f.dh && `h${f.dh > 0 ? "+" : ""}${f.dh}`].filter(Boolean).join(" ");
  };
  $("#moves").innerHTML = moves.map((m) => `<tr data-id="${m.id}"><td><b>${m.id}</b></td><td style="color:${RULE_COLORS[m.rule]}">${m.rule}</td><td class="stat">${delta(m)}</td><td class="muted">${m.why}</td></tr>`).join("") || `<tr><td class="muted" colspan="4">Nothing to tidy at these knobs.</td></tr>`;
  paint();
}

$("#moves").addEventListener("mouseover", (e) => {
  const id = (e.target as Element).closest<HTMLElement>("tr[data-id]")?.dataset.id;
  if (id) paint(id);
});
$("#moves").addEventListener("mouseleave", () => paint());
for (const r of document.querySelectorAll('input[name="view"]')) r.addEventListener("change", () => paint());

tuningPanel($("#side"), ["tidy", "render"], (t) => {
  tuning = t;
  run();
});

let timer = 0;
src.addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(run, 200);
});
fixture.addEventListener("change", () => {
  src.value = fixtures[fixture.value];
  run();
});

src.value = fixtures[fixture.value];
fontsReady().then(run);
