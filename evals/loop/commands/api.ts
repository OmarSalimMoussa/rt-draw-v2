// rte api <tool>: the PGX's side of Claude's tools for the eval (evals/ops/mcp.ts runs them from the laptop over ssh).
// One JSON object on stdout. Ids, counts and the harness's own words only: never what a tester said or drew (a card's
// content stays in Eval HQ), never a token.
//   rte api status | needs_you [--thread <id> --text "<words>" [--resolve]] | run | stop | intake_now
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { historyFile, readNotes } from "../../pages/plugin.ts";
import { needsYou, threadsOf, waiting } from "../../progress/attention.ts";
import { intakeView } from "../../real/review.ts";
import { requestStop } from "../coordinator.ts";
import { paths } from "../paths.ts";
import { type Rte, msg } from "../rte.ts";
import { championStatus, holder, loopUnit, readState } from "../state.ts";
import { Slots } from "../tokens.ts";
import type { DecisionRow } from "../types.ts";
import { replyNote } from "./note.ts";

/** The tools, as evals/ops/mcp.ts offers them (it says what each does). */
export const TOOLS = ["status", "needs_you", "run", "stop", "intake_now"] as const;

const unit = (name: string) => `${process.env.RT_UNIT_PREFIX ?? "rt"}-${name}`;

function status(rte: Rte) {
  const st = readState(), p = paths(), v = intakeView(), h = holder();
  const ships = (historyFile("ships.jsonl", p.repo).text ?? "").split("\n").filter(Boolean);
  let budget: unknown;
  try {
    budget = new Slots(rte.tokens().map((t) => t.slot), join(p.home, "meter", "slots.json")).status().map((s) => ({ slot: s.slot, fiveHour: s.fiveHour, week: s.sevenDay, status: s.status, parked: s.why }));
  } catch (err) {
    budget = { none: msg(err) };
  }
  return {
    loop: { unit: loopUnit(), ...(st?.run ?? { status: "never started" }), epoch: st?.epoch, cards: st && { decided: st.cards.filter((c) => c.status === "done").length, of: st.cards.length }, blocked: st?.blocked },
    lock: h ? { cmd: h.cmd, pid: h.pid, since: h.start, live: h.live } : null,
    champion: championStatus() ?? null,
    prod: ships.length ? JSON.parse(ships.at(-1)!) : null,
    intake: { pulled: { live: v.pull.live.pulledAt ?? null, local: v.pull.local.pulledAt ?? null }, lookDays: v.lookDays, cards: v.states, skipped: v.skipped, rejected: v.rejected },
    bank: v.bank,
    budget,
  };
}

function needs(args: { thread?: string; text?: string; resolve?: boolean }) {
  if (args.thread) {
    const n = replyNote(args.thread, args.text ?? "", !!args.resolve);
    return { replied: { thread: n.thread, resolved: !!n.resolved } };
  }
  const repo = paths().repo;
  const decisions = (historyFile("decisions.jsonl", repo).text ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DecisionRow);
  const notes = readNotes();
  const n = needsYou(historyFile("owner-list.md", repo).text ?? "", decisions, notes);
  return {
    items: n.items.map((x) => ({ id: x.id, date: x.date, held: x.held, what: x.what, why: x.why, ownersTurn: x.turn })),
    chats: n.chats.map((t) => ({ thread: t.id, last: t.last && { who: t.last.who, at: t.last.at } })),
    waiting: waiting(threadsOf(notes)).map((t) => ({ thread: t.id, at: t.last!.at, owner: t.last!.text })),
    settled: n.settled.map((x) => x.id),
  };
}

/** `systemctl --user <args>`: its exit status and what it said. */
const systemctl = (...args: string[]) => {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return { ok: r.status === 0, said: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

function run() {
  // bin/rte run: the owner's word that the loop should run (rte wanted), a reset of a unit that gave up, then the start.
  const r = spawnSync("bash", [join(import.meta.dirname, "..", "..", "..", "bin", "rte"), "run"], { encoding: "utf8" });
  return { started: r.status === 0, said: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function intakeNow() {
  const loop = loopUnit();
  if (loop === "active" || loop === "activating") return { started: false, said: "the loop is running: it runs intake between its epochs" };
  const r = systemctl("start", "--no-block", `${unit("intake")}.service`);
  return { started: r.ok, said: r.ok ? `${unit("intake")}.service started: a live pull, then rte intake (journalctl --user -u ${unit("intake")})` : r.said };
}

export async function apiCmd(rte: Rte) {
  const tool = rte.o.pos[1];
  if (!(TOOLS as readonly string[]).includes(tool)) throw new Error(`api <tool>: one of ${TOOLS.join(", ")}`);
  const f = rte.o.f;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const out = tool === "status" ? status(rte) : tool === "needs_you" ? needs({ thread: str(f.thread), text: str(f.text), resolve: !!f.resolve }) : tool === "run" ? run() : tool === "stop" ? { said: requestStop() } : intakeNow();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}
