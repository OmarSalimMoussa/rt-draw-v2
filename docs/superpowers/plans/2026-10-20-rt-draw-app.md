# rt-draw app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local product page that is v1's UI (sidebar, prompt bar, voice, projects, settings, latency overlay, sketchbook look) running v2's engine and backend with the champion's tuning, served at http://localhost:5180.

**Architecture:**
- A separate package in `app/` with React 19. It imports v2's engine (`src/core/*`), API plugins (`dev/model-plugin.ts`, `playgrounds/speech/token-plugin.ts`) and clock (`evals/bridge/timing.ts`) by relative path. It copies and adapts v1's UI files from `~/projects/rt-draw`.
- The pure logic (view math, page list, history, sender queue, latency stages, voice sessions) gets its own tested modules. React components and the board renderer wire them together.
- A send is exactly the eval bridge's call: `send(scene, {strokes, words}, tuning, hooks, camera)`.

**Tech Stack:** TypeScript 7 (Node 22 type stripping), Vite 8, React 19, Vitest 5 with happy-dom, rough.js, v2's core (OpenTelemetry spans, Claude Agent SDK on the subscription, Jev).

**Spec:** `docs/superpowers/specs/2026-10-20-rt-draw-app-design.md`. Read it before any task. **v1 source:** `/home/omar-moussa/projects/rt-draw`. Read it only; never modify it. Copy from its working tree, because its uncommitted `src/page/Sidebar.tsx` and `src/styles.css` edits are wanted.

## Global Constraints

- **Root files stay unchanged:** root `package.json`, `package-lock.json` and `tsconfig.json`.
- **`src/core/*` changes:** only Task 2's two hooks.
- **Root typecheck:** `npm run typecheck` (root) must still pass after every task.
- **`app/` checks:** `npm --prefix app run typecheck` and `npm --prefix app test` pass after every task from Task 1 on.
- **Run command:** `npm --prefix app run dev` serves on port 5180 (`strictPort`).
- **Keys:** they come from the repo's `.env`: `CLAUDE_CODE_OAUTH_TOKEN`, `TYPESAFE_API_KEY`, `ELEVENLABS_API_KEY`. Never print their values.
- **Data:** the app's data goes under `RT_DATA_DIR` (default `<repo>/.data`), with projects at `.data/app/owners/<owner>/`.
- **Tuning:** use `DEFAULTS` from `src/core/tuning.ts`, except `draw.model` from the Settings menu. No other knob changes.
- **Rendering:** render with no id tags, and at most once per animation frame (as `evals/bridge/main.ts:28-37` does).
- **Models offered:** Claude only.

| Name | `draw.model` | Price $/Mtok in / out |
|---|---|---|
| Claude Sonnet 5.5 (default) | 1 | 2 / 10 |
| Claude Opus 5.5 | 2 | 4 / 20 |
| Claude Haiku 5.5 | 0 | 0.1 / 0.5 |

- **Out of scope:** Preview mode, send-as-you-talk, OpenRouter, telemetry, a production build, and the v1 repo.
- **Commits:** end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are the failure modes most likely to bite a person, with what they would expect. Each has a test in the task named.

1. **Pressing Enter twice quickly while the mic is on:** each send gets only its own words, and no word is sent twice. Test: Task 6, `two takes in a row each get only their own words`.
2. **A saved version changing after it was saved:** history versions must not change when the live board changes after a commit. Today `scene.toJSON()` can share objects with the live scene. Test: Task 4, `commit stores a copy the live board can't change`.
3. **A send that fails** (missing key, Jev 401, Claude error): the badge shows "Couldn't draw that" with the reason, and the next queued send still runs. Test: Task 5, `a failed send shows its error and the next one still runs`.
4. **Stop with sends queued:** Stop ends the running send, pictures included, and drops the queued ones, so nothing surprising runs afterwards. Test: Task 5, `stop aborts the running send and drops the queued ones`.
5. **A tiny or hidden visible area** (window shrunk, panels covering it): the camera passed to `send()` still comes out as a sane 1.6-shaped view. Test: Task 3, `sendView falls back to the whole canvas when the visible area is under 50 px`.

---

### Task 1: The app package and the projects API

**Files:**
- Create: `app/package.json`, `app/tsconfig.json`, `app/vitest.config.ts`, `app/vite.config.ts`, `app/index.html`
- Create: `app/server/http.ts` (a copy of v1 `server/http.ts`), `app/server/projects.ts` (from v1 `server/projects.ts`), `app/server/plugin.ts`
- Test: `app/server/projects.test.ts`

**Interfaces:**
- Produces:
  - `projectsApi(): Plugin` (Vite, `apply: "serve"`). It serves v1's routes unchanged: `GET /api/projects`, `GET /api/project?id=`, `POST /api/project/save | /rename | /delete`, and `POST /api/projects/reset`.
  - `registerProjects(router: Router): void` and `Router` (as in v1).

- [ ] **Step 1: Scaffold the package and install**

`app/package.json`:
- `"name": "rt-draw-app"`, `"private": true`, `"type": "module"`.
- Scripts: `"dev": "vite"`, `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`.
- Dependencies: `react ^19.3.0`, `react-dom ^19.3.0`, `roughjs 4.6.6`.
- devDependencies: `@types/node ^22.20.5`, `@types/react ^19.3.0`, `@types/react-dom ^19.3.0`, `@vitejs/plugin-react ^6.1.2`, `typescript ^7.0.2`, `vite ^8.3.4`, `vitest 5.0.3`, `happy-dom ^21.0.4`.

`app/tsconfig.json`:
- Root's `compilerOptions`, plus `"jsx": "react-jsx"`.
- `"types": ["vite/client", "node"]`.
- `"include": ["src", "server", "vite.config.ts", "vitest.config.ts"]`. The core files it imports get checked through those imports.

`app/vitest.config.ts`: `environment: "happy-dom"`, `include: ["src/**/*.test.ts", "server/**/*.test.ts"]`. Don't use `plugins` here, so the API plugins never run under tests.

