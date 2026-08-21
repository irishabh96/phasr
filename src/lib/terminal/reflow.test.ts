import { describe, expect, it } from "vitest";
import {
  ALT_SCREEN_MODE,
  decModeSequence,
  modeRepairSequence,
  planResize,
  RETAINED_DEC_MODES,
} from "@/lib/terminal/reflow";

describe("planResize", () => {
  it("does nothing when the grid already matches", () => {
    expect(planResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(
      "none",
    );
  });

  it("resizes in place when only the row count moved", () => {
    // Nothing rewraps, so nothing can drift — and this is the tab-reveal
    // and vertical-window-resize path, which has to stay synchronous.
    expect(planResize({ cols: 80, rows: 24 }, { cols: 80, rows: 51 })).toBe(
      "resize",
    );
  });

  it("rebuilds on any width change, in either direction", () => {
    expect(planResize({ cols: 80, rows: 24 }, { cols: 122, rows: 24 })).toBe(
      "rebuild",
    );
    expect(planResize({ cols: 122, rows: 24 }, { cols: 80, rows: 24 })).toBe(
      "rebuild",
    );
    // Widening is the half that pulled history onto the screen, narrowing
    // the half that spent the blank rows. A round trip contains one of
    // each, so both have to take the same path.
    expect(planResize({ cols: 122, rows: 51 }, { cols: 80, rows: 24 })).toBe(
      "rebuild",
    );
  });
});

describe("decModeSequence", () => {
  it("writes DECSET and DECRST", () => {
    expect(decModeSequence(2004, true)).toBe("\x1b[?2004h");
    expect(decModeSequence(2004, false)).toBe("\x1b[?2004l");
  });
});

describe("modeRepairSequence", () => {
  const map = (o: Record<number, boolean>) =>
    new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

  it("is empty when the replay already re-established everything", () => {
    // The common case: the bytes that set the modes are still inside the
    // retained window, so the rebuilt grid arrives already correct.
    const both = map({ 1: true, 2004: true, 1049: false });
    expect(modeRepairSequence(both, both)).toBe("");
  });

  it("re-asserts only the modes that disagree", () => {
    expect(
      modeRepairSequence(
        map({ 1: true, 2004: true, 1002: false }),
        map({ 1: false, 2004: true, 1002: false }),
      ),
    ).toBe("\x1b[?1h");
  });

  it("turns a mode back OFF, not just on", () => {
    // A fresh terminal has DECAWM and the cursor on by default, so
    // repairing towards "the program switched it off" is a real case.
    expect(modeRepairSequence(map({ 25: false }), map({ 25: true }))).toBe(
      "\x1b[?25l",
    );
  });

  it("puts the alternate screen first, because entering it clears", () => {
    const out = modeRepairSequence(
      map({ 1: true, 2004: true, 1049: true }),
      map({ 1: false, 2004: false, 1049: false }),
    );
    expect(out.indexOf("\x1b[?1049h")).toBe(0);
    expect(out).toBe("\x1b[?1049h\x1b[?1h\x1b[?2004h");
  });

  it("ignores modes nobody asked about", () => {
    expect(modeRepairSequence(map({ 9999: true }), new Map())).toBe("");
  });

  it("covers the modes whose loss is functional rather than cosmetic", () => {
    // The list is the contract: bracketed paste, the mouse encodings the
    // wheel policy reads, application cursor keys, and the alternate
    // screen. Losing any of them changes what the PTY receives.
    for (const mode of [ALT_SCREEN_MODE, 1, 1000, 1002, 1006, 2004]) {
      expect(RETAINED_DEC_MODES).toContain(mode);
    }
  });
});
