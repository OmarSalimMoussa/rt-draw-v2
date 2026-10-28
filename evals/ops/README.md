# Operating the eval

The owner's page is `evals/RUNBOOK.md`. This one is the reference behind it: the scripts here, setting the eval up
from nothing, rehearsing it at 0 calls, the owner's commits, and where everything lives.

## The scripts

| Script | Runs on | Does |
|---|---|---|
| `units.sh` | the PGX, from the loop's clone | installs the loop's, Eval HQ's and intake's systemd user units, with lingering |
| `laptop-units.sh` | the laptop | `rt-pull-local.timer`: the dev server's sends to the PGX every 30 minutes |
| `deploy.sh` | the laptop | pushes this checkout's branch to the PGX and starts `pgx-deploy.sh` there |
| `pgx-deploy.sh` | the PGX, in the unit `rt-deploy` | waits for the loop's card, re-pins the harness, reinstalls the units, starts the loop again |
| `ship.sh` | the laptop | the champion into master and onto prod, on the owner's yes |
| `box-key.sh` | the laptop, once | a key that lets the PGX pull from the box and run nothing else |
| `history-remote.sh` | the laptop, once | a private remote for `eval/history`, pushed after every commit |
| `mcp.ts` | the laptop (`.mcp.json`) | Claude's five tools, the PGX's through `rte api` over ssh |

