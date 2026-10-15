// The shell every playground shares: a header with links between them, and a
// stage that stacks the canvas <svg> under an ink <svg> with the same viewBox.
import "./ui.css";
import { DEFAULTS, type Tuning, diff, knobsOf, patching, tune, tuningId } from "./core/tuning.ts";

export const PLAYGROUNDS = [
  ["render", "Renderer"],
  ["ops", "Ops stream"],
  ["ink", "Ink"],
  ["hittest", "Hit-test"],
  ["marks", "Marks"],
  ["speech", "Speech"],
  ["link", "Ink ↔ words"],
  ["shot", "Model screenshot"],
  ["coords", "Coordinates"],
  ["tidy", "Tidy pass"],
  ["describe", "Descriptions"],
  ["resolve", "Resolver"],
  ["draw", "Drawing model"],
  ["picture", "Pictures"],
  ["router", "Router"],
] as const;

export function shell(current: string, blurb: string) {
  const header = document.createElement("header");
  header.className = "bar";
  header.innerHTML = `<h1><a href="/" style="color:inherit;text-decoration:none">rt-draw v2</a></h1><nav>${PLAYGROUNDS.map(([p, name]) => `<a href="/playgrounds/${p}/"${p === current ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav><p>${blurb}</p>`;
  document.body.prepend(header);
}

export function stage(host: HTMLElement, width = 1280, height = 800, withInk = false) {
  const wrap = document.createElement("div");
  wrap.className = "stage";
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
  wrap.append(canvas);
  let ink: SVGSVGElement | undefined;
  if (withInk) {
    ink = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ink.setAttribute("viewBox", `0 0 ${width} ${height}`);
    ink.classList.add("ink");
    wrap.append(ink);
  }
  host.append(wrap);
  return { canvas, ink };
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Saves text as a file in the browser's downloads. */
export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Waits for Excalifont, so text is measured with the right widths. */
export const fontsReady = () => document.fonts.load("20px Excalifont").then(() => undefined);

/**
 * Sliders for every knob of the given parts, built from the registry, so any
 * playground can tune the parts it shows. Says which tuning is live (its id is
 * what saved sets and logs record) and copies the changed knobs to paste back.
 */
export function tuningPanel(host: HTMLElement, parts: string[], onChange: (t: Tuning) => void) {
  let t: Tuning = DEFAULTS;
  const patchKnobs = parts.flatMap(knobsOf).filter((k) => k.patches);
  const models = [...new Set(patchKnobs.map((k) => k.patches!))];
  const card = document.createElement("div");
  card.className = "card knobs";
  // One switch per patched model, off by default: the model as it comes is the baseline.
  card.innerHTML = `<h2>Knobs</h2>${models.map((m) => `<div class="row"><button data-act="patches" data-model="${m}" title="Turns our ⚙ adjustments to ${m}'s output on or off; off is ${m} exactly as it comes"></button></div>`).join("")}${parts
    .map((part, i) => `<details${i ? "" : " open"}><summary>${part}</summary>${knobsOf(part)
      .map((k) => `<label title="${k.key}: ${k.doc}${k.patches ? ` (patches ${k.patches})` : ""}"><span>${k.patches ? "⚙ " : ""}${k.doc}${k.unit ? ` (${k.unit})` : ""}</span><input type="range" data-key="${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${k.value}"><span class="stat" data-v="${k.key}">${k.value}</span></label>`)
      .join("")}</details>`)
    .join("")}<div class="row"><button data-act="reset">Defaults</button><button data-act="copy">Copy changes</button><span class="stat" data-id></span></div>`;
  host.append(card);
  const show = () => {
    for (const input of card.querySelectorAll<HTMLInputElement>("input[data-key]")) {
      const k = input.dataset.key!;
      const p = patchKnobs.find((x) => x.key === k);
      const off = !!p && !patching(t, p.patches!);
      input.disabled = off;
      input.value = String(t[k]);
      // Off: a patch reads neutral, or "model" when it isn't sent at all (the model's own default).
      card.querySelector(`[data-v="${k}"]`)!.textContent = off ? (p!.neutral === undefined ? "model" : String(p!.neutral)) : String(t[k]);
    }
    for (const btn of card.querySelectorAll<HTMLButtonElement>('[data-act="patches"]')) {
      const on = patching(t, btn.dataset.model!);
      btn.textContent = on ? `${btn.dataset.model} patches: on` : `${btn.dataset.model} patches: off (as it comes)`;
      btn.classList.toggle("primary", on);
    }
    const changed = Object.keys(diff(t)).length;
    card.querySelector("[data-id]")!.textContent = changed ? `${tuningId(t)} · ${changed} changed` : "defaults";
  };
  const set = (next: Tuning) => {
    t = next;
    show();
    onChange(t);
  };
  card.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.key) set(tune({ [input.dataset.key]: Number(input.value) }, t));
  });
  card.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const act = el.dataset.act;
    if (act === "reset") set(DEFAULTS);
    if (act === "patches") set(tune({ [`patches.${el.dataset.model}`]: patching(t, el.dataset.model!) ? 0 : 1 }, t));
    if (act === "copy") navigator.clipboard?.writeText(JSON.stringify(diff(t), null, 1));
  });
  show();
  return {
    get: () => t,
    /** Load a saved tuning (only known knobs; the rest stay default). */
    load: (saved: Record<string, number>) => set(tune(Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULTS)))),
  };
}
