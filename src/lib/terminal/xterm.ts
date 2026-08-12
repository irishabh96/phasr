import { Terminal as XtermTerminal } from "@xterm/xterm";
import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { itermSequenceFor } from "@/lib/terminal/keymap";
import type { UserSettings } from "@/lib/types";

const DEFAULT_MONO_FONT = "ui-monospace, Menlo, monospace";
const DEFAULT_FONT_SIZE = 13;
const DEFAULT_SCROLLBACK = 10000;

type TerminalSettings = Pick<
  UserSettings,
  | "monoFont"
  | "baseFontSize"
  | "cursorStyle"
  | "cursorBlink"
  | "terminalScrollback"
>;

export function createXtermTerminal(settings?: Partial<TerminalSettings>) {
  const term = new XtermTerminal(buildTerminalOptions(settings));
  // iTerm-parity chords (⌘⌫, ⌘←/→, ⌥-word, ⇧↵, …). xterm ignores
  // meta-modified keys, so without this the PTY never hears them.
  // `input()` emits onData — the normal send path picks it up.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const seq = itermSequenceFor(e);
    if (seq === null) return true;
    term.input(seq);
    e.preventDefault();
    return false;
  });
  return term;
}

export function applyXtermSettings(
  term: XtermTerminal,
  settings: Partial<TerminalSettings> | undefined,
) {
  const options = buildTerminalOptions(settings);
  // Assign ONLY what actually changed. Every write to `term.options` fires
  // xterm's options-changed path, and several of them (theme, fontFamily,
  // fontSize) make the WebGL renderer throw away its whole glyph atlas.
  // This runs on every terminal (re)mount — i.e. every tab switch — and an
  // unconditional theme assignment meant scrolling right after a switch
  // re-rasterized every visible glyph through WKWebView's synchronous
  // GPU-process IPC: the "terminal scroll is never smooth" jank.
  if (
    options.fontFamily !== undefined &&
    term.options.fontFamily !== options.fontFamily
  )
    term.options.fontFamily = options.fontFamily;
  if (
    options.fontSize !== undefined &&
    term.options.fontSize !== options.fontSize
  )
    term.options.fontSize = options.fontSize;
  if (
    options.cursorStyle !== undefined &&
    term.options.cursorStyle !== options.cursorStyle
  )
    term.options.cursorStyle = options.cursorStyle;
  if (
    options.cursorBlink !== undefined &&
    term.options.cursorBlink !== options.cursorBlink
  )
    term.options.cursorBlink = options.cursorBlink;
  if (
    options.scrollback !== undefined &&
    term.options.scrollback !== options.scrollback
  )
    term.options.scrollback = options.scrollback;
  if (
    options.theme !== undefined &&
    JSON.stringify(term.options.theme ?? {}) !== JSON.stringify(options.theme)
  )
    term.options.theme = options.theme;
}

function buildTerminalOptions(
  settings?: Partial<TerminalSettings>,
): ITerminalOptions {
  return {
    fontFamily: terminalFontFamily(settings?.monoFont),
    fontSize: positiveNumber(settings?.baseFontSize, DEFAULT_FONT_SIZE),
    lineHeight: 1.0,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: normalizeCursorStyle(settings?.cursorStyle),
    convertEol: true,
    allowProposedApi: true,
    // xterm's default scroll is discrete whole-line jumps, which reads as
    // "janky" on a macOS trackpad no matter the frame rate. A short
    // animation glides between positions the way every other surface in
    // the app scrolls.
    smoothScrollDuration: 120,
    scrollback: positiveNumber(
      settings?.terminalScrollback,
      DEFAULT_SCROLLBACK,
    ),
    theme: terminalTheme(),
  };
}

function terminalTheme(): ITheme {
  const computed = getComputedStyle(document.documentElement);
  const css = (name: string, fallback: string) =>
    computed.getPropertyValue(name).trim() || fallback;

  return {
    background: css("--color-bg-terminal", "#000000"),
    foreground: css("--color-text-primary", "#e6edf3"),
    cursor: css("--color-accent-500", "#f78166"),
    selectionBackground: "rgba(247,129,102,0.28)",
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

function terminalFontFamily(font: string | undefined) {
  const cleaned = font?.trim().replaceAll('"', "").replaceAll("'", "");
  const fallback = cssMonoFallback();
  return cleaned ? `"${cleaned}", ${fallback}` : fallback;
}

function cssMonoFallback() {
  const computed = getComputedStyle(document.documentElement);
  return computed.getPropertyValue("--font-mono").trim() || DEFAULT_MONO_FONT;
}

function positiveNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizeCursorStyle(
  value: string | undefined,
): NonNullable<ITerminalOptions["cursorStyle"]> {
  if (value === "underline" || value === "bar" || value === "block")
    return value;
  return "block";
}
