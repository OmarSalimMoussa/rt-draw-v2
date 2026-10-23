// The editor's state: the project open in this tab, its live board (the v2
// scene a send draws on, in place), its history, and the tuning sends run with.
// After v1's PageStore (src/page/store.ts) without the HTML: redraws go to the
// board's <svg> once per animation frame (BoardView.tsx), as the eval's bridge
// coalesces them, and the React parts subscribe for everything else. One Board per
// project opened in the tab: opening another one (New project included) mounts a new
// editor (Root.tsx), so a send still finishing commits to the project it began on.
// The board places its own pages (place.ts): after every send, on opening and after
// Restore, the pages glide to where the layout puts them and the arrows follow.
import { homeOf, pagesOf } from "../../../src/core/board.ts";
import { Scene } from "../../../src/core/scene.ts";
import type { Tuning } from "../../../src/core/tuning.ts";
import { tuningFor } from "../models.ts";
import { SAVED_EVENT, blankBoard, currentProjectId, listProjects, loadVersions, renameProject, saveVersions, savedFor } from "../projects/storage.ts";
import { getModel, onSettings } from "../settings.ts";
import { adoptArrows, adoptFrames, adoptLinks } from "./adopt.ts";
import { History } from "./history.ts";
import { type Placement, moveBy, placeBoard, shiftsOf } from "./place.ts";

/** How long pages glide to their places. */
export const SETTLE_MS = 400;

/** Calls `frame` with 0-1 (eased) once per animation frame for `ms`, ending on 1. */
function ease(ms: number, frame: (e: number) => void): Promise<void> {
  if (ms <= 0) return Promise.resolve(frame(1));
  return new Promise((done) => {
    const t0 = performance.now();
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / ms);
      frame(u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
      if (u < 1) requestAnimationFrame(step);
      else done();
    };
    step();
  });
}

export class Board {
  /** The project this tab works on (also in the URL as ?p=). */
  project: string;
  /** The live board: sends change it in place. */
  scene: Scene;
  history: History;
  tuning: Tuning;
  /** A send is running: another tab's save waits (adoptSaved), and the board isn't swapped under it. */
  busy = false;
  /** Opened and not looked at yet: the editor puts the camera on its first page once. */
  fresh = true;
  /** Where the layout put the live board's pages, and their arrows. */
  placement?: Placement;
  /** Pages are gliding to their places: no arrows until they're there. */
  gliding = false;
  /** Where the camera looks now, and how to move it by the same offset as a page (the editor sets it). */
  follow?: () => { centre: { x: number; y: number }; move: (dx: number, dy: number) => void };

  private version = 0;
  private frame = 0;
  private listeners = new Set<() => void>();
  private painters = new Set<() => void>();
  /** Versions looked at, parsed once each, and their layouts. */
  private parsed = new Map<number, Scene>();
  private placements = new Map<number, Promise<Placement>>();
  private settling: Promise<void> = Promise.resolve();

  constructor() {
    this.project = currentProjectId();
    this.history = new History(loadVersions(this.project));
    this.scene = this.latestScene();
    this.tuning = tuningFor(getModel());
    this.keepUrl();
  }

