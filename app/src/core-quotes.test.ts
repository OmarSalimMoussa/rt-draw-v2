// Quoted text in the op language (src/core/ops.ts): \n is a line break, as the model
// writes it, and the canvas written back out as ops (draw.ts sceneToOps) keeps every
// text on one line and reads back the same.
import { describe, expect, it } from "vitest";
import { sceneToOps } from "../../src/core/draw.ts";
import { runScript } from "../../src/core/ops.ts";

const D = '"a part of the page used by these tests"';

describe("quoted text", () => {
  it("reads \\n as a line break, \\\" as a quote and \\\\ as a backslash", () => {
    const { scene, errors } = runScript(String.raw`shape(card, rect, 0 0 400 200, ${D})
text(card, "Visit us\n12 Cog Street\nCall 555-0100")
shape(note, rect, 0 300 400 100, ${D})
text(note, "Say \"hi\" at C:\\shop")`);
    expect(errors).toEqual([]);
    expect(scene.get("card")!.text!.words).toBe("Visit us\n12 Cog Street\nCall 555-0100");
    expect(scene.get("note")!.text!.words).toBe('Say "hi" at C:\\shop');
  });

  it("written back out as ops, a text with line breaks stays on its one line and reads back the same", () => {
    const { scene } = runScript(String.raw`shape(card, rect, 0 0 400 200, ${D})
text(card, "Visit us\n12 Cog Street")
shape(path, rect, 0 300 400 100, ${D})
text(path, "C:\\new")`);
    const ops = sceneToOps(scene);
    expect(ops.split("\n").filter((l) => l.startsWith("text("))).toEqual([String.raw`text(card, "Visit us\n12 Cog Street")`, String.raw`text(path, "C:\\new")`]);
    const back = runScript(ops).scene;
    expect(back.get("card")!.text!.words).toBe("Visit us\n12 Cog Street");
    expect(back.get("path")!.text!.words).toBe("C:\\new");
  });
});
