// A stage with a camera over an infinite board: scroll to pan, ctrl (or ⌘)
// scroll to zoom at the pointer, hold space and drag (or drag with the middle
// button) to pan. The pen draws in board pixels wherever the camera is. Moving
// the camera only changes the viewBox; the scene is redrawn when it changes.
import { ASPECT, type View } from "./core/board.ts";
import { stage } from "./ui.ts";

export type BoardStage = {
  canvas: SVGSVGElement;
  ink: SVGSVGElement;
  view: () => View;
  /** Moves the camera, gliding over `ms` when given. */
  setView: (v: View, ms?: number) => Promise<void>;
  /** Called after every camera move. */
  onMove: (fn: (v: View) => void) => void;
};

export function boardStage(host: HTMLElement, start: View): BoardStage {
  const { canvas, ink } = stage(host, 1280, 800, true);
  const wrap = canvas.parentElement!;
  let view = { ...start };
  const listeners: ((v: View) => void)[] = [];
  const apply = () => {
    const vb = `${view.x} ${view.y} ${view.w} ${view.h}`;
    canvas.setAttribute("viewBox", vb);
    ink!.setAttribute("viewBox", vb);
    // The board's background follows the camera (render() put it first, after <defs>).
    const bg = canvas.querySelector(":scope > rect");
    if (bg) for (const [k, v] of Object.entries({ x: view.x, y: view.y, width: view.w, height: view.h })) bg.setAttribute(k, String(v));
    for (const fn of listeners) fn(view);
  };
  const clampW = (w: number) => Math.max(80, Math.min(200000, w));
  const toBoard = (clientX: number, clientY: number) => {
    const r = wrap.getBoundingClientRect();
    return [view.x + ((clientX - r.left) / r.width) * view.w, view.y + ((clientY - r.top) / r.height) * view.h];
  };

  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const [px, py] = toBoard(e.clientX, e.clientY);
      const w = clampW(view.w * Math.exp(e.deltaY * 0.0015));
      const k = w / view.w;
      view = { x: px - (px - view.x) * k, y: py - (py - view.y) * k, w, h: w / ASPECT };
    } else view = { ...view, x: view.x + (e.deltaX * view.w) / r.width, y: view.y + (e.deltaY * view.h) / r.height };
    apply();
  }, { passive: false });

  let space = false;
  const typing = () => ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "");
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !typing()) {
      space = true;
      wrap.style.cursor = "grab";
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      space = false;
      wrap.style.cursor = "";
    }
  });
  // Capture phase, so a pan never reaches the pen.
  wrap.addEventListener("pointerdown", (e) => {
    if (!space && e.button !== 1) return;
    e.stopPropagation();
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    let [lx, ly] = [e.clientX, e.clientY];
    const move = (m: PointerEvent) => {
      view = { ...view, x: view.x - ((m.clientX - lx) * view.w) / r.width, y: view.y - ((m.clientY - ly) * view.h) / r.height };
      [lx, ly] = [m.clientX, m.clientY];
      apply();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, { capture: true });

  let anim = 0;
  const setView = (to: View, ms = 0) =>
    new Promise<void>((done) => {
      cancelAnimationFrame(anim);
      const from = { ...view };
      if (!ms) {
        view = { ...to };
        apply();
        return done();
      }
      const t0 = performance.now();
      const step = () => {
        const u = Math.min(1, (performance.now() - t0) / ms);
        const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
        // Zoom glides evenly in scale (log of the width), not in pixels.
        const w = Math.exp(Math.log(from.w) + (Math.log(to.w) - Math.log(from.w)) * e);
        const cx = from.x + from.w / 2 + (to.x + to.w / 2 - from.x - from.w / 2) * e;
        const cy = from.y + from.h / 2 + (to.y + to.h / 2 - from.y - from.h / 2) * e;
        view = { x: cx - w / 2, y: cy - w / ASPECT / 2, w, h: w / ASPECT };
        apply();
        if (u < 1) anim = requestAnimationFrame(step);
        else done();
      };
      step();
    });
  apply();
  return { canvas, ink: ink!, view: () => view, setView, onMove: (fn) => listeners.push(fn) };
}