  /** Follows the settings (the model) and other tabs' saves, until the returned function lets go (the editor unmounting). */
  listen(): () => void {
    const offSettings = onSettings(() => {
      this.tuning = tuningFor(getModel());
      this.draw();
    });
    // Another tab saved: follow it, so this tab never builds on (or saves) a stale copy.
    const onSaved = (e: Event) => savedFor(e, this.project) && this.adoptSaved();
    addEventListener(SAVED_EVENT, onSaved);
    return () => {
      offSettings();
      removeEventListener(SAVED_EVENT, onSaved);
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  /** Called with each paint of the board (BoardView). */
  onPaint(fn: () => void): () => void {
    this.painters.add(fn);
    return () => void this.painters.delete(fn);
  }

  /** What the canvas shows: a version from the history while looking at one, else the live board. */
  shown(): Scene {
    const n = this.history.looking;
    return n === undefined ? this.scene : this.versionScene(n);
  }

  /** Version n's board, parsed once. */
  versionScene(n: number): Scene {
    let s = this.parsed.get(n);
    if (!s) this.parsed.set(n, (s = Scene.fromJSON(this.history.doc(n)!)));
    return s;
  }

  /** The layout for version n's board, for its own arrows (none fit where its pages weren't placed). */
  placementFor(n: number): Promise<Placement> {
    let p = this.placements.get(n);
    if (!p) this.placements.set(n, (p = placeBoard(this.versionScene(n)).catch(() => ({ at: new Map(), arrows: [] }))));
    return p;
  }

  /** Resolves once a settle under way is over. */
  settled = () => this.settling;

  /**
   * Puts the pages where the layout says (place.ts): the model's old page arrows become links first, then
   * the pages glide there over glideMs with their content (and the camera with the page it's on), and the
   * arrows come once they've arrived. `placed` is called once the board holds the pages' final places,
   * before the glide (a send's version is saved then, so nothing waits on the animation), or once the
   * layout gave up. In memory otherwise: the next version saves it. Never throws.
   */
  settle({ glideMs, placed }: { glideMs: number; placed?: () => void }): Promise<void> {
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      placed?.();
    };
    this.settling = this.settling
      .then(() => this.place(glideMs, tell))
      .catch((e) => {
        this.gliding = false;
        console.error("placing the pages failed", e);
      })
      .then(tell);
    return this.settling;
  }

  private async place(glideMs: number, placed: () => void) {
    const scene = this.scene;
    adoptFrames(scene);
    adoptArrows(scene, this.tuning);
    adoptLinks(scene);
    scene.home ??= homeOf(scene)?.id;
    const p = await placeBoard(scene);
    if (scene !== this.scene) return;
    const shifts = shiftsOf(scene, p.at);
    if (shifts.size) {
      const cam = this.follow?.();
      const c = cam?.centre;
      const under = c && pagesOf(scene).filter((f) => c.x >= f.box.x && c.x <= f.box.x + f.box.w && c.y >= f.box.y && c.y <= f.box.y + f.box.h).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
      const d = under && shifts.get(under.id);
      const from = new Map([...shifts.keys()].map((id) => [id, { ...scene.get(id)!.box }]));
      // At their places first, for whoever saves the board now; the glide then shows them getting there.
      moveBy(scene, p.at);
      this.placement = p;
      placed();
      this.gliding = true;
      this.draw();
      await ease(glideMs, (e) => {
        for (const [id, sh] of shifts) {
          const shape = scene.get(id);
          const b = from.get(id)!;
          if (shape) shape.box = { ...shape.box, x: b.x + sh.dx * e, y: b.y + sh.dy * e };
        }
        if (d) cam!.move(d.dx * e, d.dy * e);
        this.draw();
      });
      this.gliding = false;
    }
    this.placement = p;
    this.draw();
  }

  /** Redraws at the next animation frame, however many times it's asked before then. */
  draw = () => {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.painters.forEach((fn) => fn());
      this.changed();
    });
  };

  /** A redraw still waiting for its frame happens now: the eval's clock starts from what's on screen (as the bridge renders before Enter). */
  flush() {
    if (!this.frame) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.painters.forEach((fn) => fn());
    this.changed();
  }

  private changed() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  meta() {
    return listProjects().find((p) => p.id === this.project);
  }

  rename(name: string) {
    renameProject(this.project, name);
    this.changed();
  }

  /** No send has made a version yet. */
  isEmpty = () => this.history.latest() === 0;

  /** The board after a send, as a new version, saved. */
  commit(label: string) {
    this.history.commit(this.scene.toJSON(), label);
    this.save();
  }

  look(n: number | undefined, pin = false) {
    this.history.look(n, pin);
    this.draw();
  }

  stopLooking() {
    if (this.history.looking === undefined) return;
    this.history.stopLooking();
    this.draw();
  }

  /** Version n as the live board again, a new version: nothing is lost. */
  restore(n: number) {
    // A send's board is still settling: its version isn't saved yet.
    if (this.busy) return;
    const v = this.history.restore(n);
    this.scene = Scene.fromJSON(v.doc);
    this.placement = undefined;
    this.save();
    void this.settle({ glideMs: SETTLE_MS });
  }

  private latestScene() {
    return Scene.fromJSON(this.history.versions.at(-1)?.doc ?? blankBoard());
  }

  private save() {
    saveVersions(this.project, this.history.versions);
    // Storage keeps the newest versions, and renumbers them if another tab saved meanwhile.
    this.history.versions = loadVersions(this.project);
    this.draw();
  }

  /** Puts the project in the URL, so a reload or a copied link opens the same one. */
  private keepUrl() {
    const url = new URL(location.href);
    if (url.searchParams.get("p") === this.project) return;
    url.searchParams.set("p", this.project);
    history.replaceState(history.state, "", url);
  }

  private adoptSaved() {
    if (this.busy) return;
    const saved = loadVersions(this.project);
    const theirs = saved.at(-1);
    const ours = this.history.versions.at(-1);
    if (!theirs || (ours && theirs.n === ours.n && theirs.at === ours.at)) return;
    const looking = this.history.looking;
    this.history = new History(saved);
    this.parsed.clear();
    this.placements.clear();
    if (looking !== undefined && saved.some((v) => v.n === looking)) this.history.look(looking, true);
    this.scene = Scene.fromJSON(theirs.doc);
    this.placement = undefined;
    void this.settle({ glideMs: 0 });
  }
}
