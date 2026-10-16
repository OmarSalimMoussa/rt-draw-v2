# The eval loop

An unattended loop that makes rt-draw better at what the owner wants: the highest fidelity at the lowest latency. Each
epoch an analyst and a critic propose up to 3 changes (knob values, prompt variants, code in `src/core/`), each one is
measured against the champion on banked sends, and a change that wins is kept on `loop/champion`. The owner merges the
champion into his master when he chooses. The spec is `evalprep/work/spec/SPEC.md`; §11 is the first-run plan below.

## Why it's built this way: v1 cost too much

- v1 worked (126–13–11 over 150 pairs, speech end → change 4.0 → 1.5 s), but each decision took ~2 h and 25–33% of a
  five-hour window, and both accounts' windows were gone in one day.
- Its coordinator was an Opus session that re-read ~375k tokens a request; here it's a script (`loop/run.ts`).
- Every Claude process wrote the 1-hour cache (half its use); here every call is 5-minute cached and metered.
- It re-ran whole sessions for every change; here forks are banked once and only the cases a change affects are paid.
- No step makes a real call without `--cap n`: the gateway refuses call n+1, so a bug stops at the cap.

## Running it

From the loop's clone (`~/rt-eval/repo`) or the owner's checkout:

```bash
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }   # direct runs
bash evals/loop/launch.sh <command> [flags]   # supervised: a systemd unit holding the sleep inhibitor (laptop), tmux window `loop` (PGX)
bash evals/loop/launch.sh stop
```

Tokens: `~/.config/rt-eval/tokens.env` (chmod 600, outside every repo) with `RT_EVAL_TOKEN_1..3=…`, three loop
accounts. `run.ts` reads it itself and never prints a token; one or two tokens work (a warning; the smoke skips U2).
`--dev-token` uses the dev plugin's own token from `~/projects/rt-draw-v2/.env`, only with `--cap 60` or less.

