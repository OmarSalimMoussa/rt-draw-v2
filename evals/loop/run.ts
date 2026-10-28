// The loop's CLI (spec §7.1, §7.7, §8.1, §11): a script, never an LLM session (v1's Opus
// coordinator re-read ~375k tokens a request, ~$72). Every step that can call a model goes through one gateway
// process under a hard --cap, so a loop or retry bug stops at the cap instead of burning a window (v1 burned two
// in a day). Tokens come only from the tokens file, read here (agents) and by the gateway, never from the
// environment: a systemd unit doesn't see the caller's variables.
//   node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts <command> [flags]      (`rte`, evals/RUNBOOK.md)
// Every command takes --cap n, --tokens <file> (checks; default ~/.config/rt-eval/tokens.env), --dev-token (the
// dev plugin's own token, only under --cap 60), --mock-api <url> (every Claude process on that fake API, checks),
// --port n (the first arm server's, default 5300) and --fakes <module> (checks: a canned critic, engineer, judge).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { apiCmd } from "./commands/api.ts";
import { calib, checkpointCmd, packetsCmd, syncCmd } from "./commands/checkpoint.ts";
import { noteCmd } from "./commands/note.ts";
import { intakeCmd } from "./commands/intake.ts";
import { aaCmd, bakeCmd, bankCmd, benchCmd, costCmd, exportTo, gc, humanCmd, init, ladderCmd, probeCmd, readyCmd, smoke, status } from "./commands/setup.ts";
import { shippedCmd } from "./commands/shipped.ts";
import { loop, stopAfterCmd, unitFailedCmd, wantedCmd, weekCmd } from "./coordinator.ts";
import { decideCmd } from "./decide.ts";
import { remetric } from "./remetric.ts";
import { Rte, js, msg, parse } from "./rte.ts";

const USAGE = `usage: rte <command> [--cap n] [--tokens f | --dev-token] …   (evals/RUNBOOK.md)
  init --from <repo> [--refresh]       ready [--stub] [--mock-api]         ladder --max n
  smoke --cap n                        bake --cap n                         bank build --tuning n --heldout-gate n --heldout-chart n --cap n
  probe --cap n | --accept               bank accept (a bank that failed §2.3, used anyway) | bank rerecord --cap n (replies on today's champion)
  aa --shared --cases n | --live --cap n   bench freeze                     human freeze
  intake [--regold]   (testers' new sends to cards for the owner's review, evals/real/README.md: rt-intake.timer runs it while the
       loop is stopped, the loop between its epochs; --regold redraws the gold of every card without a verdict)
  checkpoint [--zero] --cap n          calib --contrast k=v [--more n] --cap n | --check [--cap n] [--variant 2] | --fake-labels (a dry run)
       | --illustrations --contrast picture.k=v [--cases n] --cap n | --check --illustrations   (the judge on pictures: labels/illustrations/)
  sync --cap n                         export <host | /dir>                 decide <branch> [--goal latency --metric ttfd|render | --card <decision id>] [--owner-ok] --cap n
  loop [--epochs n] [--seed-cards f] [--quality-only] [--resume]   (on the PGX its unit runs it: rte run, rte stop-after)
  stop-after [--cancel]   (the running loop stops before its next step: nothing lost, loop --resume goes on)
  unit-failed | wanted [--set]   (the loop's unit: it gave up after its restarts; whether it should run, or now should)
  week --cap n            (reads again the weekly use of each token parked on an old reading, one one-word call each)
  status (each token's use too)        cost <run>… (calls and list $, sub-runs included)   remetric <run>   gc --trees
  packets <run>… (frames the changes a run's after captures missed, 0 calls)
  note [<thread> "<text>" [--resolve] | <thread> --resolve | new "<text>"]   (the owner's threads in Eval HQ: no thread lists
       those where they wrote last; a reply is Claude's, in $RT_EVAL_HOME/notes/threads.jsonl)
  api status | needs_you [--thread <id> --text "<words>" [--resolve]] | run | stop | intake_now   (JSON: Claude's tools, evals/ops/mcp.ts)
  shipped --sha <commit> --tag <image tag> [--champion <commit>] [--url <prod's address>]   (evals/ops/ship.sh's record of what's on prod)`;

/** Each command, given the command line (rte.ts' Rte): the commands are in commands/, decide.ts and coordinator.ts. */
const COMMANDS: Record<string, (rte: Rte) => Promise<number | void>> = {
  init, ready: readyCmd, ladder: ladderCmd, smoke, bake: bakeCmd, probe: probeCmd, bank: bankCmd, aa: aaCmd, bench: benchCmd, human: humanCmd, intake: intakeCmd,
  checkpoint: checkpointCmd, calib, sync: syncCmd, export: exportTo, decide: decideCmd, loop, "stop-after": stopAfterCmd, "unit-failed": unitFailedCmd, wanted: wantedCmd, week: weekCmd, status,
  remetric: async (rte) => void rte.say(`remetric: ${js(remetric(rte.o.pos[1]))}`), gc, packets: packetsCmd, cost: costCmd, note: noteCmd,
  api: apiCmd, shipped: shippedCmd,
};

if (import.meta.main) {
  process.stdout.on("error", () => {}); // a closed terminal must not end the run: logs/ has every line
  let rte = new Rte(parse([]));
  try {
    rte = new Rte(parse(process.argv.slice(2)));
    const run = COMMANDS[rte.o.cmd];
    if (!run) throw new Error(`no command "${rte.o.cmd}"\n${USAGE}`);
    if (typeof rte.o.f.fakes === "string") rte.fakes = await import(pathToFileURL(resolve(rte.o.f.fakes)).href);
    process.exitCode = (await run(rte)) ?? 0;
  } catch (err) {
    rte.say(`run.ts ${rte.o.cmd}: ${msg(err)}`);
    process.exitCode = 1;
  }
  // Pages, servers and Claude processes are closed; a stray timer must not hold the step open.
  setTimeout(() => process.exit(), 1000).unref();
}
