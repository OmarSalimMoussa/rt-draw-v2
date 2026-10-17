// The loop's record (spec §3.5, §5.3, §8.5; F17): branch eval/history of the loop's own clone, an orphan
// written only by the loop, checked out at $RT_EVAL_HOME/history. Rows are appended and the few whole
// files (anchors, eras) rewritten in place: git keeps every version, so nothing here is voided. Every
// decision and checkpoint ends in one commit, pushed when the branch has a remote
// (`git config branch.eval/history.remote <name>`), so the record outlives the machine. The owner's
// checkout and master are never touched: on the laptop the clone's origin is his checkout, and nothing
// is pushed there unless he sets that remote himself.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configId } from "./config.ts";
import { readRows } from "./metrics.ts";
import { paths } from "./paths.ts";
import { runFile, voidPath } from "./record.ts";
import { clusteredZ } from "./stats.ts";
import type { BudgetRow, CheckpointRow, DecisionRow, EpochRow, Era, HealthRow, HypothesisCard, Lat, Marker, Ratio, Row, RunInfo, SmokeRow } from "./types.ts";
import type { Decision } from "./verdict.ts";

export const BRANCH = "eval/history";
/** runs/<id>.json's cap (§3.5): rows past it are dropped and counted. */
const RUN_MAX_BYTES = 200_000;
/** A missing ratio (no pairs) as no change. */
export const ONE: Ratio = { est: 1, lo90: 1, hi90: 1, lo95: 1 };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function tryGit(cwd: string, ...args: string[]): string | undefined {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined; // a non-zero exit is the answer (no such ref, staged changes)
  }
}
/** The loop always commits as itself: the machine's own identity (the owner's email) would land in every record and tried patch. */
const WHO = ["-c", "user.name=rt-eval loop", "-c", "user.email=rt-eval@localhost"];

