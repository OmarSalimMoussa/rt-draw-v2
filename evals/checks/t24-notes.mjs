// T24's acceptance check: what waits for the owner (evals/progress/attention.ts) from an owner list and decisions (held
// decisions first, then newest first; ticked lines and re-decided holds settled; one item per decision named), and the
// threads beside it: POST /api/eval/threads appends the owner's notes to $RT_EVAL_HOME/notes/threads.jsonl (never
// history/, which is pushed), GET ?waiting is a watcher's, and `rte note` lists what waits and answers as Claude.
// 0 model calls: no model endpoint, no tokens.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t24-notes.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "vite";
import { ROOT, check, cleanEnv, finish, tempHome } from "./lib.mjs";

const PORT = 5253; // this task's ports are 5250–5259
const put = (f, text) => (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, text));
const home = tempHome();
const notesFile = join(home, "notes/threads.jsonl");
const notes = () => (existsSync(notesFile) ? readFileSync(notesFile, "utf8").split("\n").filter(Boolean) : []);

// ---- A history: held decisions with and without a line, a ticked hold, a hold re-decided since, a revert, an owner step.
const d = (id, verdict, o = {}) => ({ id, kind: "card", epoch: 1, card: { id, component: "draw", change: `${id}'s change. More words after the first sentence.` }, goal: "latency", verdict, reasons: [`${id}'s reason`], ...o });
const decisions = [d("e1-h1", "owner"), d("e2-h1", "owner"), d("e3-h1", "owner"), d("e4-h1", "revert"), { ...d("owner-ck-01", "owner"), kind: "owner-step", card: undefined }, d("d-cand-e3-h1", "revert"), d("e5-h1", "owner")];
put(join(home, "history/decisions.jsonl"), decisions.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ownerList = `# Owner list

- [x] 2026-10-20: e1-h1: patch to src/core/render.ts (ticked 2026-10-20: declined)
- [ ] 2026-10-21: e2-h1: render not measured whole on 30 of 80 cases
- [ ] 2026-10-21: dry well: 6 reverts in a row on draw; paused for 3 epochs or until the next checkpoint
- [ ] 2026-10-22: e3-h1: a prompt line about roughness or stroke width in src/core/prompts.ts: "stroke-width 3"
- [ ] 2026-10-22: e3-h1: a prompt line about roughness or stroke width in src/core/prompts.ts: "fill none"
- [ ] 2026-10-23: e4-h1: too rare to measure: 12 affected cases, ~2 more from 48 top-up sends (< 32)
`;
put(join(home, "history/owner-list.md"), ownerList);
const historyBefore = readdirSync(join(home, "history")).sort().join(" ");

const { needsYou, yourTurn } = await import("../progress/attention.ts");
const now = (ns = []) => needsYou(ownerList, decisions, ns.map((l) => JSON.parse(l)));
let n = now();
const DRY = "2026-10-21-dry-well-6-reverts-in-a-row-on-draw";
check(JSON.stringify(n.items.map((x) => x.id)) === JSON.stringify(["e5-h1", "e2-h1", "e4-h1", "e3-h1", DRY]), `the items are ${JSON.stringify(n.items.map((x) => x.id))}`);
const by = (id) => n.items.find((x) => x.id === id);
check(by("e5-h1")?.held && by("e2-h1")?.held && !by("e3-h1")?.held && !by("e4-h1")?.held && !by(DRY)?.held, "held is wrong: only e5-h1 and e2-h1 wait for his call");
check(by("e3-h1")?.since?.id === "d-cand-e3-h1" && by("e3-h1").why.length === 2 && by("e3-h1").why.every((w) => /hand-drawn/.test(w)), `e3-h1 isn't one item re-decided since, with both lines in plain words: ${JSON.stringify(by("e3-h1"))}`);
check(by("e2-h1").what === "e2-h1's change." && by("e2-h1").why[0] === "render not measured whole on 30 of 80 cases" && by("e5-h1").why[0] === "e5-h1's reason", "a held item's headline or why is wrong");
check(/^only 12 cases touched/.test(by("e4-h1").why[0]) && /^nothing kept lately/.test(by(DRY).what), `plain words: ${by("e4-h1").why[0]} / ${by(DRY).what}`);
check(yourTurn(n) === 5 && !n.chats.length && !n.settled.length, `nothing answered yet, yet ${yourTurn(n)} on his turn`);

// ---- The pages server: the owner's notes appended outside history/, refused when malformed.
const server = await createServer({ root: ROOT, configFile: join(ROOT, "evals/pages.vite.config.ts"), cacheDir: join(home, "vite-cache"), logLevel: "error", clearScreen: false, server: { port: PORT, strictPort: true, host: "127.0.0.1", watch: null } });
await server.listen();
const base = `http://127.0.0.1:${PORT}/api/eval/threads`;
const post = (b) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
check(JSON.stringify(await (await fetch(base)).json()) === '{"notes":[]}', "GET /api/eval/threads isn't empty before any note");
const r1 = await post({ thread: "e2-h1", text: "  Measure render whole first.  ", who: "claude" });
const l1 = JSON.parse(notes()[0] ?? "{}");
check(r1.status === 200 && notes().length === 1 && JSON.stringify(Object.keys(l1)) === '["at","thread","item","who","text"]' && l1.who === "owner" && l1.item === "e2-h1" && l1.text === "Measure render whole first." && !Number.isNaN(Date.parse(l1.at)), `the owner's note is ${JSON.stringify(l1)}`);
for (const [b, status] of [[{ thread: "../x", text: "x" }, 400], [{ thread: "e2-h1", text: "   " }, 400], [{ text: "x".repeat(20_001) }, 413]]) {
  const r = await post(b);
  check(r.status === status, `POST ${JSON.stringify(b).slice(0, 60)} answered ${r.status}, not ${status}`);
}
const chat = await (await post({ text: "Can the loop skip render cards?" })).json();
check(/^chat-\d{8}-\d{6}$/.test(chat.thread) && !("item" in chat) && notes().length === 2, `a note with no thread didn't start a side chat: ${JSON.stringify(chat)}`);
check(readdirSync(join(home, "history")).sort().join(" ") === historyBefore, "a note landed in history/");
check(notes().every((l) => JSON.parse(l) && l.includes('"who":"owner"')), "a line isn't whole JSON a tail -F | grep '\"who\":\"owner\"' finds");
let w = (await (await fetch(`${base}?waiting`)).json()).waiting;
check(JSON.stringify(w.map((t) => t.id)) === JSON.stringify(["e2-h1", chat.thread]) && w[0].last.text === "Measure render whole first.", `?waiting is ${JSON.stringify(w)}`);

// ---- rte note: the list, a reply as Claude, a resolve, a typo refused, a side chat of Claude's.
const rte = (...a) => spawnSync(process.execPath, ["--import", "./evals/loop/node-hooks.mjs", "evals/loop/run.ts", "note", ...a], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 60_000 });
let o = rte();
check(o.status === 0 && /2 threads wait for a reply/.test(o.stdout) && o.stdout.includes("e2-h1 · held for his call: e2-h1's change.") && o.stdout.includes("why: render not measured whole") && o.stdout.includes("Measure render whole first.") && o.stdout.includes(`${chat.thread} · side chat`), `rte note listed: ${o.stdout}${o.stderr}`);
o = rte("e2-h1", "Queued: e2-h1 again, render timed whole.");
const l3 = JSON.parse(notes().at(-1));
check(o.status === 0 && notes().length === 3 && l3.who === "claude" && l3.thread === "e2-h1" && l3.item === "e2-h1" && l3.text === "Queued: e2-h1 again, render timed whole.", `rte note e2-h1 wrote ${JSON.stringify(l3)} (${o.stdout}${o.stderr})`);
w = (await (await fetch(`${base}?waiting`)).json()).waiting;
check(w.length === 1 && w[0].id === chat.thread, `after Claude's reply ?waiting is ${JSON.stringify(w.map((t) => t.id))}`);
o = rte("e4-h1", "--resolve");
check(o.status === 0 && JSON.parse(notes().at(-1)).resolved === true && JSON.parse(notes().at(-1)).text === "", `rte note e4-h1 --resolve wrote ${notes().at(-1)}`);
o = rte("e9-h9", "a typo");
check(o.status === 1 && notes().length === 4, `a reply to no thread or item was written (${o.status})`);
o = rte("new", "A question from Claude.");
check(o.status === 0 && /^chat-/.test(JSON.parse(notes().at(-1)).thread) && JSON.parse(notes().at(-1)).who === "claude", `rte note new wrote ${notes().at(-1)}`);
o = rte();
check(/1 thread waits for a reply/.test(o.stdout) && /Resolved in the threads, still open in owner-list.md \(tick them there\): e4-h1/.test(o.stdout), `rte note listed after: ${o.stdout}`);

// ---- What the page counts now: e4-h1 settled; e2-h1 and Claude's chat his move again, his own chat Claude's.
n = now(notes());
check(!by("e4-h1") && n.settled.map((x) => x.id).join() === "e4-h1" && by("e2-h1")?.turn && by("e2-h1").thread.last.who === "claude", "e4-h1 isn't settled or e2-h1 isn't his move after Claude's reply");
check(n.chats.length === 2 && yourTurn(n) === 5, `his turn: ${yourTurn(n)} (want e5-h1, e2-h1, e3-h1, dry well and Claude's chat)`);
await server.close();
finish();
