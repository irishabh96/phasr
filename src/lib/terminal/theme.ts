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
    foreground: css("--color-text-primary", "#e6edf3"),
    cursor: css("--color-accent-500", "#f78166"),
    // Tokenised (was a literal here) so a theme can override it; the base
    // value is unchanged, and light deliberately does not override it.
    selectionBackground: css("--ansi-selection", "rgba(247, 129, 102, 0.28)"),
    black: css("--ansi-black", "#484f58"),
    red: css("--ansi-red", "#ff7b72"),
    green: css("--ansi-green", "#3fb950"),
    yellow: css("--ansi-yellow", "#d29922"),
    blue: css("--ansi-blue", "#58a6ff"),
    magenta: css("--ansi-magenta", "#bc8cff"),
    cyan: css("--ansi-cyan", "#39c5cf"),
    white: css("--ansi-white", "#b1bac4"),
    brightBlack: css("--ansi-bright-black", "#6e7681"),
    brightRed: css("--ansi-bright-red", "#ffa198"),
    brightGreen: css("--ansi-bright-green", "#56d364"),
    brightYellow: css("--ansi-bright-yellow", "#e3b341"),
    brightBlue: css("--ansi-bright-blue", "#79c0ff"),
    brightMagenta: css("--ansi-bright-magenta", "#d2a8ff"),
    brightCyan: css("--ansi-bright-cyan", "#56d4dd"),
    brightWhite: css("--ansi-bright-white", "#ffffff"),
  };
}