/** The history worktree, made on first use: the orphan branch, then the worktree; files written before it are adopted. */
export function openHistory(): string {
  const { repo, history } = paths();
  if (existsSync(join(history, ".git"))) return history;
  if (!existsSync(join(repo, ".git"))) throw new Error(`no loop clone at ${repo}: run init first`);
  if (tryGit(repo, "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`) === undefined) {
    // An orphan: the record shares no history with the product's. Its root is the same commit on every machine
    // (fixed identity and date), so another machine's `export` imports as a fast-forward; rows appended on two
    // machines merge by union.
    const git0 = (args: string[], input: string, env = process.env) => execFileSync("git", ["-C", repo, ...args], { input, env, encoding: "utf8" }).trim();
    const tree = git0(["mktree"], `100644 blob ${git0(["hash-object", "-w", "--stdin"], "*.jsonl merge=union\n*.md merge=union\n")}\t.gitattributes\n`);
    const id = { NAME: "rt-eval loop", EMAIL: "rt-eval@localhost", DATE: "2026-10-16T00:00:00Z" };
    const env = { ...process.env, ...Object.fromEntries(["AUTHOR", "COMMITTER"].flatMap((r) => Object.entries(id).map(([k, v]) => [`GIT_${r}_${k}`, v]))) };
    git(repo, "branch", BRANCH, git0(["commit-tree", tree, "-m", "eval/history: the loop's record (spec §3.5)"], "", env));
  }
  // Judge ids or a hand-made bench may predate the worktree: set aside, then copied in and committed.
  const before = existsSync(history) ? voidPath(history) : undefined;
  tryGit(repo, "worktree", "prune");
  git(repo, "worktree", "add", "-q", history, BRANCH);
  if (before) {
    cpSync(before, history, { recursive: true });
    commitHistory(`adopt what was written before the history worktree (left at ${before})`);
  }
  return history;
}

const at = (...p: string[]) => join(openHistory(), ...p);

/** Commits everything in the worktree (nothing to commit: undefined) and pushes when the branch has a remote. */
export function commitHistory(message: string): string | undefined {
  const dir = openHistory();
  git(dir, "add", "-A");
  if (tryGit(dir, "diff", "--cached", "--quiet") !== undefined) return undefined;
  git(dir, ...WHO, "commit", "-q", "-m", message);
  const remote = tryGit(dir, "config", "--get", `branch.${BRANCH}.remote`);
  if (remote) {
    try {
      git(dir, "push", "-q", remote, `${BRANCH}:${BRANCH}`);
    } catch (err) {
      // Never fatal: the next decision's push carries this commit too.
      console.error(`history: push to ${remote} failed: ${String(err).split("\n")[0]}`);
    }
  }
  return git(dir, "rev-parse", "HEAD");
}

// ---- The files of §5.3

type Rows = { "epochs.jsonl": EpochRow; "decisions.jsonl": DecisionRow; "checkpoints.jsonl": CheckpointRow; "budget.jsonl": BudgetRow; "health.jsonl": HealthRow; "markers.jsonl": Marker; "smoke.jsonl": SmokeRow };
/** anchors.json: each anchor once frozen (§5.2); `tuning` when the champion was a commit plus knobs. */
export type Anchor = { id: string; sha: string; Q: number; latency?: Lat; tuning?: Record<string, number> };
type Whole = { "anchors.json": Anchor[]; "eras.json": Era[] };

export function historyAdd<K extends keyof Rows>(name: K, row: Rows[K]) {
  const f = at(name);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify(row)}\n`);
}
export function historyRows<K extends keyof Rows>(name: K): Rows[K][] {
  const f = at(name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
export const historyRead = <K extends keyof Whole>(name: K): Whole[K] => (existsSync(at(name)) ? json<Whole[K]>(at(name)) : []);
export function historyWrite(name: string, data: unknown, indent = 1) {
  const f = at(name);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, `${JSON.stringify(data, null, indent)}\n`);
  renameSync(`${f}.tmp`, f);
}

/** machine/<host>.json: the ladder's machine.json, kept with the record so a chart point says what it ran on. */
export function recordMachine() {
  const m = paths().machine;
  if (existsSync(m)) historyWrite(`machine/${json<{ host: string }>(m).host}.json`, json(m));
}

/** runs/<id>.json: run.json, verdict.json and rows.jsonl in one file, rows dropped from the end past 200 KB. */
export function saveRun(run: string) {
  const maybe = (f: string) => (existsSync(runFile(run, f)) ? json(runFile(run, f)) : undefined);
  const out = { run: maybe("run.json"), verdict: maybe("verdict.json"), rows: readRows(run), dropped: 0 };
  let size = JSON.stringify({ ...out, rows: [], dropped: out.rows.length }).length + out.rows.reduce((a, r) => a + JSON.stringify(r).length + 1, 0);
  while (size > RUN_MAX_BYTES && out.rows.length) (size -= JSON.stringify(out.rows.pop()).length + 1), out.dropped++;
  historyWrite(`runs/${run}.json`, out, 0);
}

// ---- The ledger, tried patches and the owner list (§8.5)

/** One ledger.md entry per decision: card, class, goal, verdict, looks, vetoes, $ and minutes, the run. */
export function ledger(d: DecisionRow) {
  const f = at("ledger.md");
  const head = d.kind === "owner-step" ? `## ${d.id} · owner step · ${d.reasons[0]}` : `## ${d.id} · ${d.card?.component} · ${d.verdict} (${d.class}, ${d.goal})`;
  const looks = d.looks.map((l) => `${l.n}: Z ${l.z.toFixed(2)}`).join(" → ") || "none";
  const lines = [
    head, "",
    ...(d.card ? [`- ${d.card.change}`] : []),
    `- looks ${looks}; ${d.counts.wins} won, ${d.counts.losses} lost, ${d.counts.ties} tied, ${d.counts.exactTies} exact ties; trust ${d.trust}`,
    ...(d.kind === "card" ? [`- ${d.reasons.join("; ") || "no vetoes"}`] : [`- checkpoint ${d.checkpoint}`]),
    `- TTFC ×${d.latency.ttfc.est.toFixed(2)}, TTD ×${d.latency.ttd.est.toFixed(2)}; $${d.cost.listUsd.toFixed(2)}, ${d.cost.calls} calls, ${d.minutes} min; [run](runs/${d.run}.json)`,
  ];
  appendFileSync(f, `${existsSync(f) ? "" : "# Ledger\n\n"}${lines.join("\n")}\n\n`);
}

/** tried/<id>.patch: the card's commits as `git format-patch` (a knob card: its knobs), under a header with the card and verdict. */
export function triedPatch(d: DecisionRow, repo = paths().repo) {
  const body = d.candSha !== d.baseSha ? git(repo, "format-patch", "--stdout", `${d.baseSha}..${d.candSha}`) : `knobs: ${JSON.stringify(d.card?.knobs ?? {})}`;
  const head = [`rt-eval tried: ${d.id}`, `title: ${d.card?.change ?? ""}`, `component: ${d.card?.component ?? ""}`, `verdict: ${d.verdict}: ${d.reasons.join("; ")}`, `diff: ${sha256(body).slice(0, 12)}`, `card: ${JSON.stringify(d.card)}`];
  mkdirSync(at("tried"), { recursive: true });
  writeFileSync(at("tried", `${d.id}.patch`), `${head.join("\n")}\n---\n${body}\n`);
}

/** The critic's tried index, one line per patch: "<id> <title> | <component> | <diff hash> | <verdict>". */
export function triedIndex(): string[] {
  const dir = at("tried");
  return (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".patch")).sort() : []).map((f) => {
    const h = Object.fromEntries(readFileSync(join(dir, f), "utf8").split("\n---\n")[0].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
    return `${h["rt-eval tried"]} ${h.title} | ${h.component} | ${h.diff} | ${h.verdict.split(":")[0]}`;
  });
}

