# rt-draw app: v1's UI on v2's engine

2026-10-20. The owner's decisions are marked **(owner)**. Choices I made without asking are marked **(my call)**, so the owner can push back on any of them.

## Intent

rt-draw v2 has been tuned by the eval loop until its sends are about twice as fast as the original. At ck-10, time to first change on screen (TTFC) had a median of 2.44 s against 5.79 s, and time to done had a median of 3.89 s against 7.11 s, with quality tied. That tuned version, merged into master as `6a9844e`, has never been something a person can use. The engine lives in playgrounds and in the eval bridge.

v1 (`~/projects/rt-draw`) is the opposite case: a finished, pleasant product UI on top of the old, slower HTML-wireframe engine.

This project puts the two together. **The product is v1's UI on v2's engine and backend (owner).** The owner will run it locally to test the speedups as a real product.

## What the person gets

**v1's UI (owner):** everything a person sees and touches comes from v1.

- **Boot:** the load screen with the boiling logo bubble, the animated favicon and the hand-drawn cursors.
- **Canvas look:** the full-screen dot-grid paper with its vignette, and the red-pencil pen.
- **Canvas controls:**
  - Press and drag draws. Wheel or two fingers pans.
  - Pinch or ctrl/⌘+wheel zooms. Space+drag or middle button pans. Arrow keys pan.
  - `H` toggles the hand tool, `+`/`-` zoom, and `Shift+1` fits everything.
  - The zoom controls sit bottom-left: hand, −, %, +, Fit.
  - A "Back to your pages" button appears when no page is in view.
  - A first-run hint pill appears.
- **Sidebar**, top-left:
  - The logo, and the project name (click it to rename).
  - The **Pages** list.
  - **History**: hover a version to see it, click to pin it, then **Restore** or **Latest**.
  - The Preview button is removed (see Non-goals).
- **Status badge**, top-center: "Drawing… N changes", "Couldn't draw that", and "Done" once the pictures are in.
- **Top-right tools:** New project, All projects, and the Settings gear.
- **Prompt bar**, bottom-center:
  - The captions row, the textarea and the mic toggle.
  - Send. It reads Queue while a send runs, and becomes Stop when a send runs and there is nothing new to send.
  - The "N drawings ×" chip.
- **Keys:** Enter sends, Shift+Enter adds a newline. Esc and Cmd/Ctrl+Z undo the last stroke.
- **Projects page** (`/projects`): cards with a thumbnail, click-to-rename, "N pages · N versions · ago", and Open and Delete (Delete asks for confirmation).
- **Settings menu:**
  - Model choice with prices.
  - Debug: the Latency overlay toggle, and Start from scratch.
- **Latency overlay**, bottom-right: see Latency below.
- v1's uncommitted sidebar fix (`src/page/Sidebar.tsx`, `src/styles.css` in v1's working tree) is the behaviour to copy:
  - A hovered history version shows only on the canvas; the Pages list stays on the latest board.
  - The Viewing bar appears only once a version is pinned.

**v2's engine and backend (owner):** what is on the board, and everything behind a send, comes from v2 unchanged.

- **Ops and rendering:** v2's shape ops (`src/core/ops.ts`) and renderer (`src/core/render.ts`) take the place of v1's wireframe ops and HTML pages. Pages are v2 frame shapes on its infinite board, drawn the v2 way, with pictures as v2 doodles.
- **A send** is v2's `send()` (`src/core/send.ts`). It is called the way the eval bridge calls it (`evals/bridge/main.ts:95-130`):
  - board mode, with the camera passed in;
  - no id tags in the render;
  - the scene redrawn at most once per animation frame (`bridge/main.ts:28-37`).

  What the eval measured is then what the product does.
- **Backend:** v2's dev-server API, unchanged:
  - `/api/model`: Claude on the subscription and Jev on TypeSafe AI.
  - `/api/stt-token`: ElevenLabs Scribe.
- **Tuning:** `DEFAULTS` from `src/core/tuning.ts`, which hold the champion's values. The product passes them unchanged, apart from the drawing model the person picks in Settings.

**Voice is talk, then Enter (owner).**

- While the mic is on, Scribe's words show live in the captions row and pile up.
- Nothing is sent until Enter.
- At Enter, the timed words go to `send()` together with the ink, on the ink's clock, as in `playgrounds/draw/main.ts:218-255`. That way "this" lines up with the stroke drawn while it was said.
- v1's send-as-you-talk behaviour is not built.
- **The mic stays on across sends (owner),** as v1's toggle did.
  - v2's speech code can only collect its last words by closing its connection: `ScribeEngine.stop()` sends a final commit and then closes the socket. Restarting an engine on the same running `Mic` would send all the audio again from the start.
  - So at Enter, the current engine is stopped and its words go to this send. At the same moment, a fresh `Mic`, Scribe token and socket start for the next send.
  - Words said after Enter, during the flush or while a send runs, belong to the next send, which queues as usual.
  - Fetch the next token ahead of time so the switch leaves as small a gap as possible.
  - This can be done with `speech.ts` unchanged. If a small, behaviour-neutral hook there makes it cleaner, that is allowed under the core-change constraint.
  - The mic turns off only when the person clicks it.

