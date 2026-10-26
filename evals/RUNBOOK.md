# Running the eval: the runbook

The exact commands, in order, for the laptop and the PGX. How the loop is built and what it found is in `evals/README.md`;
why each step exists is in the spec's §11 (the spec isn't in this repo).
Every step with real calls has a hard `--cap n` (the gateway refuses call n+1). Costs are list-equivalent $ on the
subscription (no money), against a five-hour window of ~$220.

Measured on 2026-10-17 (laptop, the dev token, from a fresh `RT_EVAL_HOME`): the step-1 smoke made **36 real calls,
$0.22, 1.5 min**, every line passed. The rest of the numbers are the spec's estimates (±30%) and the 0-call rehearsal.

## 0. Once, before anything

**Tokens.** One to three tokens (`claude setup-token` on each account). Today one token is shared with testers on
prod (the owner, 2026-10-24): the loop pauses at 90% of its five-hour window (60% until 2026-10-26), leaving testers the rest, and stops at 50%
of its week. Put the tokens in a file outside every repo:

```bash
mkdir -p ~/.config/rt-eval && (umask 077 && nano ~/.config/rt-eval/tokens.env)   # RT_EVAL_TOKEN_1=sk-ant-oat01-…, _2, _3
chmod 600 ~/.config/rt-eval/tokens.env
```

`run.ts` reads it itself and refuses any mode but 600. Fewer than 3 tokens works with a warning (no rotation; the
smoke's U2 says "skipped: one token"). Without the file, `smoke`, `bake` and `probe` can run on the dev plugin's own
token with `--dev-token` (only with `--cap 60` or less); the bank and everything after need the file.

**The PGX (spec §12 decision 6), pick one remote for the code:**

```bash
# a) private GitHub repo (v1's way, the spec's default)
git -C ~/projects/rt-draw-v2 remote add origin git@github.com:OmarSalimMoussa/rt-draw-v2.git && git -C ~/projects/rt-draw-v2 push -u origin master
# b) a bare repo on the PGX over Tailscale, no GitHub
ssh omar-salim-moussa@thinkstationpgx-0eea 'git init --bare ~/git/rt-draw-v2.git' && git -C ~/projects/rt-draw-v2 remote add pgx omar-salim-moussa@thinkstationpgx-0eea:git/rt-draw-v2.git && git -C ~/projects/rt-draw-v2 push pgx master
```

**Every shell that runs a step** (laptop; the PGX adds the PATH line):

```bash
export RT_EVAL_HOME=$HOME/rt-eval
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }
```

On the laptop run `launch.sh` steps from a desktop terminal (it holds the sleep inhibitor; plug in to AC). Over ssh
without a user systemd manager it says so and prints the bare command instead.

## 1. Laptop, in order (spec §11)

| # | Command (from `~/rt-eval/repo` after init) | Cap | Expect |
|---|---|---:|---|
| a | `cd ~/projects/rt-draw-v2 && for c in evals/checks/t*.mjs; do node --import ./evals/loop/node-hooks.mjs "$c" \|\| break; done` | 0 | every line PASS, ~15 min |
| b | `rte init --from ~/projects/rt-draw-v2 && cd ~/rt-eval/repo` | 0 | `init: … at eval-harness-1`, 1 s |
| c | `rte ready --stub --mock-api` | 0 | `ready: ok`, 30 s |
| d | `bash evals/loop/launch.sh ladder --max 4` | 0 | `ladder: 4 case slots` (fewer on a busy laptop), ~4 min |
| 1 | `bash evals/loop/launch.sh smoke --cap 50` | 50 | `smoke: ok, ~36 calls`, $0.2, 2 min |
| 2 | `bash evals/loop/launch.sh bake --cap 36` | 36 | ~31 picture calls, $0.1–0.3, 2 min; then the re-pin below |
| 3 | `bash evals/loop/launch.sh probe --cap 10` | 10 | 8 driver calls, $0.1, 1 min (bank build runs it itself too) |
| 4 | `bash evals/loop/launch.sh bank build --tuning 32 --heldout-gate 8 --heldout-chart 8 --cap 1900` | 1,900 | ~1,520 calls, ~$11.7 (5% of a window), ~25 min at 4 slots here, ~10 min on the PGX at 16 (estimates) |
| 5 | `rte aa --shared --cases 16 && rte bench freeze` | 0 | `aa: ok … ×1.00`, 2 min |
| 6 | `bash evals/loop/launch.sh checkpoint --zero --cap 750` | 750 | ~600 calls, ~$5.1, ~20 min here (an estimate) |
| 7 | `bash evals/loop/launch.sh calib --contrast draw.model=0 --cap 200`, label at http://localhost:5180/evals/label/ (60 clear fidelity + 30 craft), then `rte calib --check` | 200 | ~160 calls, ~$1.6, plus 25–30 min of your labelling |
| 7b | `bin/rte job calib --illustrations --contrast picture.model=0 --cap 600` (the loop stopped), label at /evals/label/?set=illustrations (30 clear fidelity + 15 craft; only the pictures differ), then `rte calib --check --illustrations`. Sets `use.illustrations` alone: a picture model switch's keep and R1 deciding wait for it. Run 2026-10-26: `more`, and Sonnet against Haiku can't get there (3 clear of 44, LOOP-V2 C3); a rerun needs a contrast whose pictures differ more | 600 | ~48 cases with pictures, plus 12–15 min of your labelling |
| 8 | `bash evals/loop/launch.sh loop --epochs 3 --seed-cards evals/optimizer/seed-cards.json --quality-only` | night cap | per epoch ~$15 (7% of a window), ~1 h here; per decision ~$5, ~20 min here |
| 9 | `bash evals/loop/launch.sh loop --night-windows 0.5` (first night), then `bash evals/loop/launch.sh loop` | 0.5 then 1.2 windows a night | the weekly allowance binds first |

Step 2's re-pin: look at the doodles in `~/rt-eval/out/pictures.json` (or the bake's log), then commit **only** that file:

