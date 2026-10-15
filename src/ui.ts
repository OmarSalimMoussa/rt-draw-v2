// The shell every playground shares: a header with links between them, and a
// stage that stacks the canvas <svg> under an ink <svg> with the same viewBox.
import "./ui.css";
import { DEFAULTS, type Tuning, diff, knobsOf, patchesOff, tune, tuningId } from "./core/tuning.ts";

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
  /** The knobs as set; with patches off, the patch knobs read neutral but these values come back. */
  let base: Tuning = DEFAULTS;
  let off = false;
  const live = () => (off ? patchesOff(base) : base);
  const patchKnobs = parts.flatMap(knobsOf).filter((k) => k.patches);
  const models = [...new Set(patchKnobs.map((k) => k.patches))].join(", ");
  const card = document.createElement("div");
  card.className = "card knobs";
  card.innerHTML = `<h2>Knobs</h2>${patchKnobs.length ? `<div class="row"><button data-act="patches" aria-pressed="false" title="Sets every knob that adjusts ${models} to neutral, so you hear or see the model alone">Patches off</button><span class="muted">${models} as it comes</span></div>` : ""}${parts
    .map((part, i) => `<details${i ? "" : " open"}><summary>${part}</summary>${knobsOf(part)
      .map((k) => `<label title="${k.key}: ${k.doc}${k.patches ? ` (patches ${k.patches})` : ""}"><span>${k.patches ? "⚙ " : ""}${k.doc}${k.unit ? ` (${k.unit})` : ""}</span><input type="range" data-key="${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${k.value}"><span class="stat" data-v="${k.key}">${k.value}</span></label>`)
      .join("")}</details>`)
    .join("")}<div class="row"><button data-act="reset">Defaults</button><button data-act="copy">Copy changes</button><span class="stat" data-id></span></div>`;
  host.append(card);
  const show = () => {
    const t = live();
    for (const input of card.querySelectorAll<HTMLInputElement>("input[data-key]")) {
      const k = input.dataset.key!;
      const isPatch = patchKnobs.some((p) => p.key === k);
      input.disabled = off && isPatch;
      input.value = String(t[k]);
      // A patch with no neutral value isn't sent at all: the model's own default applies.
      const unsent = off && isPatch && patchKnobs.find((p) => p.key === k)!.neutral === undefined;
      card.querySelector(`[data-v="${k}"]`)!.textContent = unsent ? "model" : String(t[k]);
    }
    const btn = card.querySelector<HTMLButtonElement>('[data-act="patches"]');
    if (btn) {
      btn.setAttribute("aria-pressed", String(off));
      btn.classList.toggle("primary", off);
    }
    const changed = Object.keys(diff(t)).length;
    card.querySelector("[data-id]")!.textContent = off ? `patches off · ${tuningId(t)}` : changed ? `${tuningId(t)} · ${changed} changed` : "defaults";
  };
  const set = () => {
    show();
    onChange(live());
  };
  card.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.key) return;
    base = tune({ [input.dataset.key]: Number(input.value) }, base);
    set();
  });
  card.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    if (act === "reset") [base, off] = [DEFAULTS, false];
    else if (act === "patches") off = !off;
    else if (act === "copy") return void navigator.clipboard?.writeText(JSON.stringify(diff(live()), null, 1));
    else return;
    set();
  });
  show();
  return {
    get: live,
    /** Load a saved tuning (only known knobs; the rest stay default). A saved "patches off" turns them off here too. */
    load: (saved: Record<string, number>) => {
      base = tune(Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULTS && k !== "patches.off")));
      off = saved["patches.off"] === 1;
      set();
    },
  };
}