Run: `npm --prefix app install`. Expected: `app/node_modules` exists, and `git status` shows no change to the root lockfile.

- [ ] **Step 2: Write the failing test** `app/server/projects.test.ts`

The test uses a `node:http` server on port 0, running a `Router` with `registerProjects`. `RT_DATA_DIR` is set to a fresh `mkdtemp` folder before `projects.ts` is imported.
- `a new browser gets an owner cookie and an empty list`: `GET /api/projects` → 200 `{projects: []}`, with a `set-cookie` header matching `/^rt_owner=[a-f0-9]{32};/`.
- `save then load returns the versions in order`: `POST /api/project/save {id:"abc123", versions:[{n:1, doc:{v:1}, at:1, label:"a"}], meta:{name:"Bakery", pages:1}}` with that cookie.
  - `GET /api/project?id=abc123` → `versions` has length 1 and `n` 1.
  - `GET /api/projects` → `[{id:"abc123", name:"Bakery", pages:1, versions:1, latest:{v:1}}]` (matched with `toMatchObject`).
- `a clashing version number is renumbered after the stored ones`: save `n:1` twice with labels "a" and "b". The second response's `versions.map(v => v.n)` equals `[1, 2]`.
- `rename and delete`:
  - After rename to "X", the list has `name: "X", named: true`.
  - After delete, the list is `[]`, and `GET /api/project?id=abc123` returns 404.
- `another browser doesn't see the projects`: a request with a different `rt_owner` cookie lists `[]`.
- `projects are kept under RT_DATA_DIR/app/owners`: `<tmp>/app/owners/<owner>/abc123.ndjson` exists after a save.

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm --prefix app test -- server/projects.test.ts`. Expected: FAIL, because `../server/projects.ts` can't be found.

- [ ] **Step 4: Copy and adapt the server files**

`http.ts` is v1's, verbatim. In `projects.ts`, change only these things from v1:
- The data folder is `join(process.env.RT_DATA_DIR || <repo>/.data, "app", "owners")`, read when each request is handled, so tests can set the env first. `<repo>` is `fileURLToPath(new URL("../..", import.meta.url))`.
- It imports `./http.ts`.

`plugin.ts`:
- `projectsApi()` mounts one middleware.
- Requests whose path starts with `/api/project` go to `router.handle(req, res)`; anything unmatched calls `next()`, and an error calls `next(err)`.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npm --prefix app test -- server/projects.test.ts`. Expected: 6 passed.

- [ ] **Step 6: The dev server config, then check the API in the running server**

`app/vite.config.ts`:
- `repo = resolve(import.meta.dirname, "..")`.
- `process.loadEnvFile(join(repo, ".env"))`. Vite's `loadEnv`, which the v2 plugins call with prefix `""`, also returns `process.env`, so the plugins see the keys.
- `process.env.RT_DATA_DIR ||= join(repo, ".data")`.
- `defineConfig({ root: import.meta.dirname, plugins: [react(), modelApi(), sttToken(), projectsApi()], server: { port: 5180, strictPort: true, fs: { allow: [repo] }, watch: { ignored: ["**/.data/**"] } } })`.
- If `Plugin` types from the two Vite copies clash, cast the v2 plugins with `as PluginOption`.

`app/index.html`: title `rt-draw`, `<div id="root"></div>`, `<script type="module" src="/src/main.tsx"></script>`.

Run `npm --prefix app run dev` in the background, then:
- `curl -s -X POST localhost:5180/api/stt-token` → JSON with a `token` field (not "ELEVENLABS_API_KEY is not set").
- `curl -s localhost:5180/api/model` → `{"error":"POST only"}`.
- `curl -s localhost:5180/api/projects` → `{"projects":[]}`.

Stop the server.

- [ ] **Step 7: Check that the root is untouched, then commit**

Run: `npm run typecheck && npm --prefix app run typecheck && git status --short package.json package-lock.json tsconfig.json`. Expected: both typechecks clean, and no root file listed.

```bash
git add app/package.json app/package-lock.json app/tsconfig.json app/vitest.config.ts app/vite.config.ts app/index.html app/server
git commit -m "App: its own package, and v1's projects API on v2's dev server"
```

---

### Task 2: Two core hooks for a page that stays open

**Files:**
- Modify: `src/core/model.ts:173` (call numbering) and add `forgetCallsBefore`.
- Modify: `src/core/trace.ts` to add `forgetSpansBefore`.
- Test: `app/src/core-hooks.test.ts`

**Interfaces:**
- Produces:
  - `forgetCallsBefore(n: number): void`: drops every `CallRecord` whose `n < n`, then fires `CALLS_EVENT`.
  - `forgetSpansBefore(ms: number): void`: keeps only finished spans that started at or after `ms` (`performance.now()` ms).
  - Call numbers come from a counter that never repeats. Today `calls.length + 1` would repeat once records are dropped.

- [ ] **Step 1: Write the failing test** `app/src/core-hooks.test.ts`

- `call numbers keep counting after old calls are forgotten`:
  - Stub `fetch` with a `Response` whose body streams `{"text":"hi"}\n{"done":true,"model":"sonnet","ms":5}\n`.
  - Make 3 calls with `callModel({model:"sonnet", system:"s", user:"u"})`, then `forgetCallsBefore(3)`, then make one more call.
  - Expect `calls.map(c => c.n)` to equal `[3, 4]`.
