// The send log: every send, kept so it can be replayed as an eval case (evals/real/), with the board
// before it, the camera it saw, the person's words and ink on their own clock, and how it went. The
// before is taken as the send starts (onStart); the rest once the board has settled after it. Posted
// to /api/sends (app/server/projects.ts) and never waited for: a send never slows down for its record.
import type { View } from "../../../src/core/board.ts";
import type { Stroke } from "../../../src/core/ink.ts";
import type { Word } from "../../../src/core/link.ts";
import type { SceneJSON } from "../../../src/core/scene.ts";
import type { JobStatus } from "./sender.ts";

export type SendRecord = {
  id: string;
  project: string;
  /** When Enter was pressed (ISO). */
  at: string;
  label: string;
  spoken: boolean;
  /** A preview click's build, or a send from the bar. */
  kind: "send" | "build";
  /** The board the send was drawn on, in board pixels, as the drawing model was told. */
  camera: View;
  words: Word[] | string;
  strokes: Stroke[];
  /** Ms from the ink clock's zero to Enter: the eval's enterAtMs. */
  enterAtMs: number;
  before: SceneJSON;
  beforeVersion: number;
  afterVersion: number;
  status: JobStatus;
  landed: number;
  error?: string;
  ttfcMs?: number;
  ttdMs?: number;
};

/** What a send starts from. */
export type SendStart = { at: number; camera: View; before: SceneJSON; beforeVersion: number };

/** A short random id, unique enough within one project. */
export const sendId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Posts a record; a failure is only logged, never the person's problem. */
export function postSend(rec: SendRecord) {
  void fetch("/api/sends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) })
    .then((r) => r.ok || console.warn(`send log: HTTP ${r.status}`))
    .catch((e) => console.warn(`send log: ${e instanceof Error ? e.message : e}`));
}
