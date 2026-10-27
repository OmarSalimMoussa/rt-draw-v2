import { describe, expect, it } from "vitest";
import { type Word, linkInk } from "../../../src/core/link.ts";
import type { Mark } from "../../../src/core/marks.ts";
import type { SpeechEvents, Utterance } from "../../../src/core/speech.ts";
import { type EngineLike, type Take, Voice, type VoiceDeps, boxWords, onInkClock } from "./voice.ts";

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
const said = (ws: Word[] | string) => (typeof ws === "string" ? ws : ws.map((w) => w.word));
const words = (t: Take) => t.words as Promise<Word[]>;
/** The person replaces `cut` characters at `at` with `put`, the caret after it, as typing in the box does. */
const edit = (voice: Voice, at: number, cut: number, put: string) => {
  voice.type(voice.text.slice(0, at) + put + voice.text.slice(at + cut), at + put.length);
};

describe("voice", () => {
  it("take() returns the finished words plus what the flush brings", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["make", "it"]));
    engines[0].flush = ["blue"];
    expect(said(await voice.take().words)).toEqual(["make", "it", "blue"]);
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
    await taken.words;
    expect(voice.listening).toBe(true);
  });

  it("two takes in a row each get only their own words", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["make", "it", "blue"]));
    const first = voice.take();
    await tick();
    engines[1].events.onFinal(utt(["bigger"], 3000));
    expect(voice.text).toBe("bigger");
    const second = voice.take();
    const [a, b] = [said(await first.words), said(await second.words)];
    expect(a).toEqual(["make", "it", "blue"]);
    expect(b).toEqual(["bigger"]);
  });

  it("what Scribe hears is written in the box: its interim as it changes, then the final in its place", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onInterim("make");
    expect(voice.text).toBe("make");
    engines[0].events.onInterim("make it bl");
    expect(voice.text).toBe("make it bl");
    engines[0].events.onFinal(utt(["make", "it", "blue."]));
    expect(voice.text).toBe("make it blue.");
    engines[0].events.onInterim("and");
    expect(voice.text).toBe("make it blue. and");
    const t = voice.take();
    expect(t.text).toBe("make it blue. and");
    expect(t.spoken).toBe(true);
    expect(voice.text).toBe("");
  });

  it("stop(): its last words land in the box, to edit, and are the next take's", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["hello"]));
    engines[0].events.onInterim("there");
    engines[0].flush = ["there", "you"];
    await voice.stop();
    expect(voice.listening).toBe(false);
    expect(voice.text).toBe("hello there you");
    expect(said(await voice.take().words)).toEqual(["hello", "there", "you"]);
    expect(engines).toHaveLength(1);
  });

  it("typed text stays: speech goes after it, a space between, and typed words are said at Enter", async () => {
    const { voice, engines } = rig();
    voice.type("add a header");
    await voice.start();
    engines[0].events.onInterim("make it");
    expect(voice.text).toBe("add a header make it");
    engines[0].events.onFinal(utt(["make", "it", "blue"]));
    expect(voice.text).toBe("add a header make it blue");
    const t = voice.take(9000);
    expect(t.text).toBe("add a header make it blue");
    expect(await t.words).toEqual([
      { word: "add", t0: 9000, t1: 9000 },
      { word: "a", t0: 9000, t1: 9000 },
      { word: "header", t0: 9000, t1: 9000 },
      ...utt(["make", "it", "blue"]).words,
    ]);
  });

  it("with the box focused, speech goes in at the caret, and the caret ends after it", async () => {
    const { voice, engines } = rig();
    voice.type("make blue");
    voice.select(5, 5);
    await voice.start();
    engines[0].events.onInterim("it");
    expect(voice.text).toBe("make it blue");
    expect(voice.sel).toEqual([8, 8]);
    engines[0].events.onFinal(utt(["it", "very"]));
    expect(voice.text).toBe("make it very blue");
    expect(voice.sel).toEqual([13, 13]);
    // Out of the box, the next words go at the end.
    voice.select();
    engines[0].events.onFinal(utt(["now"], 2000));
    expect(voice.text).toBe("make it very blue now");
    expect(await words(voice.take(9000))).toEqual([
      { word: "make", t0: 9000, t1: 9000 },
      ...utt(["it", "very"]).words,
      { word: "blue", t0: 9000, t1: 9000 },
      ...utt(["now"], 2000).words,
    ]);
  });

  it("words said at the caret inside earlier ones: both keep their times", async () => {
    const { voice, engines } = rig();
    await voice.start();
    const first = utt(["make", "the", "hero", "blue"]);
    engines[0].events.onFinal(first);
    voice.select(9, 9); // before "hero"
    engines[0].events.onInterim("big");
    engines[0].events.onFinal(utt(["big"], 3000));
    expect(voice.text).toBe("make the big hero blue");
    const [make, the, hero, blue] = first.words;
    expect(await voice.take(9000).words).toEqual([make, the, ...utt(["big"], 3000).words, hero, blue]);
  });

  it("typing while the interim shows: the voice keeps to its place, and what's typed stays", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onInterim("make it");
    edit(voice, 0, 0, "ok ");
    edit(voice, voice.text.length, 0, " now");
    expect(voice.text).toBe("ok make it now");
    engines[0].events.onInterim("make it blue");
    expect(voice.text).toBe("ok make it blue now");
    // The caret stays where the person typed.
    expect(voice.sel).toEqual([19, 19]);
    engines[0].events.onFinal(utt(["make", "it", "blue"]));
    expect(voice.text).toBe("ok make it blue now");
    expect(said(await voice.take().words)).toEqual(["ok", "make", "it", "blue", "now"]);
  });

  it("speech left as heard goes with its own times, the ink link's", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["move", "this", "up"]));
    engines[0].events.onFinal(utt(["and", "that", "down"], 3000));
    expect(await voice.take().words).toEqual([...utt(["move", "this", "up"]).words, ...utt(["and", "that", "down"], 3000).words]);
  });

  it("edited speech: a changed word takes the time of the one it replaced, a deleted one is gone, an added one is typed", async () => {
    const { voice, engines } = rig();
    await voice.start();
    const first = utt(["make", "the", "hero", "blew"]);
    const second = utt(["and", "dis", "one", "bigger"], 3000);
    engines[0].events.onFinal(first);
    engines[0].events.onFinal(second);
    expect(voice.text).toBe("make the hero blew and dis one bigger");
    edit(voice, 5, 4, ""); // "the " deleted
    edit(voice, 10, 4, ""); // "blew" backspaced...
    edit(voice, 10, 0, "blue"); // ...and typed again
    edit(voice, 19, 3, "this"); // "dis" fixed
    edit(voice, 27, 0, " much"); // a word added
    expect(voice.text).toBe("make hero blue and this one much bigger");
    const [make, , hero, blew] = first.words;
    const [and, dis, one, bigger] = second.words;
    expect(await voice.take(9000).words).toEqual([
      make,
      hero,
      { ...blew, word: "blue" },
      and,
      { ...dis, word: "this" },
      one,
      { word: "much", t0: 9000, t1: 9000 },
      bigger,
    ]);
  });

  it("the ink drawn while a word was said links to it, as heard and after the words around it are edited", async () => {
    // Pen down while "this" (1100-1180) and "that" (1500-1580) were said.
    const marks = [{ n: 1, t0: 1120 }, { n: 2, t0: 1520 }] as Mark[];
    const heard = utt(["make", "this", "blue", "and", "that", "red"]);
    const send = async (fix?: (voice: Voice) => void) => {
      const { voice, engines } = rig();
      await voice.start();
      engines[0].events.onFinal(heard);
      fix?.(voice);
      return linkInk((await voice.take(9000).words) as Word[], marks).text;
    };
    expect(await send()).toBe(linkInk(heard.words, marks).text);
    expect(await send()).toBe("make this [ink 1] blue and that [ink 2] red");
    expect(await send((v) => edit(v, 10, 4, "green"))).toBe("make this [ink 1] green and that [ink 2] red");
    expect(await send((v) => (edit(v, 0, 0, "please "), edit(v, v.text.length, 0, " now")))).toBe("please make this [ink 1] blue and that [ink 2] red now");
  });

  it("Enter while the interim shows: Scribe's last words go in its place", async () => {
    const { voice, engines } = rig();
    voice.type("hi");
    await voice.start();
    engines[0].events.onInterim("make it bl");
    engines[0].flush = ["make", "it", "blue"];
    const t = voice.take(9000);
    expect(t.text).toBe("hi make it bl");
    expect(await t.words).toEqual([{ word: "hi", t0: 9000, t1: 9000 }, ...utt(["make", "it", "blue"], 5000).words]);
  });

  it("stopped, then Enter before the flush: its last words are this send's, and don't show in the box after", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onInterim("make it");
    let release!: () => void;
    engines[0].hold = new Promise<void>((r) => (release = r));
    engines[0].flush = ["make", "it", "red"];
    const stopped = voice.stop();
    const t = voice.take();
    release();
    await stopped;
    expect(said(await t.words)).toEqual(["make", "it", "red"]);
    expect(voice.text).toBe("");
  });

  it("nothing said left, or nothing said: the box goes as typed", async () => {
    const { voice, engines } = rig();
    await voice.start();
    engines[0].events.onFinal(utt(["hello"]));
    edit(voice, 0, 5, "");
    edit(voice, 0, 0, "draw a cat");
    const t = voice.take();
    expect(t.spoken).toBe(false);
    expect(await t.words).toBe("draw a cat");
    voice.type("make it\nblue ");
    expect(await voice.take().words).toBe("make it\nblue");
  });

  it("boxWords: changed words spread over the time of the ones they replaced", () => {
    const heard = utt(["make", "the", "big", "hero", "blue"]).words;
    const at = { at: 0, len: 25 };
    const ws = boxWords("make the header blue", [{ range: at, words: heard }], [], 9000) as Word[];
    expect(ws.map((w) => [w.word, w.t0, w.t1])).toEqual([
      ["make", 1000, 1080],
      ["the", 1100, 1180],
      ["header", 1200, 1380],
      ["blue", 1400, 1480],
    ]);
  });

  it("onInkClock", () => {
    expect(onInkClock([{ word: "a", t0: 1500.4, t1: 1700.6 }], 1000)).toEqual([{ word: "a", t0: 500, t1: 701 }]);
  });
});
