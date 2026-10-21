import { describe, expect, it } from "vitest";
import { asPage } from "../../../src/core/board.ts";
import { runScript } from "../../../src/core/ops.ts";
import { History } from "./history.ts";

const board = () => runScript(asPage("", "page", "Home")).scene;

/** Two versions: a blank Home page, then one with a hero box on it. */
function twoVersions() {
  const scene = board();
  const h = new History([]);
  h.commit(scene.toJSON(), "start", 1);
  runScript(`shape(hero, rect, 0 80 1280 400, "a big yellow hero banner across the top")`, scene);
  h.commit(scene.toJSON(), "add a hero", 2);
  return h;
}

describe("history", () => {
  it("commit numbers each version after the latest", () => {
    const h = twoVersions();
    expect(h.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(h.latest()).toBe(2);
  });

  it("commit stores a copy the live board can't change", () => {
    const scene = board();
    const h = new History([]);
    const j = scene.toJSON();
    const before = structuredClone(j);
    h.commit(j, "start");
    // toJSON() hands out the live shapes: a later op on the board, or a change to that JSON, must not reach the version.
    scene.get("page")!.box.x = 999;
    runScript(`shape(hero, rect, 0 80 1280 400, "a big yellow hero banner across the top")`, scene);
    j.shapes[0].box.y = -5;
    expect(h.doc(1)).toEqual(before);
  });

  it("hovering looks at a version and the latest stops looking", () => {
    const h = twoVersions();
    h.look(1);
    expect(h.looking).toBe(1);
    h.look(2);
    expect(h.looking).toBeUndefined();
    h.look(1);
    h.look(undefined);
    expect(h.looking).toBeUndefined();
  });

  it("a clicked version stays until another is clicked", () => {
    const h = twoVersions();
    h.look(1, true);
    h.look(2);
    expect(h.looking).toBe(1);
    expect(h.pinned).toBe(true);
    h.look(2, true);
    expect(h.looking).toBeUndefined();
    expect(h.pinned).toBe(false);
  });

  it("restore adds the old board as a new version and keeps the rest", () => {
    const h = twoVersions();
    h.look(1, true);
    const v = h.restore(1);
    expect(v).toMatchObject({ n: 3, label: "Restored V1" });
    expect(v.doc).toEqual(h.doc(1));
    expect(h.versions).toHaveLength(3);
    expect(h.looking).toBeUndefined();
  });
});
