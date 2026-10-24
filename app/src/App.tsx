// The editor: draw and talk (or type) on v2's board, press Enter, and watch the
// model draw back. The sidebar has the project, its pages and its history; the
// bar at the bottom takes what you say; the mic stays on until you turn it off.
// A send is exactly the eval bridge's call (evals/bridge/main.ts): v2's send() on
// the live board, with the camera the person sees, redraws once per frame, and
// camera(...) ops gliding the view. The preview shows the site over the editor, in
// this tab, with its page in the URL's hash. (v1's App.tsx, on v2's engine.)
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Clock, watch } from "../../evals/bridge/timing.ts";
import { SCREEN, fitView, homeOf, pageName, pageTop, pagesOf, union } from "../../src/core/board.ts";
import { groupStrokes } from "../../src/core/marks.ts";
import { CALLS_EVENT, calls, forgetCallsBefore, modelOf, warmModel } from "../../src/core/model.ts";
import { promptOf, thinkingOf } from "../../src/core/prompts.ts";
import type { Box, Shape } from "../../src/core/scene.ts";
import { send } from "../../src/core/send.ts";
import { Mic, ScribeEngine } from "../../src/core/speech.ts";
import { forgetSpansBefore, span } from "../../src/core/trace.ts";
import type { Pt, Stroke } from "../../src/core/ink.ts";
import { currentMe, seesInternals } from "./access/api.ts";
import { FeedbackButton } from "./access/Feedback.tsx";
import { Board, SETTLE_MS } from "./board/board.ts";
import { BoardArrows } from "./board/BoardArrows.tsx";
import { BoardView } from "./board/BoardView.tsx";
import { LatencyLog } from "./board/latency.ts";
import { Sender } from "./board/sender.ts";
import { Canvas, type Tool } from "./canvas/Canvas.tsx";
import { numberSpots } from "./canvas/marks.ts";
import { toStroke } from "./canvas/strokes.ts";
import { type Rect, type View, boardRect, glideAt, sendView, toScene, viewShowing } from "./canvas/view.ts";
import { isCompact, useCompact } from "./compact.ts";
import { LatencyOverlay } from "./LatencyOverlay.tsx";
import { type Building, Preview } from "./preview/Preview.tsx";
import { buildEnded, buildJob } from "./preview/build.ts";
import { hitClickable, previewHash, previewOfHash } from "./preview/preview.ts";
import { boilCss, shapeSelector } from "./board/boil.ts";
import { createProject } from "./projects/storage.ts";
import { navigate } from "./router.ts";
import { onSettings, getModel, showsLatency } from "./settings.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { Icon } from "./sketch/Icon.tsx";
import { Logo } from "./sketch/Logo.tsx";
import { MarkSketch } from "./sketch/MarkSketch.tsx";
import { Voice, onInkClock, plainVoiceError, withTyped } from "./speech/voice.ts";
import { keepWarm } from "./warm.ts";

/** Height kept clear at the top for the toolbar. */
const TOOLBAR_HEIGHT = 64;
const HINT_KEY = "rt-draw.hint.gestures";
/** How long a page pick glides (camera.easeMs). */
const GLIDE_MS = 450;

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A whole page with its name above it, and a little room around: what Edit this page fits in view. */
const wholePage = (b: Box): Box => {
  const m = Math.max(b.w, b.h) * 0.03;
  return { x: b.x - m, y: b.y - 60 - m, w: b.w + 2 * m, h: b.h + 60 + 2 * m };
};