```bash
cp ~/rt-eval/out/pictures.json ~/projects/rt-draw-v2/evals/fixtures/ && git -C ~/projects/rt-draw-v2 add evals/fixtures/pictures.json && git -C ~/projects/rt-draw-v2 commit -m "Eval fixtures: baked pictures" -- evals/fixtures/pictures.json
cd ~/rt-eval/repo && rte init --refresh && rte ready --stub --mock-api
```

When a step stops: a failed `probe` → read `~/rt-eval/probe.json`, then fix the driver or `rte probe --accept`; a bank
refused by §2.3 → build again with more sessions (only new ones run) or `rte bank accept`; a failed `calib --check` →
`bash evals/loop/launch.sh calib --check --variant 2 --cap 150` (~$1.1), and if that fails too the judge prompt is yours to change.

## 2. The PGX (latency decisions and nights)

```bash
ssh -t omar-salim-moussa@thinkstationpgx-0eea tmux attach -t rt          # launch.sh opens window `loop` in session rt
export PATH=$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH RT_EVAL_HOME=$HOME/rt-eval
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }
git clone git@github.com:OmarSalimMoussa/rt-draw-v2.git ~/projects/rt-draw-v2   # or: git clone ~/git/rt-draw-v2.git ~/projects/rt-draw-v2
cd ~/projects/rt-draw-v2 && npm ci
for c in evals/checks/t*.mjs; do node --import ./evals/loop/node-hooks.mjs "$c" || break; done   # t7 and t21 leave the laptop's systemd unit to the laptop
rte init --from ~/projects/rt-draw-v2 && cd ~/rt-eval/repo
rte ready --stub --mock-api && bash evals/loop/launch.sh ladder --max 16   # 16 slots, ~8 min
```

