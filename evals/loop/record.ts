// Writes what the loop records (spec §3.2–3.3): banked cases and run folders. Every write is
// atomic (a temp file, then a rename), so a killed run never leaves half a file; a `done`
// marker goes last and is the resume key. Nothing is ever deleted: a file about to be replaced
// by different content, or a voided case, is renamed *.void first. Images are stored once by
// sha256 in cache/blobs/ and hard-linked where a case names them.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { View } from "../../src/core/board.ts";
import { needsPicture, readPicture } from "../../src/core/picture.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";
import { nameOf, sceneDiff } from "../core/diff.ts";
import { paths } from "./paths.ts";
import type {
  Arm, ArmResult, ArmTiming, CaseInfo, CaseInput, ChampionOutcome, DriverRecord, Expectation, Meant, Miss, Rating,
  Readings, RecordedReply, RunInfo, SceneJSON, SpanJSON,
} from "./types.ts";

type Data = string | Uint8Array | object;
const bytesOf = (d: Data) => (typeof d === "string" || d instanceof Uint8Array ? d : `${JSON.stringify(d, null, 2)}\n`);
const sha256 = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");

/** Renames a file or folder to its first free `*.void` name (never deletes it). */
export function voidPath(p: string): string {
  let to = `${p}.void`;
  for (let n = 2; existsSync(to); n++) to = `${p}.void.${n}`;
  renameSync(p, to);
  return to;
}