- `forgetSpansBefore keeps the newer spans`:
  - Run `await span("old", undefined, () => {})`, note `cut = performance.now()`, then run `await span("new", undefined, () => {})`.
  - Call `forgetSpansBefore(cut)`.
  - Expect `finished().map(s => s.name)` to equal `["new"]`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm --prefix app test -- src/core-hooks.test.ts`. Expected: FAIL, because `forgetCallsBefore` is not exported.

- [ ] **Step 3: Implement the two hooks**

- `model.ts`: add `let made = 0` and set `n: ++made` in `record()`. `forgetCallsBefore` splices `calls` in place, because `calls` stays the exported array.
- `trace.ts`: filter `exporter.getFinishedSpans()`, then `exporter.reset()`, then `exporter.export(kept, () => {})`.

- [ ] **Step 4: Run the tests, plus the root typecheck**

Run: `npm --prefix app test -- src/core-hooks.test.ts && npm run typecheck`. Expected: 2 passed, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/model.ts src/core/trace.ts app/src/core-hooks.test.ts
git commit -m "Model calls and spans can be forgotten, for a page that stays open (call numbers keep counting)"
```

---

### Task 3: View math and the page list

**Files:**
- Create: `app/src/canvas/view.ts`. It is v1's `src/canvas/view.ts` with `MIN_ZOOM` set to 0.02, so a camera op that shows a whole board fits.
- Create: `app/src/board/pages.ts`
- Test: `app/src/canvas/view.test.ts`, `app/src/board/pages.test.ts`

**Interfaces:**
- Consumes: from `src/core/board.ts`: `fitView`, `pagesOf`, `pageName`, `linksOf`, `pageTop`, `union` and `ASPECT`; and `Box` from `src/core/scene.ts`.
- Produces, in `view.ts`:
  - v1's `View`, `Point`, `CanvasApi`, `toScene`, `toScreen`, `zoomAt`, `panBy` and `clampZoom`.
  - `type Rect = { left: number; top: number; right: number; bottom: number }`: screen px, the canvas area the panels leave uncovered.
  - `boardRect(v: View, size: { width: number; height: number }): Box`: the board area the whole canvas shows.
  - `seenRect(v: View, r: Rect): Box`: the board area inside `r`.
  - `sendView(v: View, r: Rect, size: { width: number; height: number }): Box`: `fitView(seenRect(v, r), 0)`. If `r` is under 50 px wide or tall, it is `fitView(boardRect(v, size), 0)` instead.
  - `viewShowing(box: Box, r: Rect): View`: the view in which `box` just fits inside `r`, centred, with zoom clamped.
  - `glideAt(from: View, to: View, u: number, r: Rect): View`: the view at progress `u` (0 to 1) of a glide. It uses cubic in-out easing. Zoom is interpolated in log scale, and so is the board point at `r`'s centre.
- Produces, in `pages.ts`:
  - `type PageRow = { id: string; name: string; depth: number; home: boolean }`.
  - `pageRows(scene: Scene, t?: Tuning): PageRow[]`.
    - Order: pages top to bottom, then left to right, compared as `a.box.y - b.box.y || a.box.x - b.box.x`, as `siteMap` sorts.
    - `depth`: the number of link arrows (`linksOf`, from → to) on the shortest path from the first page. An unreachable page has depth 0.
    - `home`: true for the first page only.
  - `siteName(scene: Scene): string`: the words of the topmost shape with text on the first page (not the frame itself), cut to 40 characters, or `"Untitled"`.

- [ ] **Step 1: Write the failing tests**

`view.test.ts`:
- `boardRect is what the whole canvas shows`: `boardRect({scrollX:-100, scrollY:-50, zoom:2}, {width:800, height:600})` → `{x:100, y:50, w:400, h:300}`.
- `seenRect is what the uncovered area shows`: at zoom 1 with no scroll, rect `{left:262, top:64, right:788, bottom:488}` → `{x:262, y:64, w:526, h:424}`.
- `sendView has the screen's shape and holds what is seen`: `w / h` is within 1e-9 of 1.6, and all four corners of `seenRect` are inside it.
- `sendView falls back to the whole canvas when the visible area is under 50 px` (Review Focus 5): a rect 20 px tall gives `fitView(boardRect(v, size), 0)`.
- `viewShowing fits the box in the visible area`: for `box = {x:0, y:0, w:1280, h:800}`, `seenRect(viewShowing(box, r), r)` contains `box` and equals it, within 1e-6, on the tighter axis.
- `viewShowing clamps a huge box to MIN_ZOOM`: a box 100000 wide gives zoom 0.02.
- `glideAt starts and ends where it should, with zoom halfway in log scale`: `u = 0` gives `from`, `u = 1` gives `to` (within 1e-9), and at `u = 0.5` the zoom is `Math.sqrt(from.zoom * to.zoom)`.

`pages.test.ts` uses the scene from `runScript`:

```
shape(home, frame, 0 0 1280 800, "the Home page")
text(home, "Home")
shape(logo, rect, 40 20 200 40, "the bakery's name at the top left of the header")
text(logo, "Crumb & Co bakery")
shape(shop, frame, 1400 0 1280 800, "the shop page")
text(shop, "Shop")
shape(cart, frame, 2800 0 1280 800, "the cart page")
text(cart, "Cart")
shape(a1, arrow, 1280 400 120 0, "a link from home to the shop page")
shape(a2, arrow, 2680 400 120 0, "a link from the shop to the cart page")
shape(about, frame, 0 1000 1280 800, "the about page")
text(about, "About")
```

- `pages come in reading order with their link depth`: `[{id:"home", name:"Home", depth:0, home:true}, {id:"shop", depth:1}, {id:"cart", depth:2}, {id:"about", depth:0, home:false}]` (matched with `toMatchObject`).
- `a board without pages has no rows`: `pageRows(new Scene())` is `[]`.
- `siteName is the topmost text on the first page`: gives `"Crumb & Co bakery"`. A board with only a blank Home gives `"Untitled"`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm --prefix app test -- src/canvas src/board/pages.test.ts`. Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement `view.ts` and `pages.ts`** to the signatures above.

- [ ] **Step 4: Run them to make sure they pass**

Run: the same command. Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/canvas/view.ts app/src/canvas/view.test.ts app/src/board/pages.ts app/src/board/pages.test.ts
git commit -m "App: v1's view on v2's board (what's seen, what's sent, camera glides), and the page list"
```

---

### Task 4: History