| Step (§11) | Command | Calls |
|---|---|---|
| all checks | `for c in evals/checks/t*.mjs; do node --import ./evals/loop/node-hooks.mjs "$c" \|\| break; done` | 0 |
| clone, tag, champion, history | `rte init --from ~/projects/rt-draw-v2` (then `cd ~/rt-eval/repo`) | 0 |
| readiness | `rte ready --stub --mock-api` | 0 |
| concurrency knee | `bash evals/loop/launch.sh ladder --max 4` (`--max 12` on the PGX) | 0 |
| smoke | `bash evals/loop/launch.sh smoke --cap 50` (§11's 40 is what a full smoke makes: 39–41 in the rehearsal) | ≤ 50 |
| fixture doodles | `bash evals/loop/launch.sh bake --cap 36`, review, commit only `evals/fixtures/pictures.json` on master, `rte init --refresh && rte ready --stub --mock-api` (a new harness tag needs its own readiness before the loop) | ≤ 36 |
| bank | `bash evals/loop/launch.sh bank build --tuning 32 --heldout-gate 8 --heldout-chart 8 --cap 1900` | ~1,520 |
| shared A/A, yardstick | `rte aa --shared --cases 16`, `rte bench freeze` | 0 |
| checkpoint 0 | `bash evals/loop/launch.sh checkpoint --zero --cap 750` | ~600 |
| calibration | `bash evals/loop/launch.sh calib --contrast draw.model=0 --cap 200`, label at `/evals/label/`, `rte calib --check` (else `calib --check --variant 2 --cap 150`) | ~200 |
| first epochs, watched | `bash evals/loop/launch.sh loop --epochs 3 --seed-cards evals/optimizer/seed-cards.json` (`--quality-only` on the laptop) | per epoch |
| nights | `bash evals/loop/launch.sh loop --night-windows 0.5` the first night, then without the flag (1.2) | night cap |

Also: `rte status` (slots, cap, cwd, node, launched, inhibitor), `rte decide <branch> --cap n` (one branch through the
funnel), `rte checkpoint --cap n`, `rte human freeze` (U1 from the owner's recorded sends), `rte remetric <run>`,
`rte gc --trees`, `rte loop --resume` (a stale lock resumes by itself).

A loop stops on §6.7's rules (night cap, weekly allowance, 2 voids in a row, a V9 invariant, readiness, calibration, a
sync conflict, a blocked request), pauses on others (all slots past 0.90 until the earliest reset, overloads, disk,
battery) and writes each to the owner list. Mornings: `/evals/progress/`, `owner-list.md`, `budget.jsonl`.

## Rehearsing at 0 calls

The whole chain, small, on a fake API that answers every role (`evals/mock/dry.ts`: canned replies by system prompt and
prompt, v2's median call timings per role, the resolver's thinking-off pilot, three fake tokens). Run from a new
`RT_EVAL_HOME` outside any repo, never `~/rt-eval`; it takes about an hour on the laptop and makes no real call
(`HTTPS_PROXY` points at a closed port). The judge always ties, so verdicts come from latency alone.

```bash
export RT_EVAL_HOME=/tmp/rt-eval-dry      # new and empty
rte init --from ~/projects/rt-draw-v2 && cd $RT_EVAL_HOME/repo
rte ready --stub --mock-api
node --import ./evals/loop/node-hooks.mjs evals/mock/dry.ts --port 5400 &   # READY http://127.0.0.1:5400
F="--tokens $RT_EVAL_HOME/dry/tokens.env --mock-api http://127.0.0.1:5400"
bash evals/loop/launch.sh ladder --max 4 --latency $RT_EVAL_HOME/dry/latency.jsonl
bash evals/loop/launch.sh smoke --cap 50 $F
bash evals/loop/launch.sh bake --cap 36 $F
cp $RT_EVAL_HOME/out/pictures.json evals/fixtures/ && git commit -qm "dry: baked pictures" -- evals/fixtures/pictures.json   # in the clone only
rte init --refresh && rte ready --stub --mock-api
bash evals/loop/launch.sh bank build --tuning 8 --heldout-gate 2 --heldout-chart 2 --cap 450 $F   # REFUSED by the §2.3 gates: a 56-send bank is too small, as it should be
rte aa --shared --cases 12
rte bench freeze --heldout 8 --tuning 8            # smaller than B1's 32 + 32, for the rehearsal only
bash evals/loop/launch.sh checkpoint --zero --cap 200 $F
bash evals/loop/launch.sh calib --contrast draw.model=0 --cap 200 $F
rte calib --fake-labels --mock-api http://127.0.0.1:5400; rte calib --check   # the judge's own verdicts (ties) as labels: "more"
bash evals/loop/launch.sh loop --epochs 1 --seed-cards evals/optimizer/seed-cards.json $F
```

Then `./node_modules/.bin/vite --config evals/pages.vite.config.ts --port 5181` and `/evals/progress/` shows the
rehearsal's history. The fake API's `GET /_log` lists every request it answered, with its role.

## The owner's commits and merging back

`rte sync --cap 750` merges the owner's master into `loop/champion` as an owner step: G0's build checks, every banked
before-scene through the merged `Scene.fromJSON` (failing cases are refused; past 10% a bank refresh is queued), then a
checkpoint. The loop runs it between epochs when master moved and the last owner step is a day old. A merge conflict
pauses the loop with an owner-list item: resolve it on master, then `rte sync`.

Taking the champion into master (the loop never touches the owner's checkout):

```bash
git -C ~/projects/rt-draw-v2 fetch ~/rt-eval/repo loop/champion && git -C ~/projects/rt-draw-v2 merge --ff-only FETCH_HEAD
```

When `--ff-only` refuses, master has commits the champion lacks: `rte sync` first.

Moving to another machine: `rte export <host>` (bank/, cache/replies/, cache/blobs/, labels/, human/, and eval/history
as eval/history-import), then `rte init --refresh` there.

## Where everything lives (`$RT_EVAL_HOME`, default `~/rt-eval`)

| Path | What |
|---|---|
| `repo/` | the loop's clone of the owner's master; `loop/champion`, `cand/e<E>-h<n>` branches, tag `eval-harness-<n>` |
| `history/` | worktree of the orphan `eval/history`: decisions, checkpoints, epochs, budget, ledger, owner list, tried patches, bench/ |
| `bank/cases/` | banked fork points (`c-<bank>-s<session>-<n>`); `bank/archive/` retired ones |
| `runs/<run>/` | every run's cases, rows, verdict; run ids `<stamp>-e<E>-h<n>-{g0,scan,ab}` |
| `cache/replies/`, `cache/blobs/` | model replies by request hash, images |
| `meter/calls.jsonl`, `meter/slots.json` | one line per model call (slot numbers only), each slot's window and week |
| `wt/`, `trees/`, `trees-old/` | engineer worktrees; served arm trees by content hash (and the harness); an old harness's trees after a re-pin, until `gc --trees` |
| `state.json`, `loop.lock`, `heartbeat.json` | the coordinator's cursor, one loop at a time, suspend detection |
| `logs/` | every `run.ts` line (`run-<date>.log`), arm servers |
| `machine.json`, `ready/`, `labels/`, `human/`, `out/` | the ladder's slots, readiness runs, calibration labels, the owner's sends, baked pictures |

Code: `evals/loop/` (CLI, gateway, runner, history), `evals/judge/`, `evals/optimizer/` (agents, digests, G0),
`evals/core/` (driver, synthesizer, personas), `evals/checks/` (one acceptance check per task, 0 real calls).

## What changed on the owner's 5180 server at merge

- His model calls now run with the 5-minute cache and an empty config dir (`.data/claude-config`), quiet and
  email-free. The first real call after the merge is the first real use of this env: its `.data/model-calls.jsonl`
  line should show `cacheWrite1h` 0 and the served model (the smoke checks it again).
- Voice keeps working there: only servers the harness starts set `RT_DENY_TTS=1` (`/api/tts` and `/api/stt-token` answer
  403 on them).
- Plugins honour `RT_DATA_DIR` (default `<root>/.data`), so eval runs never write his data.
