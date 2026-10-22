// The board's boil (boil.ts) is CSS from outside the board's <svg>: hovering
// something a visitor could click changes nothing the eval's clock watches.
import { describe, expect, it } from "vitest";
import { watch } from "../../../evals/bridge/timing.ts";
import { runScript } from "../../../src/core/ops.ts";
import { render } from "../../../src/core/render.ts";
import { hitClickable } from "../preview/preview.ts";
import { boilCss, shapeSelector } from "./boil.ts";

const D = '"a part of the page used by these tests"';
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

describe("the board's boil", () => {
  const { scene } = runScript(`shape(page, frame, 0 0 1280 800, ${D})
shape(go, pill, 80 300 200 50, ${D}, link:shop)
shape(shop, frame, 1500 0 1280 800, ${D})
shape(buy, pill, 1580 300 200 50, ${D}, button:yes)`);

  it("finds the clickable under the pointer on any page", () => {
    expect(hitClickable(scene, undefined, { x: 100, y: 320 })?.id).toBe("go");
    expect(hitClickable(scene, undefined, { x: 1600, y: 320 })?.id).toBe("buy");
    expect(hitClickable(scene, undefined, { x: 600, y: 600 })).toBeUndefined();
  });

  it("hovering changes no shape's signature on the eval's clock", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("bd");
    document.body.append(svg);
    render(svg, scene, { view: { x: 0, y: 0, w: 2800, h: 800 } });
    const clock = watch(svg);
    const before = clock.enter();
    const style = document.createElement("style");
    style.textContent = boilCss("bd", shapeSelector(".bd", "go"), 2);
    document.head.append(style);
    await frame();
    expect(clock.measure(before, performance.now()).changed).toEqual([]);
    expect(svg.querySelector('g[data-id="go"]')!.getAttribute("style")).toBeNull();
    style.remove();
    svg.remove();
  });
});
