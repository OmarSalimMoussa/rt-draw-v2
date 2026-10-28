// rte shipped --sha <commit> --tag <image tag> [--champion <commit>] [--url <prod's address>]: evals/ops/ship.sh's
// record of what it put on prod, a line of history's ships.jsonl, for Eval HQ's overview (the keeps not on prod, and
// whether the address is up) and rte api status. The same commit recorded again replaces its line.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitHistory, historyAdd, historyRows, openHistory } from "../history.ts";
import type { Rte } from "../rte.ts";

export async function shippedCmd(rte: Rte) {
  const { sha, tag, champion, url } = rte.o.f;
  const commit = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{12,40}$/.test(v);
  if (!commit(sha) || typeof tag !== "string" || !/^[\w.-]{1,128}$/.test(tag) || (champion !== undefined && !commit(champion)) || (url !== undefined && !(typeof url === "string" && /^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(url))))
    throw new Error("shipped --sha <commit> --tag <image tag> [--champion <commit>] [--url https://<prod's host>]");
  const dir = openHistory();
  writeFileSync(join(dir, "ships.jsonl"), historyRows("ships.jsonl").filter((r) => r.sha !== sha).map((r) => `${JSON.stringify(r)}\n`).join(""));
  historyAdd("ships.jsonl", { at: new Date().toISOString(), sha, tag, ...(champion ? { champion: champion as string } : {}), ...(url ? { url: url as string } : {}) });
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