**Files:**
- Create: `app/src/board/history.ts`
- Test: `app/src/board/history.test.ts`

**Interfaces:**
- Consumes: `SceneJSON` from `src/core/scene.ts`.
- Produces:
  - `type Version = { n: number; doc: SceneJSON; at: number; label: string }`. It has the same shape as v1's stored version, so the server is unchanged.
  - `class History`:
    - `constructor(versions: Version[])`
    - `versions: Version[]`
    - `looking?: number`
    - `pinned: boolean`
    - `latest(): number` (0 when empty)
    - `doc(n: number): SceneJSON | undefined`
    - `newestFirst(): Version[]`
    - `commit(doc: SceneJSON, label: string, at?: number): Version`: stores `structuredClone(doc)` as `n = latest() + 1`.
    - `look(n: number | undefined, pin?: boolean): void`
    - `stopLooking(): void`
    - `restore(n: number): Version`
  - The `look` and `restore` semantics are v1's (`src/page/store.ts:349-373`), for the whole board.

- [ ] **Step 1: Write the failing test** `history.test.ts`

- `commit numbers each version after the latest`: versions get `n` 1 and 2, and `latest()` is 2.
- `commit stores a copy the live board can't change` (Review Focus 2): build `j = scene.toJSON()`, commit it, then `applyOp` a recolour on `scene` and mutate `j.shapes[0].box.x`. `doc(1)` is still deep-equal to the JSON taken before.
- `hovering looks at a version and the latest stops looking`: `look(1)` sets `looking` to 1; `look(2)`, the latest, clears it; `look(undefined)` clears it.
- `a clicked version stays until another is clicked`: after `look(1, true)`, `look(2)` leaves `looking` at 1; `look(2, true)` clears it, because 2 is the latest.
- `restore adds the old board as a new version and keeps the rest`:
  - `restore(1)` returns `{n: 3, label: "Restored V1"}`, with `doc` deep-equal to `doc(1)`.
  - `versions.length` is 3, and `looking` is undefined.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm --prefix app test -- src/board/history.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `History`**

- [ ] **Step 4: Run it to make sure it passes**

Run: the same command. Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/board/history.ts app/src/board/history.test.ts
git commit -m "App: board history (look, pin, restore), versions copied so the live board can't change them"
```

---

### Task 5: Latency log and the sender queue

**Files:**
- Create: `app/src/board/latency.ts`, `app/src/board/sender.ts`
- Test: `app/src/board/latency.test.ts`, `app/src/board/sender.test.ts`

**Interfaces:**
- Consumes:
  - **Types only:** `SendInput`, `SendHooks` and `Sent` from `src/core/send.ts`; `Stroke` from `src/core/ink.ts`; `Word` from `src/core/link.ts`; `Clock` from `evals/bridge/timing.ts`; `CallRecord` from `src/core/model.ts`.
- Produces, in `latency.ts`:
  - `type SendTimes`. All times are `performance.now()` ms. The fields:
    - `n`, `label`, `spoken`, `model`, `enter`
    - `words?`: Scribe's last words are in
    - `start?`: `send()` was called
    - `prompt?`: `onPrompt`
    - `firstText?`: the drawing call's first text
    - `firstOp?`: the first op that is ok and not a camera op
    - `reply?`: `onReply`
    - `pictures?`: `start + sent.pics.ms`, else `reply`
    - `end?`: `send()` returned
    - `ttfcMs?`, `ttdMs?`: the eval's clock, from `start`
    - `changes`, `rejected`, `status: "queued" | "running" | "done" | "stopped" | "error"`, `error?`
    - `callsFrom`, `callsTo`: model calls with `callsFrom < n ≤ callsTo` belong to this send
  - `PHASES`, in this order, each with `{key, label, hint}`:
    1. `listen`: Scribe's last words after Enter
    2. `queue`: waiting for the send before
    3. `prompt`: marks, ink links, board shots, Jev
    4. `model`: drawing call to first text
    5. `line`: first change
    6. `changes`: the rest of the reply
    7. `pictures`: pictures drawn
    8. `camera`: last glide settling

    Their step ends are `[words, start, prompt, firstText, firstOp, reply, pictures, end]`.
  - `segments(t: SendTimes, now: number): { key; from; ms }[]`: v1's algorithm (`src/agent/latency.ts:96-140`) over these ends.
    - Each segment runs from the previous end. The previous end is the max of the ends so far.
    - A missing end is skipped once the send is over. While the send is live, the first missing step grows to `now` and the list stops there.
    - With no changes, a missing `firstOp` is taken as `reply`.
  - `isLive(t, now)`: true while `status` is `"queued"` or `"running"`, or while `end` is set but `ttfcMs` and `ttdMs` aren't yet.
  - `class LatencyLog`: `{ sends: SendTimes[]; begin(t): SendTimes; touch(); clear(); subscribe; getVersion }`. It keeps the newest 50 sends.
  - `callRows(calls: CallRecord[], t: SendTimes): CallRow[]`.
    - `CallRow = { n; who; model; waitMs?; firstMs?; ms?; warm?; inTokens?; outTokens?; running; error? }`.
    - `who` is `req.from`, except that Jev models read `"Jev · " + from`.
  - `fmtMs`: v1's.
- Produces, in `sender.ts`:
  - `type Job = { label: string; spoken: boolean; strokes: Stroke[]; words: Promise<Word[] | string>; enter: number }`.
  - `type SenderDeps`:
    - `run: (input: SendInput, hooks: Pick<SendHooks, "onPrompt" | "onOp" | "onReply" | "signal">) => Promise<Sent>`
    - `model: () => string`
    - `clock: () => Pick<Clock, "enter" | "measure"> | undefined`
    - `lastCall: () => number`
    - `frame?: () => Promise<void>`: defaults to two `requestAnimationFrame`s
    - `onStart?: (job: Job) => void`
    - `onEnd: (job: Job, landed: number, error?: string) => void`
    - `log: LatencyLog`
  - `type SendStatus = { running: boolean; queued: number; ops: number; settling: boolean; done: boolean; error?: string; rejected: number }`.
  - `class Sender`:
    - `enqueue(job)`
    - `stop()`
    - `firstText(at?: number)`: marks the running send's drawing call's first text.
    - `getStatus(): SendStatus` (a stable object between changes, for `useSyncExternalStore`)
    - `subscribe(fn): () => void`
  - **The sequence for one job:**
    1. `begin` the times, with status `queued`. Set `times.words` when `job.words` settles.
    2. Wait for the previous job, then for the words.
    3. Skip the job if it was dropped.
    4. `onStart`, then `start`, `before = clock()?.enter()` and `callsFrom = lastCall()`.
    5. `await run(...)` with an `AbortController` signal.
    6. Set `pictures` and `end`, then `await frame()`.
    7. Measure: `ttfcMs` and `ttdMs` from `clock.measure(before, start)`. If nothing changed, `ttdMs` is `end - start`, as the bridge does.
    8. Set `callsTo = lastCall()`, then `onEnd`.
    - If `run` throws, `error` is its message and the queue goes on.

- [ ] **Step 1: Write the failing tests**

`latency.test.ts`:
- `a finished send's segments run in order and add up`: with every end set, the keys are `PHASES` order, and the sum of `ms` equals `end - enter`.
- `a live send grows its first missing step`: with only `words`, `start` and `prompt` set, the last segment is `model`, ending at `now`.
- `words that arrive after the send before finished leave no queue time`: with `words > start`, the `queue` segment has `ms` 0.
- `callRows keeps this send's calls and names Jev`: calls with n 3 to 6, `callsFrom` 4 and `callsTo` 6 give `[5, 6]`. One with `req.model: "jev-1.13.0"` and `from: "draw-refs"` reads `who: "Jev · draw-refs"`.

