# rt-draw app: links, the board's arrows, and the preview

2026-10-21. The owner's decisions are marked **(owner)**. Choices I made without asking are marked **(my call)**, so the owner can push back on any of them.

Mocks: https://claude.ai/artifact/P76LNWLMBnt2mpbkq7BwfF. There are six boards, made from real captures of the "Spoke & Chain" demo project (project `gqqkglbt`, three pages: Home, Services, Contact).

## Intent

The app (spec `2026-10-20-rt-draw-app-design.md`) puts v1's UI on v2's engine. It left v1's Preview out, because v2's pages are drawings, not HTML with buttons. The owner now wants the Preview back **"just like v1" (owner)**:

- It shows the site as a visitor sees it, one page at a time.
- Clicking a link goes to that link's page.
- Clicking something that leads nowhere yet builds its page live while the visitor watches. This is the "generative walkthrough".

The owner also wants:

- **Arrows connecting the pages on the board (owner)**, routed the way v1 routed them.
- **A button in the preview that takes them back to the canvas, zoomed in on exactly that page, so they can fix a page they don't like (owner).**

Today v2 has no idea of a link. A "link" is just an arrow shape the model happened to draw with its two ends on different pages (`linksOf`, `src/core/board.ts:70`). The model draws those arrows wherever it likes. They cut across pages, miss the element they belong to, and go stale when things move.

The owner asked for "the cleanest way to guarantee correct routing between pages and consistently correct arrows being drawn". The answer this design takes:

- **Links are data on the element.**
- **The app works out the arrows and routes them.** The model never draws them.
- **The board places the pages the way v1 did (owner: "let the board place pages like v1").**

## What the person gets

### On the board (mock board 1)

- **Placement:** pages sit where v1's layout puts them.
  - The layout is a left-to-right flowchart: each page sits in the column after the page whose element leads to it.
  - Home stays at (0, 0).
- **Arrows:** each page other than Home gets one orange arrow.
  - It starts at the element that leads to that page, leaves its page by the side that draws least over it, runs around the other pages with rounded right-angle turns, and enters the target page's left edge near its top.
  - This is v1's `src/page/layout.ts`, constants unchanged.
- **The Pages list:**
  - It is in tree order: Home first, then each page under the page whose element leads to it.
  - The **Pages** header gets v1's **Preview** button back (`.lp-head button`).
  - Project cards get their Preview buttons back too, as in v1 **(my call)**.
- **Boil:** hovering anything a visitor could click makes it boil (see Boil below).

### The preview (mock boards 2–4)

- **The bar.** This is v1's preview bar: 52 px tall, white, with a bottom border. From left to right:
  - The page select, in tree order, indented two spaces per level as in v1.
  - v1's hint: "Click buttons, links and pictures. Ones that lead nowhere yet get their page built as you watch."
  - **Edit this page**, with a pencil icon. This button is new.
  - **Full screen**.
  - **Exit preview**: black, with a close icon.
- **The page.** It is shown as in v1's `.pv-main`:
  - Centred, `min(1100px, 100% − 32px)` wide, with 24 px of padding above.
  - The shadow is `0 6px 24px rgb(0 0 0 / 0.08)`, and the background is `#f1f3f5`.
  - It is drawn by v2's `render()` with the view set to the page's box exactly, so anything that sticks out past the page is cut off, as a visitor would see it.
  - Tall pages scroll.
- **What is clickable:** a shape on this page that has a link or is a button (see Links in the engine).
  - Hovering one gives a pointer cursor and the boil.
  - Hovering one that has no page yet also shows a small tip, "No page yet: click to build it", as on board 2 **(my call)**.
  - **Headings, paragraphs and empty space do nothing (owner, by adding the button attribute).**
  - Hit testing picks the topmost clickable shape whose box holds the point. Text and pictures inside a button therefore count as the button.
