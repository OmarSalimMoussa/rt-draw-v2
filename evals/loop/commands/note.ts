// rte note: Claude's side of the owner's threads beside the progress page's "Needs you" ($RT_EVAL_HOME/notes/threads.jsonl,
// outside git; evals/progress/attention.ts). With no thread: each thread where the owner wrote last (a reply is due), with
// the item it is on, and the items settled in the threads that owner-list.md still has open (tick them there). A watcher
// can also follow the file: tail -F -n0 ~/rt-eval/notes/threads.jsonl | grep --line-buffered '"who":"owner"'.
//   rte note                    rte note <thread> "<text>" [--resolve]    rte note <thread> --resolve    rte note new "<text>"
import { addNote, historyFile, readNotes } from "../../pages/plugin.ts";
import { chatId, isChat, needsYou, threadsOf, waiting } from "../../progress/attention.ts";
import { paths } from "../paths.ts";
import type { Rte } from "../rte.ts";
import type { DecisionRow } from "../types.ts";

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 90 ? `${min} min ago` : `${(min / 60).toFixed(1)} h ago`;
};

/**
 * Claude's reply on a thread (or `new`: a side chat). It goes only to a thread or an item that exists: a typo would start
 * a thread no page shows.
 */
export function replyNote(thread: string, text: string, resolve: boolean, n = waitingNow()) {
  if (!text && !resolve) throw new Error(`note ${thread}: say something ("<text>"), or --resolve`);
  const id = thread === "new" ? chatId() : thread;
  const known = thread === "new" || threadsOf(readNotes()).some((t) => t.id === id) || n.items.some((x) => x.id === id);
  if (!known) throw new Error(`note: no thread or waiting item "${thread}" (rte note lists them; rte note new "<text>" starts a side chat)`);
  return addNote({ thread: id, who: "claude", text, resolved: resolve ? true : undefined });
}
function waitingNow() {
  const repo = paths().repo;
  const decisions = (historyFile("decisions.jsonl", repo).text ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DecisionRow);
  return needsYou(historyFile("owner-list.md", repo).text ?? "", decisions, readNotes());
}

export async function noteCmd(rte: Rte) {
  const [, thread, ...words] = rte.o.pos;
  const resolve = rte.o.f.resolve;
  // `--resolve "<text>"` parses as the flag's value: the words all the same.
  const text = [...words, ...(typeof resolve === "string" ? [resolve] : [])].join(" ").trim();
  const n = waitingNow();
  if (thread) {
    const note = replyNote(thread, text, !!resolve, n);
    rte.say(`note: ${note.thread}${note.text ? `, ${note.text.length} characters` : ""}${note.resolved ? ", resolved" : ""}`);
    return 0;
  }
  const items = new Map([...n.items, ...n.settled].map((x) => [x.id, x]));
  const due = waiting(threadsOf(readNotes()));
  console.log(due.length ? `${due.length} thread${due.length > 1 ? "s wait" : " waits"} for a reply (the owner wrote last):` : "No thread waits for a reply.");
  for (const t of due) {
    const it = items.get(t.id);
    const about = isChat(t.id) ? "side chat" : it ? `${it.held ? "held for his call" : "on the owner list"}: ${it.what}` : "an item no longer waiting";
    console.log(`  ${t.id} · ${about}${t.resolved ? " (resolved)" : ""}`);
    for (const w of it?.why ?? []) console.log(`    why: ${w}`);
    console.log(`    owner, ${ago(t.last!.at)}: ${t.last!.text.replace(/\n/g, "\n      ")}`);
  }
  if (n.settled.length) console.log(`Resolved in the threads, still open in owner-list.md (tick them there): ${n.settled.map((x) => x.id).join(", ")}`);
  return 0;
}
