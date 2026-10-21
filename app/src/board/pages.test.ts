import { describe, expect, it } from "vitest";
import { asPage } from "../../../src/core/board.ts";
import { runScript } from "../../../src/core/ops.ts";
import { Scene } from "../../../src/core/scene.ts";
import { pageRows, siteName } from "./pages.ts";

// Descriptions have 6+ words, or v2's ops throw the shape away (ops.minDescriptionWords).
const bakery = runScript(`shape(home, frame, 0 0 1280 800, "the Home page of the bakery site")
text(home, "Home")
shape(logo, rect, 40 20 200 40, "the bakery's name at the top left of the header")
text(logo, "Crumb & Co bakery")
shape(shop, frame, 1400 0 1280 800, "the shop page listing the bakery's breads")
text(shop, "Shop")
shape(cart, frame, 2800 0 1280 800, "the cart page with the chosen breads")
text(cart, "Cart")
shape(a1, arrow, 1280 400 120 0, "a link from home to the shop page")
shape(a2, arrow, 2680 400 120 0, "a link from the shop to the cart page")
shape(about, frame, 0 1000 1280 800, "the about page telling the bakery's story")
text(about, "About")`).scene;

describe("pages", () => {
  it("pages come in reading order with their link depth", () => {
    expect(pageRows(bakery)).toMatchObject([
      { id: "home", name: "Home", depth: 0, home: true },
      { id: "shop", name: "Shop", depth: 1, home: false },
      { id: "cart", name: "Cart", depth: 2, home: false },
      { id: "about", name: "About", depth: 0, home: false },
    ]);
  });

  it("a board without pages has no rows", () => {
    expect(pageRows(new Scene())).toEqual([]);
  });

  it("siteName is the topmost text on the first page", () => {
    expect(siteName(bakery)).toBe("Crumb & Co bakery");
    expect(siteName(runScript(asPage("", "page", "Home")).scene)).toBe("Untitled");
  });
});
