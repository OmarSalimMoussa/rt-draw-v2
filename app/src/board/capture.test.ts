import { describe, expect, it } from "vitest";
import { runScript } from "../../../src/core/ops.ts";
import { snapshot } from "./capture.ts";

describe("snapshot", () => {
  it("keeps the board as it was while a send changes it in place", () => {
    const { scene } = runScript(`shape(card, rect, 10 10 200 100, "pricing card for the starter plan", fill:#ffffff)
text(card, "Starter")
shape(dot, circle, 300 10 40 40, "small round status dot beside the card")
group(pair, [card, dot])`);
    const before = snapshot(scene);
    const was = JSON.stringify(before);
    runScript(`shape(card, rect, 20 20 300 150, "pricing card for the starter plan, wider now", fill:#ffe0e0, stroke:#333333)
text(card, "Starter plan")
drawing(card, "a small rocket")
move(pair, 50 50 400 200)
layer(dot, back)
remove(dot)`, scene);
    expect(JSON.stringify(before)).toBe(was);
    expect(scene.get("card")!.style.fill).toBe("#ffe0e0");
  });
});
