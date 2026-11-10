import { describe, expect, it, vi } from "vitest";
import { enqueue, mustQueue, queuedMessages, shouldFlush } from "./sendQueue";

describe("queued send", () => {
  it("queues only while a turn runs", () => {
    expect(mustQueue("working")).toBe(true);
    for (const s of ["idle", "needs-you", "exited", null, undefined] as const) expect(mustQueue(s)).toBe(false);
  });

  it("joins a second message onto the one already waiting", () => {
    expect(enqueue(null, "first")).toBe("first");
    expect(enqueue("first", "second")).toBe("first\n\nsecond");
  });

  it("flushes once the turn is over, never mid-turn, mid-approval or mid-send", () => {
    expect(shouldFlush("msg", "idle", false)).toBe(true);
    expect(shouldFlush("msg", "exited", false)).toBe(true);
    expect(shouldFlush("msg", null, false)).toBe(true);
    expect(shouldFlush("msg", "working", false)).toBe(false);
    expect(shouldFlush("msg", "needs-you", false)).toBe(false);
    expect(shouldFlush("msg", "idle", true)).toBe(false);
    expect(shouldFlush(null, "idle", false)).toBe(false);
  });

  it("holds the slot per task outside React, and notifies on change", () => {
    const listener = vi.fn();
    const off = queuedMessages.subscribe(listener);
    queuedMessages.set("t1", "hello");
    expect(queuedMessages.get("t1")).toBe("hello");
    expect(queuedMessages.get("t2")).toBeNull();
    queuedMessages.set("t1", "hello"); // no change, no notification
    queuedMessages.set("t1", null);
    expect(queuedMessages.get("t1")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
