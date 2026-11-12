import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedCoalescer } from "./coalesce";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createKeyedCoalescer", () => {
  it("a burst of 100 events in 100ms flushes at most 4 times, and the last value wins", () => {
    const flushes: Map<string, number>[] = [];
    const c = createKeyedCoalescer<number>((b) => flushes.push(b), 33);
    for (let i = 0; i < 100; i++) {
      c.push("a", i);
      vi.advanceTimersByTime(1);
    }
    expect(flushes.length).toBeLessThanOrEqual(4);
    // Nothing is lost: the trailing value lands on the next tick.
    vi.advanceTimersByTime(40);
    expect(flushes.at(-1)!.get("a")).toBe(99);
    expect(flushes.length).toBeLessThanOrEqual(5);
  });

  it("applies the first event of a quiet period on the next tick", () => {
    const flush = vi.fn();
    const c = createKeyedCoalescer<number>(flush, 33);
    c.push("a", 1);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    // A quiet period later, the next event is immediate again.
    vi.advanceTimersByTime(100);
    c.push("a", 2);
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("keeps keys apart and in first-queued order", () => {
    const flushes: Map<string, string>[] = [];
    const c = createKeyedCoalescer<string>((b) => flushes.push(b), 33);
    c.push("b", "b1");
    c.push("a", "a1");
    c.push("b", "b2");
    vi.advanceTimersByTime(0);
    expect([...flushes[0]!]).toEqual([
      ["b", "b2"],
      ["a", "a1"],
    ]);
  });

  it("flush() applies immediately; dispose() drops and stops", () => {
    const flush = vi.fn();
    const c = createKeyedCoalescer<number>(flush, 33);
    c.push("a", 1);
    c.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    c.flush(); // empty: no-op
    expect(flush).toHaveBeenCalledTimes(1);
    c.push("a", 2);
    c.dispose();
    vi.advanceTimersByTime(100);
    c.push("a", 3);
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
