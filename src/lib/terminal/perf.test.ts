import { describe, expect, it } from "vitest";
import {
  LatencyTracker,
  MARK_EXPIRE_MS,
  RateMeter,
  percentile,
  type RenderStatsLike,
} from "@/lib/terminal/perf";

/**
 * The latency-sampling maths from the Phase 0 spec's evidence plan:
 * percentiles, the mark→frame resolution rule, and that a dropped frame
 * does not corrupt a sample. Pure functions driven with explicit clocks —
 * no rAF, no engine.
 */

const stats = (ticks: number, lastFrameAt: number): RenderStatsLike => ({
  ticks,
  lastFrameAt,
  paused: false,
  open: true,
  disposed: false,
});

describe("percentile", () => {
  it("uses the probes' nearest-rank convention (sorted[floor(n*q)])", () => {
    const samples = [5, 1, 3, 2, 4]; // sorted: 1..5
    expect(percentile(samples, 0.5)).toBe(3); // floor(5*0.5)=2 → 3
    expect(percentile(samples, 0.95)).toBe(5); // floor(5*0.95)=4 → 5
    expect(percentile(samples, 0)).toBe(1);
  });

  it("is 0 on no samples and clamps q=1 to the last element", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 1)).toBe(7);
  });

  it("does not mutate its input", () => {
    const samples = [3, 1, 2];
    percentile(samples, 0.5);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe("LatencyTracker — the mark→frame resolution rule", () => {
  it("resolves a mark against the first frame that ENTERED at/after it", () => {
    const t = new LatencyTracker();
    // Mark placed at t=100 while the loop had run 10 frames.
    t.mark(100, 10);
    // A later frame: tick counter moved AND its entry stamp is after the
    // mark — this frame painted the mark's consequence.
    t.onFrame(stats(11, 112), 113);
    const s = t.summary();
    expect(s.count).toBe(1);
    expect(s.last).toBe(12); // 112 - 100: the ENGINE's stamp, not ours
    expect(t.pendingCount()).toBe(0);
  });

  it("keeps a mark pending when the frame entered BEFORE the mark", () => {
    const t = new LatencyTracker();
    t.mark(100, 10);
    // ticks moved, but that frame entered at 99 — it cannot have painted
    // what was marked at 100. Resolving it would fabricate a ~0ms sample.
    t.onFrame(stats(11, 99), 105);
    expect(t.summary().count).toBe(0);
    expect(t.pendingCount()).toBe(1);
    // The frame after it answers.
    t.onFrame(stats(12, 116), 117);
    expect(t.summary().count).toBe(1);
    expect(t.summary().last).toBe(16);
  });

  it("keeps a mark pending while the tick counter has not moved", () => {
    const t = new LatencyTracker();
    t.mark(100, 10);
    // Same tick count with a plausible stamp: no NEW frame ran.
    t.onFrame(stats(10, 101), 101);
    expect(t.summary().count).toBe(0);
    expect(t.pendingCount()).toBe(1);
  });

  it("a dropped frame does not corrupt a sample — the mark expires instead", () => {
    const t = new LatencyTracker();
    t.mark(100, 10);
    // The loop stops (hidden page, wedged rAF): observations keep coming
    // from elsewhere but no frame ever answers. Past the expiry the mark
    // must die WITHOUT recording a giant fake latency.
    t.onFrame(stats(10, 90), 100 + MARK_EXPIRE_MS + 1);
    const s = t.summary();
    expect(s.count).toBe(0);
    expect(s.expired).toBe(1);
    expect(t.pendingCount()).toBe(0);
    // And a later real keystroke still measures normally.
    t.mark(5000, 10);
    t.onFrame(stats(11, 5008), 5009);
    expect(t.summary().count).toBe(1);
    expect(t.summary().last).toBe(8);
  });

  it("resolves several queued marks against one frame", () => {
    const t = new LatencyTracker();
    // A paste: three onData firings between two frames.
    t.mark(100, 10);
    t.mark(102, 10);
    t.mark(104, 10);
    const recorded = t.onFrame(stats(11, 110), 111);
    expect(recorded).toEqual([10, 8, 6]);
    expect(t.summary().count).toBe(3);
    expect(t.pendingCount()).toBe(0);
  });

  it("percentiles come from the recorded samples", () => {
    const t = new LatencyTracker();
    for (let i = 0; i < 10; i++) {
      t.mark(i * 100, i);
      // Every sample is exactly 10ms except one 50ms outlier.
      const paint = i === 9 ? 50 : 10;
      t.onFrame(stats(i + 1, i * 100 + paint), i * 100 + paint + 1);
    }
    const s = t.summary();
    expect(s.count).toBe(10);
    expect(s.p50).toBe(10);
    expect(s.p95).toBe(50);
  });
});

describe("RateMeter", () => {
  it("reports bytes over its rolling window", () => {
    const m = new RateMeter();
    m.add(1000, 0);
    m.add(1000, 500);
    // 2000 bytes inside a 2s window → 1000 B/s.
    expect(m.perSecond(1000)).toBe(1000);
  });

  it("forgets bytes older than the window", () => {
    const m = new RateMeter();
    m.add(4000, 0);
    expect(m.perSecond(2500)).toBe(0);
  });
});
