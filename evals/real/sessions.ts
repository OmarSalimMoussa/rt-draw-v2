// Testers' real sends as sessions (evals/real/README.md): one project's history in order, each send with
// what it was given, what came back and what the person did next. A send from the send log
// (app/src/board/capture.ts) is exact. One from before the log is rebuilt from its version and the drawing
// call's prompt: words without ink replay exactly, as typed words; ink survives only as the product's reading
// of it ("loop around tail"), so those sends are context for triage and gold, not replayable cases.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SendRecord } from "../../app/src/board/capture.ts";
import { type View, asPage } from "../../src/core/board.ts";
import type { Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";
import { runScript } from "../../src/core/ops.ts";
import type { SceneJSON } from "../loop/types.ts";

export type Source = "live" | "local";
/** exact: from the send log; typed: rebuilt, no ink, replays as typed words; ink: rebuilt, its ink is lost. */
export type Replay = "exact" | "typed" | "ink";
export type RealSend = {
  /** `<session>#<n>`, n counting the session's sends from 1: the case id's root. */
  key: string;
  at: string;
  label: string;
  kind: "send" | "build";
  replay: Replay;
  words: Word[] | string;
  strokes: Stroke[];
  enterAtMs: number;
  /** The board the drawing model was shown, in board pixels. */
  camera?: View;
  /** The product's reading of each ink mark, and what it resolved, from the drawing call's prompt. */
  marks: string[];
  refs?: string;
  /** Versions: the board it started from (0, the blank board) and the one it left (the same when nothing landed). */
  before: number;
  after: number;
  /** The drawing model's ops, and each picture it asked for. */
  reply?: string;
  pictures: { subject: string; w: number; h: number; elements: number }[];
  status?: string;
  error?: string;
};
export type Session = {
  id: string;
  source: Source;
  /** A pseudonym: the hash of the owner id, never an email. */
  person: string;
  /** The owner's (admin's) own work, or a tester's. */
  admin: boolean;
  project: { id: string; name: string };
  sends: RealSend[];
  restores: { at: string; version: number; label: string }[];
  feedback: { at: string; text: string; version?: number }[];
};

type Version = { n: number; doc: SceneJSON; at: number; label: string };
type Person = { id: string; email: string; owner: string; admin?: boolean };
type Call = { at: string; from?: string; who?: string; ms?: number; user?: string; reply?: string };
type Feedback = { at: number; person: string; text: string; project?: { id: string; version?: number } };

const readJson = <T>(f: string): T | undefined => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined);
function readLines<T>(f: string): T[] {
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

/** The board a new project starts with (app/src/projects/storage.ts' blankBoard). */
export const blankBoard = (): SceneJSON => runScript(asPage("", "page", "Home")).scene.toJSON();

/** A label or a request, compared without ink markers, punctuation, case or spacing. */
export const normal = (s: string) => s.replace(/\[ink \d+\]/g, " ").replace(/[^\p{L}\p{N}\s']/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/** What a drawing call's prompt says about its send. */
export function readPrompt(user: string): { request: string; camera?: View; marks: string[]; refs?: string } {
  const request = /\nRequest: ([\s\S]*?)(?:\n\n|$)/.exec(user)?.[1]?.trim() ?? "";
  const c = /The screen shows (-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+) of it/.exec(user);
  const marks = (/\nMarks \([^)]*\):\n([\s\S]*?)(?:\n\n|$)/.exec(user)?.[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const refs = /References \(resolved before this call\): (.*)/.exec(user)?.[1]?.trim();
  return { request, camera: c ? { x: +c[1], y: +c[2], w: +c[3], h: +c[4] } : undefined, marks, refs };
}

/**
 * Whether a drawing call's request is the send a version was labeled with. A spoken label is what was heard at
 * Enter, and the transcript can still change after it, so the two only have to start alike.
 */
export function sameSend(label: string, request: string): boolean {
  if (/^preview click/i.test(label)) return /^preview click/i.test(request);
  if (label === "(drawing only)") return normal(request) === "";
  const [a, b] = [normal(label), normal(request)];
  return a === b || (Math.min(a.length, b.length) >= 12 && a.slice(0, 40) === b.slice(0, 40));
}

const elements = (svg: string) => (svg.match(/<(path|circle|ellipse|rect|line|polyline|polygon)\b/g) ?? []).length;

/**
 * Every project of one snapshot (live: the box's /data; local: this laptop's .data) as sessions, written to
 * out/<session>/session.json with each version they use as v<n>.json (v0: the blank board).
 */
export function ingest(raw: string, source: Source, out: string): Session[] {
  const people = readJson<{ people: Person[] }>(join(raw, "access", "access.json"))?.people ?? [];
  const calls = readLines<Call>(join(raw, "model-calls.jsonl"));
  const feedback = readLines<Feedback>(join(raw, "access", "feedback.jsonl"));
  const ownersDir = join(raw, "app", "owners");
  const owners = existsSync(ownersDir) ? readdirSync(ownersDir) : [];
  const sessions: Session[] = [];
  for (const owner of owners) {
    const who = people.find((p) => p.owner === owner);
    // Live: only a person's own calls. Local: the dev server logs no person, so any call may be this owner's.
    const mine = (c: Call) => (source === "live" ? !!who && c.who === who.id : true);
    const draws = calls.filter((c) => c.from === "draw" && mine(c) && c.user).map((c) => ({ c, end: Date.parse(c.at), start: Date.parse(c.at) - (c.ms ?? 0), p: readPrompt(c.user!) }));
    const pictures = calls.filter((c) => c.from === "picture" && mine(c) && c.user).map((c) => ({ c, end: Date.parse(c.at) }));
    const metas = readJson<{ id: string; name: string }[]>(join(ownersDir, owner, "index.json")) ?? [];
    for (const meta of metas) {
      const versions = readLines<Version>(join(ownersDir, owner, `${meta.id}.ndjson`)).sort((a, b) => a.n - b.n);
      const logged = readLines<SendRecord>(join(raw, "app", "sends", owner, `${meta.id}.ndjson`));
      if (!versions.length && !logged.length) continue;
      const id = `${source}-${sha(`${source}:${owner}`).slice(0, 8)}-${meta.id}`;
      const dir = join(out, id);
      mkdirSync(dir, { recursive: true });
      const docs = new Map<number, SceneJSON>([[0, blankBoard()], ...versions.map((v) => [v.n, v.doc] as [number, SceneJSON])]);
      const sends: RealSend[] = [];
      const restores: Session["restores"] = [];
      const used = new Set<typeof draws[number]>();
      const key = () => `${id}#${sends.length + 1}`;
      for (const [i, v] of versions.entries()) {
        const prevAt = i ? versions[i - 1].at : 0;
        if (/^Restored V\d+/.test(v.label)) {
          restores.push({ at: iso(v.at), version: v.n, label: v.label });
          continue;
        }
        const exact = logged.find((s) => s.afterVersion === v.n && s.landed > 0);
        if (exact) {
          sends.push({ key: key(), at: exact.at, label: exact.label, kind: exact.kind, replay: "exact", words: exact.words, strokes: exact.strokes, enterAtMs: exact.enterAtMs, camera: exact.camera, marks: [], before: exact.beforeVersion, after: v.n, pictures: [], status: exact.status, error: exact.error });
          docs.set(-exact.beforeVersion - 1, exact.before);
          continue;
        }
        // The latest unused drawing call that ended by this version's save and asked for what it's labeled with.
        const d = draws.filter((x) => !used.has(x) && x.end <= v.at + 2000 && x.end >= prevAt - 2000 && sameSend(v.label, x.p.request)).sort((a, b) => b.end - a.end)[0];
        if (d) used.add(d);
        const pics = d ? pictures.filter((x) => x.end >= d.start && x.end <= v.at + 2000) : [];
        sends.push({
          key: key(), at: iso(d?.start ?? v.at), label: v.label, kind: /^preview click/i.test(v.label) ? "build" : "send",
          replay: d?.p.marks.length ? "ink" : "typed", words: d ? d.p.request : v.label, strokes: [], enterAtMs: 0,
          camera: d?.p.camera, marks: d?.p.marks ?? [], refs: d?.p.refs, before: i ? versions[i - 1].n : 0, after: v.n, reply: d?.c.reply,
          pictures: pics.map(({ c }) => {
            const box = /The box is (\d+) wide and (\d+) tall/.exec(c.user!);
            return { subject: /Doodle: (.*)/.exec(c.user!)?.[1] ?? "", w: box ? +box[1] : 0, h: box ? +box[2] : 0, elements: elements(c.reply ?? "") };
          }),
        });
      }
      // Logged sends that changed nothing (a camera move, a failure, a stop): no version, but what happened.
      for (const s of logged.filter((s) => s.landed === 0)) {
        sends.push({ key: key(), at: s.at, label: s.label, kind: s.kind, replay: "exact", words: s.words, strokes: s.strokes, enterAtMs: s.enterAtMs, camera: s.camera, marks: [], before: s.beforeVersion, after: s.beforeVersion, pictures: [], status: s.status, error: s.error });
        docs.set(-s.beforeVersion - 1, s.before);
      }
      sends.sort((a, b) => a.at.localeCompare(b.at));
      sends.forEach((s, k) => (s.key = `${id}#${k + 1}`));
      for (const [n, doc] of docs) if (n >= 0 && sends.some((s) => s.before === n || s.after === n)) writeFileSync(join(dir, `v${n}.json`), JSON.stringify(doc));
      // An exact send's own before (the board as it was, which a version may not hold), as before-<key n>.json.
      for (const s of sends.filter((s) => s.replay === "exact")) {
        const own = docs.get(-s.before - 1);
        if (own) writeFileSync(join(dir, `before-${s.key.split("#")[1]}.json`), JSON.stringify(own));
      }
      const session: Session = {
        id, source, person: `p-${sha(owner).slice(0, 8)}`, admin: source === "local" || !!who?.admin, project: { id: meta.id, name: meta.name }, sends, restores,
        feedback: feedback.filter((f) => who && f.person === who.id && f.project?.id === meta.id).map((f) => ({ at: iso(f.at), text: f.text, version: f.project?.version })),
      };
      writeFileSync(join(dir, "session.json"), JSON.stringify(session, null, 1));
      sessions.push(session);
    }
  }
  return sessions;
}

/** The before board of a send: its own (exact) or its starting version's. */
export function beforeOf(dir: string, s: RealSend): SceneJSON {
  const own = join(dir, `before-${s.key.split("#")[1]}.json`);
  return JSON.parse(readFileSync(existsSync(own) ? own : join(dir, `v${s.before}.json`), "utf8"));
}
export const afterOf = (dir: string, s: RealSend): SceneJSON => JSON.parse(readFileSync(join(dir, `v${s.after}.json`), "utf8"));
