// The editor in a tab, end to end: Root and App on a fake projects server, with
// v2's send() and the mic stood in for (no model calls, no microphone). For what
// only shows across a project switch, and on the board's own clock.
import ELK from "elkjs/lib/elk.bundled.js";
import { act } from "react";
import { type Root as ReactRoot, createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Word } from "../../src/core/link.ts";
import { runScript } from "../../src/core/ops.ts";
import { Scene, type SceneJSON } from "../../src/core/scene.ts";
import type { Board } from "./board/board.ts";
import { COMPACT } from "./compact.ts";
import { STARTERS } from "./onboarding/tips.ts";
import { setElk } from "./board/layout.ts";
import type { LatencyLog } from "./board/latency.ts";
import type { Sender } from "./board/sender.ts";
import { blankBoard, createProject, loadVersions, ready, saveVersions } from "./projects/storage.ts";
import { Root } from "./Root.tsx";
import { navigate } from "./router.ts";
import { getModel, setModel } from "./settings.ts";

const fake = vi.hoisted(() => ({
  send: undefined as undefined | ((...args: any[]) => Promise<unknown>),
  mics: [] as { on: boolean }[],
  /** Each Scribe engine's events, for a test to speak through. */
  scribes: [] as import("../../src/core/speech.ts").SpeechEvents[],
}));
vi.mock("../../src/core/send.ts", () => ({ send: (...args: unknown[]) => fake.send!(...args) }));
vi.mock("../../src/core/speech.ts", () => ({
  Mic: class {
    m = { on: false };
    constructor() {
      fake.mics.push(this.m);
    }
    async start() {
      this.m.on = true;
    }
    stop() {
      this.m.on = false;
    }
  },
  ScribeEngine: class {
    constructor(events: (typeof fake.scribes)[number]) {
      fake.scribes.push(events);
    }
    async start() {}
    async stop() {}
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const app = () => (window as unknown as { rtApp?: { board: Board; sender: Sender; log: LatencyLog } }).rtApp;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => unknown, ms = 3000) {
  for (const t0 = Date.now(); !ok(); await wait(20)) if (Date.now() - t0 > ms) throw new Error("timed out");
}

const BOX_A = `shape(a, rect, 100 100 300 120, "a plain grey box near the top left")`;
const BOX_B = `shape(b, rect, 100 300 300 120, "a second plain box under the first one")`;
const PRICING = `shape(pricing, rect, 0 500 1280 200, "the pricing section with three plans side by side")`;
const doc = (...scripts: string[]): SceneJSON => {
  const s = Scene.fromJSON(blankBoard());
  for (const x of scripts) runScript(x, s);
  return s.toJSON();
};
/** A project with these versions, saved (to the fake server). */
const project = (...docs: SceneJSON[]) => {
  const id = createProject().id;
  if (docs.length) saveVersions(id, docs.map((d, i) => ({ n: i + 1, doc: d, at: Date.now(), label: `V${i + 1}` })));
  return id;
};
const sent = { prompt: {}, result: { ops: [], ms: 1, reply: "" } };
/** Typing in a React text field: its value set as the browser would, then the input event. */
function type(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const job = (label: string) => ({ label, spoken: false, strokes: [], words: Promise.resolve(label), enter: performance.now() });

let root: ReactRoot | undefined;
async function open(id: string) {
  history.replaceState(null, "", `/?p=${id}`);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<Root />));
  await until(() => app()?.board.project === id);
}

beforeAll(async () => {
  setElk(new ELK());
  // The projects API, answered in memory: saves are echoed back, so this tab's numbering stands.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const path = new URL(url, location.origin).pathname;
      const out = path === "/api/projects" ? { projects: [] } : path === "/api/project" ? { versions: [] } : path === "/api/project/save" ? { versions: body.versions } : { ok: true };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  await ready();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  delete (window as { rtApp?: unknown }).rtApp;
  document.body.innerHTML = "";
  fake.mics.length = 0;
  fake.scribes.length = 0;
});

describe("the editor", () => {
  it("New project during a send keeps what landed in the old project, and the old one opens again", async () => {
    const a = project(doc());
    await open(a);
    let started = false;
    fake.send = async (scene: Scene, _input, _tuning, hooks) => {
      runScript(PRICING, scene);
      hooks.onOp?.({ line: PRICING, ok: true, ms: 1 });
      started = true;
      await new Promise((r) => hooks.signal?.addEventListener("abort", r));
      return sent;
    };
    const { board, sender } = app()!;
    sender.enqueue(job("add a pricing section"));
    await until(() => started);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="New project"]')!.click());
    await wait(400);
    await sender.idle();

    const old = loadVersions(a).at(-1)!;
    expect(old.label).toBe("add a pricing section");
    expect(old.doc.shapes.some((s) => s.id === "pricing")).toBe(true);
    const fresh = app()!.board;
    expect(fresh).not.toBe(board);
    expect(fresh.project).not.toBe(a);
    expect(loadVersions(fresh.project)).toEqual([]);
    expect(location.search).toBe(`?p=${fresh.project}`);

    // Opening the old one (from the projects page) shows it.
    await act(async () => navigate(`/?p=${a}`));
    await until(() => app()!.board.project === a);
  });

  it("opening another project lets go of the mic, and the old board stops following the settings", async () => {
    const a = project(doc());
    const b = project(doc());
    await open(a);
    const old = app()!.board;
    await act(async () => document.querySelector<HTMLButtonElement>(".pg-mic")!.click());
    await until(() => fake.mics.some((m) => m.on));

    await act(async () => navigate(`/?p=${b}`));
    await until(() => app()!.board.project === b);
    await wait(50);
    expect(fake.mics.filter((m) => m.on)).toEqual([]);
    expect(document.querySelector(".pg-mic.on")).toBeNull();

    const was = getModel();
    const tuning = old.tuning;
    setModel(was.name === "opus" ? "sonnet" : "opus");
    try {
      expect(old.tuning).toBe(tuning);
      expect(app()!.board.tuning).not.toBe(tuning);
    } finally {
      setModel(was.name);
    }
  });

  it("what's said is written into the text box, stays there to edit, and is sent only at Enter, with its times", async () => {
    await open(project(doc()));
    let input: { words: Word[] | string } | undefined;
    fake.send = async (_scene, i) => ((input = i), sent);
    const box = () => document.querySelector<HTMLTextAreaElement>(".pg-bar textarea")!;
    await act(async () => type(box(), "add a header,"));
    await act(async () => document.querySelector<HTMLButtonElement>(".pg-mic")!.click());
    await until(() => fake.scribes.length);
    const scribe = fake.scribes[0];
    await act(async () => scribe.onInterim("make the hero"));
    expect(box().value).toBe("add a header, make the hero");
    expect(document.querySelector(".pg-captions")).toBeNull();
    const t = performance.now() - 2000;
    const heard = ["make", "the", "hero", "blue"].map((word, i) => ({ word, t0: t + i * 100, t1: t + i * 100 + 80 }));
    await act(async () => scribe.onFinal({ text: "make the hero blue", words: heard, t0: t, t1: t + 380, finalAt: t + 700, features: {} }));
    expect(box().value).toBe("add a header, make the hero blue");
    // Speech ending sends nothing: the words wait in the box.
    await wait(100);
    expect(input).toBeUndefined();
    expect(app()!.log.sends).toHaveLength(0);

    await act(async () => type(box(), "add a header, make the hero red please"));
    await act(async () => void box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => input);
    expect(box().value).toBe("");
    const words = input!.words as Word[];
    expect(words.map((w) => w.word)).toEqual(["add", "a", "header,", "make", "the", "hero", "red", "please"]);
    // On the ink clock: said words a tenth of a second apart, "red" at the time "blue" was said, typed words at Enter.
    expect(words.slice(3, 7).map((w) => w.t0 - words[3].t0)).toEqual([0, 100, 200, 300]);
    expect(words[0].t0).toBe(words[7].t0);
    expect(words[7].t0).toBeGreaterThan(words[6].t1);
    expect(app()!.log.sends[0]).toMatchObject({ label: "add a header, make the hero red please", spoken: true });
  });

  it("a send while an old version is pinned is timed from the live board", async () => {
    const a = project(doc(BOX_A), doc(BOX_A, BOX_B));
    await open(a);
    const { board, sender, log } = app()!;
    await act(async () => board.look(1, true));
    await wait(60);
    expect(document.querySelector('svg.bd g[data-id="b"]')).toBeNull();

    fake.send = async () => sent;
    sender.enqueue(job("change nothing"));
    await act(() => sender.idle());
    expect(log.sends[0].status).toBe("done");
    expect(log.sends[0].ttfcMs).toBeUndefined();
  });
});

describe("onboarding", () => {
  beforeEach(() => {
    localStorage.removeItem("rt-draw.tour");
    localStorage.removeItem("rt-draw.tips");
  });
  const tip = () => document.querySelector(".ob-tip")?.textContent ?? "";

  it("an empty board shows the tour once, then first drawings that send in one tap", async () => {
    const a = project();
    await open(a);
    expect(document.querySelector(".ob-tour")).not.toBeNull();
    expect(document.querySelector(".ob-starters")).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>(".ob-start")!.click());
    expect(document.querySelector(".ob-tour")).toBeNull();
    expect([...document.querySelectorAll(".ob-starter")].map((b) => b.textContent)).toEqual(STARTERS.map((s) => s.label));

    fake.send = async (scene: Scene, _input, _tuning, hooks) => {
      runScript(BOX_A, scene);
      hooks.onOp?.({ line: BOX_A, ok: true, ms: 1 });
      return sent;
    };
    await act(async () => document.querySelector<HTMLButtonElement>(".ob-starter")!.click());
    await act(() => app()!.sender.idle());
    await until(() => loadVersions(a).length === 1);
    expect(loadVersions(a)[0].label).toBe(STARTERS[0].prompt);
    expect(document.querySelector(".ob-starters")).toBeNull();
    // Drawn: the first move to try, in the bubble.
    await until(() => tip().includes("circle"));

    // The tour doesn't come back on the next empty board, but the settings show it again.
    await act(async () => navigate(`/?p=${project()}`));
    await until(() => app()!.board.project !== a);
    expect(document.querySelector(".ob-tour")).toBeNull();
    expect(document.querySelector(".ob-starters")).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>(".st-gear")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".st-tour")!.click());
    expect(document.querySelector(".ob-tour")).not.toBeNull();
  });

  it("the bubble suggests one move at a time: × skips one, and doing one checks it off", async () => {
    await open(project(doc(BOX_A)));
    expect(document.querySelector(".ob-tour")).toBeNull();
    expect(tip()).toContain("circle");
    await act(async () => document.querySelector<HTMLButtonElement>(".ob-tip button")!.click());
    expect(tip()).toContain("another screen");

    // A board with two pages has done that one; the mic checks off talking.
    localStorage.setItem("rt-draw.tips", '["circle","preview"]');
    await act(async () => navigate(`/?p=${project(doc(BOX_A, `shape(p2, frame, 1500 0 1280 800, "a second page, empty")`))}`));
    await until(() => tip().includes("mic"));
    await act(async () => document.querySelector<HTMLButtonElement>(".pg-mic")!.click());
    await until(() => tip().includes("arrow"));
    expect(JSON.parse(localStorage.getItem("rt-draw.tips")!).sort()).toEqual(["circle", "page", "preview", "talk"]);
  });
});

