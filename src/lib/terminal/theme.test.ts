import { afterEach, describe, expect, it } from "vitest";
import { readTerminalTheme } from "@/lib/terminal/theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("readTerminalTheme", () => {
  // getComputedStyle returns "" for a custom property that isn't defined
  // (first paint, or a renamed token), and an empty colour would render a
  // terminal unreadable rather than merely off-palette.
  it("falls back to the shipped palette when no tokens are defined", () => {
    const theme = readTerminalTheme();
    expect(theme.background).toBe("#000000");
    expect(theme.foreground).toBe("#e6edf3");
    expect(theme.cursor).toBe("#f78166");
    expect(theme.brightWhite).toBe("#ffffff");
  });

  // Was a hardcoded literal in the old terminal factory; it is a token now so a
  // theme can move it. The fallback must still be the value that shipped.
  it("reads the selection colour from --ansi-selection", () => {
    expect(readTerminalTheme().selectionBackground).toBe(
      "rgba(247, 129, 102, 0.28)",
    );

    document.documentElement.style.setProperty("--ansi-selection", "#123456");
    expect(readTerminalTheme().selectionBackground).toBe("#123456");
  });

  it("re-reads at call time so a theme flip is one call away", () => {
    document.documentElement.style.setProperty(
      "--color-bg-terminal",
      "#ffffff",
    );
    expect(readTerminalTheme().background).toBe("#ffffff");

    document.documentElement.style.setProperty(
      "--color-bg-terminal",
      "#0d1117",
    );
    expect(readTerminalTheme().background).toBe("#0d1117");
  });

  it("provides all sixteen ansi slots", () => {
    const theme = readTerminalTheme();
    for (const key of [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const) {
      expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
