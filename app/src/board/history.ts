// A project's history: the whole board after every send (or restore), numbered,
// with v1's way of looking back (src/page/store.ts): hover a version to see it,
// click to keep it shown, restore it as a new version so nothing is lost. A v2
// board is restored whole (v1 could restore one page of a site).
import type { SceneJSON } from "../../../src/core/scene.ts";

/** The board after a send. `n` keeps counting even when old versions are dropped. Stored as v1 stored a site. */
export type Version = { n: number; doc: SceneJSON; at: number; label: string };

export class History {
  versions: Version[];
  /** A version shown on the canvas instead of the latest. */
  looking?: number;
  /** Whether `looking` stays when the pointer leaves the history (clicked rather than hovered). */
  pinned = false;

  constructor(versions: Version[]) {
    this.versions = versions;
  }

  latest(): number {
    return this.versions.at(-1)?.n ?? 0;
  }

  doc(n: number): SceneJSON | undefined {
    return this.versions.find((v) => v.n === n)?.doc;
  }

  newestFirst(): Version[] {
    return [...this.versions].reverse();
  }

  /** Keeps a copy: Scene.toJSON() hands out the live shapes, which the next op changes in place. */
  commit(doc: SceneJSON, label: string, at = Date.now()): Version {
    const v: Version = { n: this.latest() + 1, doc: structuredClone(doc), at, label };
    this.versions.push(v);
    return v;
  }

  /** Shows version n (undefined: back to the latest). `pin` keeps it there. */
  look(n: number | undefined, pin = false) {
    if (this.pinned && !pin) return; // a clicked version stays until another is clicked
    if (n === undefined || n === this.latest()) return this.stopLooking();
    this.looking = n;
    this.pinned = pin;
  }

  stopLooking() {
    this.looking = undefined;
    this.pinned = false;
  }

  /** Makes version n the latest again, as a new version. */
  restore(n: number): Version {
    this.stopLooking();
    const doc = this.doc(n);
    if (!doc) throw new Error(`no version ${n}`);
    return this.commit(doc, `Restored V${n}`);
  }
}
