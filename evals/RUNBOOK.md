# Running the eval

How the loop is built and what it found is in `evals/README.md`; testers' sends are in `evals/real/README.md`; setting
it up, rehearsing it and where everything lives are in `evals/ops/README.md`. This page is what the owner decides, and
the few commands behind it.

## Where things run

| Machine | What runs there |
|---|---|
| **PGX** (always on, mains power) | Everything that runs or waits, as systemd user units (`evals/ops/units.sh`): the loop (`rt-loop`), Eval HQ (`rt-pages`, port 5181 on its Tailscale address), and intake's timer (`rt-intake.timer`): a live pull every 30 minutes, and intake itself while the loop is stopped. The loop's clone, `~/rt-eval/repo`, is pinned to a harness tag and follows the PGX's checkout of master. |
| **Laptop** | Pushes code (`evals/ops/deploy.sh`), ships (`evals/ops/ship.sh`), opens Eval HQ, and sends its dev server's sends to the PGX every 30 minutes (`rt-pull-local.timer`). |
| **Prod box** | Only pulled from (a key that can run nothing but the export, `evals/ops/box-key.sh`) and shipped to. |

## What the owner does

1. **Look at new cards.** Eval HQ's *Review* stage (or Needs you) opens the reviewer on the cards waiting, one at a
   time: approve (<kbd>A</kbd>, with any edits you made), or reject for a reason (<kbd>1</kbd>–<kbd>6</kbd>); the next
   card is up at once. A card you don't touch joins after 2 days: nothing waits on you.
2. **Answer what the loop holds for you.** Eval HQ's *Needs you* has the decisions held for your call, owner-list items
   and threads with Claude. When the loop stops for a reason that's yours, or holds a decision, you get a mail (codes and
   ids only, through imagine's mailer).
3. **Ship.** When the champion has keeps you want on prod, run `bash evals/ops/ship.sh` on the laptop. It merges the
   champion into master in a clean worktree, runs the product's checks and serves the app on port 5190 for you to try.
   On your yes it pushes master, deploys it and records the ship. Shipping is never a tool.

Everything else runs by itself. The loop pauses at 90% of the five-hour window (testers share the token) and at 70%
of the week, until the week reads under that again. A crash restarts the loop's unit, at most 3 times in 6 hours; then
it stays down and mails you.

## When the loop stops for you

It stops for good only on a rule that needs you, and Needs you and the mail say which (`state.json`'s stop code):

| Code | What happened | Once it's dealt with |
|---|---|---|
| `voids` | two decisions in a row came back void: the harness is suspect | `bin/rte run` |
| `v9`, `ready`, `calib` | an invariant tripped, or readiness or the judge's calibration failed | `bin/rte run` (readiness runs first) |
| `blocked` | merging your master into the champion failed (a conflict, a type error, a lockfile): the owner list says what | fix it on master, then `bin/rte sync --cap 750` and `bin/rte run` |
| `empty` | epochs in a row decided nothing | `bin/rte run`, with seed cards if the search is dry |
| `aborted` | something asked for a request the harness never makes: the log has which | `bin/rte run` |
| `cap` | a step's `--cap` was reached (the unit's loop runs without one) | `bin/rte run` |
| `gave-up` | the unit failed past its restarts | read `journalctl --user -u rt-loop`, then `bin/rte run` |

`bin/rte stop-after` (or the `stop` tool) is a stop of yours: it holds across a reboot until `bin/rte run`.

## Eval HQ

http://thinkstationpgx-0eea:5181/, over Tailscale. It opens on the pipeline at a glance: the last pull, intake, the
cards waiting for you, the bank, the loop, the champion's keeps not on prod and prod's health. Its views:
- **Needs you:** what waits for you.
- **Intake and review:** testers' sends as cards.
- **Loop:** decisions, with their cases and calls.
- **Benchmarks:** B1, U1 and R1 over checkpoints.
- **Judge:** the calibration labeling, at `/evals/label/`.
- **Playgrounds:** what each product playground is for; they open on the laptop's dev server.

Testers' cards and images are served only there, on the PGX.

## Claude's tools

`.mcp.json` registers `rt-eval`, an MCP server the laptop runs (`evals/ops/mcp.ts`), so any Claude session in this
repo can run the pipeline:

| Tool | Does |
|---|---|
| `status` | the loop, the lock, the champion, prod, the pulls, intake's cards by state, the bank, each token's use |
| `needs_you` | what waits for you, and answers a thread as Claude |
| `run`, `stop` | starts the loop's unit; asks it to stop after the step in flight |
| `intake_now` | a pull and intake now (while the loop runs, it does this between epochs) |
| `deploy` | `evals/ops/deploy.sh`: this checkout's branch to the PGX |

They return ids, counts and the harness's own words, never what a tester said or drew. Each call passes Claude Code's
permission prompt.

## Commands

On the PGX, from `~/rt-eval/repo` (a plain ssh has no node on its PATH: `set -a; . ~/rt-eval/rt-units.env; set +a`):

```bash
bin/rte status                 # the loop, the lock, the unit, intake, each token's five-hour and weekly use
bin/rte run                    # starts the loop's unit: readiness at 0 calls, then loop --resume
bin/rte stop-after             # the loop stops before its next step; nothing in flight is lost
journalctl --user -fu rt-loop  # what it's doing; every line is also in ~/rt-eval/logs/run-<date>.log
bin/rte intake [--regold]      # a pass of intake now (while the loop runs, --regold waits for the loop's next intake)
bin/rte note                   # the threads waiting for Claude's reply; rte note <thread> "<text>" [--resolve] answers
```

From the laptop:

```bash
bash evals/ops/deploy.sh       # the harness to the PGX: push, then the loop finishes its card, is re-pinned and resumes
bash evals/ops/ship.sh         # the champion to prod, on your yes
```

The rest of `rte` (`bin/rte` with no command lists it) is in `evals/ops/README.md`.
