// What waits for the owner, for the progress page's "Needs you" and `rte note`: each open owner-list item (one per
// decision or checkpoint it names), each decision held for his call (verdict "owner") that no later run re-decided, and
// each side chat Claude answered last; beside each, its thread. Threads live in $RT_EVAL_HOME/notes/threads.jsonl, never
// in history/ (eval/history is pushed to its remote): append-only, a line per message, the page writing the owner's
// and `rte note` Claude's. An item is settled when its owner-list lines are ticked or its thread is resolved; nothing
// here edits owner-list.md (the loop writes it). Pure, so the page, the pages server and rte note share it.
import type { DecisionRow } from "../loop/types.ts";

/** One line of notes/threads.jsonl. `resolved` settles (true) or reopens (false) the thread; the text may then be empty. */
export type Note = { at: string; thread: string; item?: string; who: "owner" | "claude"; text: string; resolved?: boolean };
/** A thread's notes in order, whether it is settled, and its last note with words. */
export type Thread = { id: string; item?: string; notes: Note[]; resolved: boolean; last?: Note };
/**
 * One thing waiting for the owner. `held`: the loop holds the decision for his call; `since`: the run that re-decided it
 * after; `notice`: a line naming no decision or checkpoint (its id is made from its date and words); `turn`: his move (no
 * thread yet, or Claude spoke last); `order`: newer is larger.
 */
export type Item = { id: string; date: string; notice: boolean; held: boolean; decision?: DecisionRow; since?: DecisionRow; what: string; why: string[]; thread?: Thread; turn: boolean; order: number };

export const THREAD_ID = /^[\w.-]{1,80}$/;
/** A side chat's thread; any other thread is the item of the same id. */
export const isChat = (id: string) => id.startsWith("chat-");
export const chatId = (at = new Date()) => `chat-${at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`;

export function threadsOf(notes: Note[]): Thread[] {
  const by = new Map<string, Thread>();
  for (const n of notes) {
    let t = by.get(n.thread);
    if (!t) by.set(n.thread, (t = { id: n.thread, item: n.item, notes: [], resolved: false }));
    t.notes.push(n);
    if (n.resolved !== undefined) t.resolved = n.resolved;
    if (n.text) t.last = n;
  }
  return [...by.values()];
}
/** Threads where the owner wrote last and nobody has answered (resolved or not: an answer can settle it): a watcher's. */
export const waiting = (ts: Thread[]) => ts.filter((t) => t.last?.who === "owner");

// ---- Plain words for the loop's commonest owner-list lines (anything else stays as the loop wrote it)

