// Eval HQ's intake and review (evals/progress/, through evals/pages/plugin.ts, on the PGX only): where each pull's
// sends are, how well they're labeled (the share of cards the owner edits, per field), and each card with everything
// its verdict needs. Testers' words, drawings and images leave real/ only through these, to the owner's browser on the
// tailnet; logs, tools and history get keys and counts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Word } from "../../src/core/link.ts";
import { paths } from "../loop/paths.ts";
import { caseDir } from "../loop/record.ts";
import type { SceneJSON } from "../loop/types.ts";
import { type Card, type CardState, LOOK_DAYS, NOT_DRAWING, REJECT_REASONS, type Reason, type ReviewRow, type Rubric, addReview, bankInfo, cards as allCards, labelsOf } from "./cases.ts";
import { runChecks } from "./checks.ts";
import { type IntakePass, goldCaseDir, imagesOf, maybe, passFile, realHome } from "./real.ts";
import { type RealSend, type Source, beforeOf } from "./sessions.ts";

const said = (x: RealSend) => (typeof x.words === "string" ? x.words : x.words.map((w) => w.word).join(" ")) || x.label;
const week = (iso: string) => {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * The cards, read once for a burst of requests (a card opened asks for it and four images at once): every send and board
 * is read and hashed for them. A verdict posted here reads them again.
 */
let read: { at: number; all: Card[] } | undefined;
const cards = () => (read && Date.now() - read.at < 2000 ? read.all : (read = { at: Date.now(), all: allCards() }).all);

/** A source's last pull: when it last ran, and the snapshot it holds (evals/real/pull.sh). */
function pullOf(src: Source) {
  const dir = join(realHome(), "raw", src);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : undefined);
  return { pulledAt: read("pulled"), snapshot: read("latest") };
}

export type CardRow = {
  key: string; state: CardState; tester: boolean; split: Card["split"]; project: string; at: string; said: string;
  landed?: string; categories: string[]; gold: boolean; skip?: string; proposedAt?: string; admitAt?: string;
  verdict?: "approve" | "reject"; reason?: Reason; edited: { meant: boolean; expectation: boolean };
};
const rowOf = (c: Card): CardRow => ({
  key: c.key, state: c.state, tester: c.who !== "owner", split: c.split, project: c.ss.s.project.name, at: c.x.at, said: said(c.x).slice(0, 160),
  landed: c.triage?.landed, categories: c.triage?.categories ?? [], gold: !!c.gold?.gold, skip: c.skip, proposedAt: c.proposedAt, admitAt: c.admitAt,
  verdict: c.review.verdict, reason: c.review.reason, edited: { meant: c.review.edits.meant !== undefined, expectation: c.review.edits.expectation !== undefined },
});

/**
 * GET /api/eval/intake: each source's pull and intake's last pass, the cards by state and skipped ones by reason, the
 * owner's edit and reject rates per week (the labeling's quality), and every card past triage or skipped.
 */
export function intakeView() {
  const all = cards();
  const count = <K extends string>(ks: K[]) => ks.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<K, number>());
  const decided = all.filter((c) => c.review.verdict && c.review.at);
  const quality = [...new Set(decided.map((c) => week(c.review.at!)))].sort().map((w) => {
    const cs = decided.filter((c) => week(c.review.at!) === w);
    return { week: w, decided: cs.length, rejected: cs.filter((c) => c.review.verdict === "reject").length, meant: cs.filter((c) => c.review.edits.meant !== undefined).length, expectation: cs.filter((c) => c.review.edits.expectation !== undefined).length };
  });
  const done = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((id) => !id.includes(".void") && existsSync(join(dir, id, "done"))).length : 0);
  return {
    lookDays: LOOK_DAYS, reasons: REJECT_REASONS,
    pull: { live: pullOf("live"), local: pullOf("local") }, pass: maybe<IntakePass>(passFile()),
    bank: { driver: done(paths().bankCases), real: done(paths().realBank) },
    states: Object.fromEntries(count(all.map((c) => c.state))),
    skipped: Object.fromEntries(count(all.flatMap((c) => (c.skip ? [c.skip] : [])))),
    rejected: Object.fromEntries(count(all.flatMap((c) => (c.state === "rejected" && c.review.reason ? [c.review.reason] : [])))),
    quality,
    cards: all.filter((c) => c.state !== "pulled").map(rowOf),
  };
}

/** The image of a card a page asks for: which is before (with their ink), then (the app's result), champion or gold. */
export function cardImage(key: string, which: string): string | undefined {
  const c = cards().find((x) => x.key === key);
  if (!c) return undefined;
  const img = imagesOf(c.ss.dir)[key];
  const f =
    which === "before" ? img && join(c.ss.dir, "img", img.before)
    : which === "then" ? img && join(c.ss.dir, "img", img.after)
    : which === "gold" ? join(goldCaseDir(key), "gold.jpg")
    : which === "champion" && c.bank ? (() => {
        const run = bankInfo(c.bank!)?.recordedRun;
        return run && join(caseDir(run, c.bank!), "A", "after.jpg");
      })()
    : undefined;
  return f && existsSync(f) ? f : undefined;
}

