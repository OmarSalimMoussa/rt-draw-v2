// Building a page from a preview click (build.ts): the page and its link are made
// in code when the build's turn comes, placed, and only then is the model asked to
// draw it; a build that draws nothing takes them away again.
import { describe, expect, it, vi } from "vitest";
import type { Prompt } from "../../../src/core/draw.ts";
import { runScript } from "../../../src/core/ops.ts";
import type { Scene } from "../../../src/core/scene.ts";
import type { Sent } from "../../../src/core/send.ts";
import { LatencyLog } from "../board/latency.ts";
import { Sender } from "../board/sender.ts";
import { type BuildDeps, buildJob } from "./build.ts";

const D = '"a part of the page used by these tests"';
const site = () =>
  runScript(`shape(page, frame, 0 0 1280 900, ${D})
text(page, "Home")
shape(nav-contact, pill, 1030 28 110 30, ${D}, link:contact)
text(nav-contact, "Contact")
shape(book, pill, 80 320 200 50, ${D}, button:yes)
text(book, "Book a repair")`).scene;

const sent = (): Sent => ({ prompt: {} as Prompt, result: { ops: [], ms: 1, reply: "" } });

/** A build on `scene`, through a real sender whose sends the test finishes by hand. */
function rig(scene: Scene) {
  const sends: { words: unknown; land: (n: number) => void; fail: (e: Error) => void }[] = [];
  const sender = new Sender({
    run: (input, hooks) =>
      new Promise((ok, no) =>
        sends.push({
          words: input.words,
          land: (n) => {
            for (let i = 0; i < n; i++) hooks.onOp?.({ line: "x", ok: true, ms: 1 });
            ok(sent());
          },
          fail: no,
        }),
      ),
    model: () => "sonnet",
    clock: () => undefined,
    lastCall: () => 0,
    frame: async () => {},
    onEnd: () => {},
    log: new LatencyLog(),
  });
  // The layout puts a new page at 1500 -130.
  const settle = vi.fn(async () => {
    for (const p of scene.stacked()) if (p.kind === "frame" && p.id !== "page") p.box = { ...p.box, x: 1500, y: -130 };
  });
  const deps: BuildDeps = { scene: () => scene, settle, focus: vi.fn(async () => {}), enter: () => performance.now() };
  return { sender, sends, settle, deps };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("building a page from a click", () => {
  it("makes the page and the link when its turn comes, places it, then asks for it with its placed box", async () => {
    const scene = site();
    const { sender, sends, settle, deps } = rig(scene);
    const done = vi.fn();
    const b = buildJob(deps, { shape: scene.get("nav-contact")!, from: scene.get("page")! }, done);
    expect(b).toMatchObject({ to: "contact", label: "Contact", w: 1280, h: 900 });
    expect(b.job.label).toBe("Preview click: Contact");
    expect(scene.get("contact")).toBeUndefined();
    sender.enqueue(b.job);
    await tick();
    await tick();
    expect(scene.get("contact")).toMatchObject({ kind: "frame", text: { words: "Contact" }, box: { x: 1500, y: -130, w: 1280, h: 900 } });
    expect(scene.get("nav-contact")!.link).toBe("contact");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(deps.focus).toHaveBeenCalledWith(scene.get("contact"));
    expect(sends[0].words).toContain("Its page, contact, has just been made, empty, at 1500 -130 1280 900.");
    sends[0].land(3);
    await sender.idle();
    expect(done).toHaveBeenCalledWith("done", 3, undefined);
    expect(scene.get("contact")).toBeDefined();
  });

  it("a button with no link gets a fresh page id from its words", async () => {
    const scene = site();
    const { sender, deps } = rig(scene);
    const b = buildJob(deps, { shape: scene.get("book")!, from: scene.get("page")! }, () => {});
    expect(b.to).toBe("book-a-repair");
    sender.enqueue(b.job);
    await tick();
    await tick();
    expect(scene.get("book")!.link).toBe("book-a-repair");
  });

  it("a failed build with nothing drawn takes the page and link away", async () => {
    const scene = site();
    const { sender, sends, settle, deps } = rig(scene);
    const done = vi.fn();
    sender.enqueue(buildJob(deps, { shape: scene.get("book")!, from: scene.get("page")! }, done).job);
    await tick();
    await tick();
    sends[0].fail(new Error("Claude is down"));
    await sender.idle();
    expect(scene.get("book-a-repair")).toBeUndefined();
    expect(scene.get("book")!.link).toBeUndefined();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledWith("error", 0, "Claude is down");
  });

  it("a build stopped before its turn makes no page", async () => {
    const scene = site();
    const { sender, sends, deps } = rig(scene);
    const done = vi.fn();
    sender.enqueue({ label: "A", spoken: false, strokes: [], words: Promise.resolve("A"), enter: 0 });
    sender.enqueue(buildJob(deps, { shape: scene.get("nav-contact")!, from: scene.get("page")! }, done).job);
    await tick();
    sender.stop();
    sends[0].land(0);
    await sender.idle();
    expect(scene.get("contact")).toBeUndefined();
    expect(done).toHaveBeenCalledWith("stopped", 0, undefined);
  });
});
