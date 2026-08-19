import { describe, expect, it } from "vitest";
import {
  WheelAccumulator,
  wheelOutcome,
  type WheelContext,
} from "@/lib/terminal/backends/ghostty/wheel";

function ctx(over: Partial<WheelContext> = {}): WheelContext {
  return {
    alternateScreen: false,
    mouseTracking: false,
    sgrMouse: false,
    applicationCursor: false,
    col: 0,
    row: 0,
    lines: 1,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  };
}

describe("wheelOutcome", () => {
  it("scrolls the terminal's own scrollback on the normal screen", () => {
    expect(wheelOutcome(ctx({ lines: 3 }))).toEqual({ kind: "scrollback" });
    expect(wheelOutcome(ctx({ lines: -3 }))).toEqual({ kind: "scrollback" });
  });

  /**
   * The regression. ghostty-web fires up to FIVE `\x1b[A` per tick at any
   * alt-screen app; in Claude Code that opens the prompt-history overlay
   * and overwrites what the user was typing (verified against the real
   * CLI in a pty). One arrow per event is the conventional behaviour, and it is
   * what `less` and `vim` expect.
   */
  it("sends exactly one arrow per event in alt-screen without mouse tracking", () => {
    expect(wheelOutcome(ctx({ alternateScreen: true, lines: 5 }))).toEqual({
      kind: "send",
      seq: "\x1b[B",
    });
    expect(wheelOutcome(ctx({ alternateScreen: true, lines: -5 }))).toEqual({
      kind: "send",
      seq: "\x1b[A",
    });
  });

  it("honours DECCKM for the arrow fallback", () => {
    expect(
      wheelOutcome(
        ctx({ alternateScreen: true, applicationCursor: true, lines: -1 }),
      ),
    ).toEqual({ kind: "send", seq: "\x1bOA" });
  });

  /**
   * Claude Code's own mode set: alt screen + 1000/1002/1003 + 1006. It
   * scrolls its transcript when it gets these and ignores them when there
   * is nothing to scroll — never a key.
   */
  it("sends SGR mouse events when the app asked for them", () => {
    expect(
      wheelOutcome(
        ctx({
          alternateScreen: true,
          mouseTracking: true,
          sgrMouse: true,
          col: 39,
          row: 19,
          lines: -1,
        }),
      ),
    ).toEqual({ kind: "send", seq: "\x1b[<64;40;20M" });
    expect(
      wheelOutcome(
        ctx({
          alternateScreen: true,
          mouseTracking: true,
          sgrMouse: true,
          col: 0,
          row: 0,
          lines: 2,
        }),
      ),
    ).toEqual({ kind: "send", seq: "\x1b[<65;1;1M" });
  });

  it("falls back to the X10 encoding when 1006 is off, clamped at 223", () => {
    expect(
      wheelOutcome(
        ctx({ mouseTracking: true, col: 0, row: 0, lines: -1 }),
      ),
    ).toEqual({ kind: "send", seq: `\x1b[M${"`"}!!` });
    const out = wheelOutcome(
      ctx({ mouseTracking: true, col: 400, row: 400, lines: 1 }),
    );
    expect(out).toEqual({
      kind: "send",
      seq: `\x1b[M${String.fromCharCode(97)}${String.fromCharCode(255)}${String.fromCharCode(255)}`,
    });
  });

  it("encodes modifiers into the button byte", () => {
    expect(
      wheelOutcome(
        ctx({
          mouseTracking: true,
          sgrMouse: true,
          shift: true,
          ctrl: true,
          lines: -1,
        }),
      ),
    ).toEqual({ kind: "send", seq: "\x1b[<84;1;1M" });
  });

  it("mouse events win over scrollback on the normal screen too", () => {
    expect(
      wheelOutcome(ctx({ mouseTracking: true, sgrMouse: true, lines: 1 })),
    ).toEqual({ kind: "send", seq: "\x1b[<65;1;1M" });
  });

  it("emits nothing at all for a sub-line delta", () => {
    expect(wheelOutcome(ctx({ alternateScreen: true, lines: 0 }))).toEqual({
      kind: "swallow",
    });
    expect(wheelOutcome(ctx({ mouseTracking: true, lines: 0 }))).toEqual({
      kind: "swallow",
    });
    // On the normal screen ghostty's own smooth-scroll path can still use
    // the sub-line delta, so it is handed back rather than swallowed.
    expect(wheelOutcome(ctx({ lines: 0 }))).toEqual({ kind: "scrollback" });
  });
});

describe("WheelAccumulator", () => {
  it("turns a stream of small pixel deltas into whole lines", () => {
    const acc = new WheelAccumulator();
    // 17px cell, 6px per event: five events to cross two lines.
    const got = [6, 6, 6, 6, 6].map((d) => acc.consume(d, 0, 17, 40));
    expect(got).toEqual([0, 0, 1, 0, 0]);
    expect(acc.consume(6, 0, 17, 40)).toBe(1);
  });

  it("does not let a carry leak across a direction change", () => {
    const acc = new WheelAccumulator();
    acc.consume(10, 0, 17, 40); // carry ≈ +0.59
    expect(acc.consume(-10, 0, 17, 40)).toBe(0);
    expect(acc.consume(-10, 0, 17, 40)).toBe(-1);
  });

  it("reads line and page delta modes directly", () => {
    const acc = new WheelAccumulator();
    expect(acc.consume(3, 1, 17, 40)).toBe(3);
    expect(acc.consume(1, 2, 17, 40)).toBe(40);
  });

  it("survives a zero cell height", () => {
    const acc = new WheelAccumulator();
    expect(acc.consume(120, 0, 0, 40)).toBe(6);
  });
});
