# Intake: real sends

The bank's cases (`bench/B1`) are sends a driver model made up. Intake adds what people did on the hosted app. Each
of their sends that can replay becomes a **card**. Opus labels it: what the person meant, whether it landed, and
the failure kinds. For a clear miss, Opus also draws **gold**, the result the send should have had. The card is then
replayed on the champion and proposed to the owner in Eval HQ. After a two-day look window it is admitted, unless the
owner rejects it.

Where an admitted card goes depends on who sent it:
- **tune person:** the card is a bank case (set `real`), and every decision measures on it.
- **R-hold person:** the card reaches **R1** only, through its gold. R1 is a report shown beside every keep, so the
  owner sees whether what the loop keeps helps people it never tuned on.

```
pull.sh live   (PGX, every 30 minutes)    ─┐
pull.sh local  (laptop, every 30 minutes) ─┴→ real/raw/<source>/<stamp>
                                                │
intake (between the loop's epochs, or rte intake from its timer)
  ingest → splits → images → triage → gold → proposals ──→ look window (Eval HQ) ──→ bank (tune) / R1 (gold)
  0 calls   0        0        Opus      Opus    champion's       the owner's verdicts      0
                                                  replay
```

| Step | What it does | Calls |
|---|---|---|
| Pull | Every 30 minutes `rt-intake.timer` runs `pull.sh live`, which asks the box for its data over ssh as `rt-box`, while the loop runs too. That key may only run the export (`evals/ops/box-key.sh`): people, feedback, projects, the send log and model calls, never `claude-config/`. Separately, the laptop's `rt-pull-local.timer` (`evals/ops/laptop-units.sh`) sends its dev server's `.data` with `pull.sh local`, and the owner's recorded sends (`human/`) beside it. Each pull is a snapshot in `real/raw/<source>/<stamp>/`; the newest is named in `latest`. A pull the same as the last is dropped, and each source keeps its newest 8. | 0 |
| Ingest | `sessions.ts` turns each project into a session: its sends in order, each with its before and after boards. A send has a key that never moves: `<session>#<send id>` for one from the send log (`app/src/board/capture.ts`), or `<session>#v<n>` for one rebuilt from the version it saved. A logged send replays exactly. A rebuilt one replays its words as typed, but its ink survives only as the product's reading of it. A version saved in the 10 minutes before the snapshot, with no send log yet, waits for the next pull: the app logs a send just after saving its version, and the log would move its key. | 0 |
| Splits | Each person is placed once, in `splits.json`. The owner tunes. A tester goes, in the order of their first send, to whichever side is further below its share of the sends that replay (R-hold toward a third). Nobody changes sides. | 0 |
| Images | Each new send's before (the person's screen with their ink) and after, as JPEGs on a bridge page of the champion. A send whose boards fail to draw is tried again next pass, 3 times in all. | 0 |
| Triage | Opus (effort high) reads each session with new sends: 11 sends per call, the whole session's words as context. It judges only the new ones: what was meant, whether it landed, the failure kinds (`prompts.ts` `CATEGORIES`), whether it asked for a drawing at all, and whether gold can be drawn. A session waits until its last send is an hour old, since what the person did next is the best evidence. A send is triaged once, so a prompt change labels new sends only. | 1 per settled session with new sends |
| Gold | Each miss triage marked, if it can replay. Opus draws the product's own ops and every picture, plus a rubric (should / must not) and free checks (`checks.ts`). It works without the product's limits, since gold is the ideal the product aims at. The ops run on the before board with the product's `runScript`; the pictures go through `readPicture` (`gold.ts`). An unreadable reply is drawn once more, and gold's board image is tried 3 times. When `gold.ts` changes, each board it would build differently is rebuilt and shot again, at 0 calls. `rte intake --regold` redraws the gold that has no verdict yet, keeping its look window; while the loop runs, it asks the loop's next intake to (`real/regold.request`). | 1 per miss |
| Proposals | A tune person's card becomes a bank case `real/bank/c-r-<id>/`: its input, before board and meaning, with gold's rubric as its expectation. Where gold drew nothing, the expectation judge drafts one, in 3 tries. Its before image is shot as the driver's are. The case is replayed on the champion, in one run per champion (`real-bank-<sha12>`, resumed if cut short); that replay opens its look window. An R-hold person's card opens its window once its gold is shot. | the product's, once per case; the judge's, per case without gold |
| Admission | Each pass applies the owner's verdicts. A card is admitted when its window ends, unless rejected, and at once when approved. An admitted bank case gets `done`, so decisions take it. A rejection after that retires it. | 0 |
| R1 | Every admitted card with gold, each with the card's meaning and rubric, as `real/bench/R1/<case>/`. R1 is rebuilt whole and swapped in only when it changed, and history gets `bench/R1.json`. | 0 |

