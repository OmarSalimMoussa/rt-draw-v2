// What every acceptance check shares. A check prints PASS or FAIL <why> and
// never reaches a real model, a real token or the owner's data: it works in a
// temp RT_EVAL_HOME, hands children an env with no tokens, and talks to local
// URLs only.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo (or worktree) the check runs from. */
export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const failures = [];
/** Notes a failure and keeps going, so one run reports every broken property. */
export function check(ok, why) {
  if (!ok) failures.push(why);
  return !!ok;
}
/** Stops the check now: FAIL with this reason and any noted before it. */
export function fail(why) {
  console.log(`FAIL ${[...failures, why].join("; ")}`);
  process.exit(1);
}
/** Ends the check: PASS when nothing failed. */
export function finish() {
  console.log(failures.length ? `FAIL ${failures.join("; ")}` : "PASS");
  process.exit(failures.length ? 1 : 0);
}
// A crash is a FAIL with its message, never a bare stack.
process.on("uncaughtException", (err) => fail(`crashed: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => fail(`crashed: ${err?.stack ?? err}`));

/**
 * A fresh RT_EVAL_HOME (with RT_DATA_DIR = <home>/data) under the system temp dir
 * (TMPDIR), set in process.env so paths() and children see it. Nothing is ever deleted.
 */
export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "rt-eval-check-"));
  process.env.RT_EVAL_HOME = home;
  process.env.RT_DATA_DIR = join(home, "data");
  mkdirSync(process.env.RT_DATA_DIR);
  return home;
}

// Tokens, keys and the Claude session this check may run inside: a child that saw
// them could make a real call, or think it's inside a Claude Code session.
const SECRET = /^(RT_EVAL_TOKEN_|CLAUDE_CODE_|ANTHROPIC_|ELEVENLABS_|OPENROUTER_|TYPESAFE_|CLAUDECODE|CLAUDE_EFFORT|CLAUDE_PID)/;
/** process.env without tokens, keys or Claude session variables, plus `extra`: the env for every child a check starts. */
export function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET.test(k))), ...extra };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Throws unless the URL stays on this machine (http(s) to a loopback host, or data:/blob:/about:). */
export function assertLocalOnly(url) {
  const u = new URL(url);
  if (["data:", "blob:", "about:"].includes(u.protocol)) return url;
  if (!["http:", "https:", "ws:"].includes(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) throw new Error(`not a local URL: ${url}`);
  return url;
}

/** Counts by key, for interceptions: tally.add("stubbed"), tally.get("seen"), tally.all. */
export function tally() {
  const all = {};
  return { all, add: (key, n = 1) => (all[key] = (all[key] ?? 0) + n), get: (key) => all[key] ?? 0 };
}
