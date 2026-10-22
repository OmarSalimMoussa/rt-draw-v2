// Links as data in v2's core: a shape's link and button, the board's home, and
// what's built on them (src/core/scene.ts, ops.ts, board.ts, prompts.ts).
import { describe, expect, it } from "vitest";
import { runScript } from "../../src/core/ops.ts";
import { Scene } from "../../src/core/scene.ts";

// Descriptions have 6+ words, or v2's ops throw the shape away (ops.minDescriptionWords).
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