`sender.test.ts`:
- The fake `run` returns a deferred you resolve by hand; `frame` resolves at once.
- The fake `clock.measure` returns `{ttfcMs: 100, ttdMs: 300, changed: ["x"]}`.
- `lastCall` returns a counter the test bumps.

The tests:
- `runs one send at a time, in order`: enqueue A and B. `run` is called once until A's deferred resolves, then twice, with B's strokes.
- `waits for the words before starting`: while `job.words` is pending, `run` isn't called. Resolving it with `"make it blue"` calls `run` with `{words: "make it blue"}`.
- `a failed send shows its error and the next one still runs` (Review Focus 3): A's `run` rejects with `"CLAUDE_CODE_OAUTH_TOKEN is not set in .env"`. `getStatus().error` has that text, `onEnd` gets it, and B's `run` is still called.
- `stop aborts the running send and drops the queued ones` (Review Focus 4): with A running and B queued, `stop()` sets A's `signal.aborted`. B's `run` is never called. Once A settles, status is `{running:false, queued:0}`, and B's times have status `"stopped"`.
- `counts landed ops: ok and not a camera`: calling `onOp` with ok, ok+camera, ok and not-ok gives `onEnd(job, 2, undefined)`, and the times have `rejected` 1.
- `measures with the eval's clock from send start`: `measure` is called with `(before, times.start)`, and the times get `ttfcMs` 100 and `ttdMs` 300.
- `records the calls made during the send`: `lastCall` is 5 at start and 9 at end, giving `callsFrom` 5 and `callsTo` 9.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm --prefix app test -- src/board/latency.test.ts src/board/sender.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `latency.ts` and `sender.ts`** to the interfaces above.

- [ ] **Step 4: Run them to make sure they pass**

Run: the same command. Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/board/latency.ts app/src/board/latency.test.ts app/src/board/sender.ts app/src/board/sender.test.ts
git commit -m "App: sends run one at a time (queue, stop, errors), timed by stage and by the eval's clock"
```

---

### Task 6: Voice that stays on across sends

**Files:**
- Create: `app/src/speech/voice.ts`
- Test: `app/src/speech/voice.test.ts`

**Interfaces:**
- Consumes: the types `SpeechEvents`, `Utterance` and `Word` from `src/core/speech.ts`. The real `Mic` and `ScribeEngine` are passed in by the app.
- Produces:
  - `type MicLike = { start(): Promise<void>; stop(): void }` and `type EngineLike = { start(): Promise<void>; stop(): Promise<void> }`.
  - `type VoiceDeps = { mic: () => MicLike; engine: (events: SpeechEvents, mic: MicLike) => EngineLike }`.
  - `class Voice`:
    - `listening: boolean`
    - `interim: string`: the current partial text
    - `heard: string`: final text since the last take
    - `error?: string`
    - `subscribe`, `getVersion`
    - `start(): Promise<void>`
    - `stop(): Promise<void>`: flushes; the words wait for the next `take`
    - `take(): Promise<Word[]>`: words on the page clock
  - `onInkClock(words: Word[], epoch: number): Word[]`: `t0` and `t1` become `Math.round(t - epoch)`.
  - `withTyped(words: Word[], typed: string, at: number): Word[] | string`.
    - No words: returns `typed`.
    - Words and typed text: returns the words, then each typed word as `{word, t0: at, t1: at}`.
- **How a session works:**
  - Each session is one `MicLike` plus one `EngineLike`: mic first, then the engine.
  - **`take()` while listening:** open a new session first, without awaiting it. Then stop the old engine, wait for its flush, and stop its mic. Return the finished words collected for the old session.
  - **A closed session:** a session closed while still starting stops its own mic and engine once their `start` resolves, and its words are dropped.
  - **No token prefetch:** `ScribeEngine` sends the mic's audio from sample 0 once its socket opens, so the token wait loses nothing. The only gap is the new mic's start. This settles the spec's "fetch the next token ahead" in a way that needs no change to `speech.ts`.

- [ ] **Step 1: Write the failing test** `voice.test.ts`

The fake engines record their events, so the test can call `events.onFinal(utterance)` on any of them. `stop()` resolves after an optional "flush" utterance the test sets.

- `take() returns the finished words plus what the flush brings`: engine 1 emits `["make","it"]`, its flush brings `["blue"]`, and `take()` resolves to those three words in order.
- `while listening, take() opens a fresh session first`: after `take()`, `deps.engine` has been called twice. Engine 2 was started before engine 1's `stop` resolved, and `listening` is still true.
- `two takes in a row each get only their own words` (Review Focus 1): engine 2 emits `["bigger"]` after the first `take()`. The second `take()` resolves to `["bigger"]`, and no word appears in both results.
- `stop() keeps the words for the next take and opens nothing`: emit `["hello"]`, then `stop()`. `listening` is false, `take()` gives `["hello"]`, and `deps.engine` was called once.
- `heard is the final text since the last take`: after `onFinal` with "make it blue", `heard` is `"make it blue"`; after `take()`, it is `""`.
- `onInkClock and withTyped`:
  - `onInkClock([{word:"a", t0:1500.4, t1:1700.6}], 1000)` → `[{word:"a", t0:500, t1:701}]`.
  - `withTyped([], "make it blue", 0)` → `"make it blue"`.
  - `withTyped([w], "now", 900)` ends with `{word:"now", t0:900, t1:900}`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm --prefix app test -- src/speech/voice.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `voice.ts`**

- [ ] **Step 4: Run it to make sure it passes**

Run: the same command. Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/speech app/src/speech/voice.test.ts
git commit -m "App: the mic stays on across sends, each Enter taking only its own words"
```

