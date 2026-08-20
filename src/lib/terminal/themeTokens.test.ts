import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANVAS_BOUND_THEME_KEYS,
  WASM_BOUND_THEME_KEYS,
  carriesAlpha,
  isParseableByGhostty,
} from "@/lib/terminal/diagnostics";
import { readTerminalTheme } from "@/lib/terminal/theme";

/**
 * The theme tokens, checked against what the ENGINE can actually read.
 *
 * This guards a class of bug no suite we can run will catch. A custom
 * property's computed value is the author's literal text in Chromium and in
 * Playwright's WebKit — `rgba(247, 129, 102, 0.28)` stays exactly that — but
 * WKWebView, which is what phasr ships in, normalises it to `#f7816647`.
 * `parseColorToHex` then takes the `#` branch, `parseInt("f7816647", 16)` is
 * not NaN, and the engine silently keeps a 32-bit number it reads as 24-bit.
 * No rejection, no fallback, just a colour nobody chose.
 *
 * So the rule is enforced on the TOKEN and is engine-independent: a token
 * that becomes part of the WASM palette must be opaque, and must be in a
 * form `parseColorToHex` handles. Tokens the renderer uses as a canvas
 * `fillStyle` are unconstrained — alpha there is the mechanism behind the
 * translucent selection wash.
 */

const CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

/** Every declared value of a custom property, across all theme blocks. */
function declaredValues(token: string): string[] {
  const re = new RegExp(`${token}\\s*:\\s*([^;]+);`, "g");
  const out: string[] = [];
  for (const m of CSS.matchAll(re)) out.push(m[1]!.trim().replace(/\s+/g, " "));
  return out;
}

/** `readTerminalTheme` key -> the CSS token it reads. */
const TOKEN_FOR: Record<string, string> = {
  background: "--color-bg-terminal",
  foreground: "--color-text-primary",
  cursor: "--color-accent-500",
  cursorAccent: "--color-accent-onfill",
  selectionBackground: "--ansi-selection",
  black: "--ansi-black", red: "--ansi-red", green: "--ansi-green",
  yellow: "--ansi-yellow", blue: "--ansi-blue", magenta: "--ansi-magenta",
  cyan: "--ansi-cyan", white: "--ansi-white",
  brightBlack: "--ansi-bright-black", brightRed: "--ansi-bright-red",
  brightGreen: "--ansi-bright-green", brightYellow: "--ansi-bright-yellow",
  brightBlue: "--ansi-bright-blue", brightMagenta: "--ansi-bright-magenta",
  brightCyan: "--ansi-bright-cyan", brightWhite: "--ansi-bright-white",
};

describe("theme tokens that become the WASM palette", () => {
  it.each(WASM_BOUND_THEME_KEYS)(
    "%s is opaque and parseable in every theme block",
    (key) => {
      const token = TOKEN_FOR[key]!;
      const values = declaredValues(token);
      expect(values.length, `${token} is not declared in index.css`).toBeGreaterThan(0);
      for (const v of values) {
        expect(carriesAlpha(v), `${token}: ${v} carries alpha — WKWebView normalises it to #rrggbbaa and the engine misreads it as 24-bit`).toBe(false);
        expect(isParseableByGhostty(v), `${token}: ${v} is not a form parseColorToHex handles`).toBe(true);
      }
    },
  );

  it("every WASM-bound key is covered by the token map", () => {
    for (const k of WASM_BOUND_THEME_KEYS) expect(TOKEN_FOR[k]).toBeDefined();
  });

  it("the fallbacks baked into readTerminalTheme obey the same rule", () => {
    // jsdom resolves no custom properties, so this returns pure fallbacks —
    // which ship whenever a token is renamed, and must be just as safe.
    const theme = readTerminalTheme() as unknown as Record<string, string>;
    for (const key of WASM_BOUND_THEME_KEYS) {
      expect(carriesAlpha(theme[key]!), `${key} fallback ${theme[key]}`).toBe(false);
      expect(isParseableByGhostty(theme[key]!), `${key} fallback ${theme[key]}`).toBe(true);
    }
  });

  it("canvas-bound entries are allowed alpha — that is the selection wash", () => {
    const selection = declaredValues("--ansi-selection");
    expect(selection.length).toBeGreaterThan(0);
    expect(selection.some((v) => carriesAlpha(v))).toBe(true);
    expect(CANVAS_BOUND_THEME_KEYS).toContain("selectionBackground");
    // ...and it must NOT be treated as a palette entry.
    expect(WASM_BOUND_THEME_KEYS as readonly string[]).not.toContain("selectionBackground");
  });
});

describe("carriesAlpha", () => {
  it.each(["#f7816647", "#abcd", "rgba(1,2,3,0.5)", "hsla(1,2%,3%,0.5)", "rgb(1 2 3 / 50%)"])(
    "flags %s",
    (v) => expect(carriesAlpha(v)).toBe(true),
  );
  it.each(["#fff", "#e6edf3", "rgb(1, 2, 3)"])("passes %s", (v) =>
    expect(carriesAlpha(v)).toBe(false),
  );
});

describe("isParseableByGhostty rejects the silent-success form", () => {
  it("rejects 8-digit hex even though parseColorToHex 'accepts' it", () => {
    // parseInt("f7816647", 16) is not NaN, so the engine keeps 0xF7816647
    // and reads it as 24-bit -> rgb(129,102,71). A rejection would at least
    // have fallen back; this is why the check is positive.
    expect(Number.isNaN(Number.parseInt("f7816647", 16))).toBe(false);
    expect(isParseableByGhostty("#f7816647")).toBe(false);
  });
});
