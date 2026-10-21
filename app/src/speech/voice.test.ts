import { describe, expect, it } from "vitest";
import type { SpeechEvents, Utterance } from "../../../src/core/speech.ts";
import { type EngineLike, Voice, type VoiceDeps, onInkClock, withTyped } from "./voice.ts";

const utt = (words: string[], t = 1000): Utterance => ({
  text: words.join(" "),
  words: words.map((word, i) => ({ word, t0: t + i * 100, t1: t + i * 100 + 80 })),
  t0: t,
  t1: t + words.length * 100,
  finalAt: t + words.length * 100 + 300,
  features: {},
});

type Fake = EngineLike & { events: SpeechEvents; started: boolean; flush?: string[]; hold?: Promise<void> };

/** Scribe engines the test speaks through: each one's stop() sends its `flush` words first, as a final commit would. */
function rig() {
  const engines: Fake[] = [];
  const deps: VoiceDeps = {
    mic: () => ({ start: async () => {}, stop: () => {} }),
    engine: (events) => {
      const e: Fake = {
        events,
        started: false,
        start: async () => void (e.started = true),
        stop: async () => {
          await e.hold;
          if (e.flush) events.onFinal(utt(e.flush, 5000));
        },
      };
      engines.push(e);
      return e;
    },
  };
  return { voice: new Voice(deps), engines };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const said = (ws: { word: string }[]) => ws.map((w) => w.word);

describe("voice", () => {
  it("take() returns the finished words plus what the flush brings", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["make", "it"]));
    engines[0].flush = ["blue"];
    expect(said(await voice.take())).toEqual(["make", "it", "blue"]);
  });

  it("while listening, take() opens a fresh session first", async () => {
    const { voice, engines } = rig();
    await voice.start();
    let release!: () => void;
    engines[0].hold = new Promise<void>((r) => (release = r));
    const taken = voice.take();
    await tick();
    // The old engine is still flushing, and the next one is already listening.
    expect(engines).toHaveLength(2);
    expect(engines[1].started).toBe(true);
    release();
    await taken;
    expect(voice.listening).toBe(true);
  });

  it("two takes in a row each get only their own words", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["make", "it", "blue"]));
    const first = voice.take();
    await tick();
    engines[1].events.onFinal(utt(["bigger"], 3000));
    const second = voice.take();
    const [a, b] = [said(await first), said(await second)];
    expect(a).toEqual(["make", "it", "blue"]);
    expect(b).toEqual(["bigger"]);
  });

  it("stop() keeps the words for the next take and opens nothing", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["hello"]));
    await voice.stop();
    expect(voice.listening).toBe(false);
    expect(said(await voice.take())).toEqual(["hello"]);
    expect(engines).toHaveLength(1);
  });

  it("heard is the final text since the last take", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["make", "it", "blue"]));
    expect(voice.heard).toBe("make it blue");
    await voice.take();
    expect(voice.heard).toBe("");
  });

  it("onInkClock and withTyped", () => {
    expect(onInkClock([{ word: "a", t0: 1500.4, t1: 1700.6 }], 1000)).toEqual([{ word: "a", t0: 500, t1: 701 }]);
    expect(withTyped([], "make it blue", 0)).toBe("make it blue");
    const w = { word: "this", t0: 100, t1: 300 };
    expect(withTyped([w], "now", 900)).toEqual([w, { word: "now", t0: 900, t1: 900 }]);
  });
});
