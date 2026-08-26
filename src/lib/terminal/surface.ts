import type { UserSettings } from "@/lib/types";

/**
 * The terminal contract every phasr component talks to. **No terminal
 * library may be imported from this file** — that is the whole point of
 * it. Components hold a `TerminalSurface`; which emulator is behind it is
 * decided once, in `factory.ts`.
 *
 * Deliberately absent (the emulator-isms that leaked into components
 * before): `loadAddon`, `buffer`, `options`, `refresh`. Anything a
 * component needs from those is exposed here in library-neutral terms.
 */

/** Minimal unsubscribe handle. */
export interface SurfaceDisposable {
  dispose(): void;
}

/**
 * One member on purpose. The previous engine was removed once ghostty-web
 * had been used in anger (ADR-002), but the surface — and this discriminator,
 * which every terminal carries as `data-terminal-kind` — is what makes the next
 * engine swap a diff rather than a rewrite.
 */
export type TerminalBackendKind = "ghostty";

/**
 * The slice of user settings a terminal actually renders from.
 *
 * `terminalScrollback` applies LIVE, via a same-width grid rebuild:
 * ghostty-web's `handleOptionChange` has no `case "scrollback"` (a
 * post-`open()` write is silently ignored, no warning, unlike `theme`),
 * but the engine reads the limit at terminal construction — so a changed
 * value schedules the settle-debounced rebuild, which constructs a fresh
 * grid through the current options and carries the buffer over. Parity
 * with the previous engine, which honoured the option directly.
 *
 * Its VALUE is in lines, with 0 / unset / the legacy stored default of
 * 10000 all meaning "unlimited" — see `options.ts` (`scrollbackLines`,
 * `scrollbackBytes`) for how that becomes the engine's byte budget.
 */
export type TerminalSurfaceSettings = Pick<
  UserSettings,
  | "monoFont"
  | "baseFontSize"
  | "cursorStyle"
  | "cursorBlink"
  | "terminalScrollback"
>;

export type TerminalCursorStyle = "block" | "underline" | "bar";

/** Resolved colours, already read off CSS custom properties. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  /**
   * Ink for the character UNDER a block cursor — the cursor cell is drawn
   * inverse-video, the way every other terminal draws it. Without it the
   * block is an opaque rectangle and you cannot see what you are typing.
   */
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Column range of a link inside one line: **0-based, half-open**
 * `[startCol, endCol)` — i.e. exactly the `start`/`end` a string slice
 * uses. Library-neutral on purpose: emulators disagree (some want 1-based
 * inclusive, ghostty wants 0-based inclusive), so a backend does
 * its own translation and no convention leaks into the link core.
 */
export interface LinkSpan {
  startCol: number;
  endCol: number;
}

export interface SurfaceLink {
  /** The link's own text, as rendered. */
  text: string;
  span: LinkSpan;
  activate(event: MouseEvent): void;
}

/**
 * Backend-neutral link logic. A backend adapter asks it for links on a
 * line and routes OSC 8 activation to it; all policy (⌘-gating, scheme
 * validation, path resolution) lives on this side.
 */
export interface LinkSource {
  /** @param row 0-based absolute buffer row (scrollback included). */
  provide(row: number, lineText: string): SurfaceLink[];
  /** OSC 8 hyperlink activation — the target is untrusted agent output. */
  activateHyperlink(uri: string, event: MouseEvent): void;
}

export interface TerminalSurface {
  readonly kind: TerminalBackendKind;
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  /**
   * Surface-owned container. It is created once and lives as long as the
   * surface does; callers re-parent it (into a mount slot, or the park
   * host) but must never replace or empty it.
   */
  readonly element: HTMLElement;

  write(data: string | Uint8Array): void;
  /** Inject a sequence as if typed — fires `onData`. */
  input(seq: string): void;
  onData(cb: (data: string) => void): SurfaceDisposable;
  onResize(cb: (size: { rows: number; cols: number }) => void): SurfaceDisposable;
  focus(): void;

  /**
   * Re-measure and resize the grid to the container, then redraw.
   *
   * The immediate, unconditional path: it reflows. Correct while a
   * terminal is still being born — the PTY is spawned at whatever this
   * measures and there is no content to lose — and wrong for anything a
   * user does afterwards. See `fitAnchored`.
   *
   * @returns true iff rows/cols actually changed.
   */
  fit(): boolean;
  /**
   * Adopt the container's geometry **without moving the content**.
   *
   * This is what every resize a user can cause goes through: a panel
   * toggle, a window drag, a font-size change. A row-only change is
   * applied immediately; a width change is deferred until the container
   * stops moving and then applied by REBUILDING the grid at the new width,
   * because reflowing it walks the content down the screen and never gives
   * the rows back (ADR-002, "the reflow anchor"). See
   * `lib/terminal/reflow.ts` for the policy and what a rebuild costs.
   *
   * Deliberately returns nothing: "did the grid change" is not knowable at
   * the moment of the call, which is the whole point.
   */
  fitAnchored(): void;
  /**
   * Force a full redraw *without* a resize — the cure for a canvas that
   * was re-parented while parked. More expensive than the redraw `fit()`
   * does; call it one-shot, never on a resize tick.
   */
  repaint(): void;
  /** Pause/resume rendering while parked. No-op on backends that idle. */
  setActive(active: boolean): void;
  /**
   * Frames the renderer has actually run — or `null` when this surface is
   * not meant to be painting right now (parked, no engine yet, disposed),
   * or the backend has no free-running loop to measure.
   *
   * Monotonic and otherwise meaningless: only its MOVEMENT is a signal.
   * It exists because "this terminal is dead" and "this terminal is fine
   * and has nothing new to show" look identical on screen, and the fix for
   * one is nothing while the fix for the other is a restart. See
   * `lib/terminal/liveness.ts`.
   */
  renderTick(): number | null;
  /**
   * Force the render loop back up and repaint in full.
   *
   * Idempotent and cheap enough to fire on a healthy surface: one loop
   * restart and one full redraw. The recovery half of `renderTick`.
   */
  kickRendering(): void;

  applySettings(settings: Partial<TerminalSurfaceSettings> | undefined): void;
  applyTheme(theme: TerminalTheme): void;

  /** @param row 0-based absolute buffer row. `null` when out of range. */
  readLine(row: number): string | null;
  /**
   * Where the viewport sits, in lines.
   *
   * `offset` is how far the viewport is scrolled BACK from the live
   * bottom — 0 means pinned to the bottom, which is where a terminal sits
   * unless the user has scrolled. `scrollback` is how many lines of
   * history exist right now.
   *
   * Exposed because "the content is painted four rows lower than it was"
   * has two indistinguishable-on-screen causes with opposite fixes: blank
   * rows really are in the buffer, or the viewport is scrolled off the
   * bottom. Only these two numbers tell them apart, and BOTH move under a
   * width reflow — which rewraps lines and therefore changes how many of
   * them are history.
   */
  readViewport(): { offset: number; scrollback: number };
  /** Viewport rect of one cell — the hook e2e needs to click a character. */
  cellRect(col: number, row: number): DOMRect | null;

  installLinks(source: LinkSource): SurfaceDisposable;
  /** `map` returns the bytes to send, or null to let the terminal handle it. */
  installKeymap(map: (event: KeyboardEvent) => string | null): SurfaceDisposable;
  installClipboard(): SurfaceDisposable;

  /** Idempotent. Destroys the emulator and removes `element` from the DOM. */
  dispose(): void;
}
