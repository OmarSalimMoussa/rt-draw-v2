// The canvas the pages sit on. No tools to pick between; what you do says what you mean:
//   hover: points ("this", "that" while talking);
//   press and drag (one finger, mouse or touch): draws in red marker; the app keeps each stroke;
//   two-finger scroll or the wheel: moves around (shift + wheel sideways);
//   pinch or ctrl/cmd + wheel: zooms.
// Moving around also works with space + drag, the middle button, the arrow keys (shift: further), and
// the hand button in the zoom controls (H), a sticky mode for people who can't hold space while
// dragging. `backdrop` (the board) is drawn first in screen coordinates, children in scene
// coordinates, and `overlay` on top in screen coordinates. (v1's Canvas.tsx: a stroke comes out
// with a time on every point, coalesced events included, as v2's pen records it, src/core/ink.ts.)
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Pt } from "../../../src/core/ink.ts";
import { type Point, type View, panBy, toScene, toScreen, zoomAt } from "./view.ts";
import { Icon } from "../sketch/Icon.tsx";

/** What a drag does: draw (the default), or move around (the hand). */
export type Tool = "draw" | "hand";

/** A press that moves less than this (screen px) is a click. */
const CLICK_SLOP = 4;
const GRID = 24;
/** How far an arrow key moves the view (screen px; shift: BIG). */
const STEP = 80;
const BIG = 400;

type Props = {
  view: View;
  onView(v: View): void;
  tool: Tool;
  /** Without it, there's no hand button or H key (the tool is fixed). */
  onTool?(t: Tool): void;
  /** Keyboard shortcuts only work in the active canvas. */
  active: boolean;
  /** A finished stroke: scene coordinates (to 0.1 px) and performance.now() times, from pen down to pen up. */
  onStroke?(raw: Pt[], downAt: number, upAt: number): void;
  /** The pointer moved over the canvas, or left it (null). */
  onPointer?(p: Point | null): void;
  /** Fit everything in view. */
  onFit?(): void;
  /** The pointer went down on the canvas to draw or move around, or came back up (null). */
  onHold?(kind: "draw" | "pan" | null): void;
  /** The user drew or moved around (e.g. to retire a hint about how to). */
  onGesture?(kind: "draw" | "move"): void;
  backdrop?: ReactNode;
  children?: ReactNode;
  overlay?: ReactNode;
};

type Drag = { kind: "pan" | "draw"; x: number; y: number; lastX: number; lastY: number; moved: boolean; points: Point[]; raw: Pt[]; downAt: number };

