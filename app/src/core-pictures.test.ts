// v2's pictures (src/core/picture.ts): what of the model's reply is kept and drawn.
import { describe, expect, it } from "vitest";
import { readPicture } from "../../src/core/picture.ts";

describe("a picture's reply", () => {
  it("keeps lines: their x1, y1, x2 and y2 are geometry like any other (a sun's rays, a cat's whiskers)", () => {
    const { els, features } = readPicture('<circle cx="50" cy="50" r="20" fill="#ffd43b"/>\n<line x1="50" y1="5" x2="50" y2="20" stroke="#f59f00" stroke-width="4"/>', "a sun", 100, 100);
    expect(els.map((e) => e.tag)).toEqual(["circle", "line"]);
    expect(els[1].attrs).toEqual({ x1: "50", y1: "5", x2: "50", y2: "20", stroke: "#f59f00", "stroke-width": "4" });
    expect(features.refused).toBe(0);
  });

  it("still refuses what isn't drawing: scripts, events, links", () => {
    const { els, features } = readPicture('<script>alert(1)</script>\n<circle cx="5" cy="5" r="2" onclick="x()"/>\n<image href="https://example.com/a.png"/>', "x", 10, 10);
    expect(els).toEqual([{ tag: "circle", attrs: { cx: "5", cy: "5", r: "2" } }]);
    expect(features.refused).toBe(3);
  });
});
