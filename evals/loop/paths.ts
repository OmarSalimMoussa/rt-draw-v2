// Where the loop keeps everything: $RT_EVAL_HOME (default ~/rt-eval), laid out as
// spec §3.1. Never inside a repo or ~/projects: run files in a work tree get swept
// into commits, and a v1 harness once wiped real telemetry next to the code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const checked = new Set<string>();

/** The data dir, refused (thrown) when it's inside ~/projects or any git work tree. */
export function evalHome(home = process.env.RT_EVAL_HOME || join(homedir(), "rt-eval")): string {
  home = resolve(home);
  if (checked.has(home)) return home;
  const projects = join(homedir(), "projects");
  if (home === projects || home.startsWith(projects + sep)) throw new Error(`RT_EVAL_HOME ${home} is inside ~/projects: use a folder outside any repo (default ~/rt-eval)`);
  // It may not exist yet: ask git about the nearest folder that does.
  let dir = home;
  while (!existsSync(dir)) dir = dirname(dir);
  if (insideWorkTree(dir)) throw new Error(`RT_EVAL_HOME ${home} is inside a git work tree: use a folder outside any repo (default ~/rt-eval)`);
  checked.add(home);
  return home;
}

function insideWorkTree(dir: string): boolean {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false; // not a repo (git exits non-zero)
  }
}

/**
 * A run on testers' real sends (R1 beside keeps and checkpoints, its baseline, triage, gold): its files, and the
 * gateway's records of its calls and images, stay under real/ (LOOP-V2.md A5): never runs/ or cache/, which the pages
 * server shows and `rte export` copies to another machine. Every such run's name starts "real-" (its warm-up's too:
 * `<run>~warm`), and no other run's does.
 */
export const isRealRun = (id: string) => id.startsWith("real-");

/** Every path of §3.1 (the home checked as in evalHome). Folders the loop fills by id are functions of the id. */
export function paths(home?: string) {
  const root = evalHome(home);
  const at = (...p: string[]) => join(root, ...p);
  return {
    home: root,
    /** The loop's own clone; its working tree is the pinned harness. */
    repo: at("repo"),
    /** Engineer worktrees, e.g. worktree("cand/e12-h2"). */
    worktree: (branch: string) => at("wt", branch),
    /** Served arm trees by content hash. */
    tree: (contentHash: string) => at("trees", contentHash),
    /** Worktree of branch eval/history: the only git-tracked output. */
    history: at("history"),
    bankCases: at("bank", "cases"),
    bankCase: (id: string) => at("bank", "cases", id),
    bankArchive: at("bank", "archive"),
    /** A first-timer's half-built page, or a held-out site start. */
    resume: (target: string) => at("bank", "resume", `${target}.json`),
    run: (id: string) => (isRealRun(id) ? at("real", "runs", id) : at("runs", id)),
    /** A reply and an image in the cache; a real run's under real/cache. */
    reply: (sha: string, real = false) => (real ? at("real", "cache", "replies", `${sha}.json`) : at("cache", "replies", `${sha}.json`)),
    blob: (sha: string, real = false) => (real ? at("real", "cache", "blobs", `${sha}.jpg`) : at("cache", "blobs", `${sha}.jpg`)),
    /** Testers' data and everything made from it (evals/real/README.md). */
    real: at("real"),
    /** The champion-miss digest for a champion sha. */
    digest: (championSha: string) => at("digests", `${championSha}.md`),
    calls: at("meter", "calls.jsonl"),
    labels: at("labels", "labels.jsonl"),
    human: at("human"),
    /** RT_DATA_DIR for any product plugin the harness starts. */
    data: at("data"),
    /** The empty CLAUDE_CONFIG_DIR for every Claude process the harness starts. */
    claudeConfig: at("claude-config"),
    out: at("out"),
    logs: at("logs"),
    state: at("state.json"),
    lock: at("loop.lock"),
    heartbeat: at("heartbeat.json"),
    machine: at("machine.json"),
  };
}

export type Paths = ReturnType<typeof paths>;

/** The owner's checkout: the one `rte init --from` cloned (init.json), else the current folder. */
export function ownerCheckout(): string {
  const f = join(evalHome(), "init.json");
  return (existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as { from?: string }).from) || process.cwd();
}
