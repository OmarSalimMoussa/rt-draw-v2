// The editor: draw and talk (or type) on v2's board, press Enter, and watch the
// model draw back. The sidebar has the project, its pages and its history; the
// bar at the bottom takes what you say; the mic stays on until you turn it off.
// A send is exactly the eval bridge's call (evals/bridge/main.ts): v2's send() on
// the live board, with the camera the person sees, redraws once per frame, and
// camera(...) ops gliding the view. (v1's App.tsx, on v2's engine.)
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Clock, watch } from "../../evals/bridge/timing.ts";
import { SCREEN, fitView, pageTop, pagesOf, union } from "../../src/core/board.ts";
import { groupStrokes } from "../../src/core/marks.ts";
import { CALLS_EVENT, calls, forgetCallsBefore, modelOf, warmModel } from "../../src/core/model.ts";
import { promptOf, thinkingOf } from "../../src/core/prompts.ts";
import type { Box } from "../../src/core/scene.ts";
import { send } from "../../src/core/send.ts";
import { Mic, ScribeEngine } from "../../src/core/speech.ts";
import { forgetSpansBefore, span } from "../../src/core/trace.ts";
import type { Pt, Stroke } from "../../src/core/ink.ts";
import { Board } from "./board/board.ts";
import { BoardView } from "./board/BoardView.tsx";
import { LatencyLog } from "./board/latency.ts";
import { Sender } from "./board/sender.ts";
import { Canvas, type Tool } from "./canvas/Canvas.tsx";
import { toStroke } from "./canvas/strokes.ts";
import { type Rect, type View, boardRect, glideAt, sendView, toScreen, viewShowing } from "./canvas/view.ts";
import { onSettings, getModel } from "./settings.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { Icon } from "./sketch/Icon.tsx";
import { MarkSketch } from "./sketch/MarkSketch.tsx";
import { Voice, onInkClock, withTyped } from "./speech/voice.ts";

