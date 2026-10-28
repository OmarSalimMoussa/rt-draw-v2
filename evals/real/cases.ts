// What becomes of a labeled send (evals/real/README.md). Each send that can replay becomes a card the owner can look
// at: proposed once it's labeled and replayed on the champion, admitted when the look window ends unless they reject it
// (sooner when they approve), with their edits to its meaning and expectation pinned. A tune person's card is a bank case
// (real/bank/<id>/, set "real"), measured by every decision; an R-hold person's reaches only R1, through its gold. Every
// state is read from files: the session, its images and triage, gold, the bank case (its case.json's proposedAt and
// tries, its done) and the owner's review/verdicts.jsonl. Stored and never recomputed: each person's split (splits.json)
// and the owner's edits.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { needsPicture } from "../../src/core/picture.ts";
import { OWNER, RUBRIC } from "../judge/judge.ts";
import { historyWrite } from "../loop/history.ts";
import type { Shot } from "../loop/human.ts";
import { paths } from "../loop/paths.ts";
import type { CaseInfo, CaseInput, Expectation, Meant, SceneJSON } from "../loop/types.ts";
import { type GoldCase, GOLD_TRIES, type Labeled, SHOT_TRIES, type TriageRow, cameraOf, chosen, goldCaseDir, goldOf, imagesOf, json, maybe, put, realHome, renderFailures, triageOf } from "./real.ts";
import { type RealSend, type Session, beforeOf } from "./sessions.ts";

/** Days a proposed card waits for the owner's look before it's admitted (their choice, 2026-10-28). */
export const LOOK_DAYS = 2;
const DAY_MS = 86_400_000;
/** R-hold's share of the sends: a whole person is on one side, placed when they first appear (assignSplits). */
const HOLD_SHARE = 1 / 3;
/** Champion replays a case gets before it's skipped as one the champion can't replay. */
const RECORD_TRIES = 3;
/** Tries at drafting a tune card's expectation (where gold drew none) before it's skipped. */
const EXPECT_TRIES = 3;
/** Triage's word that a send asked for nothing drawn; the owner's approve reopens it. */
export const NOT_DRAWING = "not a drawing request";

/** Why the owner rejects a card: counted, so the next revision of the triage and expectation prompts starts from them. */
export const REJECT_REASONS = {
  meaning: "the meaning is wrong",
  expectation: "the expectation is wrong",
  detail: "it asks for more detail than they did",
  fixed: "already fixed",
  "not-drawing": "not a drawing failure",
  unclear: "unclear",
} as const;
export type Reason = keyof typeof REJECT_REASONS;
export type Rubric = { should: string[]; mustNot: string[] };
/** The owner's edits to a card, pinned: no judge, prompt change or rebuild replaces them. */
export type Edits = { meant?: string; expectation?: Rubric };
/**
 * review/verdicts.jsonl: a verdict, with the note as it was and any edit (an edit stands until a later one replaces it;
 * null takes it back), or a note saved on its own as it's typed.
 */
export type ReviewRow = { key: string; at: string; verdict?: "approve" | "reject"; reason?: Reason; note?: string; meant?: string | null; expectation?: Rubric | null };
export type Review = { verdict?: "approve" | "reject"; reason?: Reason; at?: string; note?: string; edits: Edits };
export type Split = "tune" | "hold";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const js = JSON.stringify;
const reviewFile = () => join(realHome(), "review", "verdicts.jsonl");
const splitsFile = () => join(realHome(), "splits.json");
const benchDir = () => join(realHome(), "bench", "R1");

/** The owner's word on each key: the latest verdict, every edit still standing, and the latest note. */
export function reviews(): Map<string, Review> {
  const out = new Map<string, Review>();
  const f = reviewFile();
  for (const l of existsSync(f) ? readFileSync(f, "utf8").split("\n") : []) {
    let r: ReviewRow;
    try {
      r = JSON.parse(l);
    } catch {
      continue; // blank, or the line Eval HQ is appending now
    }
    const v = out.get(r.key) ?? { edits: {} };
    if (r.verdict) Object.assign(v, { verdict: r.verdict, reason: r.reason, at: r.at });
    if (r.meant !== undefined) v.edits.meant = r.meant ?? undefined;
    if (r.expectation !== undefined) v.edits.expectation = r.expectation ?? undefined;
    if (r.note !== undefined) v.note = r.note;
    out.set(r.key, v);
  }
  return out;
}
/** Appends one review row, a whole line in one write. */
export function addReview(r: ReviewRow) {
  mkdirSync(join(reviewFile(), ".."), { recursive: true });
  appendFileSync(reviewFile(), `${js(r)}\n`);
}

