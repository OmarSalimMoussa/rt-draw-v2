# The real-use loop

The bank (`bench/B1`) is sends a driver model made up. This loop adds what real people did on the hosted
app: their sends, what came back and how they reacted. Opus reads each session for what missed and draws
what each clear miss should have made, and those cases become bench **R1**, so a change to imagine is also
measured on whether it fixes what testers actually hit. Every send that replays, landed or not, also becomes a bank
case (set `real`, since 2026-10-28), so decisions are measured on what people asked for, not only on what a driver
model made up.

```
pull.sh (laptop)  →  rte real ingest  →  rte real render  →  rte real triage  →  rte real gold  →  rte real review  →  rte real freeze  →  rte real bank
 box + laptop data    sessions            images, 0 calls     Opus per session    Opus per miss     owner approves      bench R1            bank cases
```

| Step | What it does | Calls |
|---|---|---|
| `bash evals/real/pull.sh` | On the laptop (its machines in `~/.config/rt-eval/hosts.env`): streams the box's `/data` (people, feedback, projects, send log, model calls; never `claude-config/`) and the laptop's `.data` to the PGX, as `$RT_EVAL_HOME/real/raw/<stamp>/{live,local}` | 0 |
| `rte real ingest` | Each project becomes a session (`sessions.ts`): its sends in order, each with its before and after boards. A send from the send log (`app/src/board/capture.ts`) is exact. An older one is rebuilt from its version and the drawing call's prompt: typed or spoken words replay as typed words, but ink survives only as the product's reading of it | 0 |
| `rte real render` | Each send's before (the person's screen, with their ink) and after (the screen plus everything that changed) as JPEGs on a bridge page of the champion | 0 |
| `rte real triage --cap n` | Opus reads each session (11 sends per call, the whole session's words as context) and says, per send, what the person meant, whether it landed, the failure kinds (`prompts.ts` `CATEGORIES`) and whether a good result could be drawn for it | 1 per session (more past 11 sends) |
| `rte real gold --cap n [--regold]` | For each send triage marked for gold that can replay (a send whose ink is lost can't enter R1, so it gets none) and has no gold yet: Opus at effort high, with none of the product's limits (gold is the ideal the product aims at), writes the product's own ops and draws every picture (no cap on elements or colors, detail matched to the ask), plus a rubric (should / must not) and free checks (`checks.ts`). The ops run on the before board with the product's `runScript`, the pictures go through `readPicture` (`gold.ts`), and gold is shot like a result. A prompt change doesn't redraw gold (the product's draw manual is part of gold's prompt, and the loop changes it); `--regold` redraws every unreviewed one | 1 per send |
| `rte real review --host <tailscale ip>` | A page showing before, the app's result and gold side by side, with Approve and Reject (`review.ts`), on port 5182 | 0 |
| `rte real freeze` | Accepted gold cases that replay become `real/bench/R1/<case>/`, one per distinct input (repeats merged), split R-tune / R-hold by person: the owner's sends tune, testers go to R-hold toward a third (the split is reported; no proposer reads R-tune yet). Built aside and swapped in whole, and refused while a loop holds the lock. Gold drawn for a send that a later pull moved under the same key is left out (`sendHash`). A failure that a later commit fixed is the owner's to reject on the review page; a case both arms get right is a tie | 0 |
| `rte real bank --cap n` | Every triaged send that replays (exact, or typed words), landed or not, becomes `real/bank/c-r-<id>/`, one per distinct input: its input, before board, triage's meant, and gold's approved rubric as its expectation when it has accepted gold drawn for it (else the judge makes one from the send, as for the driver's cases). Its before image is shot as the driver's are, at its camera with the ink numbered. Left out: a send whose ink is lost (it waits for synthesized ink), one whose board still waits for a picture (both arms would draw it), R-hold's people (so R-hold stays people the loop never tuned on), and a case a sync voided. Each is clustered by session and recorded on the champion (one live A/A per champion, resumed if cut short); then decisions scan and measure it like a tuning case. Holds the loop's lock while it runs | the product's, once per new case |

Local sessions (the owner's dev server) count from `--since` (default 2026-10-22, when testers started on
the hosted app); live ones always count. `--only <session>` runs one session.

## Gold review

The owner approves the first batch of gold case by case. Later batches go in unless rejected, and the page
stays open for spot checks. A rejected case stays out of R1. Redrawn gold (`--regold`) keeps its batch, so batch 1's
still waits for the owner; failed gold is retried in the next run's batch. A verdict counts only for the gold it was
given on: one given on failed gold doesn't carry over to its retry.

## What stays private

The repo and its `eval/history` branch are public. Testers' words, drawings and project names live only in
`$RT_EVAL_HOME/real/` on the PGX, mode 700. History gets `bench/R1.json`: R1's hash, counts and case ids,
nothing anyone said or drew. People are pseudonyms (`p-<sha8>` of the owner id), never emails.

Real sends in the bank keep to the same rule. Their cases are in `real/bank/`, never `bank/cases/`. In any run, a real
case's folder, its cached calls and its images are under `real/` (`paths.ts` `underReal`), so the pages server never
shows them and `rte export` never copies them. Their ids are keyed by a secret in `real/bank.key` (mode 600): a plain
hash of a send typed on a blank board would let anyone check a guess. A decision's rows and history get those ids, scores and timings;
a void or loss reason is cut to its code (V7, V9, …), and a judge's unreadable reply is counted, never quoted. The
analyst's, critic's and failure analyst's digests read only the driver's tuning cases, and say only how many real
sends were measured, so no agent can copy what someone said into the product or a commit.

## Replay

A case replays its input on a fresh page of an arm, as the bank does. Exact sends replay word timings and
ink as they were. Rebuilt sends without ink replay as typed words. Rebuilt sends with ink wait in R1's
`inkWaiting` count until ink is synthesized for them from the product's reading (`evals/core/synth.ts`).

## Tradeoffs

R1 decides nothing yet: it's scored beside every keep and checkpoint (`shadow.ts`) and reported, until the judge is
calibrated on illustrations. The bank's real sends do decide: they're cases like the driver's, judged against the
send's own expectation, not gold. A keep is decided on the bank's cases under the loop's rules, never slower first;
cost is reported, never a reason to keep or drop a change. A real send can't be continued (G4 needs the driver to take
the next turn), so class D's continuations come from the driver's cases only.
