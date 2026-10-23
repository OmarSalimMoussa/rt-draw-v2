import { describe, expect, it } from "vitest";
import { asPage } from "../../../src/core/board.ts";
import { runScript } from "../../../src/core/ops.ts";
import { Scene } from "../../../src/core/scene.ts";
import { pageRows, siteName } from "./pages.ts";

// Descriptions have 6+ words, as v2's ops want them (ops.minDescriptionWords).
const bakery = runScript(`shape(home, frame, 0 0 1280 800, "the Home page of the bakery site")
text(home, "Home")
shape(logo, rect, 40 20 200 40, "the bakery's name at the top left of the header")
text(logo, "Crumb & Co bakery")
shape(shop, frame, 1400 0 1280 800, "the shop page listing the bakery's breads")
text(shop, "Shop")
shape(cart, frame, 2800 0 1280 800, "the cart page with the chosen breads")
text(cart, "Cart")
shape(to-shop, pill, 40 400 200 50, "the button on home that opens the shop page", link:shop)
shape(to-cart, pill, 1440 400 200 50, "the button on the shop that opens the cart page", link:cart)
shape(about, frame, 0 1000 1280 800, "the about page telling the bakery's story")
text(about, "About")`).scene;

describe("pages", () => {
  it("pages come in tree order with their link depth", () => {
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

  it("siteName is the topmost text on the home page", () => {
    expect(siteName(bakery)).toBe("Crumb & Co bakery");
    // Home placed below another page still names the site.
    const moved = Scene.fromJSON(bakery.toJSON());
    moved.move("shop", { x: 1400, y: -2000 });
    expect(siteName(moved)).toBe("Crumb & Co bakery");
    expect(siteName(runScript(asPage("", "page", "Home")).scene)).toBe("Untitled");
  });
});