// ---- splits

/** Who made a send, for splits and clusters: the owner is one person wherever they worked (live or local). */
export const whoOf = (s: Session) => (s.admin ? "owner" : s.person);
export const splits = (): Record<string, Split> => maybe<Record<string, Split>>(splitsFile()) ?? {};
const replays = (x: RealSend) => x.replay !== "ink";

/**
 * Places each person intake hasn't seen, once and for good: the owner tunes (they can always make more), and a tester,
 * in the order they first sent, goes to whichever side is further below its share of the replayable sends (R-hold toward
 * HOLD_SHARE). Nobody changes sides later, so R-hold stays people the loop never tuned on. Returns the people placed.
 */
export function assignSplits(): string[] {
  const have = splits();
  const counts = new Map<string, { n: number; first: string }>();
  for (const { s } of chosen()) {
    const c = counts.get(whoOf(s)) ?? { n: 0, first: s.sends[0].at };
    counts.set(whoOf(s), { n: c.n + s.sends.filter(replays).length, first: s.sends[0].at < c.first ? s.sends[0].at : c.first });
  }
  const side = (want: Split) => [...counts].filter(([p]) => have[p] === want).reduce((a, [, c]) => a + c.n, 0);
  let tune = side("tune"), hold = side("hold");
  const added = [...counts].filter(([p]) => !have[p]).sort((a, b) => (a[0] === "owner" ? -1 : b[0] === "owner" ? 1 : a[1].first.localeCompare(b[1].first)));
  for (const [p, c] of added) {
    have[p] = p === "owner" || hold * (1 - HOLD_SHARE) > tune * HOLD_SHARE ? "tune" : "hold";
    have[p] === "tune" ? (tune += c.n) : (hold += c.n);
  }
  if (added.length) put(splitsFile(), have);
  return added.map(([p]) => p);
}

// ---- cards

/**
 * The secret real case ids are keyed by (bank.key, mode 600), made by intake the first time: ids reach history, and a
 * plain hash of a send's words on a blank board would let anyone check a guess of what a tester typed.
 */
export function makeBankKey() {
  const f = join(realHome(), "bank.key");
  if (existsSync(f)) return;
  mkdirSync(realHome(), { recursive: true });
  writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
}
/** A real case's id (c-r-<12 hex>), the same in the bank and R1; undefined before intake made the key. */
function realId(input: string): string | undefined {
  const f = join(realHome(), "bank.key");
  return existsSync(f) ? `c-r-${createHmac("sha256", readFileSync(f, "utf8").trim()).update(input).digest("hex").slice(0, 12)}` : undefined;
}
/** A send's input with its board: the same words and ink on the same board ask the same thing (one case). */
const inputKey = (x: RealSend, before: SceneJSON) =>
  sha(js([typeof x.words === "string" ? x.words : x.words.map((w) => w.word).join(" "), x.strokes.map((k) => k.points), before.shapes]));

export type CardState = "pulled" | "skipped" | "labeled" | "proposed" | "admitted" | "rejected";
export type Card = {
  key: string; ss: Labeled; x: RealSend; n: number; who: string; split: Split; state: CardState;
  /** Its case id in the bank and R1 (realId of its input). */
  id?: string;
  /** Why a skipped send is no case. */
  skip?: string;
  triage?: TriageRow; gold?: GoldCase;
  /** Its bank case (a tune person's). */
  bank?: string;
  /** When the look window opened, and when it ends. */
  proposedAt?: string; admitAt?: string;
  review: Review;
};
type BankInfo = CaseInfo & { key: string; proposedAt?: string; recordedRun?: string; recordTries?: number; expectTries?: number };
export const bankInfo = (id: string) => maybe<BankInfo>(join(paths().bankCase(id), "case.json"));

/** Gold that's done: drawn and shot, or unreadable GOLD_TRIES times, or its board undrawable SHOT_TRIES times. Undefined while it's still to come. */
function goldSettled(g: GoldCase | undefined): "ok" | "failed" | undefined {
  if (!g) return undefined;
  if (g.error) return g.attempts >= GOLD_TRIES ? "failed" : undefined;
  if (existsSync(join(goldCaseDir(g.key), "gold.jpg"))) return "ok";
  return (g.shotTries ?? 0) >= SHOT_TRIES ? "failed" : undefined;
}

