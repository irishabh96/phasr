import { describe, expect, it } from "vitest";
import { planScrollBlit } from "ghostty-web";

/**
 * The scroll-blit plan (perf phase 2, criteria 3+4) lives in the engine
 * patch — `patches/ghostty-web@0.4.0.patch` exports it, like the cadence
 * policy, so the row arithmetic can be unit-tested here without a DOM, a
 * canvas or WASM.
 *
 * The model under test: while scrolled into history, canvas row t shows
 * absolute row top+t. A scroll moves `top`; every canvas row whose
 * absolute row survives the move can be blitted from its old position,
 * and only the rows that entered the window are drawn fresh. The plan
 * must be exact — a one-row error here paints history one row off, the
 * class of misdraw the 0.4.1 scroll program existed to kill.
 */

describe("planScrollBlit", () => {
  it("scrolling deeper (up) moves content down and exposes rows at the top", () => {
    // top 100 -> 97: the user scrolled 3 rows further into history.
    const plan = planScrollBlit(100, 97, 50);
    expect(plan).not.toBeNull();
    // Old canvas row t showed absolute row 100+t; it must land where the
    // new frame wants that absolute row: t' = t + 3.
    expect(plan!).toEqual({
      delta: -3,
      srcRow: 0,
      dstRow: 3,
      copyRows: 47,
      exposedStart: 0,
      exposedEnd: 2,
    });
  });

  it("scrolling toward the bottom (down) moves content up and exposes rows at the bottom", () => {
    const plan = planScrollBlit(97, 100, 50);
    expect(plan!).toEqual({
      delta: 3,
      srcRow: 3,
      dstRow: 0,
      copyRows: 47,
      exposedStart: 47,
      exposedEnd: 49,
    });
  });

  it("the copy and the exposed span exactly tile the viewport", () => {
    for (const [last, top, rows] of [
      [100, 99, 50],
      [100, 51, 50],
      [10, 40, 60],
      [5, 6, 2],
    ] as const) {
      const plan = planScrollBlit(last, top, rows);
      expect(plan).not.toBeNull();
      const exposed = plan!.exposedEnd - plan!.exposedStart + 1;
      expect(plan!.copyRows + exposed).toBe(rows);
      expect(plan!.copyRows).toBeGreaterThan(0);
      // Every blitted destination row shows the absolute row the previous
      // frame had at the source row.
      expect(plan!.dstRow - plan!.srcRow).toBe(-plan!.delta);
    }
  });

  it("refuses when the previous frame was at the live bottom (sentinel -1)", () => {
    // First scrolled frame after leaving the bottom: nothing on the canvas
    // is known to be window-aligned — full repaint.
    expect(planScrollBlit(-1, 100, 50)).toBeNull();
  });

  it("refuses a jump of a screenful or more", () => {
    // Scrollbar jump: nothing survives, a blit would be pure overhead.
    expect(planScrollBlit(100, 50, 50)).toBeNull();
    expect(planScrollBlit(100, 250, 50)).toBeNull();
    // One row short of a screenful still blits a single row.
    expect(planScrollBlit(100, 51, 50)).not.toBeNull();
  });

  it("refuses no-movement and degenerate geometry", () => {
    expect(planScrollBlit(100, 100, 50)).toBeNull();
    expect(planScrollBlit(100, 99, 0)).toBeNull();
    expect(planScrollBlit(100, -2, 50)).toBeNull();
  });
});