The laptop's machines are its own, not the repo's: `~/.config/rt-eval/hosts.env` sets `RT_PGX` (the PGX's ssh target),
`RTDRAW_BOX` (the box's), and `RT_PGX_EVAL_HOME` when the loop's home there isn't `~/rt-eval`.

## Setting it up from nothing

Every step with real calls has a hard `--cap n` (the gateway refuses call n+1). Costs are list-equivalent $ on the
subscription, against a five-hour window of ~$220; the numbers were measured on the first setup (2026-10-17) or are
estimates (±30%).

**Tokens.** One to three tokens (`claude setup-token` on each account), in a file outside every repo on the PGX:
`~/.config/rt-eval/tokens.env` with `RT_EVAL_TOKEN_1=…` (and `_2`, `_3`), mode 600. `run.ts` reads it itself, refuses
any other mode and never prints a token.

**The code on the PGX.** The laptop pushes to a bare repo there, the PGX's checkout follows it, and the loop's clone
follows the checkout:

```bash
ssh "$RT_PGX" 'git init --bare ~/git/rt-draw-v2.git'                              # once
git remote add pgx "$RT_PGX:git/rt-draw-v2.git" && git push pgx master             # on the laptop
ssh "$RT_PGX" 'git clone ~/git/rt-draw-v2.git ~/projects/rt-draw-v2 && cd ~/projects/rt-draw-v2 && npm ci'
```

**The PGX**, in `~/projects/rt-draw-v2`:

```bash
npm run checks
node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts init --from ~/projects/rt-draw-v2 && cd ~/rt-eval/repo
bash evals/ops/units.sh        # the units, and lingering so they outlive logouts and reboots
```

Then, from the laptop, once each:
- `bash evals/ops/box-key.sh`: the PGX pulls from the box by itself.
- `bash evals/ops/laptop-units.sh`: this laptop's sends to the PGX.
- `bash evals/ops/history-remote.sh <owner>/<private repo>`: the record on a private remote.

**Mail.** On the PGX, `~/.config/rt-eval/notify.env` (mode 600) holds `MAILER_URL`, `MAILER_SECRET` (the mailer's
`NOTICE_SECRET`, which sends notices to the owner only: `deploy/README.md`) and `HQ_URL`.

**The bank, the benchmark and the judge**, on the PGX in this order. `bin/rte job` runs each in a unit of its own and
returns at once, so start the next when `journalctl --user -fu <unit>` says the last one ended:

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

Step 3's re-pin: look at the doodles in `~/rt-eval/out/pictures.json`, commit only that file to master
(`evals/fixtures/pictures.json`), deploy, then `bin/rte ready --stub --mock-api`.

When a step stops:
- **A failed `probe`:** read `~/rt-eval/probe.json`, then fix the driver or run `rte probe --accept`.
- **A bank refused by §2.3:** build again with more sessions (only new ones run), or run `rte bank accept`.
- **A failed `calib --check`:** run `bin/rte job calib --check --variant 2 --cap 150` (~$1.1). If that fails too, the
  judge prompt is the owner's to change.

**The judge on pictures alone**, for a keep that switches the picture model (LOOP-V2 C3): with the loop stopped,
`bin/rte job calib --illustrations --contrast picture.model=0 --cap 600` (~48 cases with pictures), label at
`/evals/label/?set=illustrations` (30 clear fidelity + 15 craft, 12–15 min; only the pictures differ), then
`bin/rte calib --check --illustrations`. It sets `use.illustrations` alone. The first round (Sonnet against Haiku,
2026-10-26) came back `more` for good, so a rerun needs a contrast whose pictures differ more.

The ladder's 16 slots: every tab of an arm has a host of its own (`a0.localhost`, `b3.localhost`, …), since Chrome
opens at most 6 connections per host and the tabs' model streams would queue. On the idle PGX, 16 slots ran at ×1.00 of
one slot's send wall; 24 put the arms' Enter 35 ms apart, past V9's 25 ms.

## The rest of `rte`

`bin/rte` with no command lists every command. Beside the RUNBOOK's:
- `rte job <command> [flags]`: a long step in a unit of its own (`evals/loop/launch.sh`); `rte job stop` stops it.
- `rte api <tool>`: the MCP tools' PGX side, as JSON.
- `rte cost <run>…`: calls and list $ by role.
- `rte decide <branch> --cap n`: one branch through the funnel.
- `rte checkpoint --cap n`.
- `rte aa --live --cap n`: an A/A on today's champion.
- `rte human freeze`: U1 from the owner's recorded sends.
- `rte remetric <run>`.
- `rte gc --trees`.
- `rte sync --cap n`: the owner's master into the champion. The loop runs it itself between epochs, at most daily.
- `rte shipped --sha <commit> --tag <image tag> --url <prod>`: `ship.sh`'s record of a ship.

`python3 -I evals/tools/verify_decision.py ~/rt-eval/runs <run>…` recomputes a decision's numbers from its rows,
without the harness's code. `npm run checks [-- --slow]` runs the harness's checks at 0 real calls (fast ~5 min;
`--slow` adds real checkpoints and a dry loop).

## Rehearsing at 0 calls

The whole chain, small, on a fake API that answers every role (`evals/mock/dry.ts`: canned replies by system prompt,
v2's median call timings per role, three fake tokens). Run it from a new `RT_EVAL_HOME` outside any repo, never
`~/rt-eval`. It makes no real call (`HTTPS_PROXY` points at a closed port). The judge always ties, so verdicts come from
latency alone. Each step runs in the foreground, one after the other: `bin/rte job` would start each in a unit of its
own and, on a machine without a battery (the PGX), return at once.

```bash
export RT_EVAL_HOME=/tmp/rt-eval-dry      # new and empty
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }
rte init --from ~/projects/rt-draw-v2 && cd $RT_EVAL_HOME/repo
rte ready --stub --mock-api
node --import ./evals/loop/node-hooks.mjs evals/mock/dry.ts --port 5400 &   # READY http://127.0.0.1:5400
F="--tokens $RT_EVAL_HOME/dry/tokens.env --mock-api http://127.0.0.1:5400"
rte ladder --max 4 --latency $RT_EVAL_HOME/dry/latency.jsonl
rte smoke --cap 50 $F
rte bake --cap 36 $F
cp $RT_EVAL_HOME/out/pictures.json evals/fixtures/ && git commit -qm "dry: baked pictures" -- evals/fixtures/pictures.json   # in the clone only
rte init --refresh && rte ready --stub --mock-api
rte probe --cap 10 $F; rte probe --accept   # FAILS: one canned reply per message can't tell good from bad
rte bank build --tuning 8 --heldout-gate 2 --heldout-chart 2 --cap 450 $F   # REFUSED by the §2.3 gates: a 56-send bank is too small, as it should be
rte bank accept                             # used anyway, for the rehearsal only
rte aa --shared --cases 12
rte bench freeze --heldout 8 --tuning 8     # smaller than B1's 32 + 32, for the rehearsal only
rte checkpoint --zero --cap 200 $F
rte calib --contrast draw.model=0 --cap 200 $F
rte calib --fake-labels --mock-api http://127.0.0.1:5400; rte calib --check   # the judge's own verdicts as labels
rte loop --epochs 1 --seed-cards evals/optimizer/seed-cards.json $F
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

The loop runs it between epochs when master moved and the last owner step is a day old. A merge that fails stops the
loop (`blocked`) with an owner-list item: fix it on master, then `bin/rte sync --cap 750` and `bin/rte run`. Master
reaches the PGX with each deploy and ship.

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
| `stop.request` | the owner's stop, until the loop stops on it or `rte run` takes it back |
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

## The owner's dev server

- The draw playground's `?record=1` records the owner's sends (`POST /api/eval/record`, `evals/pages/record.ts`), the
  only eval endpoint the dev server has; `rt-pull-local.timer` takes them to the PGX.
- Model calls run with the 5-minute cache and an empty config dir (`.data/claude-config`), quiet and email-free.
- Voice keeps working there: only servers the harness starts set `RT_DENY_TTS=1` (`/api/tts` and `/api/stt-token`
  answer 403 on them).
- Plugins honour `RT_DATA_DIR` (default `<root>/.data`), so eval runs never write the owner's data.
