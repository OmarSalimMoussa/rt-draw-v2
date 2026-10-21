// The two hooks v2's core has for a page that stays open (src/core/model.ts, src/core/trace.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { callModel, calls, forgetCallsBefore } from "../../src/core/model.ts";
import { finished, forgetSpansBefore, span } from "../../src/core/trace.ts";

/** /api/model's reply to any call: one text chunk, then its stats. */
const reply = () =>
  new Response(new Blob(['{"text":"hi"}\n{"done":true,"model":"sonnet","ms":5}\n']).stream(), { status: 200, headers: { "content-type": "application/x-ndjson" } });

afterEach(() => vi.unstubAllGlobals());

describe("core hooks", () => {
  it("call numbers keep counting after old calls are forgotten", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply()));
    const ask = () => callModel({ model: "sonnet", system: "s", user: "u" });
    await ask();
    await ask();
    await ask();
    forgetCallsBefore(3);
    await ask();
    expect(calls.map((c) => c.n)).toEqual([3, 4]);
  });

  it("forgetSpansBefore keeps the newer spans", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await span("old", undefined, () => {});
    await wait(5);
    const cut = performance.now();
    await wait(5);
    await span("new", undefined, () => {});
    forgetSpansBefore(cut);
    expect(finished().map((s) => s.name)).toEqual(["new"]);
  });
});