/** GET /api/eval/card?key=: one card whole, for its verdict. */
export function cardView(key: string) {
  const all = cards();
  const i = all.findIndex((x) => x.key === key);
  const c = all[i];
  if (!c || c.state === "pulled") return undefined;
  const { s } = c.ss;
  const l = labelsOf(c);
  // A skipped send's board may be unreadable (its boards couldn't be drawn): the card shows without checks then.
  const before = (() => {
    try {
      return beforeOf(c.ss.dir, c.x);
    } catch {
      return undefined;
    }
  })();
  const info = c.bank ? bankInfo(c.bank) : undefined;
  const champion = info?.recordedRun ? maybe<SceneJSON>(join(caseDir(info.recordedRun, c.bank!), "A", "after.scene.json")) : undefined;
  const g = c.gold?.gold;
  const prev = s.sends[c.n - 2];
  const img = (which: string) => (cardImage(key, which) ? `/api/eval/card-image?${new URLSearchParams({ key, which })}` : undefined);
  const drafted = c.bank ? maybe<{ judgeId: string } & Rubric>(join(paths().bankCase(c.bank), "expectation.json")) : undefined;
  return {
    ...rowOf(c), lookDays: LOOK_DAYS, reasons: REJECT_REASONS,
    send: { n: c.n, of: s.sends.length, kind: c.x.kind, replay: c.x.replay, words: c.x.words as Word[] | string, label: c.x.label, marks: c.x.marks, refs: c.x.refs, status: c.x.status },
    previous: prev && { said: said(prev), at: prev.at },
    feedback: s.feedback,
    images: { before: img("before"), then: img("then"), champion: img("champion"), gold: img("gold") },
    triage: c.triage && { meant: c.triage.meant, landed: c.triage.landed, categories: c.triage.categories, evidence: c.triage.evidence },
    meant: { now: l.meant, drafted: c.triage?.meant ?? "", pinned: l.pinned.meant },
    expectation: { now: l.expectation, from: l.pinned.expectation ? "owner" : g ? "gold" : drafted ? "judge" : undefined, pinned: l.pinned.expectation },
    gold: c.gold && {
      why: g?.why, error: c.gold.error, problems: [...c.gold.problems, ...(c.gold.shotTries ? [`the bridge couldn't draw gold's board (${c.gold.shotTries} tries)`] : [])],
      checks: (g?.checks ?? []).map((check, k) => ({ check, then: c.gold!.appChecks[k], now: champion && before ? runChecks([check], champion, before)[0] : undefined, gold: c.gold!.goldChecks[k] })),
    },
    champion: info?.recordedRun ? { sha: info.championSha, run: info.recordedRun } : undefined,
    review: c.review,
  };
}

/**
 * POST /api/eval/verdict: the owner's verdict on a proposed or decided card, with edits; or a note alone (autosaved).
 * Approving a send triage called not a drawing request reopens it: it's labeled and proposed as any other.
 */
export function postReview(b: Record<string, unknown>): ReviewRow | { error: string } {
  const key = typeof b.key === "string" ? b.key : "";
  const c = cards().find((x) => x.key === key);
  const reopens = c?.state === "skipped" && c.skip === NOT_DRAWING;
  if (!c || !(["proposed", "admitted", "rejected", "labeled"].includes(c.state) || reopens)) return { error: `no card ${key} to judge` };
  if (reopens && b.verdict !== undefined && b.verdict !== "approve") return { error: `${key} is skipped: approve reopens it` };
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => text(x, 400)).filter((x): x is string => !!x) : undefined);
  const row: ReviewRow = { key, at: new Date().toISOString() };
  if (b.note !== undefined) row.note = text(b.note, 2000) ?? "";
  if (b.verdict === undefined) {
    if (row.note === undefined) return { error: "a note or a verdict" };
  } else {
    if (b.verdict !== "approve" && b.verdict !== "reject") return { error: "a verdict is approve or reject" };
    if (c.state === "labeled") return { error: `${key} isn't proposed yet` };
    row.verdict = b.verdict;
    if (b.verdict === "reject") {
      if (!(typeof b.reason === "string" && b.reason in REJECT_REASONS)) return { error: `a rejection needs a reason: ${Object.keys(REJECT_REASONS).join(", ")}` };
      row.reason = b.reason as Reason;
    }
    if (b.meant !== undefined) row.meant = b.meant === null ? null : text(b.meant, 1000) || null;
    if (b.expectation !== undefined) {
      const e = b.expectation as Partial<Rubric> | null;
      const should = list(e?.should), mustNot = list(e?.mustNot);
      if (e !== null && !should?.length) return { error: "an expectation says at least one thing it should do" };
      row.expectation = e === null ? null : { should: should!, mustNot: mustNot ?? [] };
    }
  }
  addReview(row);
  read = undefined;
  return row;
}
