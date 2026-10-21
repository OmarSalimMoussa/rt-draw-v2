import { afterEach, describe, expect, it, vi } from "vitest";
import { SPARE_AFTER_MS, WARM_EVERY_MS, keepWarm } from "./warm.ts";

afterEach(() => vi.useRealTimers());

describe("keepWarm", () => {
  it("tops the pools up at once and at least every minute", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const stop = keepWarm(warm).stop;
    expect(warm).toHaveBeenCalledTimes(1);
    expect(WARM_EVERY_MS).toBeLessThanOrEqual(60_000);
    vi.advanceTimersByTime(WARM_EVERY_MS);
    expect(warm).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(10 * WARM_EVERY_MS);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  // A waiting process is closed 10 minutes after it started, used or not (dev/claude.ts Pool.reap), and a
  // warm request only tops a pool up: processes started together would all go at once, leaving none warm
  // until the next top-up. One more, started half way through, keeps one waiting across that moment.
  it("asks for one spare once the first processes are half way to being closed", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const { stop } = keepWarm(warm);
    expect(warm).toHaveBeenLastCalledWith(0);
    vi.advanceTimersByTime(SPARE_AFTER_MS - WARM_EVERY_MS);
    expect(warm).toHaveBeenLastCalledWith(0);
    vi.advanceTimersByTime(WARM_EVERY_MS);
    expect(warm).toHaveBeenLastCalledWith(1);
    expect(SPARE_AFTER_MS).toBeGreaterThanOrEqual(4 * 60_000);
    expect(SPARE_AFTER_MS).toBeLessThanOrEqual(6 * 60_000);
    stop();
  });

  it("now() tops up straight away, with the spare once it's due", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const w = keepWarm(warm);
    vi.advanceTimersByTime(SPARE_AFTER_MS);
    warm.mockClear();
    w.now();
    expect(warm).toHaveBeenCalledWith(1);
    w.stop();
  });
});
