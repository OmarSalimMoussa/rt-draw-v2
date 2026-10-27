// Pictures as subjects (evals/LOOP-V2.md B2, B3, B5, C1, C2): the illustration() op, a picture's box unseen unless
// styled, layer(x, back) kept on its page, ops that wait for the shape a later line makes, and the context a
// picture's prompt gets (src/core/ops.ts, scene.ts, render.ts, picture.ts).
import { describe, expect, it } from "vitest";
import { runScript } from "../../src/core/ops.ts";
import { contextLines } from "../../src/core/picture.ts";
import { render } from "../../src/core/render.ts";
import { DEFAULTS, tune } from "../../src/core/tuning.ts";

const D = '"a part of the page used by these tests"';
const SVG = "http://www.w3.org/2000/svg";

describe("illustration()", () => {
  it("makes one shape whose description and picture are what it shows, with no box drawn", () => {
    const { scene, errors } = runScript(`illustration(duck, 100 100 200 160, "a yellow duck sitting on a park bench")`);
    expect(errors).toEqual([]);
    expect(scene.get("duck")).toMatchObject({ kind: "rect", box: { x: 100, y: 100, w: 200, h: 160 }, description: "a yellow duck sitting on a park bench", drawing: "a yellow duck sitting on a park bench", style: { stroke: "transparent" } });
  });

  it("on an existing shape redraws it, keeping its box when none is given", () => {
    const { scene, errors } = runScript(`illustration(duck, 100 100 200 160, "a yellow duck sitting on a park bench")
illustration(duck, "a detailed realistic mallard duck on a bench")`);
    expect(errors).toEqual([]);
    expect(scene.get("duck")).toMatchObject({ box: { x: 100, y: 100, w: 200, h: 160 }, drawing: "a detailed realistic mallard duck on a bench" });
  });

  it("a new one needs a box and words", () => {
    expect(runScript(`illustration(duck, "a yellow duck sitting on a park bench")`).errors).toHaveLength(1);
    expect(runScript(`illustration(duck, 0 0 10 10)`).errors).toHaveLength(1);
  });

  it("ignores a kind written out of shape() habit", () => {
    const { scene, errors } = runScript(`illustration(duck, rect, 100 100 200 160, "a yellow duck sitting on a park bench")`);
    expect(errors).toEqual([]);
    expect(scene.get("duck")!.box).toEqual({ x: 100, y: 100, w: 200, h: 160 });
  });

  it("named like a page, is a new shape and leaves the page alone", () => {
    const { scene, errors } = runScript(`shape(page, frame, 0 0 1280 800, ${D})
text(page, "Cart")
illustration(cart, 100 100 200 150, "an empty wire shopping cart on wheels")`);
    expect(errors).toEqual([]);
    expect(scene.get("page")).toMatchObject({ box: { x: 0, y: 0, w: 1280, h: 800 } });
    expect(scene.get("page")!.drawing).toBeUndefined();
    expect(scene.get("cart")!.drawing).toBe("an empty wire shopping cart on wheels");
  });

  it("turns a styled shape into a bare picture, and never a page", () => {
    const { scene, errors } = runScript(`shape(card, round, 0 0 300 200, ${D}, fill:#fff3bf, stroke:#1e1e1e)
illustration(card, "a yellow duck sitting on a park bench")
shape(page, frame, 0 0 1280 800, ${D})
illustration(page, "a whole page drawn as one picture")`);
    expect(scene.get("card")).toMatchObject({ kind: "rect", style: { stroke: "transparent" } });
    expect(scene.get("card")!.style.fill).toBeUndefined();
    expect(errors.map((e) => e.line)).toEqual(['illustration(page, "a whole page drawn as one picture")']);
  });
});