---

### Task 7: v1's chrome, with projects on v2 boards

**Files:**
- Copy from v1's working tree, adapting imports:
  - `src/sketch/{cursors,favicon,icons,Icon,logo,Logo,rough}.ts(x)` → `app/src/sketch/`
  - `src/styles.css` → `app/src/styles.css`
  - `src/page/fonts/*` → `app/src/fonts/`
  - `src/canvas/marks.ts` → `app/src/canvas/marks.ts` (only `isLoop`, `simplify`, `polygonBox` and `Point` are needed)
- Create, from v1:
  - `app/src/router.ts`: `Route = "editor" | "projects"`.
  - `app/src/Root.tsx`: no Preview route and no telemetry `record`.
  - `app/src/settings.ts`, `app/src/SettingsMenu.tsx`.
  - `app/src/StatusBadge.tsx`: takes `SendStatus`.
  - `app/src/projects/storage.ts`: `Version` from `history.ts`; `doc` is `SceneJSON`; no doodles.
  - `app/src/projects/ProjectsPage.tsx`, plus `app/src/projects/projects.css` (v1 `page.css`'s `px-*` rules).
- Create: `app/src/models.ts`, `app/src/main.tsx`, and `app/src/App.tsx` (the chrome only, in this task).

**Interfaces:**
- Consumes: `History`/`Version` (Task 4), `pageRows`/`siteName` (Task 3), `SendStatus` (Task 5), and `render`, `Scene`, `runScript`, `asPage`, `fitView`, `pagesOf`, `boardBounds` and `fontsReady` (`src/ui.ts:68`) from v2.
- Produces:
  - `type DrawModel = { name: "sonnet" | "opus" | "haiku"; label: string; knob: 0 | 1 | 2; price: [number, number] }`.
  - `DRAW_MODELS`, with values from Global Constraints and Sonnet first.
  - `tuningFor(m: DrawModel): Tuning`: `DEFAULTS` when `m.knob === DEFAULTS["draw.model"]`, else `tune({"draw.model": m.knob})`.
  - `getModel(): DrawModel` and `setModel(name)`: localStorage key `rt-draw.model`.
  - `showsLatency`, `setShowsLatency` and `onSettings`: v1's.
  - `blankBoard(): SceneJSON`: `runScript(asPage("", "page", "Home")).scene.toJSON()`, the eval's blank start.
  - v1's storage functions: `ready`, `ensureProject`, `listProjects`, `loadVersions`, `saveVersions`, `createProject`, `renameProject`, `deleteProject`, `currentProjectId`, `latestDoc` (returns `blankBoard()` when empty), `ago` and `deleteAllProjects`.
  - `metaFor` counts pages with `pageRows`, and names a project with `siteName`.
  - `Thumb({ doc }: { doc: SceneJSON })`: a v2 `render` into an `<svg>` with `view = fitView(pages ? union(page boxes) : boardBounds, 0.03)`.
- **Changes from v1:**
  - Settings menu note: "Prices are USD per million tokens in / out. Pictures are drawn with Claude Sonnet 5.5, and Jev (TypeSafe AI) works out what you point at."
  - Projects card: no Preview link, and no sessions list.
  - CSS: `styles.css` also defines `--paper: var(--bg)`, `--ink`, `--panel`, `--line`, `--muted` and `--mono` on `:root`, so v2's model-call inspector modal is styled.

- [ ] **Step 1: Copy the files and adapt their imports.** `main.tsx` follows v1's (`src/main.tsx`), with telemetry removed. After `await ready()` it adds `await fontsReady()`, because v2 measures text in Excalifont.

- [ ] **Step 2: Typecheck and run the tests**

Run: `npm --prefix app run typecheck && npm --prefix app test`. Expected: clean, and all earlier tests pass.

- [ ] **Step 3: Check it in the browser**

Start `npm --prefix app run dev` in the background, and open http://localhost:5180 with Claude in Chrome. Expected:
- The load screen's bubble animates, then the editor's chrome appears on dot-grid paper.
- The sidebar shows "Untitled" and Pages: Home, and History says "Nothing yet…".
- The gear lists Sonnet (default), Opus and Haiku with prices, plus a Debug section.
- `/projects` shows one card with a thumbnail of a blank Home page, and Open and Delete (no Preview).
- No errors in the console.

- [ ] **Step 4: Commit**

```bash
git add app/src
git commit -m "App: v1's chrome (load screen, sidebar, settings, status, projects) over v2 boards"
```

---

### Task 8: The board, the pen and the send

**Files:**
- Create:
  - `app/src/canvas/Canvas.tsx`, from v1 `src/canvas/Canvas.tsx`
  - `app/src/canvas/strokes.ts`
  - `app/src/sketch/MarkSketch.tsx`, from v1
  - `app/src/board/board.ts`
  - `app/src/board/BoardView.tsx`
- Modify: `app/src/App.tsx` to wire everything, and the Sidebar (copied from v1 `src/page/Sidebar.tsx` working tree into `app/src/Sidebar.tsx`).
- Test: `app/src/canvas/strokes.test.ts`

**Interfaces:**
- Consumes: everything above; `send` (`src/core/send.ts`), `span` (`src/core/trace.ts`), `warmModel`, `modelOf` and `calls`/`CALLS_EVENT` (`src/core/model.ts`), `promptOf` and `thinkingOf` (`src/core/prompts.ts`), `SCREEN` and `pageTop` (`src/core/board.ts`), `groupStrokes` (`src/core/marks.ts`), `watch` (`evals/bridge/timing.ts`), and `Mic` and `ScribeEngine` (`src/core/speech.ts`).
- Produces:
  - **Canvas changes from v1.** Prop `backdrop?: ReactNode` is drawn first inside `.cv`, in screen coordinates. Prop `onStroke?(raw: Pt[], downAt: number, upAt: number)` replaces `onMark`.
    - Raw points are `[x, y, performance.now()]`, with x and y in scene coordinates rounded to 0.1.
    - Points include `getCoalescedEvents()`.
    - There is no 40 px filter.
  - `toStroke(id: number, raw: Pt[], downAt: number, upAt: number, epoch: number): Stroke`: every `t`, `t0` and `t1` becomes `Math.round(time - epoch)`.
  - **`class Board`** (the editor's state, after v1's PageStore without the HTML):
    - `project`, `scene: Scene`, `history: History`, `tuning: Tuning`
    - `subscribe`, `getVersion`
    - `shown(): Scene`: the looked-at version, parsed once per n, else the live scene
    - `draw()`: one animation frame later, paints through `onPaint` and notifies subscribers
    - `onPaint(fn): () => void`
    - `commit(label)`: `history.commit(scene.toJSON(), label)`, then `saveVersions`
    - `look`, `stopLooking`, `restore(n)`: restore replaces `scene` with `Scene.fromJSON(doc)` and commits
    - `open(id)`, `newProject()`, `rename(name)`, `meta()`, `isEmpty()` (no versions yet)
  - `BoardView({ board, view, size, onSvg })`:
    - A screen-sized `<svg className="bd">`.
    - Paint calls `render(svg, board.shown(), { tuning: board.tuning, view: boardRect(view, size) })`. It then sets the first root `<rect>`'s `fill` to `none`, so the paper shows.
    - A view change alone only sets `viewBox` and that rect's box, as `src/boardStage.ts:23-31` does.
    - It hands the element to `onSvg` once.
- **What the App wires up:**
  - **Visible rect:** v1's (`App.tsx:89-94`): left = sidebar right + 12, top = 64, right = width − 12, bottom = prompt bar top − 12.
  - **The `Sender`'s `run`:**

    ```ts
    run = (input, hooks) => span(`send ${n}`, undefined, (ctx) =>
      send(board.scene, input, board.tuning, { ...hooks, parent: ctx, draw: board.draw, setView: glideTo },
        sendView(viewRef.current, visibleRect(), canvas.size())))
    ```
    `glideTo(v: Box, ms?: number): Promise<void>` animates the canvas view to `viewShowing(v, visibleRect())` with `glideAt`. A new glide cancels the one running.
  - **The `Sender`'s other deps:**
    - `clock` is `watch(svg)` from `onSvg`.
    - `lastCall` is `calls.at(-1)?.n ?? 0`.
    - `onStart` is `board.stopLooking`.
    - `onEnd` commits if `landed > 0`. It then calls `forgetCallsBefore(oldest kept send's callsFrom + 1)` and `forgetSpansBefore(oldest kept send's enter)`.
  - **First text:** a `CALLS_EVENT` listener calls `sender.firstText()` when the newest `from: "draw"` call is running with a non-empty `reply`.
  - **Enter (`submit`):**
    - `enter = performance.now()`.
    - `words = voice.take().then(ws => withTyped(onInkClock(ws, epoch), typed, Math.round(enter - epoch)))`.
    - `label` is the typed text, else `voice.heard + voice.interim`, else `"(drawing only)"`.
    - Enqueue `{label, spoken: !typed, strokes, words, enter}`. Then clear the strokes and the textarea, and set `epoch = performance.now()`.
    - Send is enabled when there is typed text, strokes, or voice text (`heard` or `interim`).
  - **Ink display:** each stroke is a `MarkSketch` in red pencil. One number per `groupStrokes(strokes)` mark is shown at its box's top-left, as v1 placed numbers.
  - **Warm processes:** at mount, on model change, on window focus, and every 240 s, call:
    - `warmModel(modelOf(t["draw.model"]), promptOf("draw", t).system(true, scene.width, scene.height, 0, SCREEN.w), 2, thinkingOf("draw", t))`
    - `warmModel(modelOf(t["picture.model"]), promptOf("picture", t).system(t), t["picture.parallel"] * t["picture.copies"], thinkingOf("picture", t))`

    This is the same as `picture.ts:246`. Idle processes are closed after 10 minutes (`MAX_WAIT_MS`), which is why the 240 s re-warm is needed.
  - **First sight of a project:** the view is `viewShowing(pageTop(first page), visibleRect())`, the eval's start camera.
  - **Fit, Shift+1 and "Back to your pages":** `viewShowing(fitView(union(page boxes), 0.03), rect)`. "Back to your pages" shows when no page intersects `boardRect`.
  - **Sidebar:**
    - Pages come from `pageRows(board.shown())`, indented `depth * 14` px, with the home icon for `home` and the branch icon otherwise. Clicking a page calls `glideTo(pageTop(page), 450)`. "All pages" fits.
    - History is `history.newestFirst()`, with v1's hover, pin, Restore and Latest. Restore is disabled while `status.running || status.queued`.
    - There is no Preview button.
  - **Stop:** shown as in v1. It calls `sender.stop()`.
  - **New project:** first `sender.stop()`, clear the strokes, and `void voice.take()` (discarding the words). Then `board.newProject()`.
  - **Keys:** v1's. Esc or Cmd/Ctrl+Z undoes the last stroke, and Enter sends.

- [ ] **Step 1: Write the failing test** `strokes.test.ts`

- `toStroke puts a stroke on the ink clock`: `toStroke(3, [[10, 20, 1100.4], [12, 22, 1150.6]], 1100.2, 1180.7, 1000)` gives `{id:3, points:[[10, 20, 100], [12, 22, 151]], t0:100, t1:181}`.

- [ ] **Step 2: Run it to make sure it fails, implement `strokes.ts`, then run it to make sure it passes**

Run: `npm --prefix app test -- src/canvas/strokes.test.ts`. Expected: FAIL, then PASS.

- [ ] **Step 3: Build the Canvas changes, `Board`, `BoardView` and the App wiring** to the interfaces above.

- [ ] **Step 4: Typecheck and run the tests**

Run: `npm --prefix app run typecheck && npm --prefix app test`. Expected: clean and all passed.

- [ ] **Step 5: Check it in the browser**

With the dev server running, these sends call the subscription and Jev. Expected:
- Type "a landing page for a small bakery with a hero, three products with pictures, and an about section" and press Enter.
  - The badge shows "Drawing… N changes".
  - Shapes stream onto the Home page, and picture placeholders fill in with doodles.
  - Once the pictures are in, the badge shows "Done", and History shows V1 with that label.
- Draw a loop around one product, type "make this one blue" and press Enter. That product changes colour, and V2 appears.
- Hover V1: the canvas shows V1, and the Pages list doesn't change. Click V1, then Restore: V3 is "Restored V1".
- Reload the page: the board comes back with its pictures, and none are redrawn (no picture calls in the network log).
- Pan with the wheel and zoom with ctrl+wheel: the board moves with the paper, and no stroke is drawn while panning with space held.
- No errors in the console.

- [ ] **Step 6: Commit**

```bash
git add app/src
git commit -m "App: v2's board in v1's canvas, the pen on the ink clock, and Enter as the eval's send"
```

---

### Task 9: The latency overlay

**Files:**
- Create: `app/src/LatencyOverlay.tsx`, from v1 `src/LatencyOverlay.tsx`, with the overlay's `lt-*` CSS staying in `styles.css`.
- Modify: `app/src/App.tsx` to show it when `showsLatency()`.

**Interfaces:**
- Consumes: `LatencyLog`, `PHASES`, `segments`, `isLive`, `callRows` and `fmtMs` (Task 5); `calls` and `CALLS_EVENT`; `openCallInspector(n)` (`src/callsView.ts:111`).
- **Layout:** v1's overlay, with these changes:
  - The head reads "Latency · Enter → on screen".
  - **The big number** is `ttfcMs`, labelled "first change". Beside it, `ttdMs` is labelled "done", and a smaller "Enter → done" shows `end − enter`.
  - **The legend** has one swatch per `PHASES` entry, each with its value for the latest send.
  - **Rows:** the newest 6 sends, each with its label, a mic icon if spoken, tags (failed, stopped or no changes), its stage bar, and its `ttdMs` as the total.
  - **Clicking a row** expands its calls list. Each call row reads `who · model · wait · first text · total · warm|cold · in/out tokens`, and clicking it opens `openCallInspector(n)`.
  - **The footer** shows medians of `ttfcMs` and `ttdMs` and the p90 of `ttdMs`, over finished sends with changes. Its title says these are the eval's clock and can be compared with ck-10 (2.44 s / 3.89 s).
- **Stage colours:** add CSS colours for the new keys (`lt-listen`, `lt-prompt`, `lt-pictures`, `lt-camera`). Reuse v1's `lt-model`, `lt-line`, `lt-changes` and `lt-queue`.

- [ ] **Step 1: Build `LatencyOverlay`**

- [ ] **Step 2: Typecheck and run the tests**

Run: `npm --prefix app run typecheck && npm --prefix app test`. Expected: clean and all passed.

- [ ] **Step 3: Check it in the browser**

Turn on Settings → Debug → Latency overlay, then make a typed send. Expected:
- The bar grows live through prompt, model and first change. It ends with a first-change and a done number.
- The row expands to show 2 Jev calls, 1 draw call, and one picture call per picture, each with its times and warm or cold. Clicking one opens v2's call inspector with the prompt and the reply.
- The overlay's position and look match v1's.

- [ ] **Step 4: Commit**

```bash
git add app/src
git commit -m "App: the latency overlay, with v2's stages, the eval's clock and each send's model calls"
```

---

### Task 10: Verify everything and serve it

- [ ] **Step 1: Run every check**

Run: `npm run typecheck && npm --prefix app run typecheck && npm --prefix app test && git diff 6a9844e --stat -- package.json package-lock.json tsconfig.json src evals dev playgrounds`. Expected:
- Both typechecks clean.
- All app tests pass.
- The diff lists only `src/core/model.ts` and `src/core/trace.ts`.

- [ ] **Step 2: Try it as the owner will**

The dev server stays in the background on http://localhost:5180. Check:
- On a fresh project, the first typed send's latency row shows the draw call as **warm**.
- A voice send: turn the mic on, speak, press Enter. The captions show the words, the send carries them, and the mic stays on, so the next send can start straight away.
- Stop works mid-send.
- New project gives an empty board. The old project appears on `/projects` with a thumbnail, and opening it restores it.

- [ ] **Step 3: Leave the server running, and report**

Report the URL, the overlay's numbers from these sends, and anything that differed from the spec.