/** Writes a file atomically; an existing file with other content is voided first, the same content is left alone. */
export function put(file: string, data: Data) {
  const body = bytesOf(data);
  if (existsSync(file)) {
    if (readFileSync(file).equals(Buffer.from(body))) return;
    voidPath(file);
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/** Appends one JSON line (load.ndjson, rows.jsonl). */
export function appendLine(file: string, row: object) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** An image stored once as cache/blobs/<sha256>.jpg and hard-linked at `file`. */
export function putImage(file: string, jpg: Uint8Array) {
  const blob = paths().blob(sha256(jpg));
  if (!existsSync(blob)) put(blob, jpg);
  if (existsSync(file)) {
    // The same image already (a link, or a copy after a move between machines).
    if (statSync(file).ino === statSync(blob).ino || readFileSync(file).equals(jpg)) return;
    voidPath(file);
  }
  mkdirSync(dirname(file), { recursive: true });
  linkSync(blob, file);
}

const write = (dir: string, files: Record<string, Data | undefined>) => {
  for (const [name, data] of Object.entries(files)) {
    if (data === undefined) continue;
    if (name.endsWith(".jpg")) putImage(join(dir, name), data as Uint8Array);
    else put(join(dir, name), data);
  }
};

/** Writes `done` last, after checking that every required file is there. */
function done(dir: string, required: string[]) {
  const missing = required.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`${dir} isn't complete: no ${missing.join(", ")}`);
  put(join(dir, "done"), `${new Date().toISOString()}\n`);
}
export const isDone = (dir: string) => existsSync(join(dir, "done"));

/** A voided case folder: its reason goes inside, then the whole folder is renamed *.void, so a rerun starts clean. */
export function voidCase(dir: string, why: string): string {
  put(join(dir, "void.json"), { why, at: new Date().toISOString() });
  return voidPath(dir);
}

// ---- Banked cases: bank/cases/c-<bank>-s<session>-<n>/ (§3.2)

/** A banked case's files, by the name each is written under. */
export type CaseFiles = {
  "case.json": CaseInfo; "input.json": CaseInput; "before.scene.json": SceneJSON;
  "before-ink.jpg": Uint8Array; "driver-before.jpg": Uint8Array; "driver-now.jpg": Uint8Array;
  "driver.json": DriverRecord; "meant.json": Meant;
  /** From the driver's next turn: absent on a session's last send. */
  "rating.json": Rating;
  "expectation.json": Expectation; "miss.json": Miss;
  "champion-after.jpg": Uint8Array; "champion.json": ChampionOutcome; "replies.json": RecordedReply[]; "readings.json": Readings;
};
const CASE_FILES: (keyof CaseFiles)[] = [
  "case.json", "input.json", "before.scene.json", "before-ink.jpg", "driver-before.jpg", "driver-now.jpg", "driver.json", "meant.json",
  "rating.json", "expectation.json", "miss.json", "champion-after.jpg", "champion.json", "replies.json", "readings.json",
];

/** Writes any of a banked case's files as they become known (the rating comes a turn later, the judges' after the send). */
export function writeCase(id: string, files: Partial<CaseFiles>) {
  write(paths().bankCase(id), files);
}

/** Marks a banked case complete: every §3.2 file is there (no rating on a session's last send). */
export function caseDone(id: string, o: { last: boolean }) {
  done(paths().bankCase(id), CASE_FILES.filter((f) => !(o.last && f === "rating.json")));
}

/**
 * V12: a before-scene shape that still needs a picture (the champion's failed or never
 * finished) is filled from the champion's own completed picture reply for that subject (flag
 * `filled`); without one the case is refused. Otherwise both arms would redraw it on every A/B,
 * separately sampled and unrelated to the ask.
 */
export function checkBefore(scene: SceneJSON, replies: RecordedReply[]): { scene: SceneJSON; filled: string[] } | { refused: string } {
  const out = structuredClone(scene);
  const filled: string[] = [];
  for (const s of out.shapes.filter(needsPicture)) {
    const subject = s.drawing!;
    // As pictureFiller sizes it.
    const [w, h] = [s.box.w, s.box.h].map((x) => Math.round(x * DEFAULTS["picture.fill"]));
    const els = replies
      .filter((r) => r.role === "picture" && r.subject === subject)
      .reverse()
      .map((r) => replyText(r))
      .map((text) => (text ? readPicture(text, subject, w, h).els : []))
      .find((e) => e.length);
    if (!els) return { refused: `V12: '${nameOf(s)}' still needs a picture and no completed recorded reply draws "${subject}"` };
    s.picture = { subject, w, h, els, done: true };
    filled.push(s.id);
  }
  return { scene: out, filled };
}

/** A recorded reply's text from the reply cache (`error` marks a call that never completed). */
function replyText(r: RecordedReply): string | undefined {
  const file = isAbsolute(r.cacheFile) ? r.cacheFile : join(dirname(paths().reply("x")), r.cacheFile);
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const text = j.text ?? j.reply; // cache.ts stores `text`
    return !j.error && typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

// ---- Runs: runs/<run-id>/ (§3.3)

export const runFile = (runId: string, ...p: string[]) => join(paths().run(runId), ...p);
export const caseDir = (runId: string, caseId: string) => runFile(runId, "cases", caseId);

export function writeRun(info: RunInfo) {
  put(runFile(info.id, "run.json"), info);
}

/** One arm's send in a run case. */
export type ArmFiles = { "result.json": ArmResult; "timing.json": ArmTiming; "spans.json": SpanJSON[]; "after.scene.json": SceneJSON; "after.jpg": Uint8Array };
const ARM_FILES = ["result.json", "timing.json", "spans.json", "after.scene.json", "after.jpg", "changes.json"];

/** Writes an arm's files and its change list (the frozen sceneDiff against the case's before-scene; cameras [before, after]). */
export function writeArm(runId: string, caseId: string, arm: Arm, files: ArmFiles, before: SceneJSON, cameras: [View, View]) {
  write(join(caseDir(runId, caseId), arm), { ...files, "changes.json": sceneDiff(before, files["after.scene.json"], cameras).changes });
}

/** Marks a run case complete: both arms' files and fork.json (a one-arm run passes its arm). */
export function runCaseDone(runId: string, caseId: string, arms: Arm[] = ["A", "B"]) {
  done(caseDir(runId, caseId), [...arms.flatMap((a) => ARM_FILES.map((f) => `${a}/${f}`)), ...(arms.length > 1 ? ["fork.json"] : [])]);
}
