# Links, the board's arrows, and the preview: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Links become data on v2's shapes, the app places pages and routes their arrows the way v1 did, and v1's preview comes back with its generative walkthrough, Edit this page, and the boil.

**Architecture:** Core gains three fields (`Shape.link`, `Shape.button`, `Scene.home`), four op keys, a link tree (`siteTree`), a marked site map and two sentences in the manual. Everything else lives in `app/`: v1's ELK layout in a worker (`board/layout.ts`), the placement built on it (`board/place.ts`), the old-arrow conversion (`board/adopt.ts`), an arrow layer over the board, a settle step that runs after sends, on open and after Restore, and a same-tab preview over the mounted editor.

**Tech Stack:** TypeScript, React 19, Vite 8, vitest 5 + happy-dom, rough.js, elkjs 0.12.0 (app only).

**Spec:** `docs/superpowers/specs/2026-10-21-links-and-preview-design.md`

## Global Constraints

- The root `package.json`, `package-lock.json` and `tsconfig.json` stay unchanged. `elkjs` 0.12.0 goes only in `app/package.json`.
- `src/core/*` changes are only these: the Shape and Scene fields, the `shape()` keys, `linksOf`, `siteMap`, `Scene.home`, and the manual. Each is tested in the app's vitest.
- Checks: `npx tsc --noEmit -p .` at the root, `npm --prefix app run typecheck`, and `npm --prefix app test` all pass.
- Nothing on the board that `watch()` (`evals/bridge/timing.ts`) observes may change because of the boil or the arrows. Arrows carry no `data-id`, and the boil is CSS from a `<style>` outside the board's `<svg>`.
- Arrows: `#f08c00`, 2.5 px non-scaling stroke, 13 px on-screen head, seed `arrow:<element id>`.
- v1's layout constants are unchanged: ENTRY_Y 90, ENTRY_STEP 24, GAP 6, RADIUS 14, CROSSING 1000, OUTSIDE 0.3, BEND 40, and the ELK options.
- Unreached pages sit in a row to the right of everything ELK placed, top-aligned with Home (y 0), in the order they were made, 140 px apart.
- The layout never runs during a send.
- Don't run the eval. Don't push or merge.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A model-written link to an id that is not a page** (a link to a button's id, or a link on a frame itself). The site map and the tree ignore it, and the preview treats it as "no page yet", never a crash. (Task 2 test: `links to a non-frame shape are forward links`.)
2. **Removing the home page mid-send.** `homeOf` falls back to the oldest remaining frame, and the tree, list and layout keep working. (Task 1 test: `removing home hands it to the oldest frame`.)
3. **A send that fails after the walkthrough made the page.** The page and the link go away, the layout puts the others back, and nothing is committed. (Task 7 test: `a failed build with nothing drawn takes the page and link away`.)
4. **Stop pressed while a build is queued.** No page is made, and the preview's bar leaves Building. (Task 7 test: `a build stopped before its turn makes no page`.)
5. **A board with two pages whose element boxes overlap the page edge.** The arrow start stays within 6 px of the element, and the layout still finishes. (This is covered by Task 4's random property boards, which place elements anywhere on the page, edges included.)

---

### Task 1: Core fields, keys and home

**Files:**
- Modify: `src/core/scene.ts` (Shape.link, Shape.button, Scene.home, toJSON/fromJSON, remove)
- Modify: `src/core/ops.ts` (`shape()` keys, home on the first frame)
- Test: `app/src/core-links.test.ts`

**Interfaces:**
- Produces: `Shape.link?: string`, `Shape.button?: boolean`, `Scene.home?: string`, `SceneJSON.home?: string`.

- [ ] Write the failing tests:
  - `shape(a, rect, 0 0 10 10, "...", link:contact, button:yes)` sets `link "contact"` and `button true`, and `fill` from the same line still lands.
  - On an existing shape, `shape(a, link:none)` clears the link and leaves `button`. `shape(a, button:no)` sets `button false` and leaves the link.
  - `shape(a, button:maybe)` is rejected with an error naming yes/no, and the shape is unchanged.
  - A link to a page that doesn't exist (`link:contact` before contact exists) is kept.
  - `toJSON()` → `fromJSON()` keeps the link, the button and `home`.
  - `home` is set to the first frame made by `shape(..., frame, ...)`, and is not changed by later frames.
  - `removing home hands it to the oldest frame`: remove the home frame, and `home` becomes the first remaining frame in `order` (undefined when none is left).
- [ ] Run `npm --prefix app test -- core-links`. Expected: FAIL.
- [ ] Implement. The `link`, `button` and `fillStyle` keys are read before `styleFrom` (it ignores unknown keys, so this just keeps them visible to the model). Check that `button` is yes or no before changing anything.
- [ ] Run again. Expected: PASS. Run root and app typechecks.
- [ ] Commit `Core: links and buttons on shapes, and the board's home`.

### Task 2: Core links, tree, site map and manual

**Files:**
- Modify: `src/core/board.ts` (`clickable`, `homeOf`, `linksOf`, `siteTree`, `siteMap`)
- Modify: `src/core/prompts.ts` (`drawShipped`, board only)
- Modify: `app/src/board/pages.ts` (`pageRows` from `siteTree`; `siteName` from `homeOf`)
- Test: `app/src/core-links.test.ts`, `app/src/board/pages.test.ts`

**Interfaces:**
- Produces:
  - `clickable(s: Shape): boolean` (it has a link or is a button).
  - `homeOf(scene: Scene): Shape | undefined`.
  - `linksOf(scene: Scene): Link[]`, with `Link = { from: Shape; to: Shape; via: Shape }`.
  - `type TreePage = { page: Shape; depth: number; via?: Link }`.
  - `siteTree(scene: Scene): TreePage[]`: tree order (Home first, then each page under the page that claimed it, depth-first), then pages no link reaches, at depth 0, in the order they were made.
  - The `t` parameter of `linksOf` is dropped.

- [ ] Write the failing tests:
  - `linksOf` comes from the fields. It skips links to the shape's own page, to missing pages, and to shapes that aren't frames. Arrows no longer count.
  - Tree tests:
    - Nav copies on every page claim nothing.
    - The first element in reading order wins.
    - An unreached page comes last, at depth 0.
    - Home is `scene.home`. On a board without one, it is the first page in reading order.
  - The site map:
    - It marks `→ contact`, `→ contact (no page yet)` and `[button]`.
    - It lists pages in tree order, even with a child page placed above Home.
  - `links to a non-frame shape are forward links`: the site map marks them `(no page yet)`, and `siteTree` ignores them.
  - The manual on a board mentions `link:` and `button:yes`, and says not to draw arrows between pages. The single-canvas manual doesn't.
  - Update `pages.test.ts`:
    - Its bakery board uses `link:` instead of arrows.
    - Rows come in tree order with depth.
    - `siteName` reads the home page.
- [ ] Run. Expected: FAIL.
- [ ] Implement.
  - The tree is breadth-first claiming. Each page's clickables are taken in reading order (box y, then x), and the first link to an unclaimed page claims it. The output order is a depth-first walk of the claims.
  - In the site map, the "Links to" line lists the tree's links and the other links. Each content line carries its mark.
  - `pageRows` maps `siteTree` to `{ id, name, depth, home }`.
- [ ] Run. Expected: PASS. Run both typechecks; the eval code still compiles.
- [ ] Commit `Core: links from the fields, the link tree, the marked site map, and the manual's two sentences`.

### Task 3: v1's layout, in the app

**Files:**
- Modify: `app/package.json` (elkjs 0.12.0)
- Create: `app/src/board/layout.ts` (v1's `src/page/layout.ts`, with the Box type local, plus `setElk(elk)` for tests)
- Test: `app/src/board/layout.test.ts`

**Interfaces:**
- Produces:
  - `layoutPages(home: string, pages: PageSize[], links: PageLink[], opts?: LayoutOptions): Promise<Layout>`.
  - `setElk(e: ELK): void`.
  - The types `PageSize`, `PageLink` and `Layout`, which are v1's.

- [ ] Write the failing test. Two pages and one link from a button on Home: Home is at (0, 0), the child is to its right, and one arrow ends 6 px left of the child's left edge at y = ENTRY_Y. Tests use `elkjs/lib/elk.bundled.js` through `setElk`.
- [ ] Run. Expected: FAIL (no module).
- [ ] `npm --prefix app install elkjs@0.12.0 --save-exact`, then copy v1's file.
- [ ] Run. Expected: PASS.
- [ ] Commit `App: v1's page layout (ELK in a worker)`.

### Task 4: Placement and old arrows

**Files:**
- Create: `app/src/board/place.ts`
- Create: `app/src/board/adopt.ts`
- Create: `app/src/board/fixtures/spoke-and-chain-v9.json` (the scratchpad's `demo-scene.json`)
- Test: `app/src/board/place.test.ts`, `app/src/board/adopt.test.ts`

**Interfaces:**
- Produces:
  - `type Arrow = { id: string; from: string; to: string; d: string; points: { x: number; y: number }[]; key: string }`, where `id` is the element's id.
  - `type Placement = { at: Map<string, { x: number; y: number }>; arrows: Arrow[] }`.
  - `placeBoard(scene: Scene): Promise<Placement>`.
  - `moveBy(scene: Scene, at: Placement["at"]): Map<string, { dx: number; dy: number }>`: the offset per page. Every shape on a page (by `pageOf`, taken before moving) moves with it.
  - `arrowKey(scene: Scene, a: Pick<Arrow, "id" | "from" | "to">): string`: the from page's box, the to page's box, and the element's box and link.
  - `shownArrows(scene: Scene, p: Placement | undefined): Arrow[]`: only the arrows whose key still matches.
  - `adoptArrows(scene: Scene, t?: Tuning): number`: the old page arrows turned into links.

- [ ] Write the failing tests:
  - Property tests: 40 seeded random boards with 1 to 12 pages, random element boxes and random links. In each:
    - Home is at (0, 0).
    - No two placed pages overlap.
    - Each tree page has exactly one arrow.
    - The arrow starts within 6 px of its element's box (after the move).
    - It ends 6 px left of the target's left edge, between the target's top and bottom.
    - Every segment is horizontal or vertical.
    - No segment crosses the inside of any page except its source page's.
    - The same board gives the same placement.
  - Unreached pages form a row to the right of the ELK extent at y 0, in made order, 140 apart.
  - `moveBy` moves a page's content with it and leaves shapes on no page.
  - `shownArrows` drops an arrow after its element or either page moves.
  - Adopt:
    - On the v9 fixture, `home-to-services` and `contact-link` become `nav-services.link = "services"` and `nav-contact.link = "contact"`, and both arrows are gone.
    - An arrow with nothing under its tail stays.
- [ ] Run. Expected: FAIL.
- [ ] Implement.
  - `placeBoard` builds v1's inputs from `siteTree`: each tree link's element box relative to its page, with `around` being the other non-frame shapes on that page.
  - It places the unreached pages in their row and shifts the ELK result so Home is at (0, 0).
  - It computes each arrow's key against the scene as it will be after `moveBy`.
- [ ] Run. Expected: PASS.
- [ ] Commit `App: placing pages and routing arrows from links; old page arrows become links`.

### Task 5: Settling the board, the arrow layer, and the layout stage

**Files:**
- Modify: `app/src/board/board.ts`. Add:
  - `placement`;
  - `settle(opts: { glideMs: number; onShift?: (dx: number, dy: number, page: string | undefined) => void }): Promise<void>`;
  - a cache of placements for viewed versions (`placementFor(scene)`).
- Modify: `app/src/board/sender.ts`:
  - `onEnd` may return a promise, which is awaited.
  - `Job.before?: () => Promise<void>` runs before `onStart`, and only if the job wasn't stopped.
  - `Job.done?: (status: "done" | "error" | "stopped", landed: number, error?: string) => void` is also called for a job stopped while queued.
- Modify: `app/src/board/latency.ts` (`SendTimes.layout`; a PHASES "layout" stage after camera, outside "Enter → done").
- Create: `app/src/board/BoardArrows.tsx`.
- Modify: `app/src/App.tsx`:
  - settle after a send that landed, before its commit, with `times.layout` set;
  - settle on open and after Restore;
  - the camera follows its page (the one holding the view's centre);
  - arrows in the backdrop above `BoardView`.
- Modify: `app/src/styles.css` (`.bd-arrows`, with the fade-in).
- Test: `app/src/board/sender.test.ts`, `app/src/board/latency.test.ts`, `app/src/board/board.test.ts` (new).

- [ ] Write the failing tests:
  - Sender:
    - A second job doesn't start until the first job's async `onEnd` resolves.
    - `before` runs before `run`.
    - A stopped queued job calls `done("stopped", 0)` and never calls `before`.
  - Latency: a finished send with `layout` has a "layout" segment last, and "Enter → done" is unchanged.
  - Board: `settle` on a board with an old arrow adopts it, places the pages, and sets `placement`; `shownArrows` then gives one arrow per tree page.
- [ ] Run. Expected: FAIL.
- [ ] Implement.
  - **The glide:** settle interpolates the shapes' boxes from where they are to the placed boxes over `glideMs`, eased, calling `draw()` each frame, and ends exactly at the placed boxes.
  - **The arrow layer:**
    - It's an `<svg class="bd-arrows">` with the board's viewBox.
    - Paths come from `sketchArrow(d, points, { seed: seedOf("arrow:" + id), stroke: "#f08c00", strokeWidth: 2.5, head: 13 / zoom })`, with a non-scaling stroke.
    - Each arrow's `<g>` is keyed by its key, so it fades in when rerouted.
    - Arrows are hidden while a glide is running.
- [ ] Run. Expected: PASS. Run both typechecks.
- [ ] Commit `App: the board places its pages after each send, on open and after Restore, with routed arrows`.

### Task 6: The preview

**Files:**
- Create: `app/src/preview/Preview.tsx`.
- Create: `app/src/preview/preview.ts`, with the pure helpers:
  - `previewOfHash(hash: string): string | null | undefined`: `#preview=<id>` gives the page id, `#preview` gives null (home), and anything else gives undefined;
  - `hitClickable(scene, page, p): Shape | undefined`;
  - `clickedWords(s: Shape): string`;
  - `existingPage(scene, s): Shape | undefined`;
  - `freshPageId(scene, words): string`;
  - `buildInstruction(words, s, from, page): string`.
- Create: `app/src/preview/preview.css` (v1's pv-* rules).
- Modify:
  - `app/src/App.tsx` (the preview state from the hash, Edit this page, the Back to preview pill, `picked` lifted from the Sidebar, the keyboard off while previewing);
  - `app/src/Sidebar.tsx` (the Preview button in the Pages header; `picked` as a prop);
  - `app/src/projects/ProjectsPage.tsx` (a Preview button on each card);
  - `app/src/styles.css` (`.pg-topline` and `.pg-back`).
- Test: `app/src/preview/preview.test.ts`.

- [ ] Write the failing tests:
  - The hash parsing.
  - The hit test: topmost clickable; text inside a button counts as the button; a heading and empty space give undefined.
  - `existingPage` matches a page name ignoring case and spacing, the current page included.
  - `freshPageId` slugs and avoids taken ids.
  - The instruction names the words, the element, the from page, and the new page's id and box.
- [ ] Run. Expected: FAIL.
- [ ] Implement the helpers, then the component.
  - **The bar**, in v1's order: page select (tree order, two spaces per level), hint or Building status, Edit this page, Full screen, Exit preview.
  - **The page:** `render()` into an `<svg>` with `view: page.box`, redrawn on `board.onPaint`.
  - **Hover:** a pointer cursor, the boil (from a `<style>`), and the "No page yet: click to build it" tip after 300 ms.
  - **Clicks:** a click on a linked page or a name match goes there (one history entry each). Anything else starts a build.
  - **Failures:** v1's `pv-failed` strip.
  - **Building:** the pulse on the page being built.
- [ ] Run. Expected: PASS. Run both typechecks.
- [ ] Commit `App: the preview, Edit this page and Back to preview`.

### Task 7: The walkthrough build

**Files:**
- Create: `app/src/preview/build.ts`. It exports `buildJob(deps: BuildDeps, click: { shape: Shape; from: Shape }): { job: Job; to: string; label: string }`.
- Modify: `app/src/App.tsx` (`startBuild`, which the preview calls; the camera glides to the new page).
- Test: `app/src/preview/build.test.ts`.

**Interfaces:**
- Consumes:
  - `Job.before` and `Job.done` (Task 5);
  - `Board.settle` (Task 5);
  - `freshPageId`, `clickedWords` and `buildInstruction` (Task 6).
- Produces: `BuildDeps = { scene: () => Scene; settle: () => Promise<void>; focus: (page: Shape) => Promise<void>; enter: () => number }`.

- [ ] Write the failing tests:
  - Before the send starts, the job's `before` makes the frame (the clicked-from page's size, its name the clicked words, its id from a forward link or fresh), sets the link, and settles. The instruction then holds the placed box.
  - The label is `Preview click: <words>`.
  - `a failed build with nothing drawn takes the page and link away`: `done("error", 0)` removes the frame, restores the shape's old link, and settles again.
  - `a build stopped before its turn makes no page`.
  - A build with ops landed keeps the page.
- [ ] Run. Expected: FAIL.
- [ ] Implement, and wire it into the preview's click.
- [ ] Run. Expected: PASS.
- [ ] Commit `App: building a page from a preview click`.

### Task 8: The boil on the board

**Files:**
- Modify: `app/src/App.tsx` (the hovered clickable from `Canvas.onPointer`, only when no button is held);
- Create: `app/src/board/boil.ts`: `boilCss(selector: string, px: number): string`, the boil keyframes as CSS translate in user units, with reduced motion turned off.
- Test: `app/src/board/boil.test.ts`.
- [ ] Write the failing tests:
  - `boilCss` gives keyframes stepping between three ±px spots, with `steps(1, end)` over 0.45 s, and a reduced-motion block that turns it off.
  - Hovering, run through the bridge's `watch()` on a rendered board, changes no signature.
- [ ] Run. Expected: FAIL.
- [ ] Implement. A `<style>` element in the App root (not in the board's `<svg>`) is filled with `boilCss('.bd > g[data-id="<id>"]', 0.5 / zoom)`.
- [ ] Run. Expected: PASS. Run both typechecks.
- [ ] Commit `App: what a visitor can click boils on the board too`.

### Task 9: Demo run for the owner

- [ ] Copy `gqqkglbt` versions 1–7 into a new project, "Spoke & Chain (preview demo)", through the app's storage in the browser.
- [ ] In the real app, with real sends:
  - Send "make the nav items and buttons clickable".
  - Open the preview, click through the links, and click Contact to watch it build.
  - Press Edit this page, send "make the map fit inside the page", and press Back to preview.
  - Take screenshots of each step.
- [ ] Note what was seen, with the screenshots' paths.
