// rte shipped --sha <commit> --tag <image tag> [--url <prod's address>]: evals/ops/ship.sh's record of what it put on
// prod, a line of history's ships.jsonl, for Eval HQ's overview (which checks the address is up) and rte api status.
import { commitHistory, historyAdd, openHistory } from "../history.ts";
import type { Rte } from "../rte.ts";

export async function shippedCmd(rte: Rte) {
  const { sha, tag, url } = rte.o.f;
  if (typeof sha !== "string" || !/^[0-9a-f]{12,40}$/.test(sha) || typeof tag !== "string" || !/^[\w.-]{1,128}$/.test(tag) || (url !== undefined && !(typeof url === "string" && /^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(url))))
    throw new Error("shipped --sha <commit> --tag <image tag> [--url https://<prod's host>]");
  openHistory();
  historyAdd("ships.jsonl", { at: new Date().toISOString(), sha, tag, ...(url ? { url } : {}) });
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
