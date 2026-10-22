// Sends, one at a time: each Enter queues a job (its ink, and its words, which may
// still be on their way from Scribe), and a job runs once the one before it has
// finished, pictures and glide included, as every send the eval measured ran
// alone. Stop ends the running send and drops the queued ones. Each send is timed
// step by step (latency.ts) and by the eval's own clock on the board. A failure
// stays on show until the sends queued with it are over, and the next Enter after
// that starts clean. A send's end may settle the board (place its pages): the next
// send waits for that too, so the layout never runs during a send, and the wait is
// the send's layout stage. A job may also do something first (the preview's build
// makes its page) and hear how it went.
import type { Clock } from "../../../evals/bridge/timing.ts";
import type { OpResult } from "../../../src/core/draw.ts";
import type { Stroke } from "../../../src/core/ink.ts";
import type { Word } from "../../../src/core/link.ts";
import type { SendHooks, SendInput, Sent } from "../../../src/core/send.ts";
import type { LatencyLog, SendTimes } from "./latency.ts";

export type JobStatus = "done" | "error" | "stopped";

export type Job = {
  label: string;
  spoken: boolean;
  strokes: Stroke[];
  words: Promise<Word[] | string>;
  enter: number;
  /** Its turn has come, before the send starts (not run if it was stopped while it waited). */
  before?: () => Promise<void>;
  /** After it ended, the board settled and committed: how it went, and how many ops changed the board. */
  done?: (status: JobStatus, landed: number, error?: string) => void;
};

export type SenderDeps = {
  /** One send: v2's send() on the board, with these hooks added to the app's own. */
  run: (input: SendInput, hooks: Pick<SendHooks, "onPrompt" | "onOp" | "onReply" | "signal">) => Promise<Sent>;
  /** The drawing model, for the overlay. */
  model: () => string;
  /** The eval's clock on the board's <svg>, once it's mounted. */
  clock: () => Pick<Clock, "enter" | "measure"> | undefined;
  /** n of the newest model call so far. */
  lastCall: () => number;
  /** The model calls numbered from < n ≤ to that failed (a send can go through without them: Jev's fallback, a picture), as "who: why". */
  failedCalls?: (from: number, to: number) => string[];
  /** Until the last change is on screen: two animation frames. */
  frame?: () => Promise<void>;
  /** Resolves once the board isn't busy placing its pages (a send never starts mid-layout). */
  ready?: () => Promise<void>;
  /** A send is starting. */
  onStart?: (job: Job) => void;
  /** A send ended; `landed` ops changed the board. A promise: the board is settling, and the next send waits for it. */
  onEnd: (job: Job, landed: number, error?: string) => void | Promise<void>;
  log: LatencyLog;
};

/** `failed`, `error` (the latest reason) and `callErrors` cover every send since the queue was last empty. */
export type SendStatus = { running: boolean; queued: number; ops: number; settling: boolean; done: boolean; error?: string; failed: number; callErrors: string[]; rejected: number };

const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Sender {
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by stop(): a job queued before it is dropped when its turn comes. */
  private epoch = 0;
  private waiting = 0;
  private current?: { times: SendTimes; abort: AbortController };
  private status: SendStatus = { running: false, queued: 0, ops: 0, settling: false, done: false, failed: 0, callErrors: [], rejected: 0 };
  private listeners = new Set<() => void>();
  /** Jobs whose done() has been called: once each, crash or not. */
  private told = new WeakSet<Job>();

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
    const fresh = !this.status.running && this.waiting === 0;
    this.waiting++;
    this.set({ queued: this.waiting, ...(fresh && { error: undefined, failed: 0, callErrors: [] }) });
    // A throw in a hook mustn't stop the sends queued after it.
    this.chain = this.chain.then(() => this.run(job, times, epoch)).catch((e) => this.crashed(job, times, e));
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

  private crashed(job: Job, times: SendTimes, e: unknown) {
    this.current = undefined;
    times.status = "error";
    times.error = message(e);
    times.end ??= performance.now();
    this.set({ running: false, settling: false, queued: this.waiting, done: false, error: message(e), failed: this.status.failed + 1 });
    this.deps.log.touch();
    this.tell(job, "error", 0, message(e));
  }

  private tell(job: Job, status: JobStatus, landed: number, error?: string) {
    if (this.told.has(job)) return;
    this.told.add(job);
    job.done?.(status, landed, error);
  }

  private set(change: Partial<SendStatus>) {
    this.status = { ...this.status, ...change };
    this.listeners.forEach((fn) => fn());
  }

  private async run(job: Job, times: SendTimes, epoch: number) {
    const { deps } = this;
    const { log } = deps;
    this.waiting--;
    await deps.ready?.();
    if (epoch === this.epoch) await job.before?.();
    const words = await job.words.catch(() => "");
    if (epoch !== this.epoch) {
      times.status = "stopped";
      this.set({ queued: this.waiting, running: false });
      log.touch();
      this.tell(job, "stopped", 0);
      return;
    }
    const abort = new AbortController();
    this.current = { times, abort };
    times.status = "running";
    this.set({ running: true, queued: this.waiting, ops: 0, rejected: 0, settling: false, done: false });
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
    const status: JobStatus = stopped ? "stopped" : error ? "error" : "done";
    times.status = status;
    this.current = undefined;
    const more = this.waiting > 0;
    const failed = this.status.failed + (error ? 1 : 0);
    const callErrors = stopped || error ? [] : (deps.failedCalls?.(times.callsFrom, times.callsTo) ?? []);
    this.set({
      running: false,
      settling: false,
      done: !failed && !stopped && !more,
      error: error ?? this.status.error,
      failed,
      callErrors: [...this.status.callErrors, ...callErrors],
    });
    log.touch();
    const settling = deps.onEnd(job, landed, error);
    if (settling) {
      await settling;
      times.layout = performance.now();
      log.touch();
    }
    this.tell(job, status, landed, error);
  }
}
