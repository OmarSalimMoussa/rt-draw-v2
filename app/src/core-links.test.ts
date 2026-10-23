// Links as data in v2's core: a shape's link and button, the board's home, and
// what's built on them (src/core/scene.ts, ops.ts, board.ts, prompts.ts).
import { describe, expect, it } from "vitest";
import { runScript } from "../../src/core/ops.ts";
import { Scene } from "../../src/core/scene.ts";

// Descriptions have 6+ words, as v2's ops want them (ops.minDescriptionWords).
const D = '"a part of the page used by these tests"';

describe("links and buttons on shapes", () => {
  it("a new shape takes link: and button: beside its style", () => {
    const { scene, errors } = runScript(`shape(a, rect, 0 0 10 10, ${D}, link:contact, button:yes, fill:#fde)`);
    expect(errors).toEqual([]);
    expect(scene.get("a")).toMatchObject({ link: "contact", button: true, style: { fill: "#fde" } });
  });

  it("on an existing shape each key changes only its own field", () => {
    const { scene, errors } = runScript(`shape(a, rect, 0 0 10 10, ${D}, link:contact, button:yes)
shape(a, link:none)`);
    expect(errors).toEqual([]);
    expect(scene.get("a")!.link).toBeUndefined();
    expect(scene.get("a")!.button).toBe(true);
    runScript(`shape(a, link:services)\nshape(a, button:no)`, scene);
    expect(scene.get("a")).toMatchObject({ link: "services", button: false });
  });

  it("button takes only yes or no, and a rejected line leaves the shape as it was", () => {
    const { scene, errors } = runScript(`shape(a, rect, 0 0 10 10, ${D}, link:contact)
shape(a, 20 20 10 10, link:none, button:maybe)`);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/yes or no/);
    expect(scene.get("a")).toMatchObject({ link: "contact", box: { x: 0, y: 0 } });
  });

  it("a link may name a page that doesn't exist yet", () => {
    const { scene } = runScript(`shape(a, rect, 0 0 10 10, ${D}, link:contact)`);
    expect(scene.get("contact")).toBeUndefined();
    expect(scene.get("a")!.link).toBe("contact");
  });

  it("the link, the button and home are saved with the board", () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})
shape(a, rect, 0 0 10 10, ${D}, link:contact, button:yes)`);
    const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
    expect(back.home).toBe("home");
    expect(back.get("a")).toMatchObject({ link: "contact", button: true });
  });
});

describe("the board's home", () => {
  it("is the first frame made, and later frames don't change it", () => {
    const { scene } = runScript(`shape(a, rect, 0 0 10 10, ${D})
shape(home, frame, 0 0 1280 800, ${D})
shape(shop, frame, 1400 -900 1280 800, ${D})`);
    expect(scene.home).toBe("home");
  });

  it("removing home hands it to the oldest frame", () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})
shape(shop, frame, 1400 0 1280 800, ${D})
shape(cart, frame, 2800 0 1280 800, ${D})
remove(home)`);
    expect(scene.home).toBe("shop");
    runScript("remove(shop)\nremove(cart)", scene);
    expect(scene.home).toBeUndefined();
  });
});

// A site whose layout put Services above Home (as v1's layout does): reading order would start with Services.
const site = () =>
  runScript(`shape(page, frame, 0 0 1280 800, ${D})
text(page, "Home")
shape(nav-home, pill, 800 28 80 30, ${D}, link:page)
shape(nav-services, pill, 900 28 110 30, ${D}, link:services)
shape(nav-contact, pill, 1030 28 110 30, ${D}, link:contact)
shape(hero-title, rect, 80 200 600 80, ${D})
shape(book, pill, 80 320 200 50, ${D}, button:yes)
shape(services, frame, 1500 -1070 1280 800, ${D})
text(services, "Services")
shape(s-nav-home, pill, 2300 -1042 80 30, ${D}, link:page)
shape(s-nav-contact, pill, 2530 -1042 110 30, ${D}, link:contact)
shape(s-card, rect, 1580 -800 300 200, ${D}, link:pricing)
shape(about, frame, 1500 1000 1280 800, ${D})
text(about, "About")
shape(old-arrow, arrow, 1280 400 220 0, ${D})`).scene;

