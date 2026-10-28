// rte shipped --sha <commit> --tag <image tag>: evals/ops/ship.sh's record of what it put on prod, a line of history's
// ships.jsonl, for Eval HQ's overview and rte api status.
import { commitHistory, historyAdd, openHistory } from "../history.ts";
import type { Rte } from "../rte.ts";

export async function shippedCmd(rte: Rte) {
  const { sha, tag } = rte.o.f;
  if (typeof sha !== "string" || !/^[0-9a-f]{12,40}$/.test(sha) || typeof tag !== "string" || !/^[\w.-]{1,128}$/.test(tag)) throw new Error("shipped --sha <commit> --tag <image tag>");
  openHistory();
  historyAdd("ships.jsonl", { at: new Date().toISOString(), sha, tag });
  // A loop committing at the same moment holds the index: its commit (git add -A) then carries this line.
  try {
    commitHistory(`shipped ${tag}`);
  } catch {
    rte.say("shipped: recorded; the loop's next history commit carries it");
    return 0;
  }
  rte.say(`shipped: ${tag} (${sha.slice(0, 12)}) recorded`);
  return 0;
}