A send becomes no card (it's **skipped**, with its reason shown in Eval HQ) when:
- its ink was lost (sent before the send log);
- its boards couldn't be drawn in 3 tries;
- its board still waits for a picture, which both arms would draw;
- it repeats another send (the same words and ink on the same board). The case stays with the send that holds it:
  the one its bank case was made from, then one in its look window or with the owner's verdict, then one triaged,
  else the earliest. A later pull bringing an earlier copy never moves it;
- triage found it isn't a drawing request (a question, a test). The owner's approval in Eval HQ reopens it;
- it's an R-hold send with no gold, or with gold that couldn't be drawn;
- a sync voided its bank case;
- no expectation could be drafted for it in 3 tries;
- the champion couldn't replay it in 3 tries.

Local sessions (the owner's dev server) count from 2026-10-22, when testers started on the hosted app (`real.ts`
`REAL_SINCE`); live ones always count.

## When it runs

The loop runs intake between epochs, after sync (`coordinator.ts` `between`). While the loop isn't running,
`rt-intake.timer` runs `rte intake` every 30 minutes, after its live pull. `rte intake` leaves the work to the loop
when the loop's unit is up or a live loop holds the lock.

Every Opus call waits at the budget's gate. It pauses at 90% of the five-hour window and at the week's threshold, and
never caps. A week spent (or the owner's stop, asked for while a call waited) ends the paid stages, and what was paid
for is kept.

Each stage holds its own failures: a stage, session or send that fails is said and tried again next pass, and the
stages after it still run. Admission and R1 always run, at 0 calls. The log gets keys and counts only. An error's own
text, which can quote a tester, goes to `real/logs/intake.log`. Each pass writes `real/intake.json` (when, how many
failed, and how many passes in a row had failures), which Eval HQ shows.

## Review in Eval HQ

Intake and review are at `/evals/review/` on the PGX's pages server (`evals/pages.vite.config.ts`, port 5181,
Tailscale only).

The page has:
- **Funnel:** the pull and the cards by state.
- **Quality chart:** the owner's edit and reject rates per week, which show how well the labeling is doing.
- **Queue:** proposed cards first, with filters kept in the address.

The reviewer goes through the queue (or the cards waiting, at `/evals/review/#go`, where Eval HQ's links land) one
card at a time over the whole window. A card shows four boards:
- **before:** their screen, with their ink numbered;
- **then:** what the app made;
- **now:** the champion's replay;
- **gold.**

Beside them are what they said and when, the meaning and expectation it will be judged by, and gold's checks on
each board.

Keys: <kbd>A</kbd> approves, with any edit to the meaning or expectation (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> from a
field); <kbd>1</kbd>–<kbd>6</kbd> reject for that reason; <kbd>J</kbd> / <kbd>K</kbd> step; <kbd>Z</kbd> zooms a board
in place (arrows for the others); <kbd>E</kbd> and <kbd>N</kbd> go to the meaning and the note; <kbd>Esc</kbd> closes.
The next two cards are fetched ahead, images and all, so a verdict shows the next card at once while it's saved. The
note saves as it's typed.

An edit is pinned: no prompt change, rebuild or judge replaces it, and clearing it takes it back. Rejection reasons
(`cases.ts` `REJECT_REASONS`) are counted, so the next revision of the triage and gold prompts starts from them.
Gold's board isn't edited on the page: when it's wrong, edit the expectation (which then judges the card) or reject
the card.

## Files

```
real/raw/<source>/<stamp>/   pulls; latest names the newest, pulled says when the last one came
real/sessions/<id>/          session.json, v<n>.json and before-<send>.json boards, img/ (failed.json counts tries), triage.json
real/gold/<session>-<send>/  gold.json, reply.txt, gold.scene.json, gold.jpg
real/bank/c-r-<id>/          bank cases (set real)
real/bench/R1/               R1, with its manifest
real/review/verdicts.jsonl   the owner's verdicts, edits and notes, appended
real/splits.json             each person's side
real/intake.json             the last pass: when, its failures, passes in a row with failures
real/logs/intake.log         the errors behind those failures (they can quote testers)
real/regold.request          rte intake --regold, asked while the loop runs: its next intake redraws gold
real/bank.key                the secret real case ids are keyed by (mode 600)
real/runs/, real/cache/      a run's files, calls and images for real cases
```

## What stays private

The repo is public. Testers' words, drawings and project names live only in `$RT_EVAL_HOME/real/` on the PGX
(mode 700). Of them, history gets only `bench/R1.json`: R1's hash, counts and case ids. People are pseudonyms
(`p-<sha8>` of the owner id), never emails.

Real cases in the bank keep to the same rule:
- **Case files.** Their cases are in `real/bank/`, never `bank/cases/`. In any run, a real case's folder, its cached
  calls and its images are under `real/` (`paths.ts` `underReal`), so `/api/eval/file` never serves them and
  `rte export` never copies them. Eval HQ shows cards only through its intake endpoints (`review.ts`), on the PGX.
- **Ids.** Ids are keyed by `bank.key`: a plain hash of a send typed on a blank board would let anyone check a guess.
- **Decisions.** A decision's rows and history get those ids, scores and timings. A void or loss reason is cut to its
  code (V7, V9, …), and a judge's unreadable reply is counted, never quoted.
- **Agents.** The analyst's, critic's and failure analyst's digests read only the driver's tuning cases and say only
  how many real sends were measured, so no agent can copy what someone said into the product or a commit.

## Tradeoffs

R1 decides nothing. It is scored beside every keep and checkpoint (`shadow.ts`) and reported. The bank's real
cases do decide: they're cases like the driver's, judged against their own expectation. A keep is decided on the
bank's cases under the loop's rules: never slower first, and cost is reported, never a reason to keep or drop a
change. A real send can't be continued (G4 needs the driver to take the next turn), so class D's continuations
come from the driver's cases only.
