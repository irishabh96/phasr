import { clampTerminalFontSize } from "@/lib/terminal/fontSize";
import type {
  TerminalCursorStyle,
  TerminalSurfaceSettings,
  TerminalTheme,
} from "@/lib/terminal/surface";
import { readTerminalTheme } from "@/lib/terminal/theme";

const DEFAULT_MONO_FONT = "ui-monospace, Menlo, monospace";
const DEFAULT_SCROLLBACK = 10000;

/**
 * Discrete whole-line scrolling reads as "janky" on a macOS trackpad no
 * matter the frame rate. A short animation
 * glides between positions the way every other surface in the app scrolls.
 */
const SMOOTH_SCROLL_DURATION_MS = 120;

/**
 * User settings resolved into concrete terminal options, in
 * library-neutral terms. Backends map this onto their own option bag; the
 * mapping is the only place a library name may appear.
 */
export interface ResolvedSurfaceOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: TerminalCursorStyle;
  convertEol: boolean;
  smoothScrollDuration: number;
  scrollback: number;
  theme: TerminalTheme;
}

/** Pure apart from reading CSS custom properties for font + theme. */
export function buildSurfaceOptions(
  settings?: Partial<TerminalSurfaceSettings>,
): ResolvedSurfaceOptions {
  return {
    fontFamily: terminalFontFamily(settings?.monoFont),
    fontSize: clampTerminalFontSize(settings?.baseFontSize),
    lineHeight: 1.0,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: normalizeCursorStyle(settings?.cursorStyle),
    convertEol: true,
    smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
    scrollback: positiveNumber(settings?.terminalScrollback, DEFAULT_SCROLLBACK),
    theme: readTerminalTheme(),
  };
}

/**
 * The subset of a live terminal's options that settings can change. A
 * backend passes its own (mutable, side-effecting) option bag in — hence
 * every key being optional: a library's own option type usually is, and an
 * absent value simply reads as "different" and gets written once.
 */
export interface MutableSurfaceOptions {
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  cursorStyle?: TerminalCursorStyle | undefined;
  cursorBlink?: boolean | undefined;
  scrollback?: number | undefined;
}

/** Reading `theme` back is only ever used for the equality check. */
export interface MutableThemeTarget {
  theme?: unknown;
}

/**
 * Assign ONLY what actually changed. Every write to a live terminal's
 * options fires the emulator's options-changed path, and several of them
 * (theme, fontFamily, fontSize) make the WebGL renderer throw away its
 * whole glyph atlas. This runs on every terminal (re)mount — i.e. every
 * tab switch — and an unconditional assignment meant scrolling right
 * after a switch re-rasterized every visible glyph through WKWebView's
 * synchronous GPU-process IPC: the "terminal scroll is never smooth" jank.
 *
 * The same discipline is required of any future backend for a different
 * reason: a font change there re-measures the cell and re-renders the
 * whole canvas. Expensive either way.
 *
 * @returns the option names that were written (empty when nothing changed).
 */
export function applyChangedOptions(
  target: MutableSurfaceOptions,
  next: ResolvedSurfaceOptions,
): (keyof MutableSurfaceOptions)[] {
  const written: (keyof MutableSurfaceOptions)[] = [];
  if (target.fontFamily !== next.fontFamily) {
    target.fontFamily = next.fontFamily;
    written.push("fontFamily");
  }
  if (target.fontSize !== next.fontSize) {
    target.fontSize = next.fontSize;
    written.push("fontSize");
  }
  if (target.cursorStyle !== next.cursorStyle) {
    target.cursorStyle = next.cursorStyle;
    written.push("cursorStyle");
  }
  if (target.cursorBlink !== next.cursorBlink) {
    target.cursorBlink = next.cursorBlink;
    written.push("cursorBlink");
  }
  if (target.scrollback !== next.scrollback) {
    target.scrollback = next.scrollback;
    written.push("scrollback");
  }
  return written;
}

/**
 * Theme is diffed separately from the rest so a live theme flip can push
 * colours without touching fonts, and so a settings change doesn't
 * re-write colours that didn't move. Structural comparison: the theme is
 * rebuilt from CSS on every read, so it is never reference-equal.
 *
 * @returns true iff the theme was written.
 */
export function applyChangedTheme(
  target: MutableThemeTarget,
  next: TerminalTheme,
): boolean {
  if (JSON.stringify(target.theme ?? {}) === JSON.stringify(next)) return false;
  target.theme = next;
  return true;
}

export function terminalFontFamily(font: string | undefined): string {
  const cleaned = font?.trim().replaceAll('"', "").replaceAll("'", "");
  const fallback = cssMonoFallback();
  return cleaned ? `"${cleaned}", ${fallback}` : fallback;
}

function cssMonoFallback(): string {
  const computed = getComputedStyle(document.documentElement);
  return computed.getPropertyValue("--font-mono").trim() || DEFAULT_MONO_FONT;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function normalizeCursorStyle(
  value: string | undefined,
): TerminalCursorStyle {
  if (value === "underline" || value === "bar" || value === "block")
    return value;
  return "block";
}
