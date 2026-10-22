// v1's page layout (layout.ts), run on ELK's in-thread build: tests have no web worker.
import ELK from "elkjs/lib/elk.bundled.js";
import { beforeAll, describe, expect, it } from "vitest";
import { layoutPages, setElk } from "./layout.ts";

beforeAll(() => setElk(new ELK()));

describe("v1's layout", () => {
  it("puts home at the origin and the page its button leads to in the next column, with one arrow into its left edge", async () => {
    const pages = [{ id: "home", w: 1280, h: 800 }, { id: "shop", w: 1280, h: 800 }];
    const out = await layoutPages("home", pages, [{ id: "buy", from: "home", to: "shop", button: { x: 80, y: 320, w: 200, h: 50 }, around: [] }]);
    expect(out.at.get("home")).toEqual({ x: 0, y: 0 });
    const shop = out.at.get("shop")!;
    expect(shop.x).toBeGreaterThanOrEqual(1280 + 200);
    expect(out.arrows).toHaveLength(1);
    const end = out.arrows[0].points.at(-1)!;
    expect(end).toEqual({ x: shop.x - 6, y: shop.y + 90 });
  });
});
