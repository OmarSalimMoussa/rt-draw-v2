// Judge packets (spec §4.2), from frozen harness files only: the case's input and meant, the
// frozen change lists, the before image with numbered ink. The `said` transcript is built here
// (N12), never by the arm's own linking step, so a candidate can't change what the judge reads.
// A packet stores the positions (which arm is left) and never sends them: prompts get the
// packet's words and images, never an arm, commit, tuning, model, persona, rating or `testing`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stroke } from "../../src/core/ink.ts";
import type { Word } from "../../src/core/link.ts";
import { inkGroups } from "../bridge/ink.ts";
import { targetOf } from "../core/personas.ts";
import { paths } from "../loop/paths.ts";
import { caseDir, put } from "../loop/record.ts";
import type { Arm, CaseInfo, CaseInput, Expectation, Meant, Packet } from "../loop/types.ts";
import type { StepView } from "./prompts.ts";

/** Part of every judgeId: a change to how packets are built is a change to the judge. */
export const PACKET_VERSION = 1;

export type Positions = Packet["positions"];

/**
 * The words in order with [ink n] after the word being said when mark n started (marks as the
 * before image numbers them); ink before any word leads. A typed send (a string) is its text
 * followed by [ink 1] … [ink n] in stroke order.
 */
export function said(words: Word[] | string, strokes: Stroke[]): string {
  const marks = inkGroups(strokes).map((g, i) => ({ t0: g[0].t0, tag: `[ink ${i + 1}]` }));
  if (typeof words === "string") return [words.trim(), ...marks.map((m) => m.tag)].filter(Boolean).join(" ");
  const after = words.map((w) => [w.word]);
  const lead: string[] = [];
  for (const m of marks) {
    const k = words.findLastIndex((w) => w.t0 <= m.t0);
    (k < 0 ? lead : after[k]).push(m.tag);
  }
  return [...lead, ...after.flat()].join(" ");
}

/** A case file: the run's own copy (a continuation send), else the banked case's. */
export function caseFile(caseId: string, name: string, runId?: string): string {
  const own = runId ? join(caseDir(runId, caseId), name) : undefined;
  return own && existsSync(own) ? own : join(paths().bankCase(caseId), name);
}
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));

/** What the judges are told about the step; target parts only for first-timers, as context. */
export function stepOf(caseId: string, runId?: string): StepView {
  const input = json<CaseInput>(caseFile(caseId, "input.json", runId));
  const m = json<Meant>(caseFile(caseId, "meant.json", runId));
  const info = json<CaseInfo>(caseFile(caseId, "case.json", runId));
  const parts = info.persona === "first-timer" && info.target ? targetOf(info.target).parts : undefined;
  return { said: said(input.words, input.strokes), meant: m.meant, hedged: m.hedged, ...(parts ? { targetParts: parts } : {}) };
}

/** A packet image (a path relative to the run case, else the banked case) as the data: URL a call sends. */
export function imageOf(caseId: string, rel: string, runId?: string): string {
  return `data:image/jpeg;base64,${readFileSync(caseFile(caseId, rel, runId)).toString("base64")}`;
}

/** Builds and stores judge/packet.json for a run case: both arms' frozen change lists, the expectation, the positions. */
export function writePacket(runId: string, caseId: string, positions: Positions, e: Expectation): Packet {
  const changes = (arm: Arm) => json<string[]>(join(caseDir(runId, caseId), arm, "changes.json"));
  const packet: Packet = {
    case: caseId, ...stepOf(caseId, runId),
    expectation: { should: e.should, mustNot: e.mustNot },
    images: { before: "before-ink.jpg", left: `${positions.left}/after.jpg`, right: `${positions.right}/after.jpg` },
    changes: { left: changes(positions.left), right: changes(positions.right) },
    positions,
  };
  put(join(caseDir(runId, caseId), "judge", "packet.json"), packet);
  return packet;
}

export const readPacket = (runId: string, caseId: string): Packet => json<Packet>(join(caseDir(runId, caseId), "judge", "packet.json"));
