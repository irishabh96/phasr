import { describe, expect, it } from "vitest";
import {
  clampTerminalFontSize,
  TERMINAL_FONT_SIZE,
} from "@/lib/terminal/fontSize";

// The backend never validates base_font_size — a row written by cloud sync
// from another client must not render verbatim.
describe("clampTerminalFontSize", () => {
  it("passes a legal size through", () => {
    expect(clampTerminalFontSize(13)).toBe(13);
    expect(clampTerminalFontSize(TERMINAL_FONT_SIZE.min)).toBe(
      TERMINAL_FONT_SIZE.min,
    );
    expect(clampTerminalFontSize(TERMINAL_FONT_SIZE.max)).toBe(
      TERMINAL_FONT_SIZE.max,
    );
  });

  it("clamps an out-of-range stored size to the bounds", () => {
    expect(clampTerminalFontSize(40)).toBe(24);
    expect(clampTerminalFontSize(4)).toBe(9);
  });

  // Garbage falls back to the default, not the minimum: a broken row
  // should look normal, not microscopic.
  it("falls back to the default for garbage", () => {
    expect(clampTerminalFontSize(0)).toBe(13);
    expect(clampTerminalFontSize(-5)).toBe(13);
    expect(clampTerminalFontSize(NaN)).toBe(13);
    expect(clampTerminalFontSize(Infinity)).toBe(13);
    expect(clampTerminalFontSize(undefined)).toBe(13);
  });

  it("rounds a fractional size", () => {
    expect(clampTerminalFontSize(13.4)).toBe(13);
    expect(clampTerminalFontSize(13.6)).toBe(14);
  });
});
