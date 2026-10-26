// Runs the harness checks one at a time (one Chrome at a time), each logged to $TMPDIR/rt-checks/<name>.log, and prints
// a line per check; a failing one's last lines follow. 0 real calls, as each check is.
//   npm run checks                 the fast ones (about 3 minutes)
//   npm run checks -- --slow       every one (about 20 minutes: t15 and t20 run real checkpoints, t21 the loop dry)
//   npm run checks -- t5 t13       the named ones
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SLOW = new Set(["t13-verdict", "t14-bank", "t15-ab", "t19-ready", "t20-history", "t21-loop-dry"]);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const named = args.filter((a) => !a.startsWith("--"));
const all = readdirSync(here).filter((f) => /^t\d+.*\.mjs$/.test(f)).map((f) => f.slice(0, -4)).sort((a, b) => Number(a.slice(1).split("-")[0]) - Number(b.slice(1).split("-")[0]));
const chosen = named.length ? all.filter((n) => named.some((x) => n === x || n.startsWith(`${x}-`))) : all.filter((n) => args.includes("--slow") || !SLOW.has(n));
const logs = join(tmpdir(), "rt-checks");
mkdirSync(logs, { recursive: true });
let failed = 0;
for (const n of chosen) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--import", "./evals/loop/node-hooks.mjs", join("evals", "checks", `${n}.mjs`)], { cwd: root, encoding: "utf8", timeout: 1_500_000, maxBuffer: 1 << 28 });
  const log = join(logs, `${n}.log`);
  writeFileSync(log, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${Math.round((Date.now() - t0) / 1000)}s${ok ? "" : ` (${log})`}`);
  if (!ok) console.log(readFileSync(log, "utf8").trim().split("\n").slice(-8).map((l) => `  ${l.slice(0, 400)}`).join("\n"));
}
console.log(`${chosen.length - failed} of ${chosen.length} passed${named.length || args.includes("--slow") ? "" : ` (fast; --slow adds ${[...SLOW].join(" ")})`}`);
process.exitCode = failed ? 1 : 0;