// A two-page site: Home's nav links to Services; a heading links nowhere.
const SITE = `shape(nav-services, pill, 900 28 110 30, "the Services item in the nav of Home", link:services)
text(nav-services, "Services")
shape(title, rect, 80 200 600 80, "the big heading of the Home page hero")
text(title, "Fresh bread every day")
shape(services, frame, 1500 0 1280 800, "the Services page listing what the shop does")
text(services, "Services")`;

describe("the preview", () => {
  /** Lays every page's <svg> out as 1280×800 at the window's top left, as a 100% preview of a 1280-wide page would be. */
  const rect = Element.prototype.getBoundingClientRect;
  const context = HTMLCanvasElement.prototype.getContext;
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function () {
      return this.classList?.contains("pv-page") ? ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0 } as DOMRect) : rect.call(this);
    };
    // happy-dom has no canvas: the renderer measures words to wrap them.
    HTMLCanvasElement.prototype.getContext = (() => ({ font: "", measureText: (t: string) => ({ width: t.length * 10 }) })) as never;
  });
  afterAll(() => {
    Element.prototype.getBoundingClientRect = rect;
    HTMLCanvasElement.prototype.getContext = context;
  });
  const clickAt = (x: number, y: number) =>
    act(async () => void document.querySelector("svg.pv-page")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y })));
  const select = () => document.querySelector<HTMLSelectElement>(".pv-bar select")!;

  it("opens from the hash; a link goes to its page, as a new history entry, and a heading does nothing", async () => {
    const a = project(doc(SITE));
    history.replaceState(null, "", `/?p=${a}#preview`);
    await openKeepingHash(a);
    expect(select().value).toBe("page");
    await clickAt(300, 240);
    expect(location.hash).toBe("#preview");
    const before = history.length;
    await clickAt(950, 40);
    expect(location.hash).toBe("#preview=services");
    expect(select().value).toBe("services");
    expect(history.length).toBe(before + 1);
  });

  it("opening the preview lets go of a version pinned in History: it shows the board as it is now", async () => {
    const a = project(doc(SITE), doc(SITE, BOX_A));
    history.replaceState(null, "", `/?p=${a}`);
    await open(a);
    const { board } = app()!;
    await act(async () => board.look(1, true));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".lp-head button")].find((b) => b.textContent?.includes("Preview"))!.click());
    expect(document.querySelector(".pv")).not.toBeNull();
    expect(board.history.looking).toBeUndefined();
  });

  it("offers Full screen only where the browser can do it (iPhones can't)", async () => {
    const a = project(doc(SITE));
    history.replaceState(null, "", `/?p=${a}#preview`);
    const labels = () => [...document.querySelectorAll(".pv-bar button")].map((b) => b.textContent?.trim());
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
    try {
      await openKeepingHash(a);
      expect(labels()).not.toContain("Full screen");
      Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
      await act(async () => {
        select().value = "services";
        select().dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(labels()).toContain("Full screen");
    } finally {
      delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    }
  });

  it("Edit this page goes back to the board on that page, and the pill returns to the preview there", async () => {
    const a = project(doc(SITE));
    history.replaceState(null, "", `/?p=${a}#preview=services`);
    await openKeepingHash(a);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".pv-bar button")].find((b) => b.textContent?.includes("Edit this page"))!.click());
    expect(document.querySelector(".pv")).toBeNull();
    expect(location.hash).toBe("");
    expect(document.querySelector(".lp-tree button.on")?.textContent).toContain("Services");
    const pill = document.querySelector<HTMLButtonElement>(".pg-back")!;
    expect(pill.textContent).toContain("on Services");
    await act(async () => pill.click());
    expect(location.hash).toBe("#preview=services");
    expect(select().value).toBe("services");
    expect(document.querySelector(".pg-back")).toBeNull();
  });
});

