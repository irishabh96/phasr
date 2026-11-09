import type { TerminalTheme } from "@/lib/terminal/surface";

/**
 * The terminal palette, read off the app's CSS custom properties at call
 * time (not at import time) so a theme flip is a re-read away. Every
 * value has a hardcoded fallback because `getComputedStyle` returns "" for
 * a variable that hasn't been defined yet — during the first paint, or if
 * a token is ever renamed.
 */
export function readTerminalTheme(): TerminalTheme {
  const computed = getComputedStyle(document.documentElement);
  const css = (name: string, fallback: string) =>
    computed.getPropertyValue(name).trim() || fallback;

  return {
    background: css("--color-bg-terminal", "#000000"),
    foreground: css("--color-text-primary", "#ececee"),
    cursor: css("--color-accent-500", "#e0674a"),
    // The cursor is an accent FILL, so the glyph inside it is ink on the
    // accent — exactly what `--color-accent-onfill` is for (it flips per
    // theme/accent so it always clears 4.5:1 on that fill).
    cursorAccent: css("--color-accent-onfill", "#0c0c0e"),
    // Tokenised so each theme and accent block can restate it.
    selectionBackground: css("--ansi-selection", "rgba(224, 103, 74, 0.28)"),
    black: css("--ansi-black", "#484f58"),
    red: css("--ansi-red", "#f06b6b"),
    green: css("--ansi-green", "#3dcf8e"),
    yellow: css("--ansi-yellow", "#f5b548"),
    blue: css("--ansi-blue", "#4f8cff"),
    magenta: css("--ansi-magenta", "#b79cff"),
    cyan: css("--ansi-cyan", "#39c5cf"),
    white: css("--ansi-white", "#b9bec7"),
    brightBlack: css("--ansi-bright-black", "#6e7681"),
    brightRed: css("--ansi-bright-red", "#ff9b9b"),
    brightGreen: css("--ansi-bright-green", "#6fe0ad"),
    brightYellow: css("--ansi-bright-yellow", "#f9cf7f"),
    brightBlue: css("--ansi-bright-blue", "#7faaff"),
    brightMagenta: css("--ansi-bright-magenta", "#d2c0ff"),
    brightCyan: css("--ansi-bright-cyan", "#6fdce3"),
    brightWhite: css("--ansi-bright-white", "#ffffff"),
  };
}
