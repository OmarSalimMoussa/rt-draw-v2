# The real-use loop

The bank (`bench/B1`) is sends a driver model made up. This loop adds what real people did on the hosted
app: their sends, what came back and how they reacted. Opus reads each session for what missed and draws
what each clear miss should have made, and those cases become bench **R1**, so a change to imagine is also
measured on whether it fixes what testers actually hit.

```
pull.sh (laptop)  →  rte real ingest  →  rte real render  →  rte real triage  →  rte real gold  →  rte real review  →  rte real freeze
 box + laptop data    sessions            images, 0 calls     Opus per session    Opus per miss     owner approves      bench R1
```

| Step | What it does | Calls |
|---|---|---|
| `bash evals/real/pull.sh` | On the laptop (its machines in `~/.config/rt-eval/hosts.env`): streams the box's `/data` (people, feedback, projects, send log, model calls; never `claude-config/`) and the laptop's `.data` to the PGX, as `$RT_EVAL_HOME/real/raw/<stamp>/{live,local}` | 0 |
| `rte real ingest` | Each project becomes a session (`sessions.ts`): its sends in order, each with its before and after boards. A send from the send log (`app/src/board/capture.ts`) is exact. An older one is rebuilt from its version and the drawing call's prompt: typed or spoken words replay as typed words, but ink survives only as the product's reading of it | 0 |
| `rte real render` | Each send's before (the person's screen, with their ink) and after (the screen plus everything that changed) as JPEGs on a bridge page of the champion | 0 |
| `rte real triage --cap n` | Opus reads each session (11 sends per call, the whole session's words as context) and says, per send, what the person meant, whether it landed, the failure kinds (`prompts.ts` `CATEGORIES`) and whether a good result could be drawn for it | 1 per session (more past 11 sends) |
| `rte real gold --cap n [--regold]` | For each send triage marked for gold that can replay (a send whose ink is lost can't enter R1, so it gets none) and has no gold yet: Opus at effort high, with none of the product's limits (gold is the ideal the product aims at), writes the product's own ops and draws every picture (no cap on elements or colors, detail matched to the ask), plus a rubric (should / must not) and free checks (`checks.ts`). The ops run on the before board with the product's `runScript`, the pictures go through `readPicture` (`gold.ts`), and gold is shot like a result. A prompt change doesn't redraw gold (the product's draw manual is part of gold's prompt, and the loop changes it); `--regold` redraws every unreviewed one | 1 per send |
| `rte real review --host <tailscale ip>` | A page showing before, the app's result and gold side by side, with Approve and Reject (`review.ts`), on port 5182 | 0 |
| `rte real freeze` | Accepted gold cases that replay become `real/bench/R1/<case>/`, one per distinct input (repeats merged), split R-tune / R-hold by person: the owner's sends tune, testers go to R-hold toward a third. Built aside and swapped in whole, and refused while a loop holds the lock. Gold drawn for a send that a later pull moved under the same key is left out (`sendHash`). A failure that a later commit fixed is the owner's to reject on the review page; a case both arms get right is a tie | 0 |

Local sessions (the owner's dev server) count from `--since` (default 2026-10-22, when testers started on
the hosted app); live ones always count. `--only <session>` runs one session.

## Gold review

The owner approves the first batch of gold case by case. Later batches go in unless rejected, and the page
stays open for spot checks. A rejected case stays out of R1.

## What stays private

The repo and its `eval/history` branch are public. Testers' words, drawings and project names live only in
`$RT_EVAL_HOME/real/` on the PGX, mode 700. History gets `bench/R1.json`: R1's hash, counts and case ids,
nothing anyone said or drew. People are pseudonyms (`p-<sha8>` of the owner id), never emails.

## Replay

A case replays its input on a fresh page of an arm, as the bank does. Exact sends replay word timings and
ink as they were. Rebuilt sends without ink replay as typed words. Rebuilt sends with ink wait in R1's
`inkWaiting` count until ink is synthesized for them from the product's reading (`evals/core/synth.ts`).

## Tradeoffs

Nothing that makes imagine slower is kept on R1's say-so: a gain on R1 that costs latency or $ goes to the
owner list.
