// The preview's rules (preview.ts): its URL, what a click hits, where it goes, and
// what a click with no page yet asks the model for.
import { describe, expect, it } from "vitest";
import { runScript } from "../../../src/core/ops.ts";
import { boilCss } from "../board/boil.ts";
import { buildInstruction, clickedWords, existingPage, freshPageId, hitClickable, previewHash, previewOfHash, targetOf } from "./preview.ts";

const D = '"a part of the page used by these tests"';
const site = () =>
  runScript(`shape(page, frame, 0 0 1280 800, ${D})
text(page, "Home")
shape(header, rect, 0 0 1280 80, ${D})
shape(nav-home, pill, 800 28 80 30, ${D})
text(nav-home, "Home")
shape(nav-services, pill, 900 28 110 30, ${D}, link:services)
text(nav-services, "Services")
shape(nav-contact, pill, 1030 28 110 30, ${D}, link:contact)
text(nav-contact, "  Contact ")
shape(hero-title, rect, 80 200 600 80, ${D})
text(hero-title, "Your neighbourhood bike repair shop")
shape(book, pill, 80 320 200 50, ${D}, button:yes)
shape(book-label, rect, 90 330 180 30, ${D})
text(book-label, "Book a repair")
shape(photo, rect, 700 160 500 400, ${D}, button:yes)
drawing(photo, "a mechanic fixing a bike")
shape(services, frame, 1500 -1070 1280 800, ${D})
text(services, "Services")`).scene;

describe("the preview's URL", () => {
  it("is a hash on the editor's URL, so a reload reopens the same page", () => {
    expect(previewOfHash("#preview=contact")).toBe("contact");
    expect(previewOfHash("#preview=my%20page")).toBe("my page");
    expect(previewOfHash("#preview")).toBeNull();
    expect(previewOfHash("")).toBeUndefined();
    expect(previewOfHash("#other")).toBeUndefined();
    expect(previewHash("my page")).toBe("#preview=my%20page");
    expect(previewHash()).toBe("#preview");
  });
});

describe("what a click hits", () => {
  const scene = site();
  const home = scene.get("page")!;
  it("the topmost clickable under the pointer; words inside a button count as the button", () => {
    expect(hitClickable(scene, home, { x: 950, y: 40 })?.id).toBe("nav-services");
    expect(hitClickable(scene, home, { x: 150, y: 345 })?.id).toBe("book");
  });
  it("headings, plain shapes and empty space do nothing", () => {
    expect(hitClickable(scene, home, { x: 300, y: 240 })).toBeUndefined();
    expect(hitClickable(scene, home, { x: 840, y: 40 })).toBeUndefined();
    expect(hitClickable(scene, home, { x: 40, y: 700 })).toBeUndefined();
  });
  it("only on the page shown", () => {
    expect(hitClickable(scene, scene.get("services")!, { x: 950, y: 40 })).toBeUndefined();
  });
});

describe("where a click goes", () => {
  it("the clicked words: its text, else the words inside it, else its picture, else its id", () => {
    const scene = site();
    expect(clickedWords(scene, scene.get("nav-contact")!)).toBe("Contact");
    expect(clickedWords(scene, scene.get("book")!)).toBe("Book a repair");
    expect(clickedWords(scene, scene.get("photo")!)).toBe("a mechanic fixing a bike");
    runScript(`shape(bare, rect, 300 600 50 50, ${D}, button:yes)`, scene);
    expect(clickedWords(scene, scene.get("bare")!)).toBe("bare");
  });

  it("a link to an existing page goes there; no link, or a forward link, finds a page by its name", () => {
    const scene = site();
    expect(targetOf(scene, scene.get("nav-services")!)?.id).toBe("services");
    expect(targetOf(scene, scene.get("nav-contact")!)).toBeUndefined();
    runScript(`shape(nav-home, button:yes)\nshape(cta-services, pill, 300 600 200 50, ${D}, link:pricing)\ntext(cta-services, "  SERVICES ")`, scene);
    expect(existingPage(scene, scene.get("nav-home")!)?.id).toBe("page");
    expect(targetOf(scene, scene.get("nav-home")!)?.id).toBe("page");
    expect(targetOf(scene, scene.get("cta-services")!)?.id).toBe("services");
    expect(targetOf(scene, scene.get("book")!)).toBeUndefined();
  });

  it("a new page's id comes from the words, readable and unused", () => {
    const scene = site();
    expect(freshPageId(scene, "Contact us!")).toBe("contact-us");
    expect(freshPageId(scene, "Services")).toBe("services-2");
    expect(freshPageId(scene, "!!!")).toBe("page-2");
  });
});

describe("the build instruction", () => {
  it("names what was clicked, where, and the page made for it, with its box", () => {
    const scene = site();
    runScript(`shape(contact, frame, 1500 -130 1280 800, ${D})\ntext(contact, "Contact")`, scene);
    const said = buildInstruction(scene, scene.get("nav-contact")!, scene.get("page")!, scene.get("contact")!);
    expect(said).toBe(
      "Preview click: a visitor clicked “Contact” (nav-contact) on the Home page. Its page, contact, has just been made, empty, at 1500 -130 1280 800. They're watching it being built: draw it now, top to bottom, starting with the same header and nav as the other pages, in the site's style.",
    );
  });
});

describe("the boil", () => {
  it("jitters between three spots px apart, 0.15 s each, and stops for reduced motion", () => {
    const css = boilCss("pv", '.pv-page > g[data-id="book"]', 0.25);
    expect(css).toContain("@keyframes boil-pv { 0% { translate: 0.25px 0; } 33.33% { translate: -0.25px 0.25px; } 66.66% { translate: 0 -0.25px; } }");
    expect(css).toContain('.pv-page > g[data-id="book"] { animation: boil-pv 0.45s steps(1, end) infinite; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.pv-page > g\[data-id="book"\] \{ animation: none; \} \}/);
  });
});
