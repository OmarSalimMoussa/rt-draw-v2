// The mic, on until you turn it off, across sends: talk, then press Enter. v2's
// Scribe engine (src/core/speech.ts) gives up its last words only by closing
// (a final commit, then the socket shuts), and a new engine on a running mic
// would send all its audio again from the start. So each send gets a session of
// its own, a mic and an engine: at Enter the next session opens first, then the
// old one is flushed, and its words are this send's. Words said from then on are
// the next send's. ScribeEngine sends its mic's audio from sample 0 once its
// socket opens, so the token fetch loses nothing; the gap is the new mic starting.
//
// What it hears is written into the text box, the same one you type in: Scribe's
// interim text as it changes, then the final words in its place, which stay to be
// edited like typed text (at the caret while the box has focus, else at the end).
// Nothing is sent until Enter. Then the box is the send: a word still as heard
// keeps its time, so the ink drawn while saying it links to it; a changed word
// takes the time of the one it replaced; typed words are said at Enter.
import type { Word } from "../../../src/core/link.ts";
import type { SpeechEvents } from "../../../src/core/speech.ts";

export type MicLike = { start(): Promise<void>; stop(): void };
export type EngineLike = { start(): Promise<void>; stop(): Promise<void> };
export type VoiceDeps = { mic: () => MicLike; engine: (events: SpeechEvents, mic: MicLike) => EngineLike };

/** A stretch of the box's text: [at, at + len). */
export type Range = { at: number; len: number };
/** A change to the box's text: the `cut` characters at `at` became `put` characters. */
type Edit = { at: number; cut: number; put: number };
/** A final utterance in the box: where its text is now, and its words as heard. */
export type Said = { range: Range; words: Word[] };
/** Where a session's interim stood at Enter: its last words (`late`, from the flush) go there instead. */
export type Slot = Range & { late: Word[] };
/** A send, at Enter: the box's text, whether any of it was said, and its words once the last of them is heard. */
export type Take = { text: string; spoken: boolean; words: Promise<Word[] | string> };

