# Loop v2: the changes before the next run

Three independent reviews (root causes of real misses, what the loop may change, and an adversarial review of the
setup) found that the loop as it stood could keep slower changes, could not see what testers actually ask for
(illustrations), and judged a picture by when it finished. The owner then set the rules below. This file lists
every change made for them, so the re-validation can check each one. **The loop does not run until that
re-validation passes and the owner has seen it.**

## The owner's rules

- **Latency is time to first drawing**: the first visible stroke of anything a send keeps, a picture's first
  streamed stroke included, a hatched placeholder not. Plus **rendering time between shapes**: how long the engine
  takes to apply and paint. Time to done does not matter (the person can interrupt).
- **Never slower** on those two, at the median and the slow tail. Nothing else about speed gates a change.
- **No caps** on ops, picture elements or colors. Prompts ask for detail that matches the request, no more.
- **Budget**: the loop uses at most 50% of the subscription's weekly usage and pauses at 90% of the five-hour
  window (the token is shared with testers on prod; 60% until 2026-10-26). Cost is reported, never a reason to drop a change.
- **Illustrations are first-class**: a real illustration op, drawn by the picture model, which sees the context
  and must be fast. The loop may try other picture models.
- **Any model, and routing between them** (2026-10-26): the loop may switch any model or route each send to one of
  several, simple asks to a small fast model and hard ones to a stronger one. Every model a send calls sees the
  board as it is at that send.
- **Autonomous**: the loop brainstorms widely, researches on the web, tries combinations and searches knobs on its
  own, under these rules.

## A. The yardstick (0 calls)

