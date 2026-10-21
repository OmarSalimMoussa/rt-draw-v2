import { describe, expect, it, vi } from "vitest";
import type { OpResult, Prompt } from "../../../src/core/draw.ts";
import type { Sent, SendHooks, SendInput } from "../../../src/core/send.ts";
import { LatencyLog } from "./latency.ts";
import { type Job, Sender, type SenderDeps } from "./sender.ts";

type Call = { input: SendInput; hooks: Pick<SendHooks, "onPrompt" | "onOp" | "onReply" | "signal">; done: (s?: Partial<Sent>) => void; fail: (e: Error) => void };

const sent = (over: Partial<Sent> = {}): Sent => ({ prompt: {} as Prompt, result: { ops: [], ms: 1, reply: "" }, pics: { drawn: 0, failed: [], ms: 10 }, ...over });

/** A sender over a fake send() whose calls the test finishes by hand. */
function rig(over: Partial<SenderDeps> = {}) {
  const runs: Call[] = [];
  let last = 0;
  const log = new LatencyLog();
  const deps: SenderDeps = {
    run: (input, hooks) => new Promise<Sent>((ok, no) => runs.push({ input, hooks, done: (s) => ok(sent(s)), fail: no })),
    model: () => "sonnet",
    clock: () => ({ enter: () => new Map([["page", "a"]]), measure: vi.fn(() => ({ ttfcMs: 100, ttdMs: 300, changed: ["x"] })) }),
    lastCall: () => last,
    frame: async () => {},
    onEnd: vi.fn(),
    log,
    ...over,
  };
  const sender = new Sender(deps);
  const job = (label: string, words: Promise<string> = Promise.resolve(label)): Job => ({ label, spoken: false, strokes: [{ id: 1, points: [[0, 0, 0]], t0: 0, t1: 0 }], words, enter: performance.now() });
  return { sender, runs, deps, log, job, setLast: (n: number) => (last = n) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const op = (ok: boolean, camera = false): OpResult => ({ line: "x", ok, ms: 1, ...(camera && { camera: { x: 0, y: 0, w: 1280, h: 800 } }) });

describe("sender", () => {
  it("runs one send at a time, in order", async () => {
    const { sender, runs, job } = rig();
    sender.enqueue(job("A"));
    sender.enqueue(job("B"));
    await tick();
    expect(runs).toHaveLength(1);
    expect(runs[0].input.words).toBe("A");
    runs[0].done();
    await tick();
    expect(runs).toHaveLength(2);
    expect(runs[1].input.words).toBe("B");
  });

  it("waits for the words before starting", async () => {
    const { sender, runs, job } = rig();
    let say!: (w: string) => void;
    sender.enqueue(job("spoken", new Promise<string>((r) => (say = r))));
    await tick();
    expect(runs).toHaveLength(0);
    say("make it blue");
    await tick();
    expect(runs[0].input.words).toBe("make it blue");
  });

  it("a failed send shows its error and the next one still runs", async () => {
    const { sender, runs, deps, log, job } = rig();
    sender.enqueue(job("A"));
    await tick();
    runs[0].fail(new Error("CLAUDE_CODE_OAUTH_TOKEN is not set in .env"));
    await sender.idle();
    expect(sender.getStatus()).toMatchObject({ running: false, done: false, error: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN") });
    expect(deps.onEnd).toHaveBeenCalledWith(expect.objectContaining({ label: "A" }), 0, expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN"));
    expect(log.sends[0].status).toBe("error");
    // The queue isn't wedged: the next Enter still sends.
    sender.enqueue(job("B"));
    await tick();
    expect(runs).toHaveLength(2);
  });

  it("a send that fails while another is queued still shows its error once the queue is done", async () => {
    const { sender, runs, job } = rig();
    sender.enqueue(job("A"));
    sender.enqueue(job("B"));
    await tick();
    runs[0].fail(new Error("Jev 401: bad key"));
    await tick();
    expect(sender.getStatus()).toMatchObject({ running: true, failed: 1, error: expect.stringContaining("Jev 401") });
    runs[1].done();
    await sender.idle();
    expect(sender.getStatus()).toMatchObject({ running: false, done: false, failed: 1, error: expect.stringContaining("Jev 401") });
    // The next Enter, once all that's over, starts clean.
    sender.enqueue(job("C"));
    expect(sender.getStatus()).toMatchObject({ failed: 0, error: undefined });
  });

  it("a send that went through with a failed model call says so", async () => {
    const failedCalls = vi.fn(() => ["Jev: TYPESAFE_API_KEY is not set in .env"]);
    const { sender, runs, job, setLast } = rig({ failedCalls });
    setLast(2);
    sender.enqueue(job("A"));
    await tick();
    setLast(5);
    runs[0].done();
    await sender.idle();
    expect(failedCalls).toHaveBeenCalledWith(2, 5);
    expect(sender.getStatus()).toMatchObject({ done: true, error: undefined, callErrors: ["Jev: TYPESAFE_API_KEY is not set in .env"] });
  });

  it("a throw after a send doesn't wedge the queue", async () => {
    const onEnd = vi.fn().mockImplementationOnce(() => {
      throw new Error("save failed");
    });
    const { sender, runs, job } = rig({ onEnd });
    sender.enqueue(job("A"));
    sender.enqueue(job("B"));
    await tick();
    runs[0].done();
    await tick();
    await tick();
    expect(runs).toHaveLength(2);
    runs[1].done();
    await sender.idle();
    expect(sender.getStatus()).toMatchObject({ running: false, queued: 0, error: expect.stringContaining("save failed") });
  });

  it("stop aborts the running send and drops the queued ones", async () => {
    const { sender, runs, log, job } = rig();
    sender.enqueue(job("A"));
    sender.enqueue(job("B"));
    await tick();
    sender.stop();
    expect(runs[0].hooks.signal?.aborted).toBe(true);
    runs[0].done();
    await sender.idle();
    expect(runs).toHaveLength(1);
    expect(sender.getStatus()).toMatchObject({ running: false, queued: 0 });
    expect(log.sends.find((t) => t.label === "B")!.status).toBe("stopped");
  });

  it("counts landed ops: ok and not a camera", async () => {
    const { sender, runs, deps, log, job } = rig();
    sender.enqueue(job("A"));
    await tick();
    for (const r of [op(true), op(true, true), op(true), op(false)]) runs[0].hooks.onOp?.(r);
    runs[0].done();
    await sender.idle();
    expect(deps.onEnd).toHaveBeenCalledWith(expect.objectContaining({ label: "A" }), 2, undefined);
    expect(log.sends[0].rejected).toBe(1);
  });

  it("measures with the eval's clock from send start", async () => {
    const measure = vi.fn(() => ({ ttfcMs: 100, ttdMs: 300, changed: ["x"] }));
    const before = new Map([["page", "a"]]);
    const { sender, runs, log, job } = rig({ clock: () => ({ enter: () => before, measure }) });
    sender.enqueue(job("A"));
    await tick();
    runs[0].done();
    await sender.idle();
    const t = log.sends[0];
    expect(measure).toHaveBeenCalledWith(before, t.start);
    expect(t).toMatchObject({ ttfcMs: 100, ttdMs: 300, status: "done" });
  });

  it("records the calls made during the send", async () => {
    const { sender, runs, log, job, setLast } = rig();
    setLast(5);
    sender.enqueue(job("A"));
    await tick();
    setLast(9);
    runs[0].done();
    await sender.idle();
    expect(log.sends[0]).toMatchObject({ callsFrom: 5, callsTo: 9 });
  });
});
