import { describe, expect, it } from "vitest";
import type { CallRecord } from "../../../src/core/model.ts";
import { PHASES, type SendTimes, callRows, segments } from "./latency.ts";

const base = (over: Partial<SendTimes> = {}): SendTimes => ({
  n: 1, label: "a bakery", spoken: false, model: "sonnet", enter: 1000, changes: 3, rejected: 0, status: "done", callsFrom: 0, callsTo: 0, ...over,
});
const finished = base({ words: 1040, start: 1050, prompt: 1400, firstText: 2100, firstOp: 2300, reply: 3000, pictures: 4200, end: 4500 });

describe("latency stages", () => {
  it("a finished send's segments run in order and add up", () => {
    const s = segments(finished, 9999);
    expect(s.map((x) => x.key)).toEqual(PHASES.map((p) => p.key));
    expect(s.reduce((a, x) => a + x.ms, 0)).toBe(finished.end! - finished.enter);
  });

  it("a live send grows its first missing step", () => {
    const s = segments(base({ status: "running", words: 1040, start: 1050, prompt: 1400 }), 1900);
    const last = s.at(-1)!;
    expect(last.key).toBe("model");
    expect(last.from + last.ms).toBe(1900 - 1000);
  });

  it("words that arrive after the send before finished leave no queue time", () => {
    const queue = segments({ ...finished, words: 1100, start: 1050 }, 9999).find((x) => x.key === "queue")!;
    expect(queue.ms).toBe(0);
  });

  it("callRows keeps this send's calls and names Jev", () => {
    type Model = CallRecord["req"]["model"];
    const call = (n: number, model: Model, from: string): CallRecord => ({ n, at: "", page: "/", req: { model, system: "", user: "", from }, reply: "", running: false, stats: { model, ms: 10 } });
    const rows = callRows([call(3, "sonnet", "draw"), call(4, "sonnet", "draw"), call(5, "jev-1.13.0", "draw-refs"), call(6, "sonnet", "picture")], base({ callsFrom: 4, callsTo: 6 }));
    expect(rows.map((r) => r.n)).toEqual([5, 6]);
    expect(rows[0].who).toBe("Jev · draw-refs");
    expect(rows[1].who).toBe("picture");
  });
});
