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

describe("links that name a page by its name", () => {
  it("become links to that page's id; real ids and forward links to new pages stay", async () => {
    const { adoptLinks } = await import("./adopt.ts");
    const { scene } = runScript(`shape(page, frame, 0 0 1280 800, ${D})
text(page, "Home")
shape(svc, frame, 1400 0 1280 800, ${D})
text(svc, "Our Services")
shape(logo, rect, 40 20 200 40, ${D}, link:home)
shape(more, pill, 80 300 200 50, ${D}, link:our-services)
shape(nav-home, pill, 800 28 80 30, ${D}, link:page)
shape(nav-contact, pill, 1030 28 110 30, ${D}, link:contact)
shape(to-logo, pill, 80 400 200 50, ${D}, link:logo)`);
    expect(adoptLinks(scene)).toBe(2);
    expect(["logo", "more", "nav-home", "nav-contact", "to-logo"].map((id) => scene.get(id)!.link)).toEqual(["page", "svc", "page", "contact", "logo"]);
  });
});
