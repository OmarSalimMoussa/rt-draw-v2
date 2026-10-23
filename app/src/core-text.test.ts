// A shape's text on screen (src/core/render.ts): text that would overflow its box is drawn
// smaller until it fits, since the shape cuts off whatever sticks out. A bakery's "Golden Crumb"
// at 28px in a 200×40 logo box wrapped to two lines and lost its top and bottom.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";

const D = '"a part of the page used by these tests"';
const LH = DEFAULTS["render.lineHeight"];

/** Each character is 0.55 of the font size wide: about right for Excalifont. */
const context = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText(this: { font: string }, t: string) {
      return { width: t.length * parseFloat(this.font.split(" ")[1]) * 0.55 };
    },
  })) as never;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = context;
});

/** The text of shape `id` as drawn: its size and its lines. */
function drawn(script: string, id: string) {
  const { scene, errors } = runScript(script);
  expect(errors).toEqual([]);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  render(svg, scene);
  const text = svg.querySelector(`g[data-id="${id}"] text`)!;
  return { size: Number(text.getAttribute("font-size")), lines: [...text.querySelectorAll("tspan")].map((t) => t.textContent) };
}

describe("text in its box", () => {
  it("a logo too wide for its box at its size gets smaller and stays on one line, whole", () => {
    const t = drawn(`shape(logo, rect, 40 20 200 40, ${D})
text(logo, "Golden Crumb", size:28, weight:bold, align:left)`, "logo");
    expect(t.lines).toEqual(["Golden Crumb"]);
    expect(t.size).toBeLessThan(28);
    expect(t.size * LH).toBeLessThanOrEqual(40);
    // 200 wide, less the padding on both sides.
    expect(12 * t.size * 0.55).toBeLessThanOrEqual(200 - 2 * 12);
  });

  it("text that fits keeps the size it was given, and wraps as it did", () => {
    expect(drawn(`shape(logo, rect, 0 0 400 60, ${D})
text(logo, "Golden Crumb", size:28)`, "logo")).toEqual({ size: 28, lines: ["Golden Crumb"] });
    const card = drawn(`shape(card, rect, 0 0 300 300, ${D})
text(card, "Fresh sourdough every morning, baked in the shop before we open", size:20)`, "card");
    expect(card.size).toBe(20);
    expect(card.lines.length).toBeGreaterThan(1);
  });

  it("lines that would run past the top and bottom are made smaller until they all fit", () => {
    const t = drawn(String.raw`shape(card, rect, 0 0 300 120, ${D})
text(card, "Tune-Up\nGears, brakes and safety check\n$60", size:28)`, "card");
    expect(t.lines.length * t.size * LH).toBeLessThanOrEqual(120);
    expect(t.lines.join(" ")).toBe("Tune-Up Gears, brakes and safety check $60");
  });

  it("a single word wider than its box shrinks to the box's width too", () => {
    const t = drawn(`shape(tag, rect, 0 0 120 200, ${D})
text(tag, "Wonderbread", size:28)`, "tag");
    expect(11 * t.size * 0.55).toBeLessThanOrEqual(120 - 2 * 7.2);
  });

  it("a shape with a picture and words puts the words under the picture, as a caption, so neither covers the other", () => {
    const { scene } = runScript(`shape(card, rect, 40 560 380 220, ${D})
drawing(card, "round sourdough loaf")
text(card, "Sourdough loaf", size:m, weight:bold)`);
    scene.get("card")!.picture = { subject: "round sourdough loaf", w: 100, h: 100, els: [{ tag: "circle", attrs: { cx: "50", cy: "50", r: "45", fill: "#c08040" } }], done: true };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    render(svg, scene);
    const g = svg.querySelector('g[data-id="card"]')!;
    const fit = [...g.querySelectorAll("g[transform]")].find((e) => e.getAttribute("transform")!.includes("scale"))!;
    const [, ty, k] = fit.getAttribute("transform")!.match(/translate\(\S+ (\S+)\) scale\((\S+)\)/)!.map(Number);
    const pictureBottom = ty + 100 * k;
    const spans = [...g.querySelectorAll("text tspan")];
    const size = Number(g.querySelector("text")!.getAttribute("font-size"));
    expect(spans.map((s) => s.textContent)).toEqual(["Sourdough loaf"]);
    // The baseline sits 0.9 of the size below the line's top.
    expect(Number(spans[0].getAttribute("y")) - size * 0.9).toBeGreaterThanOrEqual(pictureBottom);
    expect(Number(spans[0].getAttribute("y"))).toBeLessThanOrEqual(560 + 220);
    // The picture still gets most of the card.
    expect(100 * k).toBeGreaterThan(220 * 0.6);
  });

  it("words on a shape without a picture stay in its middle", () => {
    const { scene } = runScript(`shape(card, rect, 0 0 300 200, ${D})
text(card, "Golden Crumb", size:28)`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    render(svg, scene);
    const y = Number(svg.querySelector('g[data-id="card"] text tspan')!.getAttribute("y"));
    expect(y - 28 * 0.9 + (28 * LH) / 2).toBeCloseTo(100, 5);
  });

  it("never shrinks below a readable floor: past it, the box cuts the text off as before", () => {
    const t = drawn(`shape(tiny, rect, 0 0 60 10, ${D})
text(tiny, "Golden Crumb Bakery and Coffee", size:20)`, "tiny");
    expect(t.size).toBe(8);
  });
});