- **Clicking a link to a page that exists** goes there. Each step is one browser history entry, so Back works, as in v1. The view scrolls to the top.
- **Clicking something with no page yet** builds it. The steps are under The walkthrough below.
  - The preview goes to the new page at once. The page is blank and pulses (v1's `pv-pulse`).
  - The bar shows v1's spinner and "Building “Contact”…" (board 3).
  - The page fills in live as the model draws it.
- **Edit this page** takes the person back to the board, fitted to that page (board 5). See Fixing a page below.
- **Exit preview** goes back to the editor. The editor has stayed mounted behind the preview all along, as in v1.
- **Full screen** calls `requestFullscreen` on the document, as in v1.

### Fixing a page from the preview (owner; mock boards 4–6)

- **Edit this page:**
  - It closes the preview and picks that page in the Pages list.
  - The camera glides until the **whole page** fits the visible board area: the window minus the sidebar and the prompt bar, the same area `sendView` uses. The owner said "zoomed in on exactly that page"; reading that as fitting the whole page, even a tall one, is **my call**.
  - Whatever the person says, types or draws next is an ordinary send.
- **A "Back to preview · on Contact" pill** shows at the top centre.
  - It has the back icon and is styled like v1's floating buttons (`.pg-lost button`).
  - It shares the top-centre row with the status badge.
  - Clicking it reopens the preview on that page, showing the board as it is now. If the fix is still drawing, the preview shows it live.
  - The pill goes away once it is clicked, or when another project is opened **(my call)**.
- **While a page is being built**, Edit this page is disabled for it (board 3) **(my call)**.

### Boil (owner: "don't forget the boil animation of anything clickable")

- It is v1's boil. While hovered, a clickable jitters between three spots, half a screen pixel apart, 0.15 s each: `steps(1, end)` over 0.45 s, on a loop.
  - These are v1's `boil` keyframes (`~/projects/rt-draw/src/styles.css:267-290`). They are already in `app/src/styles.css:286` for the app's own buttons.
- It happens **in the preview and on the board**, as in v1.
  - On the board the pen still draws. A hovered clickable just boils. In v1, the pages on the canvas noticed the pointer only for what a visitor could click.
- The offset is half a *screen* pixel at any zoom.
- It is off under `prefers-reduced-motion`.

## Links in the engine (owner: asked for the minimal set of ops-engine changes)

These are the only changes to `src/core/*`. Their tests run in the app's vitest, as `app/src/core-hooks.test.ts` already does, because the repo root has no test runner and its `package.json` is frozen **(my call)**.

1. **Shape fields:**
   - `Shape.link?: string` is the id of the page the shape opens.
   - `Shape.button?: boolean` means a visitor can click it.
   - A shape with a link counts as clickable whether or not `button` is set.
   - Both are saved in `Scene.toJSON()`.
2. **Ops:**
   - `shape()` takes four new key args: `link:<page id>`, `link:none` (which clears the link), `button:yes` and `button:no`.
   - On an existing shape, each one changes only that field, the way style keys work today.
   - They must not reach `styleFrom`. It ignores unknown keys, which would silently drop them.
   - A link may name a page that doesn't exist yet (a forward link). It gets no arrow until that page exists, and clicking it in the preview builds a page with that id.
3. **`linksOf(scene)`** returns links from these fields: `{ from: the shape's page, to: the frame whose id is shape.link, via: the shape }`.
   - It skips links to the shape's own page and links to missing pages.
   - Arrow shapes no longer count as links.
   - Its one caller outside core is `app/src/board/pages.ts`.
4. **`siteMap`:**
   - It marks each clickable element: `→ contact` for a link, `→ contact (no page yet)` for a forward link, and `[button]` for a button with no link.
   - It lists pages in tree order, Home first. Today it uses top-to-bottom reading order, but the layout puts some child pages above Home (Services sits at y −1070 on board 1), so reading order would no longer begin with Home.
5. **Home:**
   - `Scene.home?: string` is saved with the board. It is set when the first frame is made.
   - Old boards take the first page in today's reading order, before any layout runs.
   - If the home page is removed, the oldest remaining frame in `order` takes over.
   - The tree, the Pages list, the page select and the layout all start from it.
6. **The op manual** (`drawShipped`, `src/core/prompts.ts`) gains about two sentences, meaning:
   - Give `link:<page id>` to anything that opens another page: nav items, buttons, cards, and a logo that goes home.
   - Give `button:yes` to anything else a visitor would click.
   - Never draw arrows between pages; the board draws them.
   - The board places pages: put a new page anywhere beside the others, and it will be moved into place after you finish.
   - When moving the camera to a page, aim by its id: `camera(contact)`.

   The exact words are the builder's, but the manual stays short on purpose (see the comment on `drawShipped`).

Everything else lives in `app/`: the layout, the routing, the arrows, converting old arrows, the preview and the boil.

## Placement and arrows

**Where it lives:** `elkjs` 0.12.0 goes in `app/package.json`, and v1's `src/page/layout.ts` is copied to `app/src/board/layout.ts`, with ELK in a web worker as in v1.
- It doesn't go in core because ELK would then be a root dependency. The root `package.json` and lockfile are frozen for the eval loop (see "How it's built" in the 2026-10-20 spec).
- The eval bridge draws no link arrows, and nothing in the eval reads them.

**The tree.** Each page except Home has one parent link, found as follows:
- Go breadth-first from Home.
- On each page, visit its clickable elements in reading order: top to bottom, then left to right, by box.
- The first element that links to a page not yet in the tree claims that page.
- Every other link draws no arrow. That covers the nav copied onto every page, links back home, and a second button to the same page. In v1, nav copies got no arrows either.
- Pages no link reaches get no arrow. They are left out of ELK and placed in a row to the right of everything ELK placed, top-aligned with Home, in the order they were made, 140 px apart. Without this, ELK would stack them all in its first column. An old board with no links therefore keeps today's left-to-right row **(my call)**.

**The layout** is given what v1's `layoutPages` takes:
- each page's id, width and height;
- the tree links;
- for each tree link, the element's box relative to its page, and the other shapes on that page (`button`, `around`).

What it returns:
- **Pages:** each page's position, with Home at (0, 0). Every shape on a page moves with its page by the same offset. A shape's page is `pageOf`, the smallest page holding its middle. Shapes on no page stay where they are.
- **Arrows:** each arrow as corner points plus v1's rounded path.

**When it runs:**
- After every send, once `send()` has returned and before that send's version is saved, so the move belongs to the send's version.
- On opening a project. The positions are applied in memory and saved with the next version; this gets no version of its own **(my call)**.
- After Restore.

It never runs during a send. The model's coordinates and `camera()` ops are therefore always aimed at where the pages actually are. The layout is deterministic, so a board that is already placed doesn't move.

**The move:**
- Pages glide to their new places over about 0.4 s, and arrows fade in afterwards (v1's `.wf-arrows` fade, 0.3 s after a 0.3 s delay) **(my call)**.
- It happens after the eval's clocks stop. The latency overlay shows it as a **layout** stage after camera settle, outside the headline numbers. v1's overlay had an ELK layout stage, and the 2026-10-20 spec dropped it because v2 had no layout step until now **(my call)**.

**Pages the walkthrough makes are placed before the model draws anything** (see below), so they never jump.

**Drawing an arrow:**
- It is drawn with the app's `sketchArrow` (from v1) in `#f08c00`.
- The stroke is 2.5 px on screen at any zoom (`vector-effect: non-scaling-stroke`) and the head is 13 px on screen.
  - v1 drew an 18 px head in page pixels. The app zooms much further out than v1 did, so a fixed on-screen size reads better **(my call)**.
- The seed is `arrow:<element id>`, so an arrow keeps its wobble across redraws.
- Arrows go in their own SVG layer above the pages, not in the scene:
  - They carry no `data-id`, so the eval's clock (`evals/bridge/timing.ts`, which the overlay uses) never sees them.
  - They are not in the board shots the model gets. The model sees links in the site map instead.
  - They ignore the pointer.

**Never a wrong arrow on screen:**
- During a send, an arrow fades out as soon as its element or either of its pages changes. The rest stay.
- After the send, every arrow is routed again and fades back in **(my call)**.
- Hovering or pinning an old version in History shows *that version's* arrows, never the live board's.

**Old arrows become links.** This runs on opening a project, and after every send as a safety net in case the model draws an arrow anyway.
- It applies to an arrow shape whose two ends are on two different pages (today's `linksOf` rule, with `board.linkSnapPx`).
- The smallest non-frame shape on the from-page under the arrow's tail (within `board.linkSnapPx`) gets `link:<to page id>`, and the arrow shape is removed.
- If there is no shape under the tail, the arrow stays as an ordinary drawing **(my call)**.
- The demo project's model-drawn arrows `home-to-services` and `contact-link` become links on `nav-services` and `nav-contact`.

## Boards made before links (owner: "Leave them until asked")

- Old boards get no marking pass. Their only links are the ones converted from old arrows (above).
- Until the person asks in a send ("make the nav and buttons clickable"), their other buttons and nav items stay unclickable in the preview. The manual's link and button sentences are what make that send work.
- The preview's hint stays v1's. Nothing extra appears on a board with nothing to click.

## The walkthrough: building a page from a click

**First, v1's check for a page that already exists (`existingTarget`).** Some clicks look like they lead nowhere: the shape has no link, or its link names a page that doesn't exist. If a page's name matches the clicked words anyway (ignoring case and spacing), the click goes to that page, and the shape gets `link:<that page>` **(my call)**.
- That link is saved with the next version and gets no version of its own.
- So a nav copy the model forgot to link goes home instead of building a duplicate Home.
- v1 also matched nav copies by an id pattern (`<page>-<id>`). That pattern doesn't apply to v2's ids, and the name match covers those cases.

Any other click on a clickable with no page yet starts a build, if nothing is already building. That means a button with no link, or a forward link.

1. **The page is made in code when the build's send starts, before any model call.** If nothing is running, that is at once. If another send is running, the page is made when that send finishes, so the layout never runs during another send. Until then, the preview shows a blank page of the clicked-from page's size, pulsing:
   - It is a frame. Its id comes from the forward link if there is one. Otherwise it is a fresh id made from the clicked words, slugged and unique.
   - The clicked words are the shape's text words, else its drawing's subject, else its id, as in v1's `activate`.
   - The frame's text, which is its name, is those words.
   - It is the size of the page the click came from.
   - The clicked shape gets `link:<new id>`.
   - The layout runs, so the page lands in its final place.
2. **The editor's camera glides to the new page**, so the model's "what you see" shot is that page.
3. **A send is queued.** Its words are v1's build instruction adapted to v2, for example:

   > Preview click: a visitor clicked “Contact” (nav-contact) on the Home page. Its page, contact, has just been made, empty, at 1500 -130 1280 800. They're watching it being built: draw it now, top to bottom, starting with the same header and nav as the other pages, in the site's style.

   It shows in History as "Preview click: Contact", and in the overlay as an ordinary send.
4. **The preview goes to the new page at once**: blank, pulsing, with the bar saying Building.
5. **As ops land, the page fills in live.** It is rendered at most once per animation frame, as the bridge does.
6. **When `send()` returns**, the pulse and spinner stop.

**One build at a time (v1):**
- While a page is building, clicks on things with no page do nothing.
- Links to existing pages still work, and the visitor can go back to the page being built, which keeps pulsing.
- If the editor is already running a send, the build queues behind it. The bar says Building from the moment of the click **(my call)**.

**When it fails:** if the send fails or is stopped, v1's orange `pv-failed` strip appears: "Couldn't build “Contact”.", the reason, and an OK button.
- If nothing landed on the page, the empty page and the link the click added are taken away again.
- If something landed, it stays **(my call)**.

**When the visitor exits:** the editor is left where the last build put the camera **(my call)**.

**The mic** keeps running in the preview, as the 2026-10-20 spec says (it turns off only when clicked). Words said in the preview go to the editor's next send.

## Camera (owner asked: "Will the model still be able to move the view to pages when I tell it to?")

- Yes. `camera(id)` and `camera(x y w h)` are unchanged, and pages don't move during a send.
- After the layout moves pages, the camera moves with the page it was on by the same offset. That page is the one holding the view's centre. The person keeps looking at what they were looking at.

## Goals

1. On the demo project, and on any project, the owner can:
   - open the preview and click through the existing links;
   - click Contact (no page yet) and watch Contact being built;
   - see the map spill over, press Edit this page, fix it with a send, and press Back to preview to see it fixed.

   That is boards 2 to 6, end to end, with real sends. It runs on a **copy** of `gqqkglbt` restored to version 7, before Contact existed. The owner's own project and its history are not touched **(my call)**. Since old boards aren't marked (owner), the run starts with one send on that copy: "make the nav items and buttons clickable".
2. **Arrows are always right.** There is one arrow per page in the tree, from its element to that page's left edge. Arrows never cut through another page, and are never stale on screen.
3. **Old projects keep their links:** they open with their model-drawn page arrows turned into links, and their pages placed.
4. **Speed holds:** a build is an ordinary send, and the only cost added to every send is the manual's extra sentences and the slightly longer site map.

## Non-goals

- **Running the eval (owner: "Don't run the eval").** The champion's 2.44 s and 3.89 s medians were measured with the old manual and site map. The new ones are slightly longer, and their effect is not measured. Eval cases that ask for arrows between pages will now get links instead.
- **v1 features left out:**
  - page states (v1's modal and `(state)` entries);
  - external links and `mailto:`;
  - the preview's minimise dock.
- **Previews in other tabs.** v1's BroadcastChannel handshake isn't built. The preview runs in the editor's own tab **(my call)**.
- **Moving pages by hand, or by asking** ("move the Contact page left"). The board places pages, and the manual says so, as in v1.
- **No changes outside the app and core:** `evals/`, v1's repo and the playgrounds stay as they are.

## Anti-goals

- **A wrong arrow on screen:** to the wrong page, from nowhere, or through another page.
- **The page jumping under a visitor who is watching it being built.**
- **The preview showing something other than what is on the board.**
- **A slower send:** the layout running inside a send, ELK on the main thread, or the boil or arrows triggering the eval clock's watcher.

## Constraints

- **Frozen root files:** the root `package.json`, `package-lock.json` and `tsconfig.json` stay unchanged, for the eval loop.
- **Core changes:** only the list in Links in the engine, each with tests (in the app's vitest).
- **Checks:** the root and `app/` typechecks pass, and `npm --prefix app test` passes.
- **The boil:** it must not change anything that `watch()` (`evals/bridge/timing.ts`) observes on `[data-id]` elements, because a hover during a send would then count as a drawing change.

## Testing

- **Core:**
  - parsing `link:`, `link:none`, `button:yes` and `button:no` on new and existing shapes;
  - forward links;
  - `linksOf` from the fields;
  - the site map's marks and its tree order;
  - the home rules.
- **The tree:**
  - nav copies get no arrow;
  - the first element in reading order wins;
  - unreachable pages are placed but get no arrow.
- **Layout properties:** tested on random boards of 1 to 12 pages with random element boxes and links.
  - Home is at (0, 0).
  - No two pages overlap.
  - Every page in the tree has exactly one arrow.
  - Each arrow starts within 6 px of its element's box, and ends 6 px left of its target's left edge, between the target's top and bottom.
  - Every segment is horizontal or vertical.
  - No segment crosses the inside of any page except, on the way out, its own source page.
  - The same board always gives the same layout.
- **Old arrows:** the demo board at version 9 is exported from project `gqqkglbt` into an app test fixture. On it, the two arrows become links on `nav-services` and `nav-contact`.
- **Preview:**
  - A link goes to its page.
  - A click with no page makes the frame and the link before the send starts, then sends the build instruction.
  - A failed build with nothing drawn takes the page and the link away.
  - Edit this page fits the camera to the page, and Back to preview returns to it.
  - Headings and empty space do nothing.
- **For the owner:** the whole of Goal 1 run in the real app on the demo project, with real sends, shown with screenshots.

## Left to the builder

- The exact wording of the manual and of the build instruction, within the meaning above.
- The component split for the preview, the arrow layer and the pill.
- How an old version's arrows are got: stored with the version, or routed again on hover.
- How the boil stays clear of the eval's watcher.
- The URL shape. Whatever it is, a reload must reopen the preview on the same page, and Back must go to the previous preview page.
- The tip's delay.
