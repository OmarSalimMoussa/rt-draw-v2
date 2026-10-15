// Puts [ink n] in the transcript at the word you were saying when you drew mark
// n. Two timestamped streams merged: no model, no network.
import type { Mark } from "./marks.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

/** A spoken (or typed) word and when it was said; matches src/core/speech.ts. */
export type Word = { word: string; t0: number; t1: number; estimated?: boolean };

export type Link = {
  /** The mark's number. */
  n: number;
  /** Index of the word the marker goes after. */
  word: number;
  /** Word time minus pen-down time: negative when the word came first. */
  offsetMs: number;
  why: string;
  features: Record<string, number | string>;
};

/** Pointing words: when one is in the window, it's almost always what the ink is for. */
export const DEICTIC = new Set(["this", "that", "here", "there", "these", "those", "it"]);

const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");
/** A word's time for matching: its middle. */
const at = (w: Word) => (w.t0 + w.t1) / 2;

export function linkInk(words: Word[], marks: Mark[], t: Tuning = DEFAULTS): { text: string; links: Link[] } {
  const links: Link[] = marks.map((m) => {
    const down = m.t0;
    if (!words.length) return { n: m.n, word: -1, offsetMs: 0, why: "no words yet", features: { candidates: 0 } };
    const all = words.map((w, i) => ({ i, d: at(w) - down, deictic: DEICTIC.has(clean(w.word)) }));
    const inWindow = all.filter((c) => c.d >= -t["link.lagMs"] && c.d <= t["link.leadMs"]);
    const nearest = (cs: typeof all) => cs.reduce((a, b) => (Math.abs(b.d) < Math.abs(a.d) ? b : a));
    const deictic = inWindow.filter((c) => c.deictic);
    let pick: (typeof all)[number];
    let why: string;
    if (t["link.preferDeictic"] && deictic.length) {
      pick = nearest(deictic);
      why = `pointing word "${words[pick.i].word}" in the window`;
    } else if (inWindow.length) {
      pick = nearest(inWindow);
      why = `nearest word in the window`;
    } else {
      pick = nearest(all);
      why = `no word in the window; nearest word overall (${Math.round(pick.d)} ms away)`;
    }
    const features = {
      candidates: inWindow.length,
      deictic: deictic.length,
      considered: inWindow.map((c) => `${words[c.i].word}@${Math.round(c.d)}`).join(" "),
      estimated: words[pick.i].estimated ? 1 : 0,
    };
    return { n: m.n, word: pick.i, offsetMs: Math.round(pick.d), why, features };
  });
  return { text: withMarkers(words, links), links };
}

/** The transcript with [ink n] after each linked word, in mark order where several share one. */
export function withMarkers(words: Word[], links: Pick<Link, "n" | "word">[]): string {
  const after = new Map<number, number[]>();
  for (const l of links) if (l.word >= 0) after.set(l.word, [...(after.get(l.word) ?? []), l.n]);
  const unlinked = links.filter((l) => l.word < 0).map((l) => `[ink ${l.n}]`);
  return [...words.map((w, i) => [w.word, ...(after.get(i) ?? []).sort((a, b) => a - b).map((n) => `[ink ${n}]`)].join(" ")), ...unlinked].join(" ");
}