type Session = {
  mic: MicLike;
  engine: EngineLike;
  words: Word[];
  closed: boolean;
  started: boolean;
  ready: Promise<void>;
  /** The take it belongs to: it writes into the box until then. */
  take: number;
  /** How many of its words the box shows. */
  shown: number;
  /** Where what it's hearing now is in the box: Scribe's interim, replaced by each next one and by the final. */
  live?: Range;
  closing?: Promise<Word[]>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A voice error as a tester reads it: what to do, without naming the speech service. */
export function plainVoiceError(e: string): string {
  if (/permission|notallowed|denied|dismissed/i.test(e)) return "imagine can't hear you: allow the microphone for this site, or type instead.";
  if (/not ?found|no (microphone|device)/i.test(e)) return "No microphone found. Plug one in, or type instead.";
  return "Listening stopped. Press the mic to try again, or type instead.";
}

export class Voice {
  listening = false;
  /** The text box: what was typed and what was said, the person's to edit until Enter. */
  text = "";
  /** The box's selection while it has focus (new speech goes at its end); unset while it hasn't (speech goes at the end of the text). */
  sel?: [number, number];
  error?: string;
  private session?: Session;
  /** Sessions closed by stop(), whose words wait for the next take. */
  private kept: Session[] = [];
  /** What the box holds of each final utterance since the last take. */
  private said: Said[] = [];
  /** Bumped by take(): a session writes into the box only until then. */
  private takes = 0;
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

  /** Turns the mic off. Its last words still land in the box. */
  async stop() {
    if (!this.listening) return;
    this.listening = false;
    const s = this.session;
    this.session = undefined;
    this.touch();
    if (!s) return;
    this.kept.push(s);
    await this.close(s);
  }

  /** The person typed (or cut, pasted, undid): the box's new text and selection. */
  type(text: string, start = text.length, end = start) {
    this.move(edited(this.text, text, end), true);
    this.text = text;
    this.sel = [start, end];
    this.touch();
  }

  /** Where the selection is while the box has focus; nothing when it loses it. */
  select(start?: number, end = start) {
    this.sel = start === undefined || end === undefined ? undefined : [start, end];
  }

  /**
   * This send, at Enter (`at`, on the page clock): the box's text, and its words once Scribe has given up the
   * last of them. While listening, the next send's session is open before this one flushes. The box empties.
   */
  take(at = performance.now()): Take {
    const text = this.text;
    const sessions = [...this.kept.splice(0), ...(this.session ? [this.session] : [])];
    // A session's last words go where its interim was, or where new speech would have gone.
    const spot = { at: this.sel?.[1] ?? text.length, len: 0 };
    const slots = sessions.map((s) => ({ s, ...(s.live ?? spot) }));
    const said = this.said.splice(0);
    this.takes++;
    this.text = "";
    if (this.sel) this.sel = [0, 0];
    this.session = this.listening ? this.open() : undefined;
    this.touch();
    const words = Promise.all(sessions.map((s) => this.close(s))).then(() =>
      boxWords(text, said, slots.map(({ s, at: p, len }) => ({ at: p, len, late: s.words.slice(s.shown) })), at),
    );
    return { text: text.trim(), spoken: [...said.map((u) => u.range), ...slots].some((r) => r.len > 0), words };
  }

  /** Writes what a session hears into the box, in its live range (begun at the caret, or the end), a space either side. */
  private write(s: Session, words: string) {
    if (!s.live) {
      const p = this.sel?.[1] ?? this.text.length;
      // Begun inside a said stretch, it splits it in two, each matched against the words heard (retime).
      this.said = this.said.flatMap(({ range: { at, len }, words: ws }) =>
        p > at && p < at + len ? [{ range: { at, len: p - at }, words: ws }, { range: { at: p, len: at + len - p }, words: ws }] : [{ range: { at, len }, words: ws }],
      );
      s.live = { at: p, len: 0 };
    }
    const r = s.live;
    const before = this.text.slice(0, r.at);
    const after = this.text.slice(r.at + r.len);
    const put = words && `${/\S$/.test(before) ? " " : ""}${words}${/^\S/.test(after) ? " " : ""}`;
    const e = { at: r.at, cut: r.len, put: put.length };
    this.text = before + put + after;
    this.move(e, false);
    if (this.sel) this.sel = [moved(this.sel[0], e), moved(this.sel[1], e)];
    s.live = { at: e.at, len: put.length };
  }

  /** Every range in the box after an edit, `typed` or the voice's own; a said one emptied is gone. */
  private move(e: Edit, typed: boolean) {
    for (const s of [...this.kept, this.session]) if (s?.live) s.live = shifted(s.live, e, false);
    this.said = this.said.flatMap((u) => {
      const range = shifted(u.range, e, typed);
      return range.len ? [{ range, words: u.words }] : [];
    });
  }

  private open(): Session {
    const mic = this.deps.mic();
    const s = { mic, words: [] as Word[], closed: false, started: false, take: this.takes, shown: 0 } as Session;
    // Only a session of this take writes in the box: a taken one's flush belongs to the send that took it.
    const mine = () => s.take === this.takes;
    s.engine = this.deps.engine(
      {
        onInterim: (text) => {
          if (!mine()) return;
          this.write(s, text);
          this.touch();
        },
        onFinal: (u) => {
          s.words.push(...u.words);
          if (!mine()) return;
          this.write(s, u.words.map((w) => w.word.trim()).filter(Boolean).join(" ") || u.text);
          if (s.live!.len) this.said.push({ range: s.live!, words: u.words });
          s.shown = s.words.length;
          s.live = undefined;
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
        if (s === this.session) {
          this.listening = false;
          this.session = undefined;
        }
        this.touch();
      }
    })();
    return s;
  }

  /** Flushes a session and lets go of its mic, once however often it's asked: its words, in the order said. */
  private close(s: Session): Promise<Word[]> {
    return (s.closing ??= (async () => {
      s.closed = true;
      await s.ready;
      if (s.started) {
        s.started = false;
        await s.engine.stop();
        s.mic.stop();
      }
      // An interim no final came for stays in the box, as typed.
      s.live = undefined;
      return s.words;
    })());
  }
}

/** The edit that turned `was` into `now`, ending at the caret (`caret`, in `now`), where typing, pasting and deleting leave it. */
function edited(was: string, now: string, caret: number): Edit {
  let at = 0;
  while (at < was.length && at < now.length && at < caret && was[at] === now[at]) at++;
  let tail = 0;
  while (tail < was.length - at && tail < now.length - Math.max(at, caret) && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  return { at, cut: was.length - at - tail, put: now.length - at - tail };
}

/**
 * A range after an edit: one overlapping it takes the edit in. Text put right at its edge stays outside, unless
 * `edge`: the person typing at a said stretch's edge is fixing its words (a live range is the voice's to rewrite).
 */
function shifted(r: Range, e: Edit, edge: boolean): Range {
  const end = r.at + r.len;
  const cutEnd = e.at + e.cut;
  const d = e.put - e.cut;
  const at = r.at < e.at || (edge && r.at === e.at) ? r.at : r.at >= cutEnd ? r.at + d : e.at;
  const to = end > cutEnd || (edge && end === cutEnd) ? end + d : end <= e.at ? end : e.at + e.put;
  return { at, len: Math.max(0, to - at) };
}

/** Where the caret goes when the voice writes: past what it put at the caret, or along with the text it was in. */
const moved = (p: number, e: Edit) => (p < e.at || (p === e.at && e.cut > 0) ? p : p >= e.at + e.cut ? p + e.put - e.cut : e.at + e.put);

/** A word as compared with the one heard: case and punctuation aside. */
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "") || w;

type Placed = { at: number; word: string; t?: [number, number] };

/**
 * The box's text as a send's words, in the order they stand (on the page clock). A word of a said stretch still
 * as heard keeps its time; changed ones take the times of the words they replaced; words typed, or added where
 * nothing was replaced, are said at Enter (`at`). With nothing said left, the text goes as typed: a string.
 */
export function boxWords(text: string, said: Said[], slots: Slot[], at: number): Word[] | string {
  const cuts = slots.filter((c) => c.late.length).sort((a, b) => a.at - b.at);
  const inside = (p: number, r: Range) => p >= r.at && p < r.at + r.len;
  const placed: Placed[] = [];
  let k = 0;
  const late = (p: number) => {
    for (; k < cuts.length && cuts[k].at <= p; k++) for (const w of cuts[k].late) placed.push({ at: cuts[k].at, word: w.word.trim(), t: [w.t0, w.t1] });
  };
  for (const m of text.matchAll(/\S+/g)) {
    late(m.index);
    if (!cuts.some((c) => inside(m.index, c))) placed.push({ at: m.index, word: m[0] });
  }
  late(Infinity);
  // Each said stretch's words as they stand now, against its words as heard. A word typed where two meet is the first one's.
  const owner = (p: number) => said.reduce((best, u, i) => (inside(p, u.range) && (best < 0 || u.range.at < said[best].range.at) ? i : best), -1);
  const owners = placed.map((p) => (p.t ? -1 : owner(p.at)));
  said.forEach((u, i) => retime(placed.filter((_, j) => owners[j] === i), u.words));
  if (!placed.some((p) => p.t)) return text.trim();
  return placed.map((p) => ({ word: p.word, t0: p.t?.[0] ?? at, t1: p.t?.[1] ?? at }));
}

/** Times for a said stretch's words (`now`): the longest run in common with the words heard keeps theirs, and each change between takes those it replaced. */
function retime(now: Placed[], heard: Word[]) {
  const a = now.map((p) => norm(p.word));
  const b = heard.map((w) => norm(w.word));
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  let i = 0, j = 0, i0 = 0, j0 = 0;
  let kept = false;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      replaced(now.slice(i0, i), heard.slice(j0, j), kept ? undefined : "before");
      now[i].t = [heard[j].t0, heard[j].t1];
      kept = true;
      i0 = ++i;
      j0 = ++j;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  replaced(now.slice(i0), heard.slice(j0), kept ? "after" : undefined);
}

/**
 * Words written where `was` were said: one for one when they're as many, else spread over the time `was` took.
 * Next to a kept word only on one side (`side` of it), only as many as were replaced take times, nearest it first.
 */
function replaced(now: Placed[], was: Word[], side?: "before" | "after") {
  if (!now.length || !was.length) return;
  if (side && now.length > was.length) now = side === "after" ? now.slice(0, was.length) : now.slice(-was.length);
  const t0 = was[0].t0;
  const span = was.at(-1)!.t1 - t0;
  now.forEach((p, k) => (p.t = now.length === was.length ? [was[k].t0, was[k].t1] : [t0 + (span * k) / now.length, t0 + (span * (k + 1)) / now.length]));
}

/** Scribe's page-clock word times moved onto a send's ink clock (ms since `epoch`), as the draw playground does. */
export const onInkClock = (words: Word[], epoch: number): Word[] => words.map((w) => ({ word: w.word, t0: Math.round(w.t0 - epoch), t1: Math.round(w.t1 - epoch) }));