/** `hidden`: another page is showing over it (Root.tsx); it keeps working but ignores the keyboard. */
export function App({ hidden = false }: { hidden?: boolean }) {
  const board = useMemo(() => new Board(), []);
  useSyncExternalStore(board.subscribe, board.getVersion);
  const empty = board.isEmpty();

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLFormElement>(null);
  const [view, setViewState] = useState<View>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const viewRef = useRef(view);
  const setView = (v: View) => {
    viewRef.current = v;
    setViewState(v);
  };
  const size = () => ({ width: rootRef.current?.clientWidth ?? innerWidth, height: rootRef.current?.clientHeight ?? innerHeight });
  const [canvasSize, setCanvasSize] = useState(size);
  useEffect(() => {
    const onResize = () => setCanvasSize(size());
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  /** The canvas the sidebar and the prompt bar leave uncovered (v1's visibleRect). On a phone the sidebar folds away, so it's all the width. */
  const visibleRect = (): Rect => {
    const { width, height } = size();
    const panel = panelRef.current?.getBoundingClientRect();
    const bar = barRef.current?.getBoundingClientRect();
    return { left: isCompact() ? 12 : panel ? panel.right + 12 : 0, top: TOOLBAR_HEIGHT, right: width - 12, bottom: (bar?.top ?? height) - 12 };
  };
  // On a phone the sidebar is a button at the top left, and opens over the board (compact.ts).
  const compact = useCompact();
  const [unfolded, setUnfolded] = useState(false);
  const fold = () => setUnfolded(false);

  // Glides: camera(...) ops, and picking a page. A new glide ends the one before (its promise too, so a send waiting on it ends).
  const glide = useRef<{ frame: number; done: () => void }>(undefined);
  const glideTo = (box: Box, ms = 0) =>
    new Promise<void>((done) => {
      if (glide.current) {
        cancelAnimationFrame(glide.current.frame);
        glide.current.done();
      }
      const r = visibleRect();
      const from = viewRef.current;
      const to = viewShowing(box, r);
      if (!ms) {
        setView(to);
        glide.current = undefined;
        return done();
      }
      const t0 = performance.now();
      const g = { frame: 0, done };
      glide.current = g;
      const step = () => {
        const u = Math.min(1, (performance.now() - t0) / ms);
        setView(glideAt(from, to, u, r));
        if (u < 1) g.frame = requestAnimationFrame(step);
        else {
          if (glide.current === g) glide.current = undefined;
          done();
        }
      };
      step();
    });
  const pagesBox = () => {
    const pages = pagesOf(board.shown());
    return pages.length ? union(pages.map((p) => p.box)) : undefined;
  };
  const fitAll = () => {
    const box = pagesBox();
    if (box) void glideTo(fitView(box, 0.03));
  };

  // The preview: its page is in the hash (#preview=<page>), so a reload reopens it and Back goes to the page before.
  const [pv, setPv] = useState<string | null | undefined>(() => previewOfHash(location.hash));
  const previewing = pv !== undefined;
  useEffect(() => {
    const read = () => setPv(previewOfHash(location.hash));
    addEventListener("popstate", read);
    addEventListener("hashchange", read);
    return () => {
      removeEventListener("popstate", read);
      removeEventListener("hashchange", read);
    };
  }, []);
  // The preview shows the board as it is now: a version pinned in History is let go.
  useEffect(() => {
    if (previewing) board.stopLooking();
  }, [previewing]);
  // Coming back from the projects page (its Preview buttons) to this editor.
  useEffect(() => {
    if (!hidden) setPv(previewOfHash(location.hash));
  }, [hidden]);
  const editorUrl = () => location.pathname + location.search;
  const showPreview = (page: string | null) => {
    if (page === pv) return;
    history.pushState(null, "", editorUrl() + previewHash(page));
    setPv(page);
  };
  const exitPreview = () => {
    history.pushState(null, "", editorUrl());
    setPv(undefined);
  };
  /** The page picked in the sidebar's Pages (undefined: all of them). */
  const [picked, setPicked] = useState<string>();
  /** The page Edit this page came from: the pill back to the preview on it. */
  const [backTo, setBackTo] = useState<string>();
  const [building, setBuilding] = useState<Building>();
  /** Edit this page: back to the board, the whole page in view and picked in the sidebar. */
  const editPage = (id: string) => {
    exitPreview();
    setPicked(id);
    setBackTo(id);
    const page = board.scene.get(id);
    if (page) void glideTo(wholePage(page.box), GLIDE_MS);
  };

  // First sight of a project: the camera on its home page, as the eval starts.
  useLayoutEffect(() => {
    if (!board.fresh) return;
    const first = homeOf(board.scene);
    if (!first) return;
    board.fresh = false;
    setView(viewShowing(pageTop(first), visibleRect()));
  });
  // When the board places its pages, the camera goes with the page it's looking at.
  board.follow = () => {
    const v0 = viewRef.current;
    const r = visibleRect();
    return { centre: toScene(v0, (r.left + r.right) / 2, (r.top + r.bottom) / 2), move: (dx, dy) => setView({ ...v0, scrollX: v0.scrollX - dx, scrollY: v0.scrollY - dy }) };
  };

  // Sends: one at a time, timed, and the board saved after each one that changed it.
  const log = useMemo(() => new LatencyLog(), []);
  const clock = useRef<Clock>(undefined);
  const sender = useMemo(
    () =>
      new Sender({
        run: (input, hooks) =>
          span(`send ${log.sends.at(-1)?.n ?? ""}`, undefined, (ctx) =>
            send(board.scene, input, board.tuning, { ...hooks, parent: ctx, draw: board.draw, setView: glideTo }, sendView(viewRef.current, visibleRect(), size())),
          ),
        model: () => getModel().label,
        clock: () => clock.current,
        lastCall: () => calls.at(-1)?.n ?? 0,
        ready: board.settled,
        failedCalls: (from, to) => calls.filter((c) => c.n > from && c.n <= to && c.error).map((c) => `${c.req.model.startsWith("jev") ? "Jev" : (c.req.from ?? c.req.model)}: ${c.error}`),
        onStart: () => {
          board.busy = true;
          board.stopLooking();
          // Painted before the clock starts, so going back to the live board doesn't count as the send's changes.
          board.flush();
        },
        onEnd: (job, landed) => {
          const finish = () => {
            board.busy = false;
            if (landed) board.commit(job.label);
            // What the overlay still shows is all that's kept of the calls and spans: the page stays open.
            const oldest = log.sends[0];
            if (oldest) {
              forgetCallsBefore(oldest.callsFrom + 1);
              forgetSpansBefore(oldest.enter);
            }
          };
          if (!landed) return finish();
          // The board places its pages before the version is saved (and before they glide), so the move belongs to this send.
          return board.settle({ glideMs: SETTLE_MS, placed: finish });
        },
        log,
      }),
    [],
  );
  const status = useSyncExternalStore(sender.subscribe, sender.getStatus);
  const latency = useSyncExternalStore(onSettings, showsLatency);
  const busy = status.running || status.queued > 0;
  // Lets browser checks read the board and the timings.
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { rtApp: { board, sender, log } });
  }, []);
  // The drawing call's first text, for the overlay's "model" step.
  useEffect(() => {
    const onCalls = () => {
      for (let i = calls.length - 1; i >= Math.max(0, calls.length - 12); i--) {
        const c = calls[i];
        if (c.req.from !== "draw") continue;
        if (c.running && c.reply) sender.firstText();
        return;
      }
    };
    addEventListener(CALLS_EVENT, onCalls);
    return () => removeEventListener(CALLS_EVENT, onCalls);
  }, []);

  // Claude processes started before they're needed, as the eval had them for every case (warm.ts).
  useEffect(() => {
    const warm = keepWarm((spare) => {
      const t = board.tuning;
      warmModel(modelOf(t["draw.model"]), promptOf("draw", t).system(true, board.scene.width, board.scene.height, 0, SCREEN.w), 2 + spare, { ...thinkingOf("draw", t), from: "draw" });
      warmModel(modelOf(t["picture.model"]), promptOf("picture", t).system(t), t["picture.parallel"] * t["picture.copies"] + spare, thinkingOf("picture", t));
    });
    addEventListener("focus", warm.now);
    const off = onSettings(warm.now);
    return () => {
      warm.stop();
      removeEventListener("focus", warm.now);
      off();
    };
  }, []);

  // The voice: on until turned off; each Enter takes what was said since the last.
  const voice = useMemo(() => new Voice({ mic: () => new Mic(), engine: (events, mic) => new ScribeEngine(events, mic as Mic, () => board.tuning) }), []);
  useSyncExternalStore(voice.subscribe, voice.getVersion);
  const spoken = `${voice.heard} ${voice.interim}`.trim();

  // Another project opened in this tab mounts a new editor: this one's send stops (what landed is kept in its
  // project's versions), the mic is let go, and its board stops following saves and settings.
  useEffect(() => {
    const off = board.listen();
    // Opened: the pages go where the layout puts them (saved with the next version).
    void board.settle({ glideMs: SETTLE_MS });
    return () => {
      off();
      sender.stop();
      void voice.stop();
    };
  }, []);

  // The pen: strokes on this send's ink clock, which restarts at every Enter.
  const [tool, setTool] = useState<Tool>("draw");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  /** Whether drawing has started in this editor (a stroke, a send, or a project with versions): the Feedback arrow stops asking, for good. */
  const begun = useRef(false);
  if (!empty || strokes.length > 0 || busy || board.busy) begun.current = true;
  const epoch = useRef(performance.now());
  const nextStroke = useRef(1);
  const addStroke = (raw: Pt[], downAt: number, upAt: number) => setStrokes([...strokesRef.current, toStroke(nextStroke.current++, raw, downAt, upAt, epoch.current)]);
  const undoStroke = () => setStrokes(strokesRef.current.slice(0, -1));
  const marks = useMemo(() => groupStrokes(strokes, board.tuning), [strokes]);

  const [prompt, setPrompt] = useState("");

  /**
   * A click in the preview that leads nowhere yet: a send that builds its page (build.ts), queued like any
   * other. The preview goes to the page at once, blank and pulsing, and fills in as the model draws it.
   */
  function startBuild(shape: Shape, from: Shape) {
    const b = buildJob(
      {
        scene: () => board.scene,
        settle: () => board.settle({ glideMs: SETTLE_MS }),
        focus: (page) => glideTo(pageTop(page), GLIDE_MS),
        enter: () => performance.now(),
      },
      { shape, from },
      (status, landed, error) =>
        // Built: done. Failed or stopped (the page stays if something landed): v1's strip says why.
        setBuilding((w) => {
          const end = buildEnded(status, landed, error);
          return w && end ? { ...w, running: false, failed: end.failed } : undefined;
        }),
    );
    setBuilding({ to: b.to, label: b.label, w: b.w, h: b.h, running: true });
    sender.enqueue(b.job);
    showPreview(b.to);
  }

  function submit() {
    const typed = prompt.trim();
    const said = spoken;
    const taken = strokesRef.current;
    if (!typed && !taken.length && !said) return;
    const enter = performance.now();
    const ep = epoch.current;
    const words = voice.take().then((ws) => withTyped(onInkClock(ws, ep), typed, Math.round(enter - ep)));
    sender.enqueue({ label: typed || said || "(drawing only)", spoken: !typed && !!said, strokes: taken, words, enter });
    setStrokes([]);
    setPrompt("");
    epoch.current = performance.now();
    nextStroke.current = 1;
  }

  /** A new, empty project (the old one stays in the projects list): a new editor, as opening any project is. */
  function startFromScratch() {
    navigate(`/?p=${createProject().id}`);
  }

  // Esc leaves the hand, or else takes back the last stroke; so does cmd/ctrl+Z while there are strokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hidden || previewing) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "Escape") {
        if (tool === "hand") setTool("draw");
        else undoStroke();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && strokesRef.current.length) {
        e.preventDefault();
        undoStroke();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [tool, hidden, previewing]);

  // How to draw and move around, until the person has done both once.
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== "done";
    } catch {
      return true;
    }
  });
  const learned = useRef(new Set<string>());
  function retireHint(kind?: "draw" | "move") {
    if (!hint) return;
    if (kind) learned.current.add(kind);
    if (kind && learned.current.size < 2) return;
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "done");
    } catch {}
  }

  // What a visitor could click boils under the pointer on the board too, as in v1; the pen still draws.
  const [hovered, setHovered] = useState<string>();
  const holding = useRef(false);

  // Lost on the canvas: none of the pages is in view.
  const box = pagesBox();
  const lost = !!box && !overlaps(box, boardRect(view, canvasSize));

  return (
    <div className="pg" ref={rootRef}>
      <Canvas
        view={view}
        onView={setView}
        tool={tool}
        onTool={setTool}
        active={!hidden && !previewing}
        onStroke={addStroke}
        onGesture={retireHint}
        onPointer={(p) => setHovered(p && !holding.current ? hitClickable(board.shown(), undefined, p)?.id : undefined)}
        onHold={(kind) => {
          holding.current = kind !== null;
          if (kind) setHovered(undefined);
        }}
        onFit={fitAll}
        backdrop={
          <>
            <BoardView board={board} view={view} size={canvasSize} onSvg={(svg) => (clock.current = watch(svg))} />
            <BoardArrows board={board} view={view} size={canvasSize} />
          </>
        }
        overlay={
          strokes.length > 0 && (
            <svg className="pg-marks" aria-hidden>
              {/* The strokes, redrawn in pencil, sit on the board (so they keep their wobble as the view moves). */}
              <g transform={`scale(${view.zoom}) translate(${view.scrollX} ${view.scrollY})`}>
                {strokes.map((s) => <MarkSketch key={s.id} stroke={s} zoom={view.zoom} />)}
              </g>
              {/* Each number where the model's pictures put it: beyond an arrow's tail, beside other ink. */}
              {numberSpots(marks, view, board.tuning).map((s) => <text key={s.n} x={s.x} y={s.y} textAnchor="middle">{s.n}</text>)}
            </svg>
          )
        }
      />

      {hovered && !previewing && <style>{boilCss("bd", shapeSelector(".bd", hovered), 0.5 / view.zoom)}</style>}
      {hint && (
        <div className="pg-hint" role="note">
          <span>Press and drag to draw · two fingers to move around · pinch to zoom</span>
          <button type="button" onClick={() => retireHint()} aria-label="Got it"><Icon name="close" /></button>
        </div>
      )}
      {/* Top centre: what the app is doing, and the way back to the preview after Edit this page. */}
      <div className="pg-topline">
        <StatusBadge status={status} />
        {backTo && board.scene.get(backTo) && (
          <button
            type="button"
            className="pg-back"
            onClick={() => {
              setBackTo(undefined);
              showPreview(backTo);
            }}
          >
            <Icon name="back" /> Back to preview <span>on {pageName(board.scene.get(backTo)!)}</span>
          </button>
        )}
      </div>
      {latency && seesInternals() && <LatencyOverlay log={log} />}
      {lost && (
        <div className="pg-lost">
          <button type="button" onClick={fitAll} title="Fit all your pages into view (shift+1)">
            <Icon name="locate" /> Back to your pages
          </button>
        </div>
      )}
      {/* Top right: feedback (for anyone signed in; it asks until drawing starts), start over, all projects, settings. */}
      <div className="pg-tools">
        {currentMe() && <FeedbackButton beg={!begun.current} project={board.project} version={board.history.looking ?? board.history.latest()} />}
        <button type="button" className="pg-tool" onClick={startFromScratch} disabled={empty} title="New project: start from scratch (this one stays in your projects)" aria-label="New project">
          <Icon name="newProject" size={18} />
        </button>
        <a className="pg-tool" href="/projects" title="All your projects" aria-label="All your projects">
          <Icon name="projects" size={18} />
        </a>
        <SettingsMenu />
      </div>

      {compact && (
        <button type="button" className="pg-fold" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)} title="Pages and history">
          <Logo size={24} />
          <span>{board.meta()?.name ?? "Untitled"}</span>
        </button>
      )}
      {compact && unfolded && <div className="pg-scrim" onClick={fold} />}
      {(!compact || unfolded) && (
        <aside className="pg-panel" ref={panelRef}>
          <Sidebar
            board={board}
            busy={busy || board.busy}
            picked={picked}
            onPage={(id) => {
              fold();
              setPicked(id);
              const page = board.scene.get(id);
              if (page) void glideTo(pageTop(page), GLIDE_MS);
            }}
            onAll={() => {
              fold();
              setPicked(undefined);
              fitAll();
            }}
            onPreview={() => {
              fold();
              showPreview(null);
            }}
          />
        </aside>
      )}

      <form
        ref={barRef}
        className="pg-bar"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {(spoken || voice.error) && (
          <div className="pg-captions" aria-live="polite">
            {spoken && <div className="pg-heard"><Icon name="mic" /> {spoken}…</div>}
            {voice.error && <div className="bad">{seesInternals() ? voice.error : plainVoiceError(voice.error)}</div>}
          </div>
        )}
        <div className="pg-row">
          <textarea
            value={prompt}
            rows={2}
            placeholder={
              strokes.length
                ? "Say what the drawings mean, or just Send: an arrow moves a thing there"
                : voice.listening
                  ? "Listening: talk and draw, then press Enter. You can still type here."
                  : empty
                    ? "Think out loud about your page, e.g. “a landing page for rubber ducks, big yellow hero with a duck photo…”"
                    : "Keep going: “make the hero blue”, “add pricing under that”, or circle something and say “move this up”…"
            }
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className={voice.listening ? "pg-mic on" : "pg-mic"}
            onClick={() => void (voice.listening ? voice.stop() : voice.start())}
            title={voice.listening ? "Stop listening" : "Talk; draw while you speak, then press Enter"}
            aria-label={voice.listening ? "Stop listening" : "Talk"}
            aria-pressed={voice.listening}
          >
            <Icon name="mic" size={20} />
          </button>
          {busy && !prompt.trim() && !strokes.length && !spoken ? (
            <button type="button" className="pg-stop" onClick={() => sender.stop()}>Stop</button>
          ) : (
            <button type="submit" className="pg-send" disabled={!prompt.trim() && !strokes.length && !spoken}>{busy ? "Queue" : "Send"}</button>
          )}
        </div>
        {strokes.length > 0 && (
          <div className="pg-row pg-controls">
            <button type="button" className="pg-chip" onClick={() => setStrokes([])} title="Clear the drawings">
              {strokes.length} stroke{strokes.length > 1 ? "s" : ""} <Icon name="close" />
            </button>
          </div>
        )}
      </form>

      {previewing && (
        <Preview
          board={board}
          page={pv}
          building={building}
          onGo={showPreview}
          onBuild={startBuild}
          onLinked={() => !busy && void board.settle({ glideMs: 0 })}
          onEdit={editPage}
          onExit={exitPreview}
          onDismiss={() => {
            setBuilding(undefined);
            // Its page was taken away: back to the page it was clicked from.
            if (building && pv === building.to && !board.scene.get(building.to)) history.back();
          }}
        />
      )}
    </div>
  );
}
