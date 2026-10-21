// The editor's state: the project open in this tab, its live board (the v2
// scene a send draws on, in place), its history, and the tuning sends run with.
// After v1's PageStore (src/page/store.ts) without the HTML: redraws go to the
// board's <svg> once per animation frame (BoardView.tsx), as the eval's bridge
// coalesces them, and the React parts subscribe for everything else. One Board per
// project opened in the tab: opening another one (New project included) mounts a new
// editor (Root.tsx), so a send still finishing commits to the project it began on.
import { Scene } from "../../../src/core/scene.ts";
import type { Tuning } from "../../../src/core/tuning.ts";
import { tuningFor } from "../models.ts";
import { SAVED_EVENT, blankBoard, currentProjectId, listProjects, loadVersions, renameProject, saveVersions, savedFor } from "../projects/storage.ts";
import { getModel, onSettings } from "../settings.ts";
import { History } from "./history.ts";

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

  private version = 0;
  private frame = 0;
  private listeners = new Set<() => void>();
  private painters = new Set<() => void>();
  /** Versions looked at, parsed once each. */
  private parsed = new Map<number, Scene>();

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
    if (n === undefined) return this.scene;
    let s = this.parsed.get(n);
    if (!s) this.parsed.set(n, (s = Scene.fromJSON(this.history.doc(n)!)));
    return s;
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
    const v = this.history.restore(n);
    this.scene = Scene.fromJSON(v.doc);
    this.save();
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
    if (looking !== undefined && saved.some((v) => v.n === looking)) this.history.look(looking, true);
    this.scene = Scene.fromJSON(theirs.doc);
    this.draw();
  }
}