describe("links from the fields", () => {
  it("linksOf reads shape.link, skipping its own page, missing pages and arrows", async () => {
    const { linksOf } = await import("../../src/core/board.ts");
    expect(linksOf(site()).map((l) => [l.from.id, l.via.id, l.to.id])).toEqual([["page", "nav-services", "services"], ["services", "s-nav-home", "page"]]);
  });

  it("links to a non-frame shape are forward links", async () => {
    const { linksOf, siteMap, siteTree } = await import("../../src/core/board.ts");
    const scene = site();
    runScript("shape(book, link:hero-title)", scene);
    expect(linksOf(scene).some((l) => l.via.id === "book")).toBe(false);
    expect(siteTree(scene).map((p) => p.page.id)).toEqual(["page", "services", "about"]);
    expect(siteMap(scene)).toContain("book: a part of the page used by these tests → hero-title (no page yet)");
  });

  it("clickable: a link or a button, never a page", async () => {
    const { clickable } = await import("../../src/core/board.ts");
    const scene = site();
    expect(["nav-contact", "book", "hero-title", "page"].map((id) => clickable(scene.get(id)!))).toEqual([true, true, false, false]);
  });
});

describe("the link tree", () => {
  it("starts at home, nests each page under the first element that leads to it, and puts unreached pages last", async () => {
    const { siteTree } = await import("../../src/core/board.ts");
    expect(siteTree(site()).map((p) => [p.page.id, p.depth, p.via?.via.id])).toEqual([
      ["page", 0, undefined],
      ["services", 1, "nav-services"],
      ["about", 0, undefined],
    ]);
  });

  it("the first element in reading order claims the page; nav copies claim nothing", async () => {
    const { siteTree } = await import("../../src/core/board.ts");
    const scene = site();
    runScript(`shape(contact, frame, 3000 0 1280 800, ${D})\nshape(cta, pill, 80 500 200 50, ${D}, link:contact)`, scene);
    const tree = siteTree(scene);
    expect(tree.find((p) => p.page.id === "contact")?.via?.via.id).toBe("nav-contact");
    expect(tree.filter((p) => p.via).map((p) => p.via!.via.id)).toEqual(["nav-services", "nav-contact"]);
  });

  it("home is scene.home; without one, the first page in reading order", async () => {
    const { homeOf } = await import("../../src/core/board.ts");
    const scene = site();
    expect(homeOf(scene)?.id).toBe("page");
    scene.home = undefined;
    expect(homeOf(scene)?.id).toBe("services");
  });
});

describe("the site map", () => {
  it("marks what a visitor can click and where it goes", async () => {
    const { siteMap } = await import("../../src/core/board.ts");
    const scene = site();
    runScript(`shape(contact, frame, 3000 0 1280 800, ${D})`, scene);
    const map = siteMap(scene);
    expect(map).toContain("nav-contact: a part of the page used by these tests → contact\n");
    expect(map).toContain("s-card: a part of the page used by these tests → pricing (no page yet)");
    expect(map).toContain("book: a part of the page used by these tests [button]");
    expect(map).not.toMatch(/hero-title[^\n]*(→|\[button\])/);
  });

  it("lists pages in tree order, home first", async () => {
    const { siteMap } = await import("../../src/core/board.ts");
    const pages = [...siteMap(site()).matchAll(/^\d+\. \S+ \[(\S+)\]/gm)].map((m) => m[1]);
    expect(pages).toEqual(["page", "services", "about"]);
  });
});

describe("the op manual", () => {
  it("on a board, says how to make things clickable, that the board draws the arrows, and that a frame is a whole page", async () => {
    const { promptOf } = await import("../../src/core/prompts.ts");
    const { DEFAULTS } = await import("../../src/core/tuning.ts");
    const board = promptOf("draw", DEFAULTS).system(true, 1280, 800, 0, 1280);
    const canvas = promptOf("draw", DEFAULTS).system(false, 1280, 800, 40, 1280);
    expect(board).toMatch(/link:<page id>/);
    expect(board).toMatch(/button:yes/);
    expect(board).toMatch(/never draw arrows between pages/i);
    expect(board).toMatch(/beside the others without overlapping them/);
    expect(board).toMatch(/only ever a whole page: a strip, panel or card on a page is a rect/);
    expect(canvas).not.toMatch(/link:</);
  });
});
