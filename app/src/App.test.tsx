// The editor in a tab, end to end: Root and App on a fake projects server, with
// v2's send() and the mic stood in for (no model calls, no microphone). For what
// only shows across a project switch, and on the board's own clock.
import ELK from "elkjs/lib/elk.bundled.js";
import { act } from "react";
import { type Root as ReactRoot, createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runScript } from "../../src/core/ops.ts";
import { Scene, type SceneJSON } from "../../src/core/scene.ts";
import type { Board } from "./board/board.ts";
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
