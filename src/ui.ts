// The shell every playground shares: a header with links between them, and a
// stage that stacks the canvas <svg> under an ink <svg> with the same viewBox.
import "./ui.css";

export const PLAYGROUNDS = [
  ["render", "Renderer"],
  ["ops", "Ops stream"],
  ["ink", "Ink"],
  ["hittest", "Hit-test"],
  ["marks", "Marks"],
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
