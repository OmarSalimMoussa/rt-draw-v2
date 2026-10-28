# Running the eval

How the loop is built and what it found is in `evals/README.md`; testers' sends are in `evals/real/README.md`. This
page is what the owner does, and the commands behind it.

## Where things run

| Machine | What runs there |
|---|---|
| **PGX** (always on, mains power) | Everything that runs or waits, as systemd user units (`evals/ops/units.sh`): the loop (`rt-loop`), Eval HQ (`rt-pages`, port 5181 on its Tailscale address), and intake with its live pull every 30 minutes while the loop is stopped (`rt-intake.timer`). The loop's clone, `~/rt-eval/repo`, is pinned to a harness tag and follows the PGX's checkout of master. |
| **Laptop** | Pushes code (`evals/ops/deploy.sh`), ships (`evals/ops/ship.sh`), opens Eval HQ, and sends its dev server's sends to the PGX every 30 minutes (`rt-pull-local.timer`). |
| **Prod box** | Only pulled from (a key that can run nothing but the export, `evals/ops/box-key.sh`) and shipped to. |

## What the owner does

1. **Look at new cards.** In Eval HQ, open *Intake and review*. Approve (<kbd>A</kbd>), edit then approve (<kbd>E</kbd>),
   or reject with a reason (<kbd>R</kbd>). A card you don't touch joins after 2 days: nothing waits on you.
2. **Answer what the loop holds for you.** Eval HQ's *Needs you* has the decisions held for your call, owner-list items
   and threads with Claude. When the loop stops for a reason that's yours, or holds a decision, you get a mail (codes and
   ids only, through imagine's mailer).
3. **Ship.** When the champion has keeps you want on prod, run `bash evals/ops/ship.sh` on the laptop. It merges the
   champion into master in a clean worktree, runs the product's checks and serves the app on port 5190 for you to try.
   On your yes it pushes master, deploys it and records the ship. Shipping is never a tool.

Everything else runs by itself. The loop pauses at 90% of the five-hour window (testers share the token) and at 70%
of the week, until the week reads under that again. It stops for good only on a rule that needs you (two voids in a
row, a V9 invariant, readiness or calibration failing, a sync conflict, epochs that decide nothing), and Needs you says
which. A crash restarts the loop's unit, at most 3 times in 6 hours; then it stays down and mails you.

## Eval HQ

