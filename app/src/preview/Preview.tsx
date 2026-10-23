// The site as a visitor would use it: one page at a time, drawn by v2's renderer
// with the view set to the page exactly (whatever spills past the page is cut off,
// as a visitor would see it). Buttons, links and pictures boil under the pointer;
// one with a page goes there, one without asks the editor to build it, and the page
// fills in live as the model draws it. It sits over the editor, which stays mounted
// behind it, in the same tab (/?p=<project>#preview=<page>). Edit this page goes
// back to the board, fitted to the page. (v1's src/preview/Preview.tsx, on v2.)
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { norm, pageName, siteTree } from "../../../src/core/board.ts";
import { render } from "../../../src/core/render.ts";
import type { Box, Shape } from "../../../src/core/scene.ts";
import type { Board } from "../board/board.ts";
import { boilCss, shapeSelector } from "../board/boil.ts";
import { Icon } from "../sketch/Icon.tsx";
import { hitClickable, targetOf } from "./preview.ts";
import "./preview.css";

/** A page being built from a click: its id, the clicked words, the size it's made at, whether its send is still to finish, and why it failed. */
export type Building = { to: string; label: string; w: number; h: number; running: boolean; failed?: string };

type Props = {
  board: Board;
  /** The page shown: its id, or null for home. */
  page: string | null;
  building?: Building;
  onGo(page: string): void;
  /** A click that leads nowhere yet: build its page. */
  onBuild(shape: Shape, from: Shape): void;
  /** A click found its page by name, and the shape now links there (saved with the next version). */
  onLinked(): void;
  onEdit(page: string): void;
  onExit(): void;
  /** The failure strip's OK. */
  onDismiss(): void;
};

/** How long the pointer rests on something with no page yet before the tip says so. */
const TIP_MS = 300;

type Hover = { id: string; px: number; tip: boolean };

export function Preview(p: Props) {
  const { board, building } = p;
  useSyncExternalStore(board.subscribe, board.getVersion);
  const scene = board.scene;
  const tree = siteTree(scene);
  const wanted = p.page ?? tree[0]?.page.id;
  const found = wanted ? scene.get(wanted) : undefined;
  // The page being built shows at once, blank, until its frame is made; anything else unknown shows home.
  const pending = !found && !!building && wanted === building.to;
  const page = found?.kind === "frame" ? found : pending ? undefined : tree[0]?.page;
  const shownId = page?.id ?? (pending ? building!.to : undefined);
  const box: Box | undefined = page && norm(page.box);
  const here = !!building?.running && shownId === building.to;

  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [hover, setHover] = useState<Hover>();

  // Drawn now, and again with every redraw of the board (once per frame while a send draws).
  useLayoutEffect(() => {
    const paint = () => {
      const pg = pageRef.current;
      if (pg && svg.current) render(svg.current, board.scene, { tuning: board.tuning, view: norm(pg.box) });
    };
    paint();
    return board.onPaint(paint);
  }, [board, page?.id]);

  // Each page from its top; the tab says where you are.
  useEffect(() => {
    root.current?.scrollTo(0, 0);
    setHover(undefined);
  }, [shownId]);
  const title = page ? pageName(page) : building?.label;
  useEffect(() => {
    document.title = `${title ?? "Preview"} · Preview`;
  }, [title]);
  useEffect(() => () => void (document.title = "imagine"), []);

  const hovered = hover && scene.get(hover.id);
  const nowhere = !!hovered && !targetOf(scene, hovered);
  useEffect(() => {
    if (!hover || hover.tip || !nowhere || building?.running) return;
    const t = setTimeout(() => setHover((h) => (h?.id === hover.id ? { ...h, tip: true } : h)), TIP_MS);
    return () => clearTimeout(t);
  }, [hover?.id, nowhere, building?.running]);

  /** The clickable under the pointer, and how many drawing units half a screen pixel is (for the boil). */
  const hit = (e: React.PointerEvent | React.MouseEvent) => {
    const el = svg.current;
    if (!el || !page || !box) return undefined;
    const r = el.getBoundingClientRect();
    const at = { x: box.x + ((e.clientX - r.left) / r.width) * box.w, y: box.y + ((e.clientY - r.top) / r.height) * box.h };
    const s = hitClickable(scene, page, at);
    return s && { s, px: (0.5 * box.w) / r.width };
  };

  const onMove = (e: React.PointerEvent) => {
    const h = hit(e);
    if (h?.s.id !== hover?.id) setHover(h && { id: h.s.id, px: h.px, tip: false });
  };

  const onClick = (e: React.MouseEvent) => {
    const h = hit(e);
    if (!h || !page) return;
    const to = targetOf(scene, h.s);
    if (to) {
      // Found by its name: the link the model forgot, kept from now on.
      if (h.s.link !== to.id) {
        h.s.link = to.id;
        p.onLinked();
      }
      return p.onGo(to.id);
    }
    if (building?.running) return; // one page at a time
    p.onBuild(h.s, page);
  };

  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  const size = box ?? (building ? { w: building.w, h: building.h } : { w: 1280, h: 800 });
  const tip = hover?.tip && hovered && box && nowhere && !building?.running ? norm(hovered.box) : undefined;

  return (
    <div className="pv" ref={root}>
      <header className="pv-bar">
        <select value={shownId} onChange={(e) => p.onGo(e.target.value)} aria-label="Page">
          {pending && <option value={building!.to}>{building!.label}</option>}
          {tree.map((t) => (
            <option key={t.page.id} value={t.page.id}>
              {"  ".repeat(t.depth)}
              {pageName(t.page)}
            </option>
          ))}
        </select>
        {building?.running ? (
          <span className="pv-status">
            <span className="pv-spinner" aria-hidden /> Building “{building.label}”…
          </span>
        ) : (
          <span className="pv-hint">Click buttons, links and pictures. Ones that lead nowhere yet get their page built as you watch.</span>
        )}
        <button
          type="button"
          className="pv-edit"
          disabled={!page || here}
          onClick={() => page && p.onEdit(page.id)}
          title={here ? "Wait for the page to be built" : "Back to the board, fitted to this page"}
        >
          <Icon name="pencil" /> Edit this page
        </button>
        <button type="button" onClick={fullscreen}>Full screen</button>
        <button type="button" className="pv-exit" onClick={p.onExit} title="Close the preview and go back to the editor">
          <Icon name="close" /> Exit preview
        </button>
      </header>
      {building?.failed && (
        <div className="pv-failed" role="alert">
          Couldn't build “{building.label}”. {building.failed}
          <button type="button" onClick={p.onDismiss}>OK</button>
        </div>
      )}
      <main className={here ? "pv-main pv-building" : "pv-main"}>
        <div className="pv-stage" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
          {page ? (
            <svg
              ref={svg}
              className={hover ? "pv-page pv-over" : "pv-page"}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(undefined)}
              onClick={onClick}
              aria-label={`The ${pageName(page)} page`}
            />
          ) : (
            <div className="pv-page" aria-label="The new page, being built" />
          )}
          {tip && box && (
            <div className="pv-tip" style={{ left: `${((tip.x - box.x) / box.w) * 100}%`, top: `calc(${((tip.y + tip.h - box.y) / box.h) * 100}% + 6px)` }}>
              <span>No page yet:</span> click to build it
            </div>
          )}
        </div>
      </main>
      {hover && <style>{boilCss("pv", shapeSelector(".pv-page", hover.id), hover.px)}</style>}
    </div>
  );
}