/** Height kept clear at the top for the toolbar. */
const TOOLBAR_HEIGHT = 64;
const HINT_KEY = "rt-draw.hint.gestures";
/** A waiting Claude process is closed after 10 minutes (dev/model-plugin.ts): top them up well before. */
const WARM_EVERY_MS = 240_000;
/** How long a page pick glides (camera.easeMs). */
const GLIDE_MS = 450;

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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
  /** The canvas the sidebar and the prompt bar leave uncovered (v1's visibleRect). */
  const visibleRect = (): Rect => {
    const { width, height } = size();
    const panel = panelRef.current?.getBoundingClientRect();
    const bar = barRef.current?.getBoundingClientRect();
    return { left: panel ? panel.right + 12 : 0, top: TOOLBAR_HEIGHT, right: width - 12, bottom: (bar?.top ?? height) - 12 };
  };

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

  // First sight of a project: the camera on its first page, as the eval starts.
  useLayoutEffect(() => {
    if (!board.fresh) return;
    const first = pagesOf(board.scene).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)[0];
    if (!first) return;
    board.fresh = false;
    setView(viewShowing(pageTop(first), visibleRect()));
  });

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
        onStart: () => {
          board.busy = true;
          board.stopLooking();
        },
        onEnd: (job, landed) => {
          board.busy = false;
          if (landed) board.commit(job.label);
          // What the overlay still shows is all that's kept of the calls and spans: the page stays open.
          const oldest = log.sends[0];
          if (oldest) {
            forgetCallsBefore(oldest.callsFrom + 1);
            forgetSpansBefore(oldest.enter);
          }
        },
        log,
      }),
    [],
  );
  const status = useSyncExternalStore(sender.subscribe, sender.getStatus);
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

  // Claude processes started before they're needed, as the eval had them for every case.
  useEffect(() => {
    const warm = () => {
      const t = board.tuning;
      warmModel(modelOf(t["draw.model"]), promptOf("draw", t).system(true, board.scene.width, board.scene.height, 0, SCREEN.w), 2, thinkingOf("draw", t));
      warmModel(modelOf(t["picture.model"]), promptOf("picture", t).system(t), t["picture.parallel"] * t["picture.copies"], thinkingOf("picture", t));
    };
    warm();
    const every = setInterval(warm, WARM_EVERY_MS);
    addEventListener("focus", warm);
    const off = onSettings(warm);
    return () => {
      clearInterval(every);
      removeEventListener("focus", warm);
      off();
    };
  }, []);

  // The voice: on until turned off; each Enter takes what was said since the last.
  const voice = useMemo(() => new Voice({ mic: () => new Mic(), engine: (events, mic) => new ScribeEngine(events, mic as Mic, () => board.tuning) }), []);
  useSyncExternalStore(voice.subscribe, voice.getVersion);
  const spoken = `${voice.heard} ${voice.interim}`.trim();

  // The pen: strokes on this send's ink clock, which restarts at every Enter.
  const [tool, setTool] = useState<Tool>("draw");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const epoch = useRef(performance.now());
  const nextStroke = useRef(1);
  const addStroke = (raw: Pt[], downAt: number, upAt: number) => setStrokes([...strokesRef.current, toStroke(nextStroke.current++, raw, downAt, upAt, epoch.current)]);
  const undoStroke = () => setStrokes(strokesRef.current.slice(0, -1));
  const marks = useMemo(() => groupStrokes(strokes, board.tuning), [strokes]);

  const [prompt, setPrompt] = useState("");

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

  /** A new, empty project (the old one stays in the projects list), with nothing left over from the old one. */
  function startFromScratch() {
    sender.stop();
    void voice.take();
    setStrokes([]);
    setPrompt("");
    board.newProject();
  }

  // Esc leaves the hand, or else takes back the last stroke; so does cmd/ctrl+Z while there are strokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hidden) return;
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
  }, [tool, hidden]);

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
        active={!hidden}
        onStroke={addStroke}
        onGesture={retireHint}
        onFit={fitAll}
        backdrop={<BoardView board={board} view={view} size={canvasSize} onSvg={(svg) => (clock.current = watch(svg))} />}
        overlay={
          strokes.length > 0 && (
            <svg className="pg-marks" aria-hidden>
              {/* The strokes, redrawn in pencil, sit on the board (so they keep their wobble as the view moves). */}
              <g transform={`scale(${view.zoom}) translate(${view.scrollX} ${view.scrollY})`}>
                {strokes.map((s) => <MarkSketch key={s.id} stroke={s} zoom={view.zoom} />)}
              </g>
              {marks.map((m) => {
                const at = toScreen(view, { x: m.box.x, y: m.box.y });
                return <text key={m.n} x={at.x - 6} y={at.y - 8}>{m.n}</text>;
              })}
            </svg>
          )
        }
      />

      {hint && (
        <div className="pg-hint" role="note">
          <span>Press and drag to draw · two fingers to move around · pinch to zoom</span>
          <button type="button" onClick={() => retireHint()} aria-label="Got it"><Icon name="close" /></button>
        </div>
      )}
      <StatusBadge status={status} />
      {lost && (
        <div className="pg-lost">
          <button type="button" onClick={fitAll} title="Fit all your pages into view (shift+1)">
            <Icon name="locate" /> Back to your pages
          </button>
        </div>
      )}
      {/* Top right: start over, all projects, settings. */}
      <div className="pg-tools">
        <button type="button" className="pg-tool" onClick={startFromScratch} disabled={empty} title="New project: start from scratch (this one stays in your projects)" aria-label="New project">
          <Icon name="newProject" size={18} />
        </button>
        <a className="pg-tool" href="/projects" title="All your projects" aria-label="All your projects">
          <Icon name="projects" size={18} />
        </a>
        <SettingsMenu />
      </div>

      <aside className="pg-panel" ref={panelRef}>
        <Sidebar
          board={board}
          busy={busy}
          onPage={(id) => {
            const page = board.scene.get(id);
            if (page) void glideTo(pageTop(page), GLIDE_MS);
          }}
          onAll={fitAll}
        />
      </aside>

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
            {voice.error && <div className="bad">{voice.error}</div>}
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
    </div>
  );
}
