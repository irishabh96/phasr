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
 * `terminalScrollback` is **apply-on-next-terminal** on the ghostty
 * backend: the value is in ghostty-web's options bag but its
 * `handleOptionChange` has no `case "scrollback"`, so a post-`open()`
 * write is silently ignored (no warning, unlike `theme`). There is no
 * Settings control for it today; when one is added its copy has to say
 * "applies to terminals opened from now on".
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
   * @returns true iff rows/cols actually changed.
   */
  fit(): boolean;
  /**
   * Force a full redraw *without* a resize — the cure for a canvas that
   * was re-parented while parked. More expensive than the redraw `fit()`
   * does; call it one-shot, never on a resize tick.
   */
  repaint(): void;
  /** Pause/resume rendering while parked. No-op on backends that idle. */
  setActive(active: boolean): void;

  applySettings(settings: Partial<TerminalSurfaceSettings> | undefined): void;
  applyTheme(theme: TerminalTheme): void;

  /** @param row 0-based absolute buffer row. `null` when out of range. */
  readLine(row: number): string | null;
  /** Viewport rect of one cell — the hook e2e needs to click a character. */
  cellRect(col: number, row: number): DOMRect | null;

  installLinks(source: LinkSource): SurfaceDisposable;
  /** `map` returns the bytes to send, or null to let the terminal handle it. */
  installKeymap(map: (event: KeyboardEvent) => string | null): SurfaceDisposable;
  installClipboard(): SurfaceDisposable;

  /** Idempotent. Destroys the emulator and removes `element` from the DOM. */
  dispose(): void;
}