describe("on a phone", () => {
  // A phone-sized screen, as the CSS's compact rules see it (happy-dom doesn't evaluate media queries).
  const real = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((q: string) => ({ matches: q === COMPACT, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  });
  afterEach(() => {
    window.matchMedia = real;
  });
  const fold = () => document.querySelector<HTMLButtonElement>(".pg-fold")!;

  it("the sidebar folds into a button with the project's name; it opens over the board, and going to a page folds it", async () => {
    const a = project(doc(SITE));
    await open(a);
    expect(document.querySelector(".lp-panel")).toBeNull();
    expect(fold().textContent).toContain(app()!.board.meta()?.name ?? "Untitled");
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    await act(async () => fold().click());
    expect(document.querySelector(".lp-panel")).not.toBeNull();
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".lp-tree button")].find((b) => b.textContent?.includes("Services"))!.click());
    expect(document.querySelector(".lp-panel")).toBeNull();
    // A tap on the board around it folds it too, and draws nothing there.
    await act(async () => fold().click());
    await act(async () => document.querySelector<HTMLElement>(".pg-scrim")!.click());
    expect(document.querySelector(".lp-panel")).toBeNull();
    expect(document.querySelector(".pg-scrim")).toBeNull();
  });

  it("on a big screen the sidebar stays open, with no button to fold it", async () => {
    window.matchMedia = real;
    await open(project(doc(SITE)));
    expect(document.querySelector(".lp-panel")).not.toBeNull();
    expect(document.querySelector(".pg-fold")).toBeNull();
  });
});

/** open(), but the URL's hash (the preview) is kept. */
async function openKeepingHash(id: string) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<Root />));
  await until(() => app()?.board.project === id);
  await until(() => document.querySelector(".pv"));
}
