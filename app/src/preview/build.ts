// Building a page from a preview click, v1's generative walkthrough on v2's board:
// a send like any other, queued behind whatever the editor is drawing. When its
// turn comes, and before any model call, its page is made in code (a frame the size
// of the page clicked from, named by the clicked words) with the clicked shape's
// link to it, the board places it, and the camera glides onto it; then the model is
// asked to draw it, and the visitor watches it fill in. If nothing gets drawn, the
// page and the link are taken away again.
import { norm, pageName, pagesOf } from "../../../src/core/board.ts";
import type { Scene, Shape } from "../../../src/core/scene.ts";
import type { Job, JobStatus } from "../board/sender.ts";
import { buildInstruction, clickedWords, freshPageId } from "./preview.ts";

export type BuildDeps = {
  /** The live board. */
  scene: () => Scene;
  /** Places the pages (Board.settle), the new one among them. */
  settle: () => Promise<void>;
  /** Glides the editor's camera onto the new page, so the model's "what you see" is that page. */
  focus: (page: Shape) => Promise<void>;
  /** performance.now(), the job's Enter. */
  enter: () => number;
};

/** The send that builds a click's page, the page's id, the clicked words, and the size it will be. */
export type Build = { job: Job; to: string; label: string; w: number; h: number };

/** Where a page is made before the layout places it: right of the others, in the row the board keeps for new pages. */
const BESIDE = 140;

export function buildJob(deps: BuildDeps, click: { shape: Shape; from: Shape }, onDone: (status: JobStatus, landed: number, error?: string) => void): Build {
  const scene = deps.scene();
  const label = clickedWords(scene, click.shape);
  // A forward link names the page to make; otherwise a fresh id from the words.
  const forward = click.shape.link && !scene.get(click.shape.link) ? click.shape.link : undefined;
  const to = forward ?? freshPageId(scene, label);
  const { w, h } = norm(click.from.box);
  let say!: (words: string) => void;
  const words = new Promise<string>((r) => (say = r));
  /** What the build added, to take away if nothing gets drawn. */
  let made: { page: string; shape: string; link?: string } | undefined;

  const before = async () => {
    const live = deps.scene();
    const el = live.get(click.shape.id);
    const from = live.get(click.from.id);
    if (!el || !from) throw new Error("what was clicked isn't on the board any more");
    if (live.get(to)) throw new Error(`there's already something called ${to}`);
    const right = Math.max(...pagesOf(live).map((p) => norm(p.box).x + norm(p.box).w));
    live.add({ id: to, kind: "frame", box: { x: right + BESIDE, y: 0, w, h }, description: `the ${label} page, opened by clicking “${label}” on the ${pageName(from)} page`, style: {}, text: { words: label } });
    made = { page: to, shape: el.id, link: el.link };
    el.link = to;
    await deps.settle();
    const page = live.get(to)!;
    await deps.focus(page);
    say(buildInstruction(live, el, from, page));
  };

  const done = (status: JobStatus, landed: number, error?: string) => {
    if (made && !landed) {
      const live = deps.scene();
      live.remove(made.page);
      const el = live.get(made.shape);
      if (el) {
        if (made.link === undefined) delete el.link;
        else el.link = made.link;
      }
      made = undefined;
      void deps.settle();
    }
    onDone(status, landed, error);
  };

  return { job: { label: `Preview click: ${label}`, spoken: false, strokes: [], words, enter: deps.enter(), before, done }, to, label, w, h };
}