const PLAIN: [RegExp, string][] = [
  [/^too rare to measure: (\d+) affected cases?.*\(< (\d+)\)$/, "only $1 cases touched by the change, too few to measure (it takes $2)"],
  [/^void: (.+)$/, "not measured, the run was void: $1"],
  [/^a prompt line about roughness or stroke width in (\S+): "(.*)"$/, "changes a prompt line about roughness or stroke width in $1 (how hand-drawn the page looks is yours): “$2…”"],
  [/^dry well: (.+)$/, "nothing kept lately: $1"],
];
export const plain = (s: string) => PLAIN.reduce((t, [re, to]) => (re.test(t) ? t.replace(re, to) : t), s);
/** A card's change as a headline: its first sentence, at most `max` characters. */
export function headline(s: string, max = 160) {
  const first = /^(.+?[.!?])(\s|$)/.exec(s)?.[1] ?? s;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

// ---- The list

const LINE = /^\s*- \[([ xX])\] (?:(\d{4}-\d{2}-\d{2}): )?(.+)$/;
/** A line's words as an id, cut at a word under 40 characters. */
const slug = (s: string) => {
  const w = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return w.length <= 40 ? w : w.slice(0, 41).replace(/-[^-]*$/, "");
};

/**
 * Everything waiting for the owner, held decisions first, then newest first; the side chats still open; and the items
 * settled on the page that owner-list.md still has open (the session that runs the loop ticks those there).
 */
export function needsYou(ownerList: string, decisions: DecisionRow[], notes: Note[]) {
  const threads = new Map(threadsOf(notes).map((t) => [t.id, t]));
  const known = new Set(decisions.map((d) => d.id));
  // The decision or checkpoint a line names first ("e106-h1: …", "ck-05: …"), else none ("dry well: …").
  const named = (text: string) => {
    const id = /^([\w.-]+): /.exec(text)?.[1];
    return id && (known.has(id) || /\d/.test(id)) ? id : undefined;
  };
  // One group per name; an unnamed line is its own, its id its date and words (made unique).
  const groups = new Map<string, { id: string; date: string; order: number; open: string[]; notice: boolean }>();
  const ids = new Set<string>();
  ownerList.split("\n").forEach((l, i) => {
    const m = LINE.exec(l);
    if (!m) return;
    const [, mark, date = "", text] = m;
    const name = named(text);
    const key = name ?? `${date}\n${text}`;
    let g = groups.get(key);
    if (!g) {
      let id = name ?? [date, slug(text)].filter(Boolean).join("-");
      for (let k = 2; !name && ids.has(id); k++) id = `${[date, slug(text)].filter(Boolean).join("-")}-${k}`;
      ids.add(id);
      groups.set(key, (g = { id, date, order: i, open: [], notice: !name }));
    }
    g.order = i;
    g.date ||= date;
    if (mark === " ") g.open.push(name ? text.slice(name.length + 2) : text);
  });
  // A held decision stands until a later run decides it (rte decide on its branch: d-cand-<id>).
  const since = (d: DecisionRow) => decisions.slice(decisions.lastIndexOf(d) + 1).find((x) => (x.id === d.id || x.id === `d-cand-${d.id}`) && x.verdict !== "owner");
  const item = (id: string, date: string, order: number, open: string[], d?: DecisionRow, notice = false): Item => {
    const later = d && since(d);
    const held = d?.kind === "card" && d.verdict === "owner" && !later;
    const change = d?.card?.change;
    // The coordinator writes "<card>: <change>: <why>" for a card it held before deciding: the change once is enough.
    const why = (open.length ? open : (d?.reasons ?? [])).map((w) => (change && w.startsWith(`${change}: `) ? w.slice(change.length + 2) : w)).map(plain);
    const what = change ? headline(change) : (why.shift() ?? id);
    const t = threads.get(id);
    return { id, date, notice, held, decision: d, since: later, what, why, thread: t, turn: t?.last?.who !== "owner", order };
  };
  const all: Item[] = [];
  const grouped = new Set<string>();
  for (const g of groups.values()) {
    grouped.add(g.id);
    if (g.open.length) all.push(item(g.id, g.date, g.order, g.open, decisions.findLast((d) => d.id === g.id), g.notice));
  }
  // A held decision the list never named (its lines all ticked count as settled).
  decisions.forEach((d, i) => {
    if (d.kind === "card" && d.verdict === "owner" && !grouped.has(d.id) && decisions.findLast((x) => x.id === d.id) === d && !since(d)) all.push(item(d.id, "", 1e6 + i, [], d));
  });
  all.sort((a, b) => Number(b.held) - Number(a.held) || b.order - a.order);
  const chats = [...threads.values()].filter((t) => isChat(t.id));
  return {
    items: all.filter((x) => !x.thread?.resolved),
    chats: chats.filter((t) => !t.resolved).reverse(),
    /** Items resolved here that owner-list.md still has open, and the side chats resolved. */
    settled: all.filter((x) => x.thread?.resolved),
    closed: chats.filter((t) => t.resolved).reverse(),
  };
}

/** How many things wait on the owner's move: items nobody answered him on, and side chats Claude answered last. */
export const yourTurn = (n: ReturnType<typeof needsYou>) => n.items.filter((x) => x.turn).length + n.chats.filter((t) => t.last?.who === "claude").length;
