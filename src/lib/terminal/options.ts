import { clampTerminalFontSize } from "@/lib/terminal/fontSize";
import type {
  TerminalCursorStyle,
  TerminalSurfaceSettings,
  TerminalTheme,
} from "@/lib/terminal/surface";
import { readTerminalTheme } from "@/lib/terminal/theme";

const DEFAULT_MONO_FONT = "ui-monospace, Menlo, monospace";

/**
 * Sentinel for "no line limit". The default: an agent's logs are the
 * product, and a terminal that silently discards them is the defect the
 * scrollback saga kept rediscovering. The engine still gets a bounded BYTE
 * budget (`UNLIMITED_SCROLLBACK_BYTES`), because the WASM heap is one
 * 4 GiB space shared by every terminal in the app — "unlimited" means
 * "bounded by memory, not by a line count".
 */
export const UNLIMITED_SCROLLBACK = 0;

/**
 * Every 0.x database carries `terminal_scrollback = 10000` — the
 * migration's DEFAULT, which no UI has ever offered to change (verified:
 * nothing under routes/ or components/ writes the column). So a stored
 * 10000 is the absence of a choice, not a choice, and it is reinterpreted
 * as unlimited rather than honoured as a cap. A user who deliberately
 * wants exactly 10,000 lines can store 10001.
 */
const LEGACY_DEFAULT_SCROLLBACK_LINES = 10000;

/**
 * The byte budget handed to the engine for "unlimited": 1 GiB. ghostty's
 * `max_scrollback` is byte-denominated (see `scrollbackBytes`), and one
 * GiB is ~250k full-width styled rows or ~1.3M plain 80-column rows —
 * past what anyone scrolls, while leaving headroom in the shared wasm32
 * heap for the other seven cached terminals. Not u32-max on purpose:
 * wasm32's usize IS u32, and a budget near 4.29e9 invites overflow in the
 * core's own `max_size + page` arithmetic.
 */
export const UNLIMITED_SCROLLBACK_BYTES = 1_073_741_824;

/**
 * Bytes budgeted per requested line when the user sets a finite limit.
 * Measured against the real engine (scratchpad probe, 2026-08-26): a full
 * 200-column styled row costs ~4.2 KiB of wasm heap, a plain 80-column
 * row ~800 B. 4 KiB/row guarantees "at least this many lines" in the
 * worst case and simply retains more in the common one — the finite LINE
 * limit itself is enforced by the host at rebuild time (`snapshotPrimary`).
 */
const SCROLLBACK_BYTES_PER_ROW = 4096;

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
    scrollback: scrollbackLines(settings?.terminalScrollback),
    theme: readTerminalTheme(),
  };
}

/**
 * The user's scrollback setting in LINES; `UNLIMITED_SCROLLBACK` (0) for
 * unset, non-positive, garbage, or the never-user-chosen legacy default.
 */
function scrollbackLines(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return UNLIMITED_SCROLLBACK;
  if (value === LEGACY_DEFAULT_SCROLLBACK_LINES) return UNLIMITED_SCROLLBACK;
  return Math.floor(value);
}

/**
 * LINES → the engine's byte budget.
 *
 * ghostty-web's `scrollback` option goes verbatim into
 * `GhosttyTerminalConfig.scrollbackLimit`, and the WASM core forwards THAT
 * to ghostty's `max_scrollback` — which is a budget in BYTES with
 * page-granular eviction. Feeding it a line count is the bug that capped
 * every phasr terminal at ~1,100 rows of history: 10,000 "lines" became a
 * 10 KB budget, floored up to the allocator's minimum pages. Measured
 * against the real WASM (scratchpad probe, 2026-08-26): limits 60, 5,000
 * and 10,000 all retain the same 1,129 rows of a 20,000-row write; 10 MB
 * retains 9,375; 200 MB retains all of it.
 */
export function scrollbackBytes(lines: number): number {
  if (lines <= UNLIMITED_SCROLLBACK) return UNLIMITED_SCROLLBACK_BYTES;
  return Math.min(
    UNLIMITED_SCROLLBACK_BYTES,
    Math.ceil(lines) * SCROLLBACK_BYTES_PER_ROW,
  );
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
  // The engine bag holds BYTES (see scrollbackBytes); phasr's resolved
  // options hold lines. Convert before diffing, or every remount would
  // read lines-vs-bytes as a change and schedule a spurious rebuild.
  const scrollback = scrollbackBytes(next.scrollback);
  if (target.scrollback !== scrollback) {
    target.scrollback = scrollback;
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

export function normalizeCursorStyle(
  value: string | undefined,
): TerminalCursorStyle {
  if (value === "underline" || value === "bar" || value === "block")
    return value;
  return "block";
}
