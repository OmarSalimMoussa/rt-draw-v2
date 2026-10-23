// A page called by its name in the op language (src/core/ops.ts): the model sometimes writes a
// page's name where its id goes. Asked for a phone app on a fresh board, it wrote
// shape(Home, frame, 0 0 390 844, ...) to reshape the empty page "Home" (id page) to a phone's
// size, and got a second page beside the empty one.
import { describe, expect, it } from "vitest";
import { runScript } from "../../src/core/ops.ts";

const D = '"a part of the page used by these tests"';
const start = `shape(page, frame, 0 0 1280 800, "the Home page, the one page of this site so far")
text(page, "Home")`;

describe("a page called by its name", () => {
  it("reshaping it by name reshapes that page, and adds none", () => {
    const { scene, errors } = runScript(`${start}
shape(Home, frame, 0 0 390 844, "water tracking phone app home screen")`);
    expect(errors).toEqual([]);
    expect([...scene.shapes.values()].filter((s) => s.kind === "frame").map((s) => [s.id, s.box.w, s.box.h])).toEqual([["page", 390, 844]]);
    expect(scene.get("page")!.text!.words).toBe("Home");
  });

  it("works for its other ops too, whatever the case", () => {
    const { scene, errors } = runScript(`${start}
move(HOME, 0 0 400 900)
text(home, "Start")`);
    expect(errors).toEqual([]);
    expect(scene.get("page")).toMatchObject({ box: { x: 0, y: 0, w: 400, h: 900 }, text: { words: "Start" } });
  });

  it("an id that is a shape is always that shape, even if a page has its name", () => {
    const { scene, errors } = runScript(`${start}
shape(home, rect, 40 40 200 60, ${D})
shape(home, rect, 40 40 300 60)`);
    expect(errors).toEqual([]);
    expect(scene.get("home")!.box.w).toBe(300);
    expect(scene.get("page")!.box.w).toBe(1280);
  });

  it("a new page with a name of its own is still a new page", () => {
    const { scene } = runScript(`${start}
shape(menu, frame, 1500 0 1280 800, "the Menu page listing everything the bakery sells")`);
    expect([...scene.shapes.values()].filter((s) => s.kind === "frame").map((s) => s.id)).toEqual(["page", "menu"]);
  });
});