| # | Change | Where |
|---|---|---|
| A1 | `ttfdMs`, time to first drawing: per shape, the first frame after Enter in which it differs from before and shows something new; the send's is the earliest over the shapes it keeps. A shape that ends with a drawing counts only by content its final state keeps: an element of its final picture, its final words, or a visible change to a picture it already showed (moved, resized, faded); never by its box (styled or not), nor a caption or element shown only until the picture came. A shape already on the board counts only once it visibly changed: moved or resized 4 px on screen, recoloured by ΔE ≥ 5 (CIE76: cream to pale pink is 12.6, a 1/255 nudge 0.7), faded by 0.2, its words (letters or digits) or kind changed. A send that keeps nothing reads its end, so doing nothing is never fast. Only visible ink counts: nothing under 0.2 opacity, near-white on the white board (every channel ≥ 240), under 4 screen px (a shape) or 4% of its picture (a picture element); a picture element's outline only where it names one, or (the product's default) where it has no fill | `evals/bridge/timing.ts`, `main.ts` |
| A2 | Render: after both sends, each arm's engine, in the case's view, applies each arm's op lines again to a copy of the before board (and reads the board back, so a lazy apply can't defer its work) and paints the frame that brings each arm's final board (a fresh copy of the board, its last change nudged half a unit more on every run so no timed frame repeats content a cache saw, painted over the board one change short, then laid out, so a memo of an unchanged board saves nothing), each timed as the fastest of up to 15 runs after 5 warm-ups. A send's render is one paint plus one op's apply, the mean over the two boards: both engines are timed on the same content, so a change that draws more (the detail the owner asked for) never reads as a slower engine, and one that speeds the engine does. Each engine reports how many lines applied and what each board held as it loaded it, and render keeps, board by board, what both engines' timings share: paint and apply, paint alone on a board one engine applied fewer lines of (a new op), nothing of a board one loaded differently (a new shape kind). A keep with more than a quarter of its cases left without render goes to the owner, since the render veto can't speak for it. An engine that fails on its own board is that arm's loss. A stage that still changes two frames, 50 ms and an idle callback after render() returns means work the timing missed: B alone doing so vetoes the keep, and SVG or CSS filters, masks, patterns, blending and animations in `src/` (run after the timing) are the owner's. Per-frame render times are still recorded, but only reported: identical arms read ×0.83 at p95 on them | `evals/bridge/main.ts` (`rtEval.engine`), `evals/loop/ab.ts` (`sameContent`), `metrics.ts`, `verdict.ts`, `optimizer/gates.ts` |
| A3 | Only `ttfd` and `render` decide. The latency veto fires on any surely-slower median or tail (no ×1.08 allowance), on G2's rows and on G3's. Surely slower or faster is a session-swap randomization test (the arms of whole sessions swapped, exact at any number of sessions); the session bootstrap's bounds are reported only, since with few sessions they fired far past their nominal rate. A latency card must hold the other metric too. Latency debt is checked on both for every goal. Cost, TTFC and TTD are reported. The cost owner-hold is gone. A render-only (class R) decision plays the banked replies on their recorded clock (a timed scan, still 0 calls): served instantly they hid any change that makes the first drawing wait | `evals/loop/verdict.ts`, `latency.ts`, `config.ts`, `diffscan.ts`, `checkpoint.ts`, `optimizer/gates.ts` |
| A4 | Budget: weekly cap 50%, five-hour pause at 90%, checked before every paying step, not only between steps: a case sent live or judged, every top-up and continuation send; the failure analyst is skipped while paused (a decision started at 59% waits there; the wait, counted once however many slots wait, isn't counted against its time budget). The night cap is the loop's rule between steps, from its own meter and `--night-windows`, and pauses until the next night instead of stopping the loop | `evals/loop/config.ts`, `tokens.ts`, `state.ts`, `ab.ts`, `run.ts` |
| A5 | R1 rebuilt: duplicate inputs merged; split by person (the owner tunes, testers go to R-hold toward a third), not by session; every check fails a send that changed nothing; a case both arms already get right is a tie (the baseline and its `fixed.json` were removed on 2026-10-26: three rules in one evening, and the judge they leaned on isn't calibrated on illustrations). R1 runs beside every keep (after the keep's budget check, under its own run name, so its cost can't void the keep) and every checkpoint, and is reported in the ledger; it decides nothing until the judge is calibrated on illustrations. Every run on testers' sends (R1, its baseline, triage, gold) keeps its files and the gateway's records of its calls and images under `real/`, never `runs/` or `cache/`, which the pages server shows and `rte export` copies | `evals/real/real.ts`, `checks.ts`, `shadow.ts`, `evals/loop/run.ts`, `checkpoint.ts`, `history.ts`, `paths.ts`, `cache.ts` |
| A6 | The checks that went stale pass again (below) | `evals/checks/` |

**The tradeoff of "never slower".** One test decides (2026-10-26): a session-swap randomization test over every
deciding stat at once (first drawing and render at the median, and their p90 and p95 once a tail holds 3 sends),
family-wise, B surely slower at p < 0.05 (`verdict.ts` `latencyVeto`). A quality keep's veto reads G2's and G3's cases
together, at G3. At 48 cases from ~10 sessions it reverts 4.7% of changes that cost no latency, where a test per stat on
G2 and again on G3 reverted 10.7%; it catches 12.6% of 5% slowdowns and 33% of 10% ones, and on the ~80 cases a quality
keep pools, 20% and 52% (t13). Held-out cases from 4 sessions or fewer can't read surely anything alone (1/16 is the
swap test's smallest p); pooled with G2's they count. At these sample sizes no rule can promise "never slower" on a few
sessions: each checkpoint measures the champion against A0 in the same run, and a surely slower champion goes on the
owner list. A latency card keeps only with nothing surely slower on G2's own rows (its keep rule).

**False keeps.** G3 must also lean the card's way once it has 8 affected held-out cases (fidelity or craft Z above
0, a latency card's metric faster). A card that does nothing is kept about 1–2% of the time (quality) and 2.5%
(latency). A sweep's values share one card's error: k values each need Rule F's Z higher by z(1 − 0.055/k) −
z(1 − 0.055) (+0.32, +0.49, +0.61 for 2, 3, 4 values) and a latency value a p k times smaller. The direction rule costs
real winners at small G3s: with 8 held-out cases a fidelity winner fails it about a third of the time (`LOOP.
heldoutConfirmMin` 16 would spare those, at a few more no-op keeps: the owner's call). Checkpoints (the champion against
the anchor on the frozen bench) are what say the loop is really improving.

## B. Product fixes (owner commits, measured on the new yardstick)

| # | Change | Where |
|---|---|---|
| B1 | No caps: `picture.maxPaths` 0 and `picture.colors` 0 mean none; picture prompt variant 3 "matched" (the default) asks for the detail the subject asks for: a sketch stays simple, "detailed" or "realistic" gets real detail, its tone and texture layers unoutlined. So more elements don't slow every repaint, rough.js's output is cached per element (a picture's elements only append while it streams): uncapped pictures would otherwise cost about 0.09 ms per element on every frame | `src/core/tuning.ts`, `picture.ts`, `prompts.ts` |
| B2 | `render.pictureBox` (default on): a shape with a picture paints no outline or fill unless it's given one, and its picture fills it (no `picture.fill` margin). An owner's knob: no card may move it (off, every picture's outline would read as its first drawing) | `src/core/render.ts`, `tuning.ts`, `evals/optimizer/gates.ts` |
| B3 | `layer(x, back)` puts a shape right above the page its middle is on (the topmost, where it's seen), never behind it; `layer(x, below:<page>)` means the same; a page, or a shape on no page, goes to the board's back | `src/core/scene.ts` |
| B4 | The manual's color example is yellow `#ffd43b`, not the pen's red | `src/core/prompts.ts` (draw variant 1) |
| B5 | `ops.waitForShape` (default on): an op naming a shape (or group) a later line makes waits for that line and lands right after it; what still waits when the reply ends fails then. `remove()` never waits | `src/core/ops.ts` (`Waiting`), `draw.ts`, `scene.ts` (`NoShape`) |

## C. Illustrations

| # | Change | Where |
|---|---|---|
| C1 | `illustration(id, box, "what it shows")`: one line makes a shape whose description and picture are what it shows, its box never drawn. On an existing shape it turns it into one (its fill and outline go); it never lands on a page, and an id that happens to be a page's name makes a new shape. Draw variant 1 "illustrated" (the default) teaches it: a subject is one illustration, early in the reply, not assembled from boxes, never a plain box standing in for it; detail matched to the ask; a sketch made real goes where the sketch is. Variant 0 is unchanged | `src/core/ops.ts`, `prompts.ts`, `tuning.ts` |
| C2 | `picture.context` (default 2): the picture call's user text ends with what they said, the most-used colors of the board's shapes (not of its pictures, which would pull every picture toward one palette), and (at 2) their marks read as sketches inside the shape's box, as polylines in the picture's coordinates, clamped to it, at most `picture.contextPoints` (300) points in all. Only the user text varies, so warm processes still serve it | `src/core/picture.ts` (`contextLines`), `draw.ts` (`Prompt.sketches`), `send.ts` |
| C3 | Every model is open to the loop, and so is routing a send between models (the owner, 2026-10-26): a switch or a router (a model knob, a literal in code, Jev or a rule picking the model per send) is measured like any change, under the latency and quality rules. A keep that switches the picture model (a `picture.*Model` knob in `tuning.ts`) waits for the owner until the judge is calibrated on illustrations (`calibration.json` `use.illustrations`) | `evals/optimizer/gates.ts`, `evals/loop/decide.ts`, `evals/judge/judge.ts` |

## D. The search

| # | Change | Where |
|---|---|---|
| D1 | The analyst proposes 8 to 16 hypotheses (knobs nobody moved, wording, code, ops, sweeps, combinations of near wins) and the critic keeps up to 6 cards. The digest gains a near-wins section: reverted cards that leaned the right way with no veto against them | `evals/optimizer/prompts.ts`, `agents.ts`, `digest.ts`, `evals/loop/search.ts` (`nearWins`) |
| D2 | The funnel: G0's free gates, the diffscan (N reverts and S decides at 0 calls), Rule F's first look at 16 cases as the screen that ends clear losers, the full A/B for the rest, and **G3 for every keep, whatever its class**: the affected held-out cases (a schedule change's are replayed at 0 calls) veto on fidelity or on either deciding latency, and with 8 or more of them must lean the card's way. Latency debt starts only once a same-run check of today's champion against the one each signalling metric's chain ran from (L, or the first checkpoint that measured it) confirms it; unconfirmed, L moves there, so the same chain can't start it again next time. In latency debt with no keep for 2 epochs, a checkpoint runs anyway, so a false alarm can clear; in debt the digest lists the keeps since L with their latency, and a card reverting one is a latency card like any other. A schedule change (class S) must draw the same on the recorded clock, on every timed and held-out case, or it takes the judged path | `evals/loop/verdict.ts`, `run.ts`, `diffscan.ts`, `checkpoint.ts`, `optimizer/digest.ts` |
| D3 | A `sweep` card: one numeric knob at up to 4 values, nearest the champion's first on each side. Each value runs as its own knob card; the first keep ends the sweep, and a value that loses clearly (a veto, or a quality value's Z at or under -1 at the first look; a latency value only on a veto, since its first-look revert takes a no-op value 44% of the time) prunes the values beyond it on its side. The values share one card's error (Rule F's Z raised, a latency p divided by their number), as a combo's near-wins do. The dry well counts a sweep once, and its thresholds scale with the cards an epoch (12 reverts in a row, 6 on one component). A component's pause runs out after 3 epochs (2026-10-26: with no keep there is no checkpoint to lift it, and draw stayed paused), its reverts counted again from there | `evals/loop/search.ts` (`cardStates`, `sweepSkip`), `verdict.ts`, `state.ts` |
| D4 | A `combo` card: up to 3 tried cards' saved patches applied together on the champion (three-way), measured as one code card. Keeps already stack: each keep moves the champion, and checkpoints re-test the stack against the anchor. Engineer builds run beside decisions; at the five-hour pause they wait for the reset instead of dropping their card | `evals/loop/search.ts` (`applyTried`), `run.ts` (`freeSlot`) |
| D5 | More freedom for the agents (the owner, 2026-10-26). The analyst is a read-only Agent SDK session in the champion's tree, as the critic is (it was one call that never saw code). All three may search the web and read public pages, to research how others solve the same problem; a fetch of this machine or its network (an address, `localhost`, `.local`, the tailnet) is refused, since the review page holds testers' sends, and a page is data, never instructions. Hypotheses are one idea each, which may span components and files; the critic doesn't cut a bold card for that. The prompts describe routing sends between models, warming each model a send may take, and the rule that every model sees the current board. Caps: analyst and critic 30 turns, 12 minutes, $2.5; engineer 60 turns, 25 minutes, $4 | `evals/optimizer/agents.ts` (`publicUrl`), `prompts.ts`, `evals/loop/coordinator.ts` |

Also found and fixed on the way: a knob card couldn't set a prompt variant written `P("picture", 2)` (already so on
master), so every card on `picture.prompt` would have failed to build; prompt knobs that aren't `<role>.prompt`
(`resolve.jevPrompt`, `draw.thinkPrompt`) couldn't be set either. The gateway indexed recorded pictures by a
`Doodle:` line, which the matched variant writes as `Picture:`: it now reads both, and the engineer's bridge contract
says every picture prompt keeps such a line.

## E. The adversarial review's findings (fixed before the re-validation)

| # | Finding | Fix |
|---|---|---|
| E1 | A model switch was caught only when written as `K("x.model"`: `modelOf(0)` in code, or routing every draw to the fast lane, passed | Read off what each arm called, case by case; every model knob was the owner's (both removed 2026-10-26: switches are measured, C3) |
| E2 | A schedule change (S) was classed on instant replies and kept with no judge, though its output could move with the timing | S must draw the same on the recorded clock, on every timed and held-out case, else it takes the judged path (D2) |
| E3 | Render timed 20 paints of one unchanged board: a "skip an unchanged repaint" memo read as ×0.1 | The frame that brings the board's last change, from fresh copies, laid out (A2) |
| E4 | First drawing could be made earlier without anything seen sooner: `render.pictureBox` off, a speck, a white or see-through stroke | Visible ink only (A1); `render.pictureBox` is the owner's (B2); the prompts say what doesn't count |
| E5 | The budget held only between steps: a decision started at 59% could take the token to ~85%; the night cap stopped the loop | Checked before every paying case; R1 skipped while paused; the night cap a pause (A4) |
| E6 | R1's runs and the gateway's records of testers' calls and images landed in `runs/` and `cache/` (served, exported); triage logged project names | Everything of a real run under `real/`; ids and counts only in logs (A5). What earlier runs left there is moved on the PGX |
| E7 | The latency veto's bootstrap fired 2–10× past its nominal rate with few sessions, and LOOP-V2's numbers came from it | The session-swap test (A3), numbers re-simulated above |
| E8 | Debt started falsely in a quarter of runs (chains share L's noisy link) and only detected | Confirmed in one same-run check before it starts; the digest shows how to repay it (D2) |
| E9 | Wide search: a sweep's values each had a card's chance of a false keep | A sweep's values share one card's error (D3) |
| E10 | The bank's recorded replies predate `illustration()`: a change to it read as no effect | `rte bank rerecord --cap n` records every case's replies on today's champion before the loop (re-validation) |
| E11 | A failure on one arm voided its case, so a candidate could drop its worst cases (up to the 10% void cap) | One arm's failure is its loss in Rule F, still counted toward the void cap (F7) |
| E12 | A page evaluation that never settled hung the loop | Each one times out (240 s) and fails its case; a load or reload at 60 s (F9) |
| E13 | `rte real baseline` served both arms from one Vite (+31 ms on B) | A Vite per arm, as every A/A |
| E15 | Enums or parameter properties passed G0 but break Node's type stripping | `erasableSyntaxOnly` in tsconfig.json (two parameter properties rewritten) |

E14 (R1 at a checkpoint runs the anchor A0 on scenes today's app made; one it can't load is a void) is reported in
R1's void count and decides nothing.

## F. The second adversarial review's findings (on E's fixes)

| # | Finding | Fix |
|---|---|---|
| F1 | Model switches still hid: behind relabelled roles, in a scan's calls counted in the denominator, or on a few cases of many | Role labels unread; a scan's calls left out; two cases where one arm alone called a model or a model's output share moved 40% were a switch (removed 2026-10-26 with the hold, C3) |
| F2 | A checkpoint's R1 warm-up ran under a name outside `real/` | Every R1 run name starts `real-` (A5) |
| F3 | Render could still be gamed: a cache of the new element's own content hit from the second timed run; work left for after render() returned, or for the first read of the applied board, went untimed; SVG effects cost the browser after the timing | The last change nudged on every run; the board read back inside the apply; a stage still changing after render() vetoes; SVG effects are the owner's (A2) |
| F4 | First drawing counted any new signature of a shape already there (a 1-unit nudge, a faint recolour), a pictured shape's styled box, a default-stroked filled element, a near-white that wasn't pure white | The visible-change rule for existing shapes, content-only for pictured shapes, near-white by channel, outlines only where named or unfilled, opacity 0.2, sizes on screen (A1) |
| F5 | Paying work outside the budget gate: judged scans, top-up sessions, continuation sends, the failure analyst | All wait out the pause; the failure analyst is skipped while paused (A4) |
| F6 | Debt was confirmed against L even for a metric whose chain started later; an unconfirmed check left the same chain to start debt again | Checked against each signalling metric's chain start; unconfirmed, L moves (D2) |
| F7 | A lost case counted as an empty send (one hiccup in 32 is 3.1 points, over the 2-point veto) and as a loss at checkpoints | Left out of the work, empty-send and failed-picture rates and the failure analyst; a void at checkpoints; R1 counts it against the failed arm's checks, each arm over its own cases |
| F8 | The two engines could time different content (lines one engine applies and the other doesn't, a board loaded differently) in different views; an engine failing on its own board lost only its render | Lines applied and board as loaded compared, a mismatch leaves the case without render; one view; failing on its own board is that arm's loss (A2) |
| F9 | A page load that never finished hung the loop | Loads and reloads time out at 60 s |
| F10 | Slots waiting out the pause together counted it once each; the gateway's night cap had its own night and default | The pause counted once in wall-clock time; the night cap is the loop's rule only (A4) |
| F11 | The diffscan's S and N read each case's one recorded clock: a change whose output moves with timing the bank never recorded can still read as S | Reported: G3's held-out replays on their own clocks are the second look, and checkpoints judge every case |
| F13 | `bank rerecord` could leave a case without `replies.json` if it stopped mid-swap | The old file copied aside, the new one copied to a temp name, then renamed over |
| F14 | A combo's near-wins each had a card's chance of a false keep; a latency sweep pruned on its fidelity Z | A combo shares one card's error; a latency value prunes only on a veto (D3, G3) |
| F15 | Docs and labels: `Row.render`'s comment and the progress page called render a p90 frame | Fixed |

F12 (the visible-ink thresholds) is part of F4.

## G. The third adversarial review's findings (on F's fixes)

| # | Finding | Fix |
|---|---|---|
| G1 | A call the page drops on purpose (a losing copy, a missed speculation, a picture past its timeout) was metered as an API error: a transport failure, re-sent, then the arm's loss (F7) or a void, so a copies card could never be measured and early drops handed out free wins | Metered as `dropped`, no error; the driver's bank sends no longer void on it either (and H1) |
| G2 | A new op or shape kind left the case without render, so a slower renderer on such a card couldn't be vetoed | Render compared board by board on what both engines share; over a quarter of a keep's cases without render goes to the owner (A2) |
| G3 | A latency sweep value's first-look revert is noise half the time, yet pruned the values beyond it | A latency value prunes only on a veto (D3) |
| G4 | Moving, resizing or fading a picture already on screen never counted, so such sends read their end | A visible change to a picture it already showed counts (A1) |
| G5 | A caption or element shown only until the picture came counted as its first drawing | Only content the shape's final state keeps counts (A1) |
| G6 | The effects gate missed CSS filters in style strings, `style.filter = x`, patterns, and flagged `const mask = "#000"` | String, CSS and style-property patterns, animations included (A2) |
| G7 | The deferral check waited one task and one frame | Two frames, 50 ms and an idle callback (A2) |

G8 (reported): a lost case drops out of the latency comparison, but enough of them to hide a tail veto pass the 10%
void cap first; an engine that times out on the other arm's board is charged as failing on its own, which is rare.

## H. A fourth, narrow pass on G's fixes

| # | Finding | Fix |
|---|---|---|
| H1 | Closing a query ends its stream cleanly: a call its page dropped after the process took it, or one the gateway's timeout closed, was recorded as a success, its reply cut short and cached (first write wins), and a later identical request could follow it | What stopped a call is noted: dropped by its page, it's `dropped` and never cached; closed by the timeout, it's an error; nobody may follow a stopped flight. A dropped call isn't in the case's record (replies.json) either |
| H2 | G2's owner hold counted only cases with no render, but a new shape kind leaves render on A's board alone and a new op its apply untimed | A case counts unless B's own board was compared whole (`Row.renderSame`) |
| H3 | G3's latency pruning still pruned on G3's direction rule and the quality-debt floor | Only a veto on speed, empty sends or failed pictures prunes a latency value |
| H4 | A picture at fade 1 (render dims it to 0.3, not out) read as invisible; a brief change to a shown picture, later undone, counted | Effective opacity; a change counts only if the shape ends changed |
| H5 | The effects gate flagged ordinary code (`filter: string`, `.blur()`, a `transition:` key, re-indenting today's fade filter) and missed SMIL, markup attributes, `setProperty`, `boxShadow` | CSS words only inside strings, style properties and animation APIs in code; only more effects added than removed |

## Removed on 2026-10-26: what never changed a decision

Two reviews of the harness found machinery that had never fired, or fired only falsely, in its history. The owner
approved deleting it ("simplify, don't harden"):

| What | Evidence | Now |
|---|---|---|
| Latency and quality debts, anchor moves, Q chains, era bridges | No debt ever started, the anchor never moved, and no bridge changed a decision | Every checkpoint runs the champion against A0, which never moves. A new judgeId or bench starts the next era, charted apart. A surely slower champion goes on the owner list |
| The night cap, the window share, the calibrated W | Every slot that spent money had a five-hour reading from the server; W once calibrated to 4.6e-05 | A slot's use is the server's five-hour reading, its week the seven-day one |
| The void rerun | Every rerun of a void voided again (the same harness asymmetry) | A void goes to the owner list; `rte decide --card` re-decides it once the cause is fixed |
| The over-use hold | Its only hold, e65-h2, was false (the champion was over the cap itself) | Over-use is reported per arm, never decides |
| Twelve latency tests per decision | 10.7% of changes that cost no latency reverted | One family-wise test, pooled on G2 and G3 (above) |
| Retiring the 40 oldest tuning cases at each bank refresh | It never ran (no refresh yet); the owner wants old cases kept | Every case stays. Past `LOOP.bank.scanMax` (800) tuning cases, each decision's free diffscan takes its own seeded sample of whole sessions, so none drops out for good |
| Warming a slot's first case only | 9 of 13 voids: a candidate's new prompt started cold, the champion's pools were warm | Every live case is warmed before it's timed |
| Sampled craft, cards' `predicts` and `raisesCost`, the cost and overrun knobs | Never read by a decision | Gone |
| The model-switch hold, and reading switches off each arm's calls | 0 of 125 decisions held on it; the owner opened every model, and routing sends between them, to the loop | A switch or a router is measured like any change (C3). A picture model switch's keep still waits for illustration calibration |

Why a decision went its way is now recorded as codes (`DecisionRow.codes`: latency, empty, pictures, heldout, floor,
no-change, owner, …); the search reads them, and reads the words only for rows written before.

**G0 is frozen as it stands.** A new gate, veto or hold needs evidence that it would have changed a decision in history,
and replaces a rule rather than adding one.

## The checks

All of `evals/checks/` at 0 real calls. Changed for v2: t2, t10 and t14 (Jev stubs and roles), t3 (later knobs and
owner defaults; the drawing call, which owner commits changed on purpose since T3, is left out of its byte-for-byte
comparison), t5 (90% / 50%), t6 (time to first drawing, visible ink only, render's frame), t13
(the new rules, the swap test's veto simulation on whole sessions, held-out cases from 4 sessions can't veto, A/A on
first drawing and render, `chainFrom`), t15 (Jev stand-ins, the parser tweak), t17, t18 (sections, card kinds, model
switches read off the calls, the owner's knob, a sweep's shared error), t20 (debt on two checkpoints in a row), t21
(the week fixture, the stop rules' new thresholds, the night cap's pause; its loop waits for AC power, as the loop
does), t22 (Jev as the default resolver), and t0's `SPEC_CONFIG_ID`. For F: t5 (no night cap in the gateway), t6
(existing shapes, pictured boxes and words, engine content and deferral), t13 (the deferral veto, a lost case isn't an
empty send, a combo's keep line, `sameContent`), t18 (role-blind model switches, SVG effects, latency sweep pruning),
t20 (debt checked against a metric's chain start, an unconfirmed check moves L). For G: t5 (a dropped call isn't an
error), t6 (kept content only, a grown picture), t13 (`sameContent` board by board, render unmeasured goes to the
owner), t18 (CSS effects, latency sweeps prune only on a veto), and t0's `SPEC_CONFIG_ID` (`renderUnmeasuredMax`). For
H: t5 (a call cut short mid-stream is dropped, never banked or followed), t6 (a faded picture), t13 (cases timed on A's
board alone count as unmeasured), t18 (effects moved, not added; ordinary code; G3's direction rule doesn't prune). For
the 2026-10-26 cleanup: t13 (one family-wise veto, its rates pinned again; decisions' codes), t20 (checkpoints against
A0 alone, eras without bridges), t5 and t21 (no night cap, W or void rerun), t15 (every case warmed; a moved median is a
schedule change whatever the session count), t18 (sweeps and near wins read codes), t23 (the real-use pipeline end to
end on invented sessions), and t0's `SPEC_CONFIG_ID`. `npm run checks` runs the fast ones, `-- --slow` all.

## Re-validation (before any run)

1. The same three kinds of review on the changed setup, the adversarial one last (and again on its fixes).
2. Every check in `evals/checks/` passing.
3. Commit, and push to the PGX.
4. On the PGX, what earlier triage and gold runs left in `cache/` and the run log moves under `real/` (E6).
5. One live, unshared A/A within the noise band.
6. `rte bank rerecord --cap n` (E10), then `rte real freeze` again.
7. The owner sees all of it before the loop starts. Still the owner's: labeling illustrations for the judge's
   calibration (about 25 minutes), and deploying a champion to prod.
