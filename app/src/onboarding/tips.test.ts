import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIPS, doneTip, nextTip, seeTour, tipsDone, tourSeen } from "./tips.ts";

beforeEach(() => localStorage.clear());

describe("the tips", () => {
  it("suggest one move at a time, in order, skipping the ones done", () => {
    expect(nextTip(tipsDone())?.id).toBe("circle");
    doneTip("circle");
    doneTip("preview");
    expect(nextTip(tipsDone())?.id).toBe("page");
    for (const t of TIPS) doneTip(t.id);
    expect(nextTip(tipsDone())).toBeUndefined();
  });

  it("are remembered in this browser, and ignore what they don't know", () => {
    doneTip("talk");
    doneTip("talk");
    expect(JSON.parse(localStorage.getItem("rt-draw.tips")!)).toEqual(["talk"]);
    localStorage.setItem("rt-draw.tips", '["arrow","fly"]');
    expect([...tipsDone()]).toEqual(["arrow"]);
    localStorage.setItem("rt-draw.tips", "{not json");
    expect(tipsDone().size).toBe(0);
  });

  it("still work where storage throws, as in a private window", () => {
    const denied = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", { getItem: denied, setItem: denied });
    try {
      expect(() => doneTip("circle")).not.toThrow();
      expect(nextTip(tipsDone())?.id).toBe("circle");
      expect(tourSeen()).toBe(false);
      expect(() => seeTour()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the tour", () => {
  it("is seen once per browser", () => {
    expect(tourSeen()).toBe(false);
    seeTour();
    expect(tourSeen()).toBe(true);
  });
});