describe("a picture's box", () => {
  const paint = (script: string, t = DEFAULTS) => {
    const { scene } = runScript(script);
    // A finished one-element picture, as the picture model would leave it.
    for (const s of scene.stacked()) if (s.drawing) s.picture = { subject: s.drawing, w: 90, h: 90, els: [{ tag: "circle", attrs: { cx: "45", cy: "45", r: "40", fill: "#ffd43b" } }], done: true };
    const svg = document.createElementNS(SVG, "svg");
    render(svg, scene, { tuning: t });
    return svg.querySelector('g[data-id="a"]')!;
  };
  /** The picture's scale inside its shape. */
  const scale = (g: Element) => Number(/scale\(([\d.]+)\)/.exec(g.querySelector("g[transform*=scale]")!.getAttribute("transform")!)![1]);

  it("isn't drawn unless given a stroke or fill, and the picture fills it", () => {
    const g = paint(`shape(a, rect, 0 0 100 100, ${D})\ndrawing(a, "a sun")`);
    expect(g.children[0].getAttribute("clip-path")).toMatch(/^url/);
    expect(scale(g)).toBeCloseTo(100 / 90);
  });

  it("is drawn when styled, with the picture at picture.fill", () => {
    const g = paint(`shape(a, rect, 0 0 100 100, ${D}, stroke:#1e1e1e)\ndrawing(a, "a sun")`);
    expect(g.children[0].getAttribute("clip-path")).toBeNull();
    expect(scale(g)).toBeCloseTo(0.9 * (100 / 90));
  });

  it("keeps a circle's crop", () => {
    const { scene } = runScript(`shape(a, circle, 0 0 100 100, ${D})\ndrawing(a, "a portrait")`);
    const svg = document.createElementNS(SVG, "svg");
    render(svg, scene);
    expect(svg.querySelector("clipPath#clip-a path")!.getAttribute("d")).toMatch(/A/);
  });

  it("is drawn as before with render.pictureBox off, but never for an illustration()", () => {
    const off = tune({ "render.pictureBox": 0 });
    expect(paint(`shape(a, rect, 0 0 100 100, ${D})\ndrawing(a, "a sun")`, off).children[0].getAttribute("clip-path")).toBeNull();
    expect(paint(`illustration(a, 0 0 100 100, "a sun with a smiling face")`, off).children[0].getAttribute("clip-path")).toMatch(/^url/);
  });
});

describe("layer(x, back)", () => {
  it("puts a shape at the back of its page, never behind the page", () => {
    const { scene } = runScript(`shape(page, frame, 0 0 1000 800, ${D})
shape(other, frame, 2000 0 1000 800, ${D})
shape(a, rect, 100 100 100 100, ${D})
shape(b, rect, 300 100 100 100, ${D})
layer(b, back)`);
    expect(scene.order).toEqual(["page", "b", "other", "a"]);
  });

  it("of overlapping pages, picks the one on top, where the shape is seen", () => {
    const { scene } = runScript(`shape(small, frame, 0 0 600 600, ${D})
shape(big, frame, 0 0 1000 800, ${D})
shape(x, rect, 100 100 100 100, ${D})
layer(x, back)`);
    expect(scene.order).toEqual(["small", "big", "x"]);
  });

  it("below a page means the back of that page", () => {
    const { scene } = runScript(`shape(page, frame, 0 0 1000 800, ${D})
shape(a, rect, 100 100 100 100, ${D})
shape(x, rect, 300 100 100 100, ${D})
layer(x, below:page)`);
    expect(scene.order).toEqual(["page", "x", "a"]);
  });

  it("puts a page, or a shape on no page, at the back of the board", () => {
    const { scene } = runScript(`shape(page, frame, 0 0 1000 800, ${D})
shape(other, frame, 2000 0 1000 800, ${D})
shape(far, rect, 5000 5000 10 10, ${D})
layer(other, back)
layer(far, back)`);
    expect(scene.order.slice(0, 2)).toEqual(["far", "other"]);
  });
});

