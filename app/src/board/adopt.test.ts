// Old boards' page arrows become links (adopt.ts): the model drew them before links were data.
import { describe, expect, it } from "vitest";
import { runScript } from "../../../src/core/ops.ts";
import { Scene, type SceneJSON } from "../../../src/core/scene.ts";
import { adoptArrows } from "./adopt.ts";
import demo from "./fixtures/spoke-and-chain-v9.json";

const D = '"a part of the page used by these tests"';

describe("old page arrows", () => {
  it("on the demo board, become links on the nav items under their tails", () => {
    const scene = Scene.fromJSON(demo as SceneJSON);
    expect(adoptArrows(scene)).toBe(2);
    expect(scene.get("nav-services")!.link).toBe("services");
    expect(scene.get("nav-contact")!.link).toBe("contact");
    expect(scene.get("home-to-services")).toBeUndefined();
    expect(scene.get("contact-link")).toBeUndefined();
  });

  it("an arrow with nothing under its tail, or within one page, stays a drawing", () => {
    const { scene } = runScript(`shape(home, frame, 0 0 1280 800, ${D})
shape(shop, frame, 1400 0 1280 800, ${D})
shape(across, arrow, 600 400 820 0, ${D})
shape(btn, pill, 100 100 200 50, ${D})
shape(within, arrow, 300 125 400 0, ${D})`);
    expect(adoptArrows(scene)).toBe(0);
    expect(scene.get("across")).toBeDefined();
    expect(scene.get("within")).toBeDefined();
    expect(scene.get("btn")!.link).toBeUndefined();
  });
});
