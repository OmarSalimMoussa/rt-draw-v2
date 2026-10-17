# Running the eval: the runbook

The exact commands, in order, for the laptop and the PGX. Why each step exists is in `evals/README.md` and the spec's §11.
Every step with real calls has a hard `--cap n` (the gateway refuses call n+1). Costs are list-equivalent $ on the
subscription (no money), against a five-hour window of ~$220.

Measured on 2026-10-17 (laptop, the dev token, from a fresh `RT_EVAL_HOME`): the step-1 smoke made **36 real calls,
$0.22, 1.5 min**, every line passed. The rest of the numbers are the spec's estimates (±30%) and the 0-call rehearsal.

## 0. Once, before anything

**Tokens.** One to three loop accounts (three separate ones, none your main one, spec §12 decision 5). On each
account run `claude setup-token`, then put the tokens in a file outside every repo:

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
ssh thinkstationpgx-0eea 'git init --bare ~/git/rt-draw-v2.git' && git -C ~/projects/rt-draw-v2 remote add pgx thinkstationpgx-0eea:git/rt-draw-v2.git && git -C ~/projects/rt-draw-v2 push pgx master
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
| d | `bash evals/loop/launch.sh ladder --max 4` | 0 | `ladder: 2 case slots`, 2 min |
| 1 | `bash evals/loop/launch.sh smoke --cap 50` | 50 | `smoke: ok, ~36 calls`, $0.2, 2 min |
| 2 | `bash evals/loop/launch.sh bake --cap 36` | 36 | ~31 picture calls, $0.1–0.3, 2 min; then the re-pin below |
| 3 | `bash evals/loop/launch.sh probe --cap 10` | 10 | 8 driver calls, $0.1, 1 min (bank build runs it itself too) |
| 4 | `bash evals/loop/launch.sh bank build --tuning 32 --heldout-gate 8 --heldout-chart 8 --cap 1900` | 1,900 | ~1,520 calls, ~$11.7 (5% of a window), ~50 min at 2 slots (the spec's ~19 min on the PGX assumed 8) |
| 5 | `rte aa --shared --cases 16 && rte bench freeze` | 0 | `aa: ok … ×1.00`, 2 min |
| 6 | `bash evals/loop/launch.sh checkpoint --zero --cap 750` | 750 | ~600 calls, ~$5.1, ~20 min here (an estimate) |
| 7 | `bash evals/loop/launch.sh calib --contrast draw.model=0 --cap 200`, label at http://localhost:5180/evals/label/ (60 clear fidelity + 30 craft), then `rte calib --check` | 200 | ~160 calls, ~$1.6, plus 25–30 min of your labelling |
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
ssh -t thinkstationpgx-0eea tmux attach -t rt          # launch.sh opens window `loop` in session rt
export PATH=$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH RT_EVAL_HOME=$HOME/rt-eval
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }
git clone git@github.com:OmarSalimMoussa/rt-draw-v2.git ~/projects/rt-draw-v2   # or: git clone ~/git/rt-draw-v2.git ~/projects/rt-draw-v2
cd ~/projects/rt-draw-v2 && npm ci
for c in evals/checks/t*.mjs; do node --import ./evals/loop/node-hooks.mjs "$c" || break; done   # t7 and t21 leave the laptop's systemd unit to the laptop
rte init --from ~/projects/rt-draw-v2 && cd ~/rt-eval/repo
rte ready --stub --mock-api && bash evals/loop/launch.sh ladder --max 12   # measured 2 slots on 2026-10-17
```

Probed on 2026-10-17 from a bundle of this branch (0 calls): `npm ci` 5 s, tsc and all 22 checks pass, `ready: ok`
in 26 s, and the ladder froze **2 case slots, twice** (4 slots ran ×1.18 and ×1.37 of one slot's send wall on an idle
machine: load 0.1, no CPU pressure), not the 8 the spec planned for. At 2 slots the PGX measures a decision about as
fast as the laptop (~20 min, not ~10); calls and $ don't change. The latency trust is the reason to run there.

Then write `~/.config/rt-eval/tokens.env` there (as in §0, chmod 600) and run the table's steps that haven't run yet, the
same commands without `--quality-only`. A bank built on the laptop moves over instead of being rebuilt (saves ~$11.7):

```bash
# laptop
cd ~/rt-eval/repo && rte export thinkstationpgx-0eea
# PGX
cd ~/rt-eval/repo && rte init --refresh && rte ready --stub --mock-api
```

New code on master reaches the PGX by `git push` on the laptop, then `git -C ~/projects/rt-draw-v2 pull` and
`cd ~/rt-eval/repo && rte init --refresh` there (a harness change re-pins; the champion takes master through `rte sync`).

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

A crash or a reboot leaves a stale lock: the next `loop` resumes by itself. A laptop suspend voids the cases in flight
and replays them. The loop stops by itself on the night cap, the weekly allowance, two voids in a row, a failed
readiness or calibration, a sync conflict or a blocked request, and pauses (until the earliest reset) when every token
is past 90% of its window; each one lands in the owner list.

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
# champion on the PGX: git -C ~/projects/rt-draw-v2 fetch thinkstationpgx-0eea:rt-eval/repo loop/champion && git -C ~/projects/rt-draw-v2 merge --ff-only FETCH_HEAD
```

`--ff-only` refusing means master has commits the champion lacks: `rte sync` first.