Measured on 2026-10-17 (0 calls): the ladder first froze **2 case slots** on an idle PGX. Every tab of an arm loaded
from one host, and Chrome opens at most 6 connections per host, so the tabs' /api/model streams queued behind each
other (never more than 6 calls in flight). Each tab now has a host of its own (`a0.localhost`, `b3.localhost`, …), and
with sends shaped like a Q case's (2 pictures each) the PGX ran **16 slots at ×1.00** of one slot's send wall (load 0.2
per core, CPU pressure 2.5%, the arms' Enter 8 ms apart); 24 put them 35 ms apart, past V9's 25 ms. The ladder now
tops out at 16, a look's size. The latency trust is the reason to run there.

Then write `~/.config/rt-eval/tokens.env` there (as in §0, chmod 600) and run the table's steps that haven't run yet, the
same commands without `--quality-only`. A bank built on the laptop moves over instead of being rebuilt (saves ~$11.7):

```bash
# laptop
cd ~/rt-eval/repo && rte export omar-salim-moussa@thinkstationpgx-0eea
# PGX
cd ~/rt-eval/repo && rte init --refresh && rte ready --stub --mock-api
```

New code reaches the PGX in one step from the laptop: `bash evals/ops/deploy.sh` pushes the branch to the PGX's bare
repo (remote `pgx`), fast-forwards the PGX's checkout, re-pins the loop clone's harness on it (`rte init --refresh`) and
checks readiness at 0 calls. It refuses while the loop holds its lock (`rte stop-after` first). The champion takes the
owner's commits through `rte sync`, never through a deploy.

## 3. Watching

- **Laptop:** http://localhost:5180/evals/progress/ (your dev server reads `~/rt-eval`); labels at `/evals/label/`.
- **PGX over Tailscale:** start the pages server once in the PGX's clone, then open it from the laptop:

```bash
cd ~/rt-eval/repo && tmux new-window -t rt -n pages "./node_modules/.bin/vite --config evals/pages.vite.config.ts --host $(tailscale ip -4) --port 5181"
# laptop browser: http://thinkstationpgx-0eea:5181/evals/progress/  and  /evals/label/
```

The page polls every minute while the loop's heartbeat is fresh. Status in a terminal: `rte status`; every line a run
says is in `~/rt-eval/logs/run-<date>.log`.

## 4. Stopping and resuming

```bash
bash evals/loop/launch.sh stop          # laptop: stops the unit (Chrome, Vite and Claude with it); PGX: Ctrl-C in window rt:loop
bash evals/loop/launch.sh loop --resume # continues at the next undone case; finished calls are re-served, not re-paid
```

A crash or a reboot leaves a stale lock: the next `loop` resumes by itself. A laptop suspend voids the decision in
flight. The loop stops by itself on the weekly allowance (50% of each token's week), two voids in a row, a failed
readiness or calibration, a sync conflict, the call cap or a blocked request, and pauses (until the earliest reset) when
every token is past 90% of its five-hour window (testers share the token); each one lands in the owner list.

## 5. The morning check

1. The progress page: Quality and Latency against the anchor, Cost per epoch against v1's band, Decisions (click one for
   its cases and every call), Health, and the status strip (stopped or running, and why).
2. `cat ~/rt-eval/history/owner-list.md`: everything waiting for you (a card that needs a frozen area, a sync conflict,
   a stop reason, the morning summary).
3. `tail -3 ~/rt-eval/history/budget.jsonl`: each token's five-hour and seven-day use (`fiveHour` is a 0–1 share).
4. `rte status`: the cursor, the lock, the slots.

## 6. Taking the champion into master

The loop never touches your checkout. Merge when you choose, right after a sync so it fast-forwards:

```bash
cd ~/rt-eval/repo && rte sync --cap 750                     # only when master moved since the last sync (~$5)
git -C ~/projects/rt-draw-v2 fetch ~/rt-eval/repo loop/champion && git -C ~/projects/rt-draw-v2 merge --ff-only FETCH_HEAD
# champion on the PGX: git -C ~/projects/rt-draw-v2 fetch omar-salim-moussa@thinkstationpgx-0eea:rt-eval/repo loop/champion && git -C ~/projects/rt-draw-v2 merge --ff-only FETCH_HEAD
```

`--ff-only` refusing means master has commits the champion lacks: `rte sync` first.

## 7. The `rte` commands

From the loop's clone (`~/rt-eval/repo`) or the owner's checkout:

```bash
bin/rte <command> [flags]       # direct runs (bin/rte is `node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts`)
bin/rte job <command> [flags]   # supervised: a systemd unit holding the sleep inhibitor (laptop), tmux window `loop` (PGX)
bin/rte wait                    # PGX: until the supervised step ends, then its log's last lines
bash evals/loop/launch.sh stop
npm run checks [-- --slow]      # the harness checks, 0 calls (fast ~3 min; --slow adds the real checkpoints and the dry loop)
```

Tokens: `~/.config/rt-eval/tokens.env` (chmod 600, outside every repo) with `RT_EVAL_TOKEN_1..3=…`, three loop
accounts. `run.ts` reads it itself and never prints a token; one or two tokens work (a warning; the smoke skips U2).
`--dev-token` uses the dev plugin's own token from `~/projects/rt-draw-v2/.env`, only with `--cap 60` or less, and never for `loop` (its critic and engineers run outside the cap).

Also: `rte status` (slots, cap, cwd, node, the lock, and each token's five-hour and weekly use as the server last said
it), `rte cost <run>…` (calls and list $ by role, a run's sub-runs included), `rte decide <branch> --cap n` (one branch
through the funnel; `--card <decision id>` decides a loop card's candidate again with that card), `rte checkpoint --cap n`,
`rte aa --live --cap n` (checkpoint 0's unshared A/A again on today's champion, nothing written to history), `rte real
update` (testers' sends from the last pull through to R1, every step but the owner's review, each paying step capped at
1.5× its calls), `rte human freeze` (U1 from the owner's recorded sends), `rte remetric <run>`, `rte gc --trees`, `rte loop
--resume` (a stale lock resumes by itself). `python3 -I evals/tools/verify_decision.py ~/rt-eval/runs <run>…` recomputes a
decision's numbers from its rows without the harness's code, numbers only.

A loop stops on §6.7's rules (weekly allowance, 2 voids in a row, a V9 invariant, readiness, calibration not passed, a
sync conflict, the call cap, a blocked request), pauses on others (all slots past 0.90 of their five-hour window until the
earliest reset, overloads, disk, battery) and writes each to the owner list. Mornings: `/evals/progress/`,
`owner-list.md`, `budget.jsonl`.

## 8. Rehearsing at 0 calls

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
bash evals/loop/launch.sh probe --cap 10 $F; rte probe --accept   # FAILS: one canned reply per message can't tell good from bad
bash evals/loop/launch.sh bank build --tuning 8 --heldout-gate 2 --heldout-chart 2 --cap 450 $F   # REFUSED by the §2.3 gates: a 56-send bank is too small, as it should be
rte bank accept                                    # used anyway, for the rehearsal only
rte aa --shared --cases 12
rte bench freeze --heldout 8 --tuning 8            # smaller than B1's 32 + 32, for the rehearsal only
bash evals/loop/launch.sh checkpoint --zero --cap 200 $F
bash evals/loop/launch.sh calib --contrast draw.model=0 --cap 200 $F
rte calib --fake-labels --mock-api http://127.0.0.1:5400; rte calib --check   # the judge's own verdicts (ties) as labels: "more" (on the fake API the loop waives calibration)
bash evals/loop/launch.sh loop --epochs 1 --seed-cards evals/optimizer/seed-cards.json $F
```

Then `./node_modules/.bin/vite --config evals/pages.vite.config.ts --port 5181` and `/evals/progress/` shows the
rehearsal's history. The fake API's `GET /_log` lists every request it answered, with its role.

## 9. The owner's commits, and moving machines

`rte sync --cap 750` merges the owner's master into `loop/champion` as an owner step: G0's build checks, every banked
before-scene through the merged `Scene.fromJSON` (failing cases are refused; past 10% a bank refresh is queued), then a
checkpoint. The loop runs it between epochs when master moved and the last owner step is a day old. A merge conflict
pauses the loop with an owner-list item: resolve it on master, then `rte sync`.

Moving to another machine: `rte export <host>` (bank/, cache/replies/, cache/blobs/, labels/, human/, and eval/history
as eval/history-import), then `rte init --refresh` there.

## 10. Where everything lives (`$RT_EVAL_HOME`, default `~/rt-eval`)

| Path | What |
|---|---|
| `repo/` | the loop's clone of the owner's master; `loop/champion`, `cand/e<E>-h<n>` branches, tag `eval-harness-<n>` |
| `history/` | worktree of the orphan `eval/history`: decisions, checkpoints, epochs, budget, ledger, owner list, tried patches, bench/ |
| `bank/cases/` | banked fork points (`c-<bank>-s<session>-<n>`); `bank/archive/` a refused refresh's cases (none retire) |
| `runs/<run>/` | every run's cases, rows, verdict; run ids `<stamp>-e<E>-h<n>-{g0,scan,ab}` |
| `cache/replies/`, `cache/blobs/` | model replies by request hash, images |
| `meter/calls.jsonl`, `meter/slots.json` | one line per model call (slot numbers only), each slot's window and week |
| `wt/`, `trees/`, `trees-old/` | engineer worktrees; served arm trees by content hash (and the harness); an old harness's trees after a re-pin, until `gc --trees` |
| `state.json`, `loop.lock`, `heartbeat.json` | the coordinator's cursor, one loop at a time, suspend detection |
| `logs/` | every `run.ts` line (`run-<date>.log`), arm servers |
| `machine.json`, `ready/`, `labels/`, `human/`, `out/` | the ladder's slots, readiness runs, calibration labels, the owner's sends, baked pictures |

Code: `evals/loop/` (CLI, gateway, runner, history), `evals/judge/`, `evals/optimizer/` (agents, digests, G0),
`evals/core/` (driver, synthesizer, personas), `evals/checks/` (one acceptance check per task, 0 real calls).

## 11. What changed on the owner's 5180 server at merge

- His model calls now run with the 5-minute cache and an empty config dir (`.data/claude-config`), quiet and
  email-free. The first real call after the merge is the first real use of this env: its `.data/model-calls.jsonl`
  line should show `cacheWrite1h` 0 and the served model (the smoke checks it again).
- Voice keeps working there: only servers the harness starts set `RT_DENY_TTS=1` (`/api/tts` and `/api/stt-token` answer
  403 on them).
- Plugins honour `RT_DATA_DIR` (default `<root>/.data`), so eval runs never write his data.