/** Every send intake labels, as a card in its state (oldest first). */
export function cards(now = Date.now()): Card[] {
  const sp = splits(), rv = reviews(), sessions = chosen();
  const voided = new Set((existsSync(paths().realBank) ? readdirSync(paths().realBank) : []).filter((d) => d.includes(".void")).map((d) => d.replace(/\.void.*$/, "")));
  const all = sessions.flatMap((ss) => ss.s.sends.map((x, i) => ({ ss, x, n: i + 1 }))).sort((a, b) => a.x.at.localeCompare(b.x.at));
  const triage = new Map(sessions.flatMap(({ dir }) => [...triageOf(dir)]));
  const undrawn = new Map(sessions.flatMap(({ dir }) => Object.entries(renderFailures(dir))));
  const gold = new Map(all.map(({ x }) => [x.key, goldOf(x.key)]));
  const banks = new Map<string, BankInfo | undefined>();
  const bank = (id: string) => (banks.has(id) ? banks.get(id) : banks.set(id, bankInfo(id)).get(id));
  // What each replayable send asks: its words and ink on its board, one case per input.
  const asks = new Map<string, { before: SceneJSON; input: string; id?: string }>();
  for (const { ss, x } of all) {
    if (x.replay === "ink") continue;
    try {
      const before = beforeOf(ss.dir, x), input = inputKey(x, before);
      asks.set(x.key, { before, input, id: realId(input) });
    } catch {} // a board that can't be read: skipped below
  }
  // The send an input belongs to: the one already holding its case (the bank case made from it, then a look window or
  // the owner's word, then triage), else the earliest. A later pull bringing an earlier copy never moves it.
  const holds = (key: string, id?: string) => (id && bank(id)?.key === key ? 3 : gold.get(key)?.proposedAt || rv.get(key)?.verdict ? 2 : triage.has(key) ? 1 : 0);
  const holder = new Map<string, string>();
  for (const { x } of all) {
    const a = asks.get(x.key);
    const was = a && holder.get(a.input);
    if (a && (was === undefined || holds(x.key, a.id) > holds(was, a.id))) holder.set(a.input, x.key);
  }
  return all.map(({ ss, x, n }): Card => {
    const who = whoOf(ss.s);
    const c: Card = { key: x.key, ss, x, n, who, split: sp[who] ?? "tune", state: "pulled", review: rv.get(x.key) ?? { edits: {} }, triage: triage.get(x.key), gold: gold.get(x.key) };
    const skip = (why: string) => Object.assign(c, { state: "skipped", skip: why });
    if (x.replay === "ink") return skip("its ink was lost (sent before the send log)");
    const a = asks.get(x.key);
    if (!a || (undrawn.get(x.key) ?? 0) >= SHOT_TRIES) return skip("its boards couldn't be drawn");
    if (a.before.shapes.some(needsPicture)) return skip("its board still waits for a picture, which both arms would draw");
    if (holder.get(a.input) !== x.key) return skip("a repeat of another send");
    c.id = a.id;
    if (!c.triage) return c;
    if (c.triage.drawing === false && c.review.verdict !== "approve") return skip(NOT_DRAWING);
    c.state = "labeled";
    const g = c.triage.gold ? goldSettled(c.gold) : "none";
    if (!g) return c;
    let opened: string | undefined;
    if (c.split === "hold") {
      if (g !== "ok") return skip(g === "failed" ? "R-hold, and gold couldn't be drawn" : "R-hold, and no gold to draw (R-hold people reach R1 only)");
      opened = c.gold!.proposedAt;
    } else if (c.id) {
      if (voided.has(c.id)) return skip("its bank case was voided by a sync");
      const info = bank(c.id);
      if (info && (info.recordTries ?? 0) >= RECORD_TRIES && !info.proposedAt) return skip("the champion couldn't replay it");
      if (info && (info.expectTries ?? 0) >= EXPECT_TRIES && !existsSync(join(paths().bankCase(c.id), "expectation.json"))) return skip("no expectation could be drafted for it");
      c.bank = c.id;
      opened = info?.proposedAt;
    }
    if (!opened) return c;
    c.proposedAt = opened;
    c.admitAt = new Date(Date.parse(opened) + LOOK_DAYS * DAY_MS).toISOString();
    c.state = c.review.verdict === "reject" ? "rejected" : c.review.verdict === "approve" || now >= Date.parse(c.admitAt) ? "admitted" : "proposed";
    return c;
  });
}

