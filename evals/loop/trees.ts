// The code each arm serves, and the worktrees engineers edit (spec §7.2, fixes F11, F22).
// A tree is a commit's files (git archive) with the pinned harness's evals/ laid over
// them, so both arms measure with the same bridge and clock whatever the candidate
// changed, plus the harness clone's node_modules as hard links (~0.1 s; v1 copied
// 676 MB per tree). Trees are keyed by what the product is made of, not by sha, so a
// commit that only moved evals/ or dev/ reuses its parent's tree, and by the harness's
// evals/, so a re-pin (init --refresh, e.g. after the fixture bake) never serves an old one.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "./paths.ts";

/** What an arm serves: the tree key hashes exactly these paths (never evals/, which every tree takes from the harness). */
export const PRODUCT_PATHS = ["src", "playgrounds", "index.html", "package.json", "package-lock.json", "tsconfig.json"];

/** A candidate whose lockfile isn't the harness clone's: its node_modules can't be shared, so it goes to the owner list. */
export class LockfileDiffers extends Error {}

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const harness = new Map<string, string>();
/** sha256 of the product's files at a commit, read from git's own blob ids (no checkout), and of the harness's evals/ (once a process). */
export function contentHash(sha: string, repo = paths().repo): string {
  if (!harness.has(repo)) harness.set(repo, evalsHash(repo));
  return createHash("sha256").update(git(repo, "ls-tree", "-r", sha, "--", ...PRODUCT_PATHS)).update(harness.get(repo)!).digest("hex");
}

/** $RT_EVAL_HOME/trees/<contentHash> for a commit (or branch), built once: the commit without its evals/, the harness's evals/, linked node_modules. */
export function treeOf(sha: string): string {
  const p = paths();
  const commit = git(p.repo, "rev-parse", "--verify", `${sha}^{commit}`);
  if (git(p.repo, "rev-parse", `${commit}:package-lock.json`) !== git(p.repo, "hash-object", "package-lock.json"))
    throw new LockfileDiffers(`${sha}: package-lock.json differs from the harness clone's (owner list: dependencies change only by the owner)`);
  const dir = p.tree(contentHash(commit, p.repo));
  if (existsSync(dir)) return dir; // complete: it only ever appears by the rename below
  const tmp = `${dir}.tmp-${process.pid}`;
  mkdirSync(tmp, { recursive: true });
  execFileSync("sh", ["-c", 'git -C "$1" archive "$2" ":(exclude)evals" | tar -x -C "$3"', "sh", p.repo, commit, tmp]);
  execFileSync("cp", ["-a", join(p.repo, "evals"), join(tmp, "evals")]);
  execFileSync("cp", ["-al", join(p.repo, "node_modules"), join(tmp, "node_modules")]);
  renameSync(tmp, dir);
  return dir;
}

/**
 * $RT_EVAL_HOME/wt/<branch>: a git worktree of the harness clone on `branch` (created off `base` when it
 * doesn't exist yet), with node_modules hard-linked so ./node_modules/.bin/tsc runs there. Without a local
 * TypeScript, `npx tsc` would fetch the unrelated npm package "tsc".
 */
export function worktreeOf(branch: string, base = "loop/champion"): string {
  const p = paths();
  const dir = p.worktree(branch);
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    let exists = true;
    try {
      git(p.repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      exists = false;
    }
    git(p.repo, "worktree", "add", "--quiet", ...(exists ? [dir, branch] : ["-b", branch, dir, base]));
  }
  if (!existsSync(join(dir, "node_modules"))) execFileSync("cp", ["-al", join(p.repo, "node_modules"), join(dir, "node_modules")]);
  return dir;
}

/** sha256 over every file under <dir>/evals (paths and bytes): R1 compares each tree's with the harness's. */
export function evalsHash(dir: string): string {
  const root = join(dir, "evals");
  const h = createHash("sha256");
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  for (const rel of files.map((e) => join(e.parentPath, e.name).slice(root.length + 1)).sort()) h.update(`${rel}\0`).update(readFileSync(join(root, rel))).update("\0");
  return h.digest("hex");
}