/** One open owner-list item (a markdown task), once. */
export function ownerItem(text: string) {
  const f = at("owner-list.md");
  const have = existsSync(f) ? readFileSync(f, "utf8") : "# Owner list\n\n";
  if (have.includes(`${text}\n`)) return;
  writeFileSync(f, `${have}- [ ] ${new Date().toISOString().slice(0, 10)}: ${text}\n`);
}

// ---- A card decision

/** A card decision's history row, from its run (runAB's result) and the diffscan's counts. */
export function decisionRow(o: {
  id: string; epoch: number; card: HypothesisCard; candSha: string; baseSha: string; run: string; judgeId: string;
  result: { rows: Row[]; heldout?: Row[]; continuation?: Row[]; decision?: Decision };
  /** affected tuning cases, of how many scanned, and how many top-ups ran */
  affected: DecisionRow["affected"];
}): DecisionRow {
  const d = o.result.decision;
  if (!d || d.verdict === "more") throw new Error(`${o.id}: run ${o.run} has no decision`);
  const z = (rows: Row[] | undefined, k: "s" | "sCraft") => {
    const r = (rows ?? []).filter((x) => !x.void && x[k] !== undefined).map((x) => ({ s: x[k]!, cluster: x.cluster }));
    return r.length ? clusteredZ(r).z : undefined;
  };
  const info = existsSync(runFile(o.run, "run.json")) ? json<RunInfo>(runFile(o.run, "run.json")) : undefined;
  // Over-use is read off the judged cases the card isn't for (§1.4 item 8).
  const target = (r: Row) => !!(o.card.targets?.asks?.includes(r.ask) || (r.beat && o.card.targets?.beats?.includes(r.beat)));
  const rest = o.result.rows.filter((r) => !r.void && !target(r));
  const rate = (i: 0 | 1) => (rest.length ? rest.filter((r) => r.overuse[i]).length / rest.length : 0);
  return {
    id: o.id, kind: "card", epoch: o.epoch, card: o.card, candSha: o.candSha, baseSha: o.baseSha, class: d.class, goal: d.goal, verdict: d.verdict,
    reasons: [...new Set([...d.reasons, ...d.vetoes])], trust: trustOf(d.verdict === "void", o.run), looks: d.looks,
    counts: { wins: d.counts.wins, losses: d.counts.losses, ties: d.counts.ties, exactTies: o.affected.of - o.affected.tuning }, affected: o.affected,
    heldOutZ: z(o.result.heldout?.filter((r) => r.affected), "s"), craftZ: z(o.result.rows, "sCraft"), continuationZ: z(o.result.continuation, "s"),
    ...(o.card.overuseDetector ? { overuse: { detector: o.card.overuseDetector, a: rate(0), b: rate(1) } } : {}),
    latency: { ttfc: d.latency.ttfc ?? ONE, ttd: d.latency.ttd ?? ONE, byThinking: d.latency.byThinking },
    work: d.work, emptyRise: d.emptyRise, failedPicRise: d.failedPicRise,
    cost: { usdPerCaseRatio: d.usdRatio, listUsd: info?.meter.listUsd ?? 0, calls: info?.meter.calls ?? 0 }, minutes: Math.round(info?.meter.minutes ?? 0),
    run: o.run, judgeId: o.judgeId, configId,
  };
}

/**
 * §5.2's trust colour: void as decided; amber for a tripped load gate. A laptop point is not amber: its quality is as good
 * as the PGX's, and the latency panel hollows laptop points itself (amber here left the laptop with no quality trend at all).
 */
export const trustOf = (voided: boolean, run: string, warn = false): DecisionRow["trust"] =>
  voided ? "void" : warn || existsSync(runFile(run, "load-gate.jsonl")) ? "amber" : "green";

/** A decision's whole record: decisions.jsonl, the ledger, a tried patch unless kept, owner items, runs/<run>.json, one commit. */
export function recordDecision(d: DecisionRow, o: { owner?: string[] } = {}) {
  historyAdd("decisions.jsonl", d);
  ledger(d);
  if (d.kind === "card" && d.verdict !== "keep") triedPatch(d);
  for (const t of o.owner ?? []) ownerItem(`${d.id}: ${t}`);
  saveRun(d.run);
  return commitHistory(`${d.id}: ${d.kind === "card" ? `${d.verdict} (${d.class}, ${d.goal}, ${d.card?.change})` : d.reasons[0]}`);
}

/** The amber bands of §5.2 (they colour points, never decide). */
export const AMBER = { flip: 0.2 } as const;