describe("ops that wait for their shape (ops.waitForShape)", () => {
  it("a text() before its shape() lands right after it", () => {
    const { scene, errors } = runScript(`text(title, "Hello")
shape(title, rect, 0 0 200 50, ${D})`);
    expect(errors).toEqual([]);
    expect(scene.get("title")!.text!.words).toBe("Hello");
  });

  it("a freed op can free another, and layer() waits for the shape it's placed against", () => {
    const { scene, errors } = runScript(`shape(a, rect, 0 0 10 10, ${D})
layer(a, above:b)
group(g, [a, b])
shape(b, rect, 20 0 10 10, ${D})`);
    expect(errors).toEqual([]);
    expect(scene.order).toEqual(["b", "a"]);
    expect(scene.groups.get("g")).toEqual(["a", "b"]);
  });

  it("a move() of a group waits for the group", () => {
    const { scene, errors } = runScript(`shape(a, rect, 0 0 10 10, ${D})
move(g, 100 100 10 10)
group(g, [a])`);
    expect(errors).toEqual([]);
    expect(scene.get("a")!.box).toMatchObject({ x: 100, y: 100 });
  });

  it("what still waits when the reply ends fails then, and remove() never waits", () => {
    const { scene, errors } = runScript(`text(ghost, "Boo")
remove(late)
shape(late, rect, 0 0 10 10, ${D})`);
    expect(errors.map((e) => e.line)).toEqual(["remove(late)", 'text(ghost, "Boo")']);
    expect(scene.get("late")).toBeDefined();
  });

  it("fails at once with the knob off", () => {
    const { errors } = runScript(`text(title, "Hello")\nshape(title, rect, 0 0 200 50, ${D})`, undefined, tune({ "ops.waitForShape": 0 }));
    expect(errors).toHaveLength(1);
  });
});

describe("a picture's context (picture.context)", () => {
  const board = () =>
    runScript(`shape(card, rect, 0 0 400 300, ${D}, fill:#a5d8ff)
shape(btn, rect, 0 400 100 40, ${D}, fill:#a5d8ff, stroke:#1971c2)
illustration(duck, 100 100 200 100, "a yellow duck sitting on a park bench")`).scene;
  const ink = [{ id: 1, t0: 0, t1: 1, points: [[100, 100, 0], [200, 150, 1], [300, 200, 2]] as [number, number, number][] }, { id: 2, t0: 0, t1: 1, points: [[900, 900, 0], [950, 950, 1]] as [number, number, number][] }];

  it("gives what they said, the board's shape colors, and their sketches in the box in the picture's coordinates", () => {
    const s = board();
    const text = contextLines(s.get("duck")!, s, { said: "make this a real duck", sketches: ink }, 100, 50, DEFAULTS);
    expect(text).toContain("They asked: make this a real duck");
    expect(text).toContain("#a5d8ff, #1971c2");
    expect(text).toContain('<polyline points="0,0 50,25 100,50"/>');
    expect(text.match(/polyline/g)).toHaveLength(1);
  });

  it("clamps a stroke partly outside the box to it, and shares a point budget between strokes", () => {
    const s = board();
    const out = [{ id: 3, t0: 0, t1: 1, points: [[50, 150, 0], [150, 150, 1], [200, 150, 2], [250, 150, 3]] as [number, number, number][] }];
    expect(contextLines(s.get("duck")!, s, { said: "", sketches: out }, 100, 50, DEFAULTS)).toContain('points="0,25 25,25 50,25 75,25"');
    const long = Array.from({ length: 10 }, (_, k) => ({ id: k, t0: 0, t1: 1, points: Array.from({ length: 200 }, (_, i) => [100 + i, 100 + (i % 100), i] as [number, number, number]) }));
    const points = (contextLines(s.get("duck")!, s, { said: "", sketches: long }, 100, 50, tune({ "picture.contextPoints": 100 })).match(/\d+,\d+/g) ?? []).length;
    expect(points).toBeLessThanOrEqual(130);
  });

  it("level 1 leaves the ink out, and 0 gives nothing", () => {
    const s = board();
    expect(contextLines(s.get("duck")!, s, { said: "a duck", sketches: ink }, 100, 50, tune({ "picture.context": 1 }))).not.toContain("polyline");
    expect(contextLines(s.get("duck")!, s, { said: "a duck", sketches: ink }, 100, 50, tune({ "picture.context": 0 }))).toBe("");
  });
});
