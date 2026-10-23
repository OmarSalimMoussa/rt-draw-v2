// The app's pages, switched in place: going between the editor and the
// projects never reloads the tab. A page change shows a short load screen
// (paper, and the logo's thought bubble bubbling up) while the new page mounts.
// Once opened, the editor stays mounted, hidden, on the projects page: a send
// keeps going while you look at your projects, and coming back is instant with
// nothing lost. The preview lives in the editor, over it (App.tsx). (v1's Root.tsx.)
import { useEffect, useMemo, useRef, useState } from "react";
import { App } from "./App.tsx";
import { currentProjectId, ensureProject } from "./projects/storage.ts";
import { Projects } from "./projects/ProjectsPage.tsx";
import { type Route, onNavigate, routeOf } from "./router.ts";
import { LOGO_FRAMES, logoDrawing } from "./sketch/logo.ts";

/** The load screen fades in this fast, and stays at least until the bubble has grown (0.9s), boiling after that until the page is drawn. */
const VEIL_IN_MS = 120;
const VEIL_MIN_MS = 950;

type Where = { route: Route; search: string };
const here = (): Where => ({ route: routeOf(location.pathname), search: location.search });
const withEditor = (r: Route) => r === "editor";
/** The project an editor URL names (null: none, the one open). */
const projectIn = (search: string) => new URLSearchParams(search).get("p");

export function Root() {
  const [at, setAt] = useState(here);
  const atRef = useRef(at);
  atRef.current = at;
  // The project the editor has open; the editor stays mounted (hidden) once it's been opened.
  const [editorFor, setEditorFor] = useState<string | null>(() => (withEditor(at.route) ? currentProjectId() : null));
  const editorRef = useRef(editorFor);
  editorRef.current = editorFor;
  const [veil, setVeil] = useState<"in" | "out" | null>(null);
  const shownAt = useRef(0);

  useEffect(() => {
    /** Swaps the page under the load screen. `to` null: the URL already changed (Back or Forward). */
    const go = (to: string | null) => {
      shownAt.current = performance.now();
      setVeil("in");
      window.setTimeout(async () => {
        if (to !== null) history.pushState(null, "", to);
        const next = here();
        // The project loads from the server behind the load screen.
        if (withEditor(next.route)) {
          const id = currentProjectId();
          await ensureProject(id).catch(() => {});
          setEditorFor(id);
        }
        setAt(next);
        window.scrollTo(0, 0);
        // Lift it once the new page has painted, and not before it's been up a moment.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.setTimeout(() => setVeil("out"), Math.max(0, VEIL_MIN_MS - (performance.now() - shownAt.current)))),
        );
      }, VEIL_IN_MS);
    };
    // Links to the app's own pages switch in place (new tabs, other sites and in-page anchors are left alone).
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href);
      // The API and the admin's page aren't the app's: they load as themselves.
      if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      e.preventDefault();
      go(url.pathname + url.search + url.hash);
    };
    // Back and Forward: a different page or project swaps too (the preview's pages are the editor's hash, its own to follow).
    const onPop = () => {
      const next = here();
      const was = atRef.current;
      const p = projectIn(next.search);
      if (next.route !== was.route || (withEditor(next.route) && p !== null && p !== editorRef.current)) go(null);
    };
    document.addEventListener("click", onClick);
    addEventListener("popstate", onPop);
    const off = onNavigate(go);
    return () => {
      document.removeEventListener("click", onClick);
      removeEventListener("popstate", onPop);
      off();
    };
  }, []);

  useEffect(() => {
    if (at.route === "editor") document.title = "imagine";
  }, [at]);

  const away = at.route !== "editor";
  return (
    <>
      {editorFor !== null && (
        <div className={away ? "route-away" : undefined} inert={away}>
          <App key={editorFor} hidden={away} />
        </div>
      )}
      {at.route === "projects" && <Projects />}
      {veil && <LoadScreen state={veil} onDone={() => setVeil(null)} />}
    </>
  );
}

/**
 * Paper, and the logo bubbling up: the small bubble rises and pops in, then the bigger one, then the cloud
 * is drawn (0.9s); after that it boils until the new page has drawn.
 */
function LoadScreen({ state, onDone }: { state: "in" | "out"; onDone(): void }) {
  const frames = useMemo(() => Array.from({ length: LOGO_FRAMES }, (_, f) => logoDrawing(f)), []);
  const [big, small] = frames[0].dots;
  return (
    <div
      className={`veil veil-${state}`}
      role="status"
      aria-label="Loading"
      onAnimationEnd={(e) => state === "out" && e.target === e.currentTarget && onDone()}
    >
      <svg className="vb" viewBox="-2 -2 68 68" aria-hidden>
        <g className="vb-draw">
          <path className="vb-dot vb-small" d={small} pathLength={1} />
          <path className="vb-dot vb-big" d={big} pathLength={1} />
          <path className="vb-cloud" d={frames[0].cloud} pathLength={1} />
        </g>
        <g className="vb-boil">
          {frames.map((d, f) => (
            <g key={f} className="lf">
              {[d.cloud, ...d.dots].map((p, i) => <path key={i} d={p} />)}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
