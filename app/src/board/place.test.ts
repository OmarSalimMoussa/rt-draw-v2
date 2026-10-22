// Placing the board's pages from its links, v1's way (place.ts on layout.ts), checked
// on random boards: the properties every placement must have, whatever the links.
import ELK from "elkjs/lib/elk.bundled.js";
import { beforeAll, describe, expect, it } from "vitest";
import { pagesOf, siteTree } from "../../../src/core/board.ts";
import { runScript } from "../../../src/core/ops.ts";
import { type Box, Scene } from "../../../src/core/scene.ts";
import { setElk } from "./layout.ts";
import { type Placement, moveBy, placeBoard, shownArrows } from "./place.ts";

beforeAll(() => setElk(new ELK()));

const D = '"a part of the page used by these tests"';

/** mulberry32: the same boards every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1-12 pages in a row, each with up to 6 elements anywhere on it (edges included), about half of them linking to a random page. */
function randomBoard(seed: number): Scene {
  const r = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const n = int(1, 12);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const [w, h] = [r() < 0.7 ? 1280 : int(400, 1600), r() < 0.7 ? 800 : int(500, 2400)];
    lines.push(`shape(p${i}, frame, ${i * 3000} ${int(-500, 500)} ${w} ${h}, ${D})`);
    const x0 = i * 3000;
    const y0 = Number(lines.at(-1)!.split(" ")[3]);
    for (let k = int(0, 6); k > 0; k--) {
      const [ew, eh] = [int(20, 300), int(20, 200)];
      const link = r() < 0.55 ? `, link:p${int(0, n - 1)}` : "";
      lines.push(`shape(e${i}-${k}, rect, ${x0 + int(0, w - ew)} ${y0 + int(0, h - eh)} ${ew} ${eh}, ${D}${link})`);
    }
  }
  const { scene, errors } = runScript(lines.join("\n"));
  expect(errors).toEqual([]);
  return scene;
}

const inside = (b: Box, p: { x: number; y: number }) => p.x > b.x + 0.5 && p.x < b.x + b.w - 0.5 && p.y > b.y + 0.5 && p.y < b.y + b.h - 0.5;
/** Whether an axis-aligned segment runs through a box's inside. */
const crosses = (a: { x: number; y: number }, b: { x: number; y: number }, r: Box) =>
  Math.min(a.x, b.x) < r.x + r.w - 0.5 && Math.max(a.x, b.x) > r.x + 0.5 && Math.min(a.y, b.y) < r.y + r.h - 0.5 && Math.max(a.y, b.y) > r.y + 0.5;
const gapTo = (b: Box, p: { x: number; y: number }) => Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h));
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placing pages on random boards", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

  it.each(SEEDS)("board %i: home at the origin, no overlaps, one clean arrow per tree page", async (seed) => {
    const scene = randomBoard(seed);
    const tree = siteTree(scene);
    const p = await placeBoard(scene);
    moveBy(scene, p.at);
    const pages = pagesOf(scene);
    const home = scene.get(tree[0].page.id)!;
    expect(home.box).toMatchObject({ x: 0, y: 0 });
    for (const a of pages) for (const b of pages) if (a !== b) expect(overlap(a.box, b.box), `${a.id} overlaps ${b.id}`).toBe(false);

    const children = tree.filter((t) => t.via);
    expect(p.arrows.map((a) => a.to).sort()).toEqual(children.map((t) => t.page.id).sort());
    for (const a of p.arrows) {
      const el = scene.get(a.id)!;
      const to = scene.get(a.to)!.box;
      const [start, end] = [a.points[0], a.points.at(-1)!];
      expect(gapTo(el.box, start), `${a.id} starts by its element`).toBeLessThanOrEqual(6.01);
      expect(end.x).toBeCloseTo(to.x - 6, 1);
      expect(end.y).toBeGreaterThanOrEqual(to.y);
      expect(end.y).toBeLessThanOrEqual(to.y + to.h);
      for (let i = 1; i < a.points.length; i++) {
        const [u, v] = [a.points[i - 1], a.points[i]];
        expect(Math.abs(u.x - v.x) < 0.01 || Math.abs(u.y - v.y) < 0.01, `${a.id} segment ${i} is straight`).toBe(true);
        for (const pg of pages) {
          if (i === 1 && pg.id === a.from) continue; // leaving its own page
          expect(crosses(u, v, pg.box), `${a.id} segment ${i} runs through ${pg.id}`).toBe(false);
        }
      }
      expect(inside(to, end)).toBe(false);
    }
    // Placed where the arrows say: every arrow shows.
    expect(shownArrows(scene, p)).toHaveLength(p.arrows.length);
  });

  it("the same board always gives the same placement, and a placed board doesn't move", async () => {
    const twice = async (s: Scene) => JSON.stringify(await placeBoard(s), (_, v) => (v instanceof Map ? [...v] : v));
    const scene = randomBoard(7);
    const first = await twice(scene);
    expect(await twice(randomBoard(7))).toBe(first);
    const p = await placeBoard(scene);
    moveBy(scene, p.at);
    const again = await placeBoard(scene);
    expect([...again.at].every(([id, at]) => scene.get(id)!.box.x === at.x && scene.get(id)!.box.y === at.y)).toBe(true);
  });
});

describe("pages no link reaches", () => {
  it("sit in a row right of the rest, top-aligned with home, in the order they were made, 140 apart", async () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})
shape(go, pill, 80 300 200 50, ${D}, link:shop)
shape(lost-b, frame, 9000 4000 900 600, ${D})
shape(shop, frame, 3000 0 1280 800, ${D})
shape(lost-a, frame, -5000 0 1280 800, ${D})`);
    const p = await placeBoard(scene);
    const right = Math.max(...["home", "shop"].map((id) => p.at.get(id)!.x + 1280));
    expect(p.at.get("lost-b")).toEqual({ x: right + 140, y: 0 });
    expect(p.at.get("lost-a")).toEqual({ x: right + 140 + 900 + 140, y: 0 });
    expect(p.arrows.map((a) => a.id)).toEqual(["go"]);
  });

  it("a board with no links keeps a left-to-right row", async () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})\nshape(two, frame, 1380 0 1280 800, ${D})\nshape(three, frame, 2760 0 1280 800, ${D})`);
    const p = await placeBoard(scene);
    expect([...p.at]).toEqual([["home", { x: 0, y: 0 }], ["two", { x: 1420, y: 0 }], ["three", { x: 2840, y: 0 }]]);
  });
});

describe("moving pages", () => {
  it("a page's content moves with it; shapes on no page stay", () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})
shape(title, rect, 100 100 300 60, ${D})
shape(note, rect, 5000 5000 100 100, ${D})`);
    moveBy(scene, new Map([["home", { x: 40, y: -20 }]]));
    expect(scene.get("home")!.box).toMatchObject({ x: 40, y: -20 });
    expect(scene.get("title")!.box).toMatchObject({ x: 140, y: 80 });
    expect(scene.get("note")!.box).toMatchObject({ x: 5000, y: 5000 });
  });

  it("an arrow stops showing once its element or either of its pages moves", async () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})
shape(go, pill, 80 300 200 50, ${D}, link:shop)
shape(shop, frame, 3000 0 1280 800, ${D})`);
    const p: Placement = await placeBoard(scene);
    moveBy(scene, p.at);
    expect(shownArrows(scene, p)).toHaveLength(1);
    scene.move("go", { x: 90 });
    expect(shownArrows(scene, p)).toHaveLength(0);
    scene.move("go", { x: 80 });
    scene.move("shop", { y: 10 });
    expect(shownArrows(scene, p)).toHaveLength(0);
  });
});