/** The card's meaning and expectation now: the owner's pinned edit, else triage's meaning and gold's rubric or the bank's drafted expectation. */
export function labelsOf(c: Card): { meant: string; expectation?: Rubric; pinned: { meant: boolean; expectation: boolean } } {
  const e = c.review.edits;
  const drafted = c.bank ? maybe<Expectation>(join(paths().bankCase(c.bank), "expectation.json")) : undefined;
  const fromGold = c.gold?.gold?.rubric;
  return {
    meant: e.meant ?? c.triage?.meant ?? "",
    expectation: e.expectation ?? (drafted && drafted.judgeId !== OWNER ? { should: drafted.should, mustNot: drafted.mustNot } : fromGold),
    pinned: { meant: e.meant !== undefined, expectation: e.expectation !== undefined },
  };
}

// ---- proposals: tune people's cards as bank cases

/**
 * Bank cases for every labeled tune card without one: its input, before board and meaning, and gold's rubric as its
 * expectation when gold was drawn for it (else the expectation judge drafts one, intake.ts). Its before image is shot as
 * the driver's are, and it's recorded on the champion (intake.ts); recorded() then opens its look window. Returns the
 * cases still to record.
 */
export function writeProposals(): string[] {
  const todo: string[] = [];
  for (const c of cards().filter((x) => x.state === "labeled" && x.bank)) {
    const d = paths().bankCase(c.bank!), before = beforeOf(c.ss.dir, c.x);
    const camera = cameraOf(c.x, before);
    if (!bankInfo(c.bank!)) {
      // A cluster per session, as the driver's are: one person's many sessions don't enter a decision as one block.
      const info: BankInfo = { id: c.bank!, set: "real", scenario: "real", persona: "real" as CaseInfo["persona"], style: "real" as CaseInfo["style"], start: "real" as CaseInfo["start"], ask: "real" as CaseInfo["ask"], seed: 0,
        originSession: `r-${sha(c.ss.s.id).slice(0, 8)}`, send: c.n, championSha: "", tuningId: "", harnessTag: "", configId: "", recordedAt: c.x.at, hedged: false, beatDone: false, flags: [], key: c.key };
      put(join(d, "case.json"), info);
      put(join(d, "input.json"), { camera, words: c.x.words, strokes: c.x.strokes, enterAtMs: c.x.enterAtMs, inputHash: sha(js([camera, c.x.words, c.x.strokes])) } satisfies CaseInput);
      put(join(d, "before.scene.json"), before);
    }
    pin(c);
    todo.push(c.bank!);
  }
  return todo;
}
/** The before image of a bank case, as the driver's are shot: its board at its camera with the ink numbered, at judge size. */
export async function shootCase(id: string, shot: Shot) {
  const d = paths().bankCase(id), input = json<CaseInput>(join(d, "input.json"));
  writeFileSync(join(d, "before-ink.jpg"), await shot(json<SceneJSON>(join(d, "before.scene.json")), input.camera, input.strokes));
}
/** A case's champion replay is in (its replies.json): the look window opens. */
export function recorded(id: string, run: string, championSha: string) {
  const info = bankInfo(id)!;
  put(join(paths().bankCase(id), "case.json"), { ...info, championSha, recordedRun: run, proposedAt: info.proposedAt ?? new Date().toISOString() } satisfies BankInfo);
}
/** A replay that didn't come back: counted, so a case the champion can't replay stops being retried (RECORD_TRIES). */
export function unrecorded(id: string) {
  const info = bankInfo(id)!;
  put(join(paths().bankCase(id), "case.json"), { ...info, recordTries: (info.recordTries ?? 0) + 1 } satisfies BankInfo);
}
/** A drafted expectation that came back unreadable: counted, so the judge isn't paid for it forever (EXPECT_TRIES). */
export function undrafted(id: string) {
  const info = bankInfo(id)!;
  put(join(paths().bankCase(id), "case.json"), { ...info, expectTries: (info.expectTries ?? 0) + 1 } satisfies BankInfo);
}
/** R-hold cards open their look window once their gold is shot (they have no replay to wait for). */
export function openHoldCards(): number {
  const open = cards().filter((c) => c.state === "labeled" && c.split === "hold" && c.gold?.gold && !c.gold.proposedAt);
  for (const c of open) put(join(goldCaseDir(c.key), "gold.json"), { ...c.gold!, proposedAt: new Date().toISOString() } satisfies GoldCase);
  return open.length;
}