## Goals

1. **Local URL:** `npm run app` serves the product at a local URL.
   - The owner can draw, talk or type, press Enter, and watch shapes stream onto the board and pictures fill in.
   - Each send then shows in the overlay.
2. **Speed matches the eval:** a send is as fast as the eval measured. With warm processes, the overlay's TTFC and done times are in the same range as ck-10 (medians about 2.4 s and 3.9 s) for similar sends.
3. **Projects persist:** projects, their versions and their pictures survive a reload. Pictures are not redrawn when a project is reopened.
4. **The latency overlay measures what the eval measured.** It also shows each send's model calls with their timings (owner).

## Non-goals

- **Preview mode (owner).** v2's doodles aren't clickable HTML, so a faithful Preview would be new engine work. It is left out for now. The `/preview` route, the sidebar's Preview button, and the Preview buttons on project cards are removed.
- **Send-as-you-talk (owner).** That is v2 work no one has measured yet.
- **Models outside Claude (my call).** v2 reaches models only through the Claude subscription, so v1's OpenRouter models (GPT-6 Luna, Mercury) don't appear.
- **Hosting:** no production build, server, Docker or deploy (my call). v2's API exists only in the Vite dev server.
- **Telemetry (my call):** none of v1's browser telemetry or GlitchTip.
- **No changes to v2's core:** `src/core/*` and the tuning values, beyond what the product needs to hook in (see Constraints).
- **No changes to v1's repo**, the v2 playgrounds or the evals.

## Anti-goals

These would make it a failure even if it works:

- **Slower than the eval measured** for the same send. Causes would be: redrawing on every op, rendering id tags, a first send that starts cold, extra work at Enter, or a different call into `send()` than the bridge makes.
- **Looking like a v2 playground** instead of v1. No dev header bar, no tuning sliders, and no `shell()` chrome.
- **Losing a person's work:** a project that doesn't save, or a restore that can't be undone. In v1, restoring makes a new version, and that carries over.

## Latency overlay (owner: "latency overlay and model calls with latency too")

