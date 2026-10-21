// The mic, on until you turn it off, across sends: talk, then press Enter. v2's
// Scribe engine (src/core/speech.ts) gives up its last words only by closing
// (a final commit, then the socket shuts), and a new engine on a running mic
// would send all its audio again from the start. So each send gets a session of
// its own, a mic and an engine: at Enter the next session opens first, then the
// old one is flushed, and its words are this send's. Words said from then on are
// the next send's. ScribeEngine sends its mic's audio from sample 0 once its
// socket opens, so the token fetch loses nothing; the gap is the new mic starting.
import type { Word } from "../../../src/core/link.ts";
import type { SpeechEvents } from "../../../src/core/speech.ts";

export type MicLike = { start(): Promise<void>; stop(): void };
export type EngineLike = { start(): Promise<void>; stop(): Promise<void> };
export type VoiceDeps = { mic: () => MicLike; engine: (events: SpeechEvents, mic: MicLike) => EngineLike };

type Session = { mic: MicLike; engine: EngineLike; words: Word[]; closed: boolean; started: boolean; ready: Promise<void> };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Voice {
  listening = false;
  /** What Scribe is hearing now, not final yet. */
  interim = "";
  /** The final text since the last take. */
  heard = "";
  error?: string;
  private session?: Session;
  /** Words of a session closed by stop(), waiting for the next take. */
  private kept: Word[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();

  constructor(private deps: VoiceDeps) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  private touch() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  async start() {
    if (this.listening) return;
    this.error = undefined;
    this.listening = true;
    this.session = this.open();
    this.touch();
    await this.session.ready;
  }

  /** Turns the mic off. What it heard waits for the next take. */
  async stop() {
    if (!this.listening) return;
    this.listening = false;
    const s = this.session;
    this.session = undefined;
    this.interim = "";
    this.touch();
    if (!s) return;
    const done = this.close(s).then((ws) => void this.kept.push(...ws));
    this.flushing = done;
    await done;
  }

  /** This send's words, on the page clock. While listening, the next send's session is open before this one flushes. */
  async take(): Promise<Word[]> {
    const old = this.session;
    this.heard = "";
    this.interim = "";
    this.session = this.listening ? this.open() : undefined;
    this.touch();
    await this.flushing;
    const kept = this.kept.splice(0);
    return [...kept, ...(old ? await this.close(old) : [])];
  }

  private open(): Session {
    const mic = this.deps.mic();
    const s = { mic, words: [] as Word[], closed: false, started: false } as Session;
    // Only the open session shows what it hears: a closing one's flush belongs to the send that took it.
    const mine = () => s === this.session;
    s.engine = this.deps.engine(
      {
        onInterim: (text) => {
          if (!mine()) return;
          this.interim = text;
          this.touch();
        },
        onFinal: (u) => {
          s.words.push(...u.words);
          if (!mine()) return;
          this.heard = this.heard ? `${this.heard} ${u.text}` : u.text;
          this.interim = "";
          this.touch();
        },
        onError: (e) => {
          this.error = e;
          this.touch();
        },
      },
      mic,
    );
    s.ready = (async () => {
      try {
        await mic.start();
        if (s.closed) return mic.stop();
        await s.engine.start();
        if (s.closed) {
          // Closed while starting: flush what it heard, then let go of the mic.
          await s.engine.stop();
          return mic.stop();
        }
        s.started = true;
      } catch (err) {
        mic.stop();
        this.error = message(err);
        if (mine()) {
          this.listening = false;
          this.session = undefined;
        }
        this.touch();
      }
    })();
    return s;
  }

  /** Flushes a session and lets go of its mic: its words, in the order said. */
  private async close(s: Session): Promise<Word[]> {
    s.closed = true;
    await s.ready;
    if (s.started) {
      s.started = false;
      await s.engine.stop();
      s.mic.stop();
    }
    return s.words;
  }
}

/** Scribe's page-clock word times moved onto a send's ink clock (ms since `epoch`), as the draw playground does. */
export const onInkClock = (words: Word[], epoch: number): Word[] => words.map((w) => ({ word: w.word, t0: Math.round(w.t0 - epoch), t1: Math.round(w.t1 - epoch) }));

/** A send's words: typed text alone goes as the string; typed after speech, as words said at Enter (`at`). */
export function withTyped(words: Word[], typed: string, at: number): Word[] | string {
  if (!words.length) return typed;
  const extra = typed.split(/\s+/).filter(Boolean).map((word) => ({ word, t0: at, t1: at }));
  return [...words, ...extra];
}
