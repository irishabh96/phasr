import { describe, expect, it } from "vitest";
import { FRAME_CADENCE, ThroughputEstimator, nextCadence } from "ghostty-web";

/**
 * The frame-cadence policy (perf phase 1) lives in the engine patch —
 * `patches/ghostty-web@0.4.0.patch` exports it precisely so it can be
 * unit-tested here without a DOM, a canvas or WASM. What is under test is
 * the POLICY the render scheduler consults every frame:
 *
 *  - the throughput estimator (5 s of history in 1/30 s buckets,
 *    exponentially weighted) that decides full rate vs ~30 fps, and
 *  - the transition rule: increases immediate, decreases deferred one
 *    frame — so the first screenful of a burst paints at full rate.
 */

const { ACTIVE, REDUCED, IDLE, HIGH_THROUGHPUT_BPS, BUCKET_MS, BUCKET_COUNT } =
  FRAME_CADENCE;

describe("ThroughputEstimator", () => {
  it("reads a steady stream exactly", () => {
    const est = new ThroughputEstimator();
    // 100 KB/s delivered as one bucket's worth per bucket for 6 s —
    // longer than the whole window, so the estimate must converge on the
    // true rate regardless of weighting.
    const perBucket = (100_000 * BUCKET_MS) / 1000;
    let now = 0;
    for (let i = 0; i < Math.ceil(6000 / BUCKET_MS); i++) {
      now = (i + 0.5) * BUCKET_MS;
      est.record(perBucket, now);
    }
    expect(est.bytesPerSecond(now)).toBeGreaterThan(95_000);
    expect(est.bytesPerSecond(now)).toBeLessThan(105_000);
  });

  it("rotates bytes out of the window", () => {
    const est = new ThroughputEstimator();
    est.record(1_000_000, 100);
    // Past the full 5 s window every bucket has been zeroed.
    expect(est.bytesPerSecond(100 + BUCKET_MS * (BUCKET_COUNT + 1))).toBe(0);
  });

  it("weights recent bytes above old ones", () => {
    const est = new ThroughputEstimator();
    est.record(50_000, 100);
    const fresh = est.bytesPerSecond(150);
    const aged = est.bytesPerSecond(150 + 1000);
    const old = est.bytesPerSecond(150 + 3000);
    expect(fresh).toBeGreaterThan(aged);
    expect(aged).toBeGreaterThan(old);
    // ~1 s half-life: after a second the estimate has roughly halved.
    expect(aged).toBeGreaterThan(fresh * 0.3);
    expect(aged).toBeLessThan(fresh * 0.7);
  });

  it("sees one coalescer chunk as a burst, briefly", () => {
    // The Rust side flushes every 32 KiB / 8 ms, so a single full chunk
    // into a quiet terminal IS >10 KB/s for that moment — the cadence
    // may drop (deferred a frame), and must recover once the burst ages.
    const est = new ThroughputEstimator();
    est.record(32_768, 1000);
    expect(est.bytesPerSecond(1000)).toBeGreaterThan(HIGH_THROUGHPUT_BPS);
    expect(est.bytesPerSecond(1000 + 2000)).toBeLessThan(HIGH_THROUGHPUT_BPS);
  });

  it("a typing echo never reads as flood", () => {
    const est = new ThroughputEstimator();
    // 10 keystrokes/s, ~8 bytes of echo each.
    for (let t = 0; t < 5000; t += 100) est.record(8, t);
    expect(est.bytesPerSecond(5000)).toBeLessThan(HIGH_THROUGHPUT_BPS / 10);
  });
});

describe("nextCadence — the deferred-decrease rule", () => {
  it("applies an increase immediately (a burst into idle paints NOW)", () => {
    expect(nextCadence(IDLE, false, ACTIVE)).toEqual({
      cadence: ACTIVE,
      dropPending: false,
    });
    expect(nextCadence(REDUCED, false, ACTIVE)).toEqual({
      cadence: ACTIVE,
      dropPending: false,
    });
  });

  it("defers a decrease by one frame", () => {
    // First frame that wants a lower rate: stay, remember.
    expect(nextCadence(ACTIVE, false, REDUCED)).toEqual({
      cadence: ACTIVE,
      dropPending: true,
    });
    // Second consecutive frame that still wants it: drop.
    expect(nextCadence(ACTIVE, true, REDUCED)).toEqual({
      cadence: REDUCED,
      dropPending: false,
    });
  });

  it("a one-frame dip never drops the rate", () => {
    // Wanted lower once, then back up: the pending drop is cancelled.
    const dip = nextCadence(ACTIVE, false, REDUCED);
    expect(dip.cadence).toBe(ACTIVE);
    expect(nextCadence(dip.cadence, dip.dropPending, ACTIVE)).toEqual({
      cadence: ACTIVE,
      dropPending: false,
    });
  });

  it("staying at the same cadence clears a pending drop", () => {
    expect(nextCadence(REDUCED, true, REDUCED)).toEqual({
      cadence: REDUCED,
      dropPending: false,
    });
  });

  it("the tiers order as frame rates", () => {
    expect(ACTIVE).toBeGreaterThan(REDUCED);
    expect(REDUCED).toBeGreaterThan(IDLE);
    // The heartbeat is the ~1 Hz floor the whole phase is built on.
    expect(FRAME_CADENCE.HEARTBEAT_MS).toBe(1000);
    expect(FRAME_CADENCE.IDLE_AFTER_MS).toBe(3000);
  });
});
