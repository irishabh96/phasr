import { describe, expect, it, vi } from "vitest";
import {
  verifyRenderLoop,
  type LivenessDeps,
  type LivenessOutcome,
  type LivenessTarget,
} from "@/lib/terminal/liveness";

/**
 * The watchdog's whole job is to tell a terminal that is idle from a
 * terminal that is dead. Those are the same picture, so the only thing it
 * may look at is whether the frame counter MOVED — and the only thing it
 * may do about it is restart the loop.
 *
 * Driven through an injected scheduler so the deadline is a function call
 * rather than a wait: a test that sleeps for the real deadline is a test
 * that gets shortened later.
 */

/** A surface whose frame counter only advances when told to. */
function fakeSurface(opts: { ticking: boolean; deadAfterKick?: boolean }) {
  const state = {
    tick: 100 as number | null,
    ticking: opts.ticking,
    kicks: 0,
  };
  const target: LivenessTarget = {
    id: "ghostty-1",
    renderTick: () => {
      if (state.tick === null) return null;
      if (state.ticking) state.tick += 3;
      return state.tick;
    },
    kickRendering: () => {
      state.kicks += 1;
      if (!opts.deadAfterKick) state.ticking = true;
    },
  };
  return { target, state };
}

/** Runs every scheduled callback immediately, in order. */
function immediateDeps(): LivenessDeps & { outcomes: LivenessOutcome[] } {
  const outcomes: LivenessOutcome[] = [];
  return {
    outcomes,
    schedule: (fn) => fn(),
    report: (o) => outcomes.push(o),
  };
}

describe("verifyRenderLoop", () => {
  it("leaves a painting terminal alone", () => {
    const { target, state } = fakeSurface({ ticking: true });
    const deps = immediateDeps();
    verifyRenderLoop(target, "click", deps);
    expect(state.kicks).toBe(0);
    expect(deps.outcomes).toEqual([
      expect.objectContaining({ alive: true, kicked: false }),
    ]);
  });

  it("restarts a loop whose counter did not move", () => {
    const { target, state } = fakeSurface({ ticking: false });
    const deps = immediateDeps();
    verifyRenderLoop(target, "window-focus", deps);
    expect(state.kicks).toBe(1);
    expect(deps.outcomes).toEqual([
      expect.objectContaining({
        reason: "window-focus",
        kicked: true,
        kickFailed: false,
        alive: true,
      }),
    ]);
  });

  it("says so when the restart did not take", () => {
    // The honest case: animation frames have stopped for the whole page,
    // so restarting the loop cannot help and the dump must not claim it
    // did. `kickRendering` still repaints once, which is why this is worth
    // doing at all.
    const { target, state } = fakeSurface({
      ticking: false,
      deadAfterKick: true,
    });
    const deps = immediateDeps();
    verifyRenderLoop(target, "visible", deps);
    expect(state.kicks).toBe(1);
    expect(deps.outcomes[0]).toMatchObject({ kicked: true, kickFailed: true });
  });

  it("ignores a surface that is not supposed to be painting", () => {
    // A parked terminal reports `null`, and its counter is frozen BY
    // DESIGN. Kicking it would resume a terminal the app deliberately
    // paused — the free-running-loop cost that `setActive(false)` exists
    // to avoid.
    const target: LivenessTarget = {
      id: "ghostty-parked",
      renderTick: () => null,
      kickRendering: vi.fn(),
    };
    const deps = immediateDeps();
    verifyRenderLoop(target, "window-focus", deps);
    expect(target.kickRendering).not.toHaveBeenCalled();
    expect(deps.outcomes).toEqual([]);
  });

  it("does not kick a surface that was parked between the two samples", () => {
    // Racy on purpose: the user switched tabs while the deadline was
    // pending. The second sample is `null`, which is "not my business"
    // and not "stalled".
    let calls = 0;
    const kick = vi.fn();
    const target: LivenessTarget = {
      id: "ghostty-2",
      renderTick: () => (calls++ === 0 ? 7 : null),
      kickRendering: kick,
    };
    const deps = immediateDeps();
    verifyRenderLoop(target, "click", deps);
    expect(kick).not.toHaveBeenCalled();
    expect(deps.outcomes[0]).toMatchObject({ alive: true, kicked: false });
  });

  it("asks for a frame before it samples (the heartbeat probe)", () => {
    // Perf phase 1: an idle chain parks on a ~1 Hz heartbeat, so "the
    // counter did not move for 200 ms" is the HEALTHY idle state. The
    // check is only sound because it requests a frame first — a live
    // chain honours that within one frame at any cadence. A surface whose
    // counter advances only when a frame is requested (exactly how the
    // damage-driven engine behaves at idle) must therefore read as alive.
    const state = { tick: 50, requested: 0, kicks: 0 };
    const target: LivenessTarget = {
      id: "ghostty-idle",
      renderTick: () => {
        // The requested frame ran between the two samples; nothing else
        // moves the counter within the deadline.
        if (state.requested > 0) state.tick += 1;
        return state.tick;
      },
      kickRendering: () => {
        state.kicks += 1;
      },
      requestFrame: () => {
        state.requested += 1;
      },
    };
    const deps = immediateDeps();
    verifyRenderLoop(target, "click", deps);
    expect(state.requested).toBe(1);
    expect(state.kicks).toBe(0);
    expect(deps.outcomes[0]).toMatchObject({ alive: true, kicked: false });
  });

  it("waits before deciding — a slow frame is not a dead loop", () => {
    // The scheduler is what separates "has not painted yet" from "will
    // never paint again". If the check read the counter twice in the same
    // task it would report every terminal dead.
    const { target } = fakeSurface({ ticking: false });
    const scheduled: Array<[() => void, number]> = [];
    verifyRenderLoop(target, "click", {
      schedule: (fn, ms) => scheduled.push([fn, ms]),
      report: () => {},
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]![1]).toBeGreaterThanOrEqual(100);
  });
});
