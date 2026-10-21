// Sends, one at a time: each Enter queues a job (its ink, and its words, which may
// still be on their way from Scribe), and a job runs once the one before it has
// finished, pictures and glide included, as every send the eval measured ran
// alone. Stop ends the running send and drops the queued ones. Each send is timed
// step by step (latency.ts) and by the eval's own clock on the board.
import type { Clock } from "../../../evals/bridge/timing.ts";
import type { OpResult } from "../../../src/core/draw.ts";
import type { Stroke } from "../../../src/core/ink.ts";
import type { Word } from "../../../src/core/link.ts";
import type { SendHooks, SendInput, Sent } from "../../../src/core/send.ts";
import type { LatencyLog, SendTimes } from "./latency.ts";

export type Job = { label: string; spoken: boolean; strokes: Stroke[]; words: Promise<Word[] | string>; enter: number };

export type SenderDeps = {
  /** One send: v2's send() on the board, with these hooks added to the app's own. */
  run: (input: SendInput, hooks: Pick<SendHooks, "onPrompt" | "onOp" | "onReply" | "signal">) => Promise<Sent>;
  /** The drawing model, for the overlay. */
  model: () => string;
  /** The eval's clock on the board's <svg>, once it's mounted. */
  clock: () => Pick<Clock, "enter" | "measure"> | undefined;
  /** n of the newest model call so far. */
  lastCall: () => number;
  /** Until the last change is on screen: two animation frames. */
  frame?: () => Promise<void>;
  /** A send is starting. */
  onStart?: (job: Job) => void;
  /** A send ended; `landed` ops changed the board. */
  onEnd: (job: Job, landed: number, error?: string) => void;
  log: LatencyLog;
};

export type SendStatus = { running: boolean; queued: number; ops: number; settling: boolean; done: boolean; error?: string; rejected: number };

const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Sender {
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by stop(): a job queued before it is dropped when its turn comes. */
  private epoch = 0;
  private waiting = 0;
  private current?: { times: SendTimes; abort: AbortController };
  private status: SendStatus = { running: false, queued: 0, ops: 0, settling: false, done: false, rejected: 0 };
  private listeners = new Set<() => void>();

  constructor(private deps: SenderDeps) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** The same object until something changes (useSyncExternalStore). */
  getStatus = () => this.status;

  /** Resolves once every send queued so far has ended. */
  idle = () => this.chain;

  enqueue(job: Job) {
    const { log } = this.deps;
    const times = log.begin({ label: job.label, spoken: job.spoken, model: this.deps.model(), enter: job.enter });
    const settled = () => {
      times.words = performance.now();
      log.touch();
    };
    job.words.then(settled, settled);
    const epoch = this.epoch;
    this.waiting++;
    this.set({ queued: this.waiting });
    this.chain = this.chain.then(() => this.run(job, times, epoch));
  }

  stop() {
    this.epoch++;
    this.current?.abort.abort();
  }

  /** The running send's drawing call has its first text. */
  firstText(at = performance.now()) {
    const t = this.current?.times;
    if (!t || t.firstText !== undefined || t.start === undefined) return;
    t.firstText = at;
    this.deps.log.touch();
  }

  private set(change: Partial<SendStatus>) {
    this.status = { ...this.status, ...change };
    this.listeners.forEach((fn) => fn());
  }

  private async run(job: Job, times: SendTimes, epoch: number) {
    const { deps } = this;
    const { log } = deps;
    this.waiting--;
    const words = await job.words.catch(() => "");
    if (epoch !== this.epoch) {
      times.status = "stopped";
      this.set({ queued: this.waiting, running: false });
      log.touch();
      return;
    }
    const abort = new AbortController();
    this.current = { times, abort };
    times.status = "running";
    this.set({ running: true, queued: this.waiting, ops: 0, rejected: 0, settling: false, done: false, error: undefined });
    deps.onStart?.(job);
    times.start = performance.now();
    times.callsFrom = deps.lastCall();
    const clock = deps.clock();
    const before = clock?.enter();
    log.touch();

    let landed = 0;
    let error: string | undefined;
    let sent: Sent | undefined;
    const onOp = (r: OpResult) => {
      if (r.ok && !r.camera) {
        landed++;
        times.changes++;
        times.firstOp ??= performance.now();
      } else if (!r.ok) times.rejected++;
      this.set({ ops: landed, rejected: times.rejected });
      log.touch();
    };
    try {
      sent = await deps.run(
        { strokes: job.strokes, words },
        {
          signal: abort.signal,
          onPrompt: () => ((times.prompt = performance.now()), log.touch()),
          onOp,
          onReply: (r) => {
            times.reply = performance.now();
            if (r.error) error = r.error;
            this.set({ settling: true });
            log.touch();
          },
        },
      );
    } catch (e) {
      error = message(e);
    }
    const stopped = abort.signal.aborted;
    times.reply ??= performance.now();
    times.pictures = sent?.pics ? times.start + sent.pics.ms : times.reply;
    times.end = performance.now();
    await (deps.frame ?? twoFrames)();
    if (clock && before) {
      const m = clock.measure(before, times.start);
      times.ttfcMs = m.ttfcMs;
      // A send that changes nothing has its end as TTD, so doing nothing never reads as fast (as the bridge does).
      times.ttdMs = m.ttdMs ?? Math.round(times.end - times.start);
    }
    times.callsTo = deps.lastCall();
    if (stopped) error = undefined;
    times.error = error;
    times.status = stopped ? "stopped" : error ? "error" : "done";
    this.current = undefined;
    const more = this.waiting > 0;
    this.set({ running: false, settling: false, done: !error && !stopped && !more, error });
    log.touch();
    deps.onEnd(job, landed, error);
  }
}
