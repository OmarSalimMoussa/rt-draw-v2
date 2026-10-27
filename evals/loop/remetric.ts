// After a metric fix: rebuild a finished run's rows.jsonl from its raw files with today's
// metrics.ts. What no metric computes (the case's session, class, affected flag, dispatch
// order, over-use, a void) is read back from the old rows; everything measured is recomputed.
// The old file is renamed *.void if anything changed, never deleted.
//   node --import ./evals/loop/node-hooks.mjs evals/loop/remetric.ts <run-id>   (or: rte remetric <run-id>)
import { existsSync, readFileSync } from "node:fs";
import { meterOf, readRows, rowOf } from "./metrics.ts";
import { put, runFile } from "./record.ts";

export function remetric(runId: string): { rows: number; changed: boolean } {
  const file = runFile(runId, "rows.jsonl");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const calls = meterOf(runId);
  const rows = readRows(runId).map((r) =>
    rowOf(runId, { case: r.case, cluster: r.cluster, affected: r.affected, class: r.class, overuse: r.overuse, ask: r.ask, beat: r.beat, firstArm: r.firstArm, void: r.void, lost: r.lost }, calls),
  );
  const text = rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  put(file, text);
  return { rows: rows.length, changed: text !== before };
}

if (import.meta.main) {
  const runId = process.argv[2];
  if (!runId) throw new Error("usage: remetric.ts <run-id>");
  const { rows, changed } = remetric(runId);
  console.log(`${runId}: ${rows} rows, ${changed ? "changed (the old rows.jsonl is now rows.jsonl.void)" : "unchanged"}`);
}