const tenth = (n: number) => Math.round(n * 10) / 10;

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function Canvas(p: Props) {
  const root = useRef<HTMLDivElement>(null);
  // Event handlers outlive renders; they read the latest props from here.
  const latest = useRef(p);
  latest.current = p;
  const drag = useRef<Drag | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number; view: View; cx: number; cy: number } | null>(null);
  const [live, setLive] = useState<Point[] | null>(null);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const { view, tool } = p;

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = root.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const center = () => {
    const r = root.current!.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  };
  const zoomBy = (k: number) => {
    const c = center();
    p.onView(zoomAt(view, c.x, c.y, view.zoom * k));
  };

  // The wheel has to be a non-passive listener to stop the browser zooming the whole page.
  useEffect(() => {
    const el = root.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, onView } = latest.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const [dx, dy] = [e.deltaX * unit, e.deltaY * unit];
      if (e.ctrlKey || e.metaKey) {
        const at = local(e);
        // Trackpad pinches send small steps; a mouse wheel notch is ~100, capped so one notch is ~1.3x.
        onView(zoomAt(v, at.x, at.y, v.zoom * Math.exp(-Math.max(-25, Math.min(25, dy)) * 0.01)));
      } else {
        onView(e.shiftKey && !dx ? panBy(v, -dy, 0) : panBy(v, -dx, -dy));
        latest.current.onGesture?.("move");
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!p.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const { onTool, onFit, tool: t } = latest.current;
      if (e.key === " ") {
        e.preventDefault();
        setSpace(e.type === "keydown");
        return;
      }
      if (e.type !== "keydown") return;
      const step = e.shiftKey ? BIG : STEP;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (arrows[e.key]) {
        p.onView(panBy(view, ...arrows[e.key]));
        p.onGesture?.("move");
      } else if (e.key.toLowerCase() === "h" && onTool) onTool(t === "hand" ? "draw" : "hand");
      else if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-") zoomBy(1 / 1.2);
      else if (e.key === "!" && e.shiftKey) onFit?.(); // shift+1, as in design tools
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
    };
  }, [p.active, view]);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    root.current!.setPointerCapture(e.pointerId);
    const at = local(e);
    touches.current.set(e.pointerId, at);
    if (touches.current.size === 2) {
      // Two fingers: pinch to zoom and pan; drop whatever the first finger started.
      const [a, b] = [...touches.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      drag.current = null;
      setLive(null);
      p.onHold?.("pan");
      return;
    }
    const kind = e.button === 1 || space || tool === "hand" ? "pan" : "draw";
    const s = toScene(view, at.x, at.y);
    const now = performance.now();
    drag.current = { kind, x: at.x, y: at.y, lastX: at.x, lastY: at.y, moved: false, points: [s], raw: [[tenth(s.x), tenth(s.y), now]], downAt: now };
    if (kind === "pan") setPanning(true);
    else setLive([s]);
    p.onHold?.(kind);
  }

  function onPointerMove(e: React.PointerEvent) {
    const at = local(e);
    p.onPointer?.(toScene(view, at.x, at.y));
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, at);
    const pc = pinch.current;
    if (pc && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      const [cx, cy] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const zoomed = zoomAt(pc.view, pc.cx, pc.cy, (pc.view.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pc.dist);
      p.onView(panBy(zoomed, cx - pc.cx, cy - pc.cy));
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(at.x - d.x, at.y - d.y) > CLICK_SLOP) d.moved = true;
    if (d.kind === "pan") {
      p.onView(panBy(view, at.x - d.lastX, at.y - d.lastY));
      p.onGesture?.("move");
      [d.lastX, d.lastY] = [at.x, at.y];
    } else {
      d.points.push(toScene(view, at.x, at.y));
      for (const ce of e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) {
        const l = local(ce);
        const q = toScene(view, l.x, l.y);
        d.raw.push([tenth(q.x), tenth(q.y), ce.timeStamp || performance.now()]);
      }
      setLive([...d.points]);
    }
  }

  function onPointerUp(e: React.PointerEvent, cancelled = false) {
    touches.current.delete(e.pointerId);
    const released = touches.current.size === 0;
    if (pinch.current) {
      if (touches.current.size < 2) pinch.current = null;
      if (released) p.onHold?.(null);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setLive(null);
    setPanning(false);
    if (d && !cancelled && d.kind === "draw") {
      p.onStroke?.(d.raw, d.downAt, performance.now());
      if (d.moved) p.onGesture?.("draw");
    }
    // After the mark, so it's measured against the page as it was drawn on.
    if (released) p.onHold?.(null);
  }

  const screen = (points: Point[]) => points.map((q) => toScreen(view, q)).map((q) => `${q.x},${q.y}`).join(" ");
  // Hand-drawn cursors (sketch/cursors.ts), with the browser's own as fallbacks.
  const cursor = panning
    ? "var(--cur-grabbing, grabbing)"
    : space || tool === "hand"
      ? "var(--cur-grab, grab)"
      : live
        ? "var(--cur-pencil, crosshair)" // mid-stroke: the crosshair becomes a pencil
        : "var(--cur-crosshair, crosshair)";
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={root}
      className="cv"
      style={{
        cursor,
        backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
        backgroundPosition: `${view.scrollX * view.zoom}px ${view.scrollY * view.zoom}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerUp(e)}
      onPointerCancel={(e) => onPointerUp(e, true)}
      onPointerLeave={() => p.onPointer?.(null)}
    >
      {p.backdrop}
      <div className="cv-world" style={{ transform: `scale(${view.zoom}) translate(${view.scrollX}px, ${view.scrollY}px)` }}>
        {p.children}
      </div>
      <svg className="cv-fx" aria-hidden>
        {live && <polyline className="cv-ink" points={screen(live)} />}
      </svg>
      {p.overlay}
      <div className="cv-zoom" onPointerDown={stop}>
        {p.onTool && (
          <button
            type="button"
            className={tool === "hand" ? "cv-hand on" : "cv-hand"}
            onClick={() => p.onTool?.(tool === "hand" ? "draw" : "hand")}
            title={tool === "hand" ? "Back to drawing (H)" : "Hand: drag to move around (H). Also: two fingers, space + drag, or the arrow keys"}
            aria-label="Hand: drag to move around"
            aria-pressed={tool === "hand"}
          >
            <Icon name="hand" size={16} />
          </button>
        )}
        <button type="button" onClick={() => zoomBy(1 / 1.2)} title="Zoom out (-)" aria-label="Zoom out"><Icon name="minus" /></button>
        <button type="button" className="cv-pct" onClick={() => zoomBy(1 / view.zoom)} title="Zoom to 100%">
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} title="Zoom in (+)" aria-label="Zoom in"><Icon name="plus" /></button>
        {p.onFit && <button type="button" onClick={p.onFit} title="Fit all pages (shift+1)">Fit</button>}
      </div>
    </div>
  );
}