/** A bank case's meaning and expectation as the card has them: the owner's edits, else triage's and gold's. */
function pin(c: Card) {
  const d = paths().bankCase(c.bank!), l = labelsOf(c), e = join(d, "expectation.json");
  put(join(d, "meant.json"), { meant: l.meant, hedged: false } satisfies Meant);
  const have = maybe<Expectation>(e);
  if (l.pinned.expectation) put(e, { judgeId: OWNER, ...l.expectation! } satisfies Expectation);
  else if (c.gold?.gold) put(e, { judgeId: RUBRIC, ...c.gold.gold.rubric } satisfies Expectation);
  // An edit the owner took back: the expectation judge drafts one again.
  else if (have?.judgeId === OWNER || have?.judgeId === RUBRIC) rmSync(e);
}

/**
 * The bank in step with the owner's word: an admitted case is done (decisions take it), a rejected one isn't (retired
 * if it was), and every case carries the card's edits. Returns the counts.
 */
export function admit(): { admitted: number; retired: number } {
  let admitted = 0, retired = 0;
  for (const c of cards().filter((x) => x.bank && x.proposedAt)) {
    const done = join(paths().bankCase(c.bank!), "done");
    pin(c);
    if (c.state === "admitted" && !existsSync(done)) {
      writeFileSync(done, `${new Date().toISOString()}\n`);
      admitted++;
    } else if (c.state === "rejected" && existsSync(done)) {
      rmSync(done);
      retired++;
    }
  }
  return { admitted, retired };
}

// ---- R1

/** R1's files by sha256 and the hash over them, as checkpoint.ts' manifests are made. */
function manifest(root: string) {
  const files: Record<string, string> = {};
  for (const id of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort())
    for (const f of readdirSync(join(root, id)).sort()) files[`${id}/${f}`] = sha(readFileSync(join(root, id, f)));
  return { version: "R1", files, hash: sha(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n")) };
}

/**
 * R1 from every admitted card with gold (real/bench/R1/<case>/), rebuilt whole and swapped in only when it changed:
 * its meaning and rubric the card's (the owner's edits pinned), split by person as splits.json has them, clustered by
 * person (case.json's originSession). History gets R1.json, the hash, the counts and the case ids, nothing a tester said
 * or drew. Undefined when R1 is as it was.
 */
export function freezeR1(): { cases: number; tune: number; hold: number; people: { tune: number; hold: number }; hash: string } | undefined {
  const root = benchDir(), next = `${root}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const ids: Record<string, Split> = {};
  const people: Record<Split, Set<string>> = { tune: new Set(), hold: new Set() };
  for (const c of cards().filter((x) => x.state === "admitted" && x.gold?.gold && x.id)) {
    const id = c.id!, d = join(next, id), before = beforeOf(c.ss.dir, c.x), l = labelsOf(c);
    const camera = cameraOf(c.x, before);
    put(join(d, "case.json"), { id, set: "real", split: c.split, originSession: c.who, session: c.ss.s.id, key: c.key, recordedAt: c.x.at, replay: c.x.replay, source: c.ss.s.source, admin: c.ss.s.admin, categories: c.gold!.categories, hedged: false, beatDone: false });
    put(join(d, "input.json"), { camera, words: c.x.words, strokes: c.x.strokes, enterAtMs: c.x.enterAtMs, inputHash: sha(js([camera, c.x.words, c.x.strokes])) } satisfies CaseInput);
    put(join(d, "before.scene.json"), before);
    put(join(d, "meant.json"), { meant: l.meant, hedged: false } satisfies Meant);
    put(join(d, "rubric.json"), l.expectation ?? c.gold!.gold!.rubric);
    put(join(d, "checks.json"), c.gold!.gold!.checks);
    copyFileSync(join(c.ss.dir, "img", imagesOf(c.ss.dir)[c.key].before), join(d, "before-ink.jpg"));
    ids[id] = c.split;
    people[c.split].add(c.who);
  }
  const m = manifest(next);
  // Nothing to freeze yet, or R1 as it was.
  if ((!Object.keys(ids).length && !existsSync(root)) || maybe<{ hash: string }>(join(root, "manifest.json"))?.hash === m.hash) {
    rmSync(next, { recursive: true, force: true });
    return undefined;
  }
  put(join(next, "manifest.json"), m);
  rmSync(root, { recursive: true, force: true });
  renameSync(next, root);
  const tune = Object.values(ids).filter((s) => s === "tune").length;
  const r = { cases: Object.keys(ids).length, tune, hold: Object.keys(ids).length - tune, people: { tune: people.tune.size, hold: people.hold.size }, hash: m.hash };
  historyWrite("bench/R1.json", { ...r, at: new Date().toISOString(), splits: ids });
  return r;
}