http://thinkstationpgx-0eea:5181/evals/progress/, over Tailscale. It opens on the pipeline at a glance: the last pull,
intake, the cards waiting for you, the bank, the loop, the champion and prod. Its views:
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
bin/rte intake [--regold]      # a pass of intake now (rt-intake.timer runs it every 30 minutes while the loop is stopped)
bin/rte note                   # the threads waiting for Claude's reply; rte note <thread> "<text>" [--resolve] answers
bin/rte job <command> [flags]  # a long step in a unit of its own (evals/loop/launch.sh); bin/rte job stop stops it
bin/rte api <tool>             # the MCP tools' PGX side, as JSON
```

From the laptop:

```bash
bash evals/ops/deploy.sh       # the harness to the PGX: push, then the loop finishes its card, is re-pinned and resumes
bash evals/ops/ship.sh         # the champion to prod, on your yes
npm run checks [-- --slow]     # the harness's checks, 0 real calls (fast ~5 min; --slow adds real checkpoints and a dry loop)
```

The rest of `rte` (`bin/rte` with no command lists it):
- `rte cost <run>…`: calls and list $ by role.
- `rte decide <branch> --cap n`: one branch through the funnel.
- `rte checkpoint --cap n`.
- `rte aa --live --cap n`: an A/A on today's champion.
- `rte human freeze`: U1 from the owner's recorded sends.
- `rte remetric <run>`.
- `rte gc --trees`.
- `rte sync --cap n`: the owner's master into the champion. The loop runs it itself between epochs, at most daily.

`python3 -I evals/tools/verify_decision.py ~/rt-eval/runs <run>…` recomputes a decision's numbers from its rows,
without the harness's code.

## Setting it up from nothing

Every step with real calls has a hard `--cap n` (the gateway refuses call n+1). Costs are list-equivalent $ on the
subscription, against a five-hour window of ~$220; the numbers were measured on the first setup (2026-10-17) or are
estimates (±30%).

**Tokens.** One to three tokens (`claude setup-token` on each account), in a file outside every repo on the PGX:
`~/.config/rt-eval/tokens.env` with `RT_EVAL_TOKEN_1=…` (and `_2`, `_3`), mode 600. `run.ts` reads it itself, refuses
any other mode and never prints a token.

**The laptop's hosts.** `~/.config/rt-eval/hosts.env`: `RT_PGX` (the PGX's ssh target) and `RTDRAW_BOX` (the box's).

**The PGX:**

```bash
git clone <this repo> ~/projects/rt-draw-v2 && cd ~/projects/rt-draw-v2 && npm ci
npm run checks
node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts init --from ~/projects/rt-draw-v2 && cd ~/rt-eval/repo
bash evals/ops/units.sh        # the units, and lingering so they outlive logouts and reboots
```

Then, from the laptop, once each:
- `bash evals/ops/box-key.sh`: the PGX pulls from the box by itself.
- `bash evals/ops/laptop-units.sh`: this laptop's sends to the PGX.
- `bash evals/ops/history-remote.sh <owner>/<private repo>`: the record on a private remote, pushed after every commit.

**Mail.** On the PGX, `~/.config/rt-eval/notify.env` (mode 600) holds `MAILER_URL` and `MAILER_SECRET` (the box's, from
`/srv/emberhub.env`) and `HQ_URL`. The mailer needs its `notice` action (`deploy/README.md`).

**The bank, the benchmark and the judge**, on the PGX in this order (`bin/rte job` runs each in a unit of its own):

| # | Command | Cap | Expect |
|---|---|---:|---|
| 1 | `bin/rte ready --stub --mock-api && bin/rte job ladder --max 16` | 0 | `ladder: 16 case slots`, ~8 min |
| 2 | `bin/rte job smoke --cap 50` | 50 | `smoke: ok, ~36 calls`, $0.2, 2 min |
| 3 | `bin/rte job bake --cap 36` | 36 | ~31 picture calls, $0.1–0.3; then the re-pin below |
| 4 | `bin/rte job probe --cap 10` | 10 | 8 driver calls, $0.1 |
| 5 | `bin/rte job bank build --tuning 32 --heldout-gate 8 --heldout-chart 8 --cap 1900` | 1,900 | ~1,520 calls, ~$11.7, ~10 min at 16 slots |
| 6 | `bin/rte aa --shared --cases 16 && bin/rte bench freeze` | 0 | `aa: ok … ×1.00` |
| 7 | `bin/rte job checkpoint --zero --cap 750` | 750 | ~600 calls, ~$5.1 |
| 8 | `bin/rte job calib --contrast draw.model=0 --cap 200`, label in Eval HQ's Judge view (60 clear fidelity + 30 craft), then `bin/rte calib --check` | 200 | ~160 calls, ~$1.6, and 25–30 min of labeling |
| 9 | `bin/rte run` | none | per decision ~$5, ~20 min |

**The judge on pictures alone**, for a keep that switches the picture model (LOOP-V2 C3): with the loop stopped,
`bin/rte job calib --illustrations --contrast picture.model=0 --cap 600` (~48 cases with pictures), label at
`/evals/label/?set=illustrations` (30 clear fidelity + 15 craft, 12–15 min; only the pictures differ), then
`bin/rte calib --check --illustrations`. It sets `use.illustrations` alone. The first round (Sonnet against Haiku,
2026-10-26) came back `more` for good, so a rerun needs a contrast whose pictures differ more.

Step 3's re-pin: look at the doodles in `~/rt-eval/out/pictures.json`, commit only that file to master
(`evals/fixtures/pictures.json`), deploy, then `bin/rte ready --stub --mock-api`.

When a step stops:
- **A failed `probe`:** read `~/rt-eval/probe.json`, then fix the driver or run `rte probe --accept`.
- **A bank refused by §2.3:** build again with more sessions (only new ones run), or run `rte bank accept`.
- **A failed `calib --check`:** run `bin/rte job calib --check --variant 2 --cap 150` (~$1.1). If that fails too, the
  judge prompt is the owner's to change.

The ladder's 16 slots: every tab of an arm has a host of its own (`a0.localhost`, `b3.localhost`, …), since Chrome
opens at most 6 connections per host and the tabs' model streams would queue. On the idle PGX, 16 slots ran at ×1.00 of
one slot's send wall; 24 put the arms' Enter 35 ms apart, past V9's 25 ms.

## Rehearsing at 0 calls

The whole chain, small, on a fake API that answers every role (`evals/mock/dry.ts`: canned replies by system prompt,
v2's median call timings per role, three fake tokens). Run it from a new `RT_EVAL_HOME` outside any repo, never
`~/rt-eval`. It makes no real call (`HTTPS_PROXY` points at a closed port). The judge always ties, so verdicts come from
latency alone.

```bash
export RT_EVAL_HOME=/tmp/rt-eval-dry      # new and empty
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }
rte init --from ~/projects/rt-draw-v2 && cd $RT_EVAL_HOME/repo
rte ready --stub --mock-api
node --import ./evals/loop/node-hooks.mjs evals/mock/dry.ts --port 5400 &   # READY http://127.0.0.1:5400
F="--tokens $RT_EVAL_HOME/dry/tokens.env --mock-api http://127.0.0.1:5400"
bin/rte job ladder --max 4 --latency $RT_EVAL_HOME/dry/latency.jsonl
bin/rte job smoke --cap 50 $F
bin/rte job bake --cap 36 $F
cp $RT_EVAL_HOME/out/pictures.json evals/fixtures/ && git commit -qm "dry: baked pictures" -- evals/fixtures/pictures.json   # in the clone only
rte init --refresh && rte ready --stub --mock-api
bin/rte job probe --cap 10 $F; rte probe --accept   # FAILS: one canned reply per message can't tell good from bad
bin/rte job bank build --tuning 8 --heldout-gate 2 --heldout-chart 2 --cap 450 $F   # REFUSED by the §2.3 gates: a 56-send bank is too small, as it should be
rte bank accept                                    # used anyway, for the rehearsal only
rte aa --shared --cases 12
rte bench freeze --heldout 8 --tuning 8            # smaller than B1's 32 + 32, for the rehearsal only
bin/rte job checkpoint --zero --cap 200 $F
bin/rte job calib --contrast draw.model=0 --cap 200 $F
rte calib --fake-labels --mock-api http://127.0.0.1:5400; rte calib --check   # the judge's own verdicts as labels
bin/rte job loop --epochs 1 --seed-cards evals/optimizer/seed-cards.json $F
```

Then `./node_modules/.bin/vite --config evals/pages.vite.config.ts --port 5181` shows the rehearsal's history in Eval
HQ. The fake API's `GET /_log` lists every request it answered, with its role. `t21-loop-dry` runs a smaller version of
this as a check.

## The owner's commits, and moving machines

`rte sync` merges master into `loop/champion` as an owner step:
- G0's build checks.
- Every banked before-scene through the merged `Scene.fromJSON`. Failing cases are refused; past 10%, a bank refresh
  is queued.
- A checkpoint.

The loop runs it between epochs when master moved and the last owner step is a day old. A merge conflict pauses the loop
with an owner-list item: resolve it on master, then `rte sync`. Master reaches the PGX with each deploy and ship.

Moving to another machine: `rte export <host>` (bank/, cache/replies/, cache/blobs/, labels/, human/, and eval/history
as eval/history-import), then `rte init --refresh` there. Testers' data (`real/`) moves only by hand, and only to a
machine as private as this one.

## Where everything lives (`$RT_EVAL_HOME`, default `~/rt-eval`)

| Path | What |
|---|---|
| `repo/` | the loop's clone of master; `loop/champion`, `cand/e<E>-h<n>` branches, tags `eval-harness-<n>` |
| `history/` | worktree of the orphan `eval/history`: decisions, checkpoints, epochs, budget, health, ledger, owner list, tried patches, ships, bench/ |
| `bank/cases/` | the driver's fork points (`c-<bank>-s<session>-<n>`); `bank/archive/` a refused refresh's cases |
| `real/` | testers' sends and everything made from them, mode 700 (`evals/real/README.md`) |
| `runs/<run>/` | every run's cases, rows and verdict; run ids `<stamp>-e<E>-h<n>-{g0,scan,ab}` |
| `cache/replies/`, `cache/blobs/` | model replies by request hash, and images |
| `meter/calls.jsonl`, `meter/slots.json` | one line per model call (slot numbers only), and each slot's window and week |
| `wt/`, `trees/`, `trees-old/` | engineer worktrees; served arm trees by content hash; an old harness's trees until `gc --trees` |
| `state.json`, `loop.lock`, `heartbeat.json` | the loop's cursor and status, one command with arm servers at a time (named in the lock), suspend detection |
| `logs/` | every `run.ts` line (`run-<date>.log`), and the arm servers' |
| `machine.json`, `ready/`, `labels/`, `human/`, `out/` | the ladder's slots, readiness runs, calibration labels, the owner's recorded sends, baked pictures |
| `notes/threads.jsonl` | the owner's and Claude's threads beside Needs you, append-only, outside git |
| `rt-units.env` | the units' PATH and home (no secrets) |

Code:
- `evals/loop/`: the CLI, gateway, runner and history.
- `evals/judge/`: the judge.
- `evals/optimizer/`: agents, digests and G0.
- `evals/core/`: the driver, synthesizer and personas.
- `evals/real/`: intake.
- `evals/progress/`, `evals/review/`, `evals/label/`: Eval HQ's pages, with their endpoints in `evals/pages/`.
- `evals/ops/`: the units, deploy, ship and the tools.
- `evals/checks/`: one acceptance check per task, 0 real calls.

## The eval on the owner's dev server

- The draw playground's `?record=1` records the owner's sends (`POST /api/eval/record`, `evals/pages/record.ts`), the
  only eval endpoint the dev server has.
- Model calls run with the 5-minute cache and an empty config dir (`.data/claude-config`), quiet and email-free.
- Voice keeps working there: only servers the harness starts set `RT_DENY_TTS=1` (`/api/tts` and `/api/stt-token`
  answer 403 on them).
- Plugins honour `RT_DATA_DIR` (default `<root>/.data`), so eval runs never write the owner's data.
