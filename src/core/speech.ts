// Your voice as timed words, on the same clock as the ink (performance.now()),
// so a word can be matched to the stroke drawn while it was said. Two engines:
// the browser's free recognizer (no word times, so they're estimated) and
// ElevenLabs Scribe (real word times, paid per minute). The mic is recorded
// alongside, for the waveform and to play a word back.
import { DEFAULTS, type Tuning, patching } from "./tuning.ts";

/** A word and when it was said, in ms on the page clock. `estimated`: spread over the utterance, not measured. */
export type Word = { word: string; t0: number; t1: number; estimated?: boolean; /** Scribe's own start and end, in seconds of audio. */ raw?: [number, number] };

/** Scribe's seconds-into-the-recording → page-clock word times, under speech.shiftMs. */
export const scribeWord = (word: string, start: number, end: number, mic: Mic, t: Tuning): Word => ({ word, t0: Math.round(mic.wall(start) + t["speech.shiftMs"]), t1: Math.round(mic.wall(end) + t["speech.shiftMs"]), raw: [start, end] });

/** One finished utterance: its words, when speech ended, and when its final text arrived. */
export type Utterance = {
  text: string;
  words: Word[];
  engine: "browser" | "scribe";
  /** Speech start and end (ms, page clock). */
  t0: number;
  t1: number;
  /** When the final text arrived; finalAt - t1 is the wait after you stop talking. */
  finalAt: number;
  features: Record<string, number>;
};

export type SpeechEvents = {
  onInterim: (text: string) => void;
  onFinal: (u: Utterance) => void;
  onError: (error: string) => void;
};

export interface SpeechEngine {
  start(): Promise<void>;
  /** Resolves once the last words are in (Scribe finishes the utterance you were in). */
  stop(): void | Promise<void>;
}

/**
 * Words with no times of their own, spread over the utterance by length: each
 * word gets a share of the span proportional to its letters (plus one for the
 * gap after it). Starts speech.onsetLeadMs before the first partial arrived.
 */
export function estimateWords(text: string, firstPartialAt: number, endAt: number, t: Tuning = DEFAULTS): { words: Word[]; t0: number; features: Record<string, number> } {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const t0 = firstPartialAt - t["speech.onsetLeadMs"];
  const span = Math.max(1, endAt - t0);
  const weight = parts.map((w) => w.length + 1);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let at = t0;
  const words = parts.map((word, i) => {
    const d = (span * weight[i]) / total;
    // The word takes its letters' share; the extra one is the gap after it.
    const w = { word, t0: Math.round(at), t1: Math.round(at + (d * word.length) / weight[i]), estimated: true };
    at += d;
    return w;
  });
  return { words, t0, features: { spanMs: Math.round(span), words: parts.length, msPerLetter: Math.round(span / total) } };
}

// ---- Mic: 16 kHz 16-bit mono, kept for the waveform and playback, streamed to Scribe when it's on.

export const SAMPLE_RATE = 16000;
/** 80 ms of audio per chunk (what Scribe expects to be streamed). */
const CHUNK = 1280;

