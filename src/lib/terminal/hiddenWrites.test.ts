import { describe, expect, it } from "vitest";
import {
  HIDDEN_PARSE_BUDGET_MS,
  HiddenWriteQueue,
  MAX_QUEUED_BYTES,
} from "@/lib/terminal/hiddenWrites";

/**
 * A5 (perf phase 4, criterion 9) — the policy half, tested without a DOM
 * or an engine: order, budget, cap, and the reveal flush. The integration
 * half (a parked GhosttySurface actually deferring its parses) is
 * e2e/terminal-lru.spec.ts + terminal-drop.spec.ts territory, where the
 * real engine runs.
 */

interface Harness {
  queue: HiddenWriteQueue;
  written: (string | Uint8Array)[];
  /** Run every drain the queue has scheduled so far (one macrotask). */
  tick: () => void;
  /** How much the fake clock advances per hooks.write call. */
  setWriteCost: (ms: number) => void;
  scheduled: () => number;
}

function makeHarness(): Harness {
  const written: (string | Uint8Array)[] = [];
  const drains: (() => void)[] = [];
  let now = 0;
  let writeCost = 0;
  const queue = new HiddenWriteQueue({
    write: (data) => {
      written.push(data);
      now += writeCost;
    },
    schedule: (drain) => drains.push(drain),
    now: () => now,
  });
  return {
    queue,
    written,
    tick: () => {
      const batch = drains.splice(0, drains.length);
      for (const drain of batch) drain();
    },
    setWriteCost: (ms) => {
      writeCost = ms;
    },
    scheduled: () => drains.length,
  };
}

describe("HiddenWriteQueue", () => {
  it("defers writes and drains them in arrival order", () => {
    const h = makeHarness();
    h.queue.enqueue("a");
    h.queue.enqueue(new Uint8Array([1, 2]));
    h.queue.enqueue("c");
    expect(h.written).toEqual([]);
    expect(h.queue.bytes).toBe(4);
    h.tick();
    expect(h.written).toEqual(["a", new Uint8Array([1, 2]), "c"]);
    expect(h.queue.bytes).toBe(0);
  });

  it("schedules exactly one drain however many chunks arrive", () => {
    const h = makeHarness();
    h.queue.enqueue("a");
    h.queue.enqueue("b");
    h.queue.enqueue("c");
    expect(h.scheduled()).toBe(1);
  });

  it("stops a slice at the parse budget and reschedules the rest", () => {
    const h = makeHarness();
    // Each write "costs" the whole budget, so a slice fits exactly one.
    h.setWriteCost(HIDDEN_PARSE_BUDGET_MS);
    h.queue.enqueue("a");
    h.queue.enqueue("b");
    h.queue.enqueue("c");
    h.tick();
    expect(h.written).toEqual(["a"]);
    expect(h.scheduled()).toBe(1);
    h.tick();
    expect(h.written).toEqual(["a", "b"]);
    h.tick();
    h.tick();
    expect(h.written).toEqual(["a", "b", "c"]);
    // Nothing left: the chain goes quiet instead of spinning.
    expect(h.scheduled()).toBe(0);
  });

  it("flush parses everything immediately, in order", () => {
    const h = makeHarness();
    h.setWriteCost(HIDDEN_PARSE_BUDGET_MS * 10); // budget must not apply
    h.queue.enqueue("a");
    h.queue.enqueue("b");
    h.queue.flush();
    expect(h.written).toEqual(["a", "b"]);
    expect(h.queue.bytes).toBe(0);
  });

  it("sheds the oldest chunks inline past the byte cap, keeping order", () => {
    const h = makeHarness();
    const big = "x".repeat(MAX_QUEUED_BYTES - 1);
    h.queue.enqueue(big);
    expect(h.written).toEqual([]);
    // This one pushes past the cap: the OLD chunk parses inline; the new
    // one stays queued — order preserved by construction.
    h.queue.enqueue("tail");
    expect(h.written).toEqual([big]);
    expect(h.queue.bytes).toBe(4);
    h.tick();
    expect(h.written).toEqual([big, "tail"]);
  });

  it("clear drops everything unparsed", () => {
    const h = makeHarness();
    h.queue.enqueue("a");
    h.queue.clear();
    h.tick();
    expect(h.written).toEqual([]);
    expect(h.queue.bytes).toBe(0);
  });
});
