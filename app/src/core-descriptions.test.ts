// A shape's description in the op language (src/core/ops.ts): one shorter than
// ops.minDescriptionWords says little to find the shape by later, but it never costs the
// shape. The model wrote "hero headline over the photo" (5 words) and the page lost its
// headline, its button and a whole card.
import { describe, expect, it } from "vitest";
import { runScript } from "../../src/core/ops.ts";

const D = '"a part of the page used by these tests"';

describe("short descriptions", () => {
  it("a new shape with a short description is drawn anyway, and its text and picture land on it", () => {
    const { scene, errors } = runScript(`shape(hero-title, rect, 80 210 600 80, "hero headline over the photo", fill:none)
text(hero-title, "Baked fresh every morning", size:xl)
shape(card1, rect, 80 550 340 220, "card for croissant")
drawing(card1, "butter croissant doodle")`);
    expect(errors).toEqual([]);
    expect(scene.get("hero-title")).toMatchObject({ description: "hero headline over the photo", text: { words: "Baked fresh every morning" } });
    expect(scene.get("card1")).toMatchObject({ description: "card for croissant", drawing: "butter croissant doodle" });
  });

  it("an edit with a short description still moves the shape, and keeps the description it had", () => {
    const { scene, errors } = runScript(`shape(card, rect, 0 0 300 200, ${D})
shape(card, 400 0 300 200, "the card", fill:#ffa94d)`);
    expect(errors).toEqual([]);
    expect(scene.get("card")).toMatchObject({ box: { x: 400, y: 0, w: 300, h: 200 }, description: "a part of the page used by these tests", style: { fill: "#ffa94d" } });
  });

  it("a new shape still needs some description", () => {
    const { scene, errors } = runScript("shape(card, rect, 0 0 300 200)");
    expect(errors.map((e) => e.error)).toEqual(['new shape "card" needs a "description" of what it is and what it\'s for']);
    expect(scene.get("card")).toBeUndefined();
  });
});