const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor(o) { super(); this.step = sampleRate / o.processorOptions.rate; this.pos = 0; this.size = o.processorOptions.chunk; this.buf = new Int16Array(this.size); this.n = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    while (this.pos < input.length) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(this.pos)]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.size) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(this.size); this.n = 0; }
      this.pos += this.step;
    }
    this.pos -= input.length;
    return true;
  }
}
registerProcessor("pcm16", Pcm16);`;

export class Mic {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  /** Everything recorded since start, in 80 ms chunks. */
  chunks: Int16Array[] = [];
  /** Page-clock ms at audio sample 0. */
  startedAt = 0;
  onChunk?: (pcm: ArrayBuffer) => void;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, "pcm16", { processorOptions: { chunk: CHUNK, rate: SAMPLE_RATE } });
    this.chunks = [];
    this.startedAt = 0;
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      // The first chunk ends now, so audio time 0 was one chunk ago.
      if (!this.startedAt) this.startedAt = performance.now() - (CHUNK / SAMPLE_RATE) * 1000;
      this.chunks.push(new Int16Array(e.data.slice(0)));
      this.onChunk?.(e.data);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.ctx.createMediaStreamSource(this.stream).connect(node).connect(mute).connect(this.ctx.destination);
  }

  /** Seconds into the recording → page-clock ms. */
  wall = (seconds: number) => this.startedAt + seconds * 1000;
  /** Recorded length in ms. */
  get ms() {
    return (this.chunks.length * CHUNK * 1000) / SAMPLE_RATE;
  }

  stop() {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = undefined;
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
  }

  /** Peak level (0-1) per bucket of `bucketMs`, for drawing the waveform. */
  peaks(bucketMs: number): number[] {
    const per = Math.max(1, Math.round((SAMPLE_RATE * bucketMs) / 1000));
    const out: number[] = [];
    let peak = 0;
    let n = 0;
    for (const c of this.chunks)
      for (const s of c) {
        peak = Math.max(peak, Math.abs(s) / 0x8000);
        if (++n === per) {
          out.push(peak);
          peak = 0;
          n = 0;
        }
      }
    return out;
  }

  /** Plays the recording between two page-clock times. */
  play(fromMs: number, toMs: number) {
    const all = new Int16Array(this.chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const a = Math.max(0, Math.floor(((fromMs - this.startedAt) / 1000) * SAMPLE_RATE));
    const b = Math.min(all.length, Math.ceil(((toMs - this.startedAt) / 1000) * SAMPLE_RATE));
    if (b <= a) return;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const buf = ctx.createBuffer(1, b - a, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = a; i < b; i++) ch[i - a] = all[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => void ctx.close();
    src.start();
  }
}

// ---- Browser engine: free, interim text as you talk, no word times.

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

export const browserSpeechAvailable = () => "SpeechRecognition" in window || "webkitSpeechRecognition" in window;

export class BrowserEngine implements SpeechEngine {
  private rec?: Recognition;
  private stopped = false;
  /** When the current utterance's first partial arrived, and when its text last changed (≈ end of speech). */
  private firstAt?: number;
  private lastChangeAt = 0;
  private lastText = "";
  constructor(private events: SpeechEvents, private tuning: () => Tuning) {}

  async start() {
    const w = window as unknown as Record<string, new () => Recognition>;
    const Rec = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Rec) throw new Error("this browser has no speech recognizer");
    this.stopped = false;
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      const now = performance.now();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        this.firstAt ??= now;
        if (text !== this.lastText) {
          this.lastText = text;
          this.lastChangeAt = now;
        }
        if (!r.isFinal) {
          this.events.onInterim(text);
          continue;
        }
        // Speech ended about when the text last changed before this final.
        const end = Math.min(this.lastChangeAt, now);
        const est = estimateWords(text, this.firstAt, end, this.tuning());
        this.events.onFinal({ text, words: est.words, engine: "browser", t0: est.t0, t1: end, finalAt: now, features: est.features });
        this.firstAt = undefined;
        this.lastText = "";
      }
    };
    rec.onerror = (e) => e.error !== "no-speech" && e.error !== "aborted" && this.events.onError(`browser recognizer: ${e.error}`);
    // Chrome ends sessions on its own after a while; keep listening until stopped.
    rec.onend = () => !this.stopped && rec.start();
    rec.start();
    this.rec = rec;
  }

  stop() {
    this.stopped = true;
    this.rec?.stop();
  }
}

// ---- Scribe engine: ElevenLabs realtime, word times measured by the service.

/** How long Stop waits for Scribe to finish the last utterance. */
const FLUSH_WAIT_MS = 3000;

type ScribeWord = { text: string; start?: number; end?: number; type: string };
type ScribeMessage = { message_type: string; text?: string; words?: ScribeWord[]; error?: string };

function base64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class ScribeEngine implements SpeechEngine {
  private ws?: WebSocket;
  private stopped = false;
  constructor(private events: SpeechEvents, private mic: Mic, private tuning: () => Tuning) {}

  async start() {
    this.stopped = false;
    // A single-use token from the dev server, which keeps the API key.
    const res = await fetch("/api/stt-token", { method: "POST" });
    const auth = (await res.json()) as { token?: string; url?: string; error?: string };
    if (!res.ok || !auth.token || !auth.url) throw new Error(auth.error ?? `token request failed (HTTP ${res.status})`);
    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      token: auth.token,
      audio_format: "pcm_16000",
      // Without VAD commits a mic session never produces a committed transcript.
      commit_strategy: "vad",
      include_timestamps: "true",
    });
    // A patch: with patches off Scribe uses its own end-of-speech silence.
    if (patching(this.tuning())) params.set("vad_silence_threshold_secs", String(this.tuning()["speech.vadSilenceMs"] / 1000));
    const ws = new WebSocket(`${auth.url}?${params}`);
    this.ws = ws;
    const early: string[] = [];
    ws.onopen = () => early.splice(0).forEach((m) => ws.send(m));
    ws.onmessage = (m) => typeof m.data === "string" && this.onMessage(JSON.parse(m.data) as ScribeMessage);
    ws.onclose = (e) => !this.stopped && this.events.onError(`Scribe disconnected (${e.code}${e.reason ? `: ${e.reason}` : ""})`);
    const toMsg = (pcm: ArrayBuffer) => JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64(pcm), commit: false, sample_rate: SAMPLE_RATE });
    // Scribe's word times count from the first audio it gets, so it must get the recording from
    // sample 0: what the mic took while the token was fetched goes first. Skipping it made every
    // word land that much too early.
    for (const c of this.mic.chunks) early.push(toMsg(c.slice().buffer));
    this.mic.onChunk = (pcm) => {
      const msg = toMsg(pcm);
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (ws.readyState === WebSocket.CONNECTING) early.push(msg);
    };
  }

  /** Called when a timestamped commit arrives, while stop() waits for the last one. */
  private flushed?: () => void;

  async stop() {
    this.stopped = true;
    this.mic.onChunk = undefined;
    const ws = this.ws;
    // Words only come with a commit, and VAD commits only after a silence. Without this, whatever
    // you said since the last pause (all of it, under Scribe's longer default silence) was lost.
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: SAMPLE_RATE }));
      await new Promise<void>((done) => {
        const timer = setTimeout(done, FLUSH_WAIT_MS);
        this.flushed = () => (clearTimeout(timer), done());
      });
      this.flushed = undefined;
    }
    ws?.close();
  }

  private onMessage(msg: ScribeMessage) {
    if (msg.message_type === "partial_transcript" && msg.text?.trim()) return this.events.onInterim(msg.text.trim());
    // The plain commit is ignored: the timestamped one follows it with the same text.
    if (msg.message_type === "committed_transcript_with_timestamps") {
      const text = msg.text?.trim();
      if (!text) return this.flushed?.();
      const timed = (msg.words ?? []).filter((w) => w.type === "word" && w.start !== undefined);
      const words: Word[] = timed.map((w) => scribeWord(w.text, w.start!, w.end ?? w.start!, this.mic, this.tuning()));
      const now = performance.now();
      const t0 = words[0]?.t0 ?? now;
      const t1 = words.at(-1)?.t1 ?? now;
      this.events.onFinal({ text, words, engine: "scribe", t0, t1, finalAt: now, features: { spanMs: t1 - t0, words: words.length } });
      this.flushed?.();
      return;
    }
    if (msg.error) this.events.onError(`Scribe ${msg.message_type}: ${msg.error}`);
  }
}