- **Layout:** v1's overlay as it is. The big number shows the latest send, there are stacked bars for the last 6 sends and a hatched span for pictures, and the median, p90 and first-change figures are shown.
- **Stages** (my call: they follow v2's send):
  - queue;
  - speech flush: the wait for Scribe's last words after Enter (up to 3 s), shown separately because the eval never measured it;
  - prompt: marks, ink links, board shots, alongside Jev;
  - Jev;
  - draw call to first text;
  - first op;
  - ops;
  - pictures;
  - camera settle.

  v1's ELK "layout" stage goes, because v2 has no layout step.
- **Clocks** (my call): the two headline numbers are the eval's own clock, `watch()`/`measure()` in `evals/bridge/timing.ts`, used as they are. The clock starts when `send()` is called, so the figures can be compared with ck-10's 2.44 s and 3.89 s. That clock defines them this way:
  - **TTFC:** the time until the first changed shape reaches its final state.
  - **Done:** the time until the last shape changes. The camera glide doesn't count.

  Queue wait, speech flush and camera settle each come before or after those clocks. They are shown as stages of their own, so nothing is hidden in the headline numbers. An "Enter → done" total is shown smaller beside them, for what the person actually felt.
- **Model calls:** each send's row expands into its calls: the two Jev calls, the drawing call, and each picture call. For each call it shows:
  - the model;
  - wait for a process, time to first text, total;
  - warm or cold;
  - tokens.

  The data is in `ModelStats` (`src/core/model.ts:17`) and the trace spans (`src/core/trace.ts`). Clicking a call opens v2's model-call inspector (`openCallInspector`, `src/callsView.ts:111`) to show the prompt and the reply (my call).
- **Visibility:** the overlay is off by default and switched on in Settings → Debug, as in v1. Debug is always shown, because this runs only locally (my call).

## Behaviour details (all my calls unless marked)

- **Pages list:**
  - v2's pages are `pagesOf(scene)` (`src/core/board.ts`), in the site map's reading order (top to bottom, left to right), named by `pageName`.
  - Pages are indented by how many link arrows (`linksOf`) lead to them from the first page, the way v1 indented sub-pages.
  - Clicking a page glides the camera to `pageTop(page)`.
- **History:**
  - Each finished send makes one version: the whole board as `Scene.toJSON()`, labelled with the send's words, or "(drawing only)".
  - Hovering a version renders it on the canvas instead of the live board. Pinning keeps it shown.
  - Restore replaces the whole board with it as a new version. v1 restored one page; a v2 board restores whole.
  - A stopped or failed send still makes a version if any op landed.
- **Queue and Stop:**
  - One send runs at a time, and a send lasts until `send()` returns: its pictures are drawn and its last glide is done. Enter during a send queues the new input, and queued sends run in order once the running one is done. v1 merged queued requests; sends are not merged here.
  - Overlapping sends would need a core hook. Two picture fillers would otherwise draw the same pictures twice, and the board shots would catch half-drawn pictures. It would also measure something the eval never ran, since every eval case ran alone. So the next send waits, usually a few seconds.
  - Stop aborts the running send through `send()`'s signal, pictures included. The board keeps what landed.
- **Ink:**
  - Strokes are captured with v2's `attachInk` (`src/core/ink.ts`), which gives the timed points `send()` needs.
  - They are drawn in v1's red-pencil look and numbered as v1 numbered them.
  - Every stroke is kept, because v2's marks read taps and short strokes as pointing. v1's under-40-px filter is dropped.
  - Strokes clear when their send starts, and the ink clock resets for the next send.
- **Typed text together with speech:** when both exist, the spoken words go first and the typed text is appended as words timed at Enter. Typed text alone goes as the string, as the bridge does for typed sends.
- **The camera and the window:**
  - v2's views always have the 1280×800 shape (`ASPECT` 1.6, `board.ts:18-20`), and the model's "what you see" shot assumes it.
  - The product's canvas fills the window, as v1's did.
  - The view passed to `send()` is `fitView` of the board area actually visible: the window minus the sidebar and the prompt bar, as v1's `visibleRect` does (`App.tsx:89-94`).
  - Camera ops glide the real window so that the view they name fills that visible area.
- **Warm start:** at page load, and again when the drawing model changes, warm the drawing processes the way the eval did before each case. The key must match exactly: `warmModel(model, promptOf("draw", t).system(true, scene.width, scene.height, 0, SCREEN.w), 2)`. The picture filler warms its own processes.
- **Model menu:**
  - Haiku 5.5, Sonnet 5.5 and Opus 5.5 set `draw.model` (0/1/2). Sonnet is the default, being what the eval tuned. Prices are shown as in v1.
  - Pictures stay on the tuned picture model.
  - The choice is kept per browser in localStorage, as v1 kept its choice.
- **Projects storage:**
  - v1's per-owner storage (`server/projects.ts` in v1), moved into v2's dev server as a Vite plugin: the owner cookie, `index.json` plus one append-only `<id>.ndjson` of versions per project, and the same routes.
  - It is kept under `RT_DATA_DIR`, default `.data`, which git ignores, at `.data/app/`.
  - The doc in each version is the v2 scene JSON. Page counts come from `pagesOf`.
  - Project thumbnails are v2 renders of the board, fitted into the card.
- **Memory:**
  - Cap the in-memory model-call list (`calls`, `model.ts:89`) and the span exporter (`trace.ts:19`) to the last 50 sends' worth. The bridge reloads before every case for this reason; a product page stays open.
  - That needs one small hook into those two files.
- **Fonts:** wait for `fontsReady()` before the first render. v2 measures text in Excalifont.
- **Errors:** missing keys and Jev or Claude failures show in the status badge ("Couldn't draw that") with the reason on hover. The mic's errors show in the captions row, as in v1.

## How it's built (my calls)

- **Where it lives:** in this repo (rt-draw-v2) under `app/`, so v2's engine and backend are imported directly, not copied.
- **A separate package:** `app/` has its own `package.json`, lockfile, `tsconfig.json` and typecheck script. Root `package.json`, `package-lock.json` and `tsconfig.json` stay unchanged, and root `npm run typecheck` doesn't cover `app/`. This keeps the eval loop able to resume on this repo:
  - its tree builder refuses a commit whose root lockfile differs from the harness clone's (`evals/loop/trees.ts`);
  - its first gate typechecks the root tree, and those root files are frozen for candidates (`evals/optimizer/gates.ts`).

  The cost of this choice: a change to a core signature can break `app/` without the root typecheck catching it, so `app/`'s own typecheck has to be run as well.
- **Port:** its own Vite config (`app/vite.config.ts`) and script, `npm run app`, on its own port. It shows the product at `/` and `/projects`, with v2's API plugins (`modelApi`, `sttToken`) and the new projects plugin. `npm run dev` and the playgrounds are untouched.
- **React:** React 19 and `@vitejs/plugin-react` are added, because v1's UI is React. v1's components, styles, sketch helpers, fonts and speech UI are copied into `app/` and adapted. v1's repo isn't imported from, so it stays independent.
- **The engine:** v2's `boardStage` is used as a basis, or replaced, as the canvas controls need. The rendering, ops, send, ink and speech come from `src/core/*`.

## Constraints

- Node 22 type stripping and Vite 8, as in the rest of the repo. TypeScript must pass `npm run typecheck`.
- **v2 core changes:** only small, behaviour-neutral hooks, such as capping memory, or an option the bridge doesn't use. Anything else in `src/core/*` changes what the eval measured.
- **Keys:** they come from v2's `.env`, which already has `CLAUDE_CODE_OAUTH_TOKEN`, `TYPESAFE_API_KEY` and `ELEVENLABS_API_KEY`.

## Left to the builder

- The component structure, and how v1's files are split between copying and rewriting.
- How canvas input is shared between v1's controls and v2's ink capture, as long as panning never draws.
- How the overlay gets its stage times: from trace spans, from `send()`'s hooks, or both.
- The exact sizes of the memory caps.
