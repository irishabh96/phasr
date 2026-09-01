/**
 * Wheel policy for the ghostty backend.
 *
 * `ghostty-web@0.4.0` handles the wheel like this (dist/ghostty-web.js,
 * `handleWheel`):
 *
 * ```js
 * if (this.wasmTerm?.isAlternateScreen() ?? false) {
 *   const dir = e.deltaY > 0 ? "down" : "up";
 *   const n = Math.min(Math.abs(Math.round(e.deltaY / 33)), 5);
 *   for (let i = 0; i < n; i++)
 *     dir === "up" ? this.dataEmitter.fire("\x1B[A") : this.dataEmitter.fire("\x1B[B");
 * } else { …scrollback… }
 * ```
 *
 * Two things are wrong with that for a phasr terminal:
 *
 * 1. **It never reports the mouse.** ghostty-web emits no mouse sequences
 *    anywhere (`\x1b[<` appears zero times in its bundle), so an app that
 *    asked for wheel events with DECSET 1000/1002/1003 never gets them.
 *    Claude Code asks — verified by driving the real CLI in a pty: it emits
 *    `\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h` at startup —
 *    and it scrolls its own transcript when it receives SGR wheel events.
 * 2. **The fallback types keys into the app.** Up to FIVE `\x1b[A` per
 *    tick. In Claude that opens the prompt-history overlay and replaces
 *    whatever the user had typed; five at a time also jumps five entries.
 *
 * The engine phasr shipped before did neither, and neither does any
 * mainstream emulator. They send real mouse events whenever the app
 * requested them, and only when it did NOT do they fall back to ONE arrow
 * per wheel event (for `less`/`vim` without `set mouse`), respecting
 * DECCKM. This module reproduces that
 * behaviour exactly, and is installed through the supported
 * `attachCustomWheelEventHandler` hook rather than another dist patch.
 */

import { encodeMouse } from "@/lib/terminal/backends/ghostty/mouse";

/** DEC private modes this policy reads. */
export const DEC_APPLICATION_CURSOR = 1;

/** What the wheel should do, given the terminal's mode state. */
export type WheelOutcome =
  /** Bytes to send to the PTY as if the user had produced them. */
  | { kind: "send"; seq: string }
  /** Consume the event and do nothing (no scrollback, no keys). */
  | { kind: "swallow" }
  /** Let ghostty-web run its own (correct) scrollback path. */
  | { kind: "scrollback" };

export interface WheelContext {
  /** `wasmTerm.isAlternateScreen()`. */
  alternateScreen: boolean;
  /** `wasmTerm.hasMouseTracking()` — DECSET 1000/1002/1003. */
  mouseTracking: boolean;
  /** DECSET 1006. Without it, mouse events use the X10 encoding. */
  sgrMouse: boolean;
  /** DECSET 1 (DECCKM) — arrow keys become `ESC O A` instead of `ESC [ A`. */
  applicationCursor: boolean;
  /** 0-based cell under the pointer. */
  col: number;
  row: number;
  /** Whole lines this event scrolled: >0 down, <0 up, 0 = below threshold. */
  lines: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** Wheel-up / wheel-down as the SGR/X10 protocol numbers them (bit 6 set). */
const BUTTON_WHEEL_UP = 64;
const BUTTON_WHEEL_DOWN = 65;

/**
 * The whole policy, as a pure function of mode state — so it is testable
 * without a canvas, a wasm instance or a DOM event.
 */
export function wheelOutcome(ctx: WheelContext): WheelOutcome {
  // Shift bypasses mouse reporting — the xterm/iTerm escape hatch, and the
  // only way to read the shell's scrollback while a mouse-aware program
  // (Claude Code, vim `set mouse=a`) owns the wheel. Only off the
  // alternate screen: the alt screen has no scrollback to bypass TO, so a
  // shifted wheel there falls through to the arrow-key branch below.
  const reporting = ctx.mouseTracking && !ctx.shift;

  // A sub-line delta (trackpads emit many tiny ones) is consumed by the
  // accumulator and produces nothing at all. Sending an event per pixel
  // would flood the PTY; sending an arrow per pixel is the bug above.
  if (ctx.lines === 0) {
    return ctx.alternateScreen || reporting
      ? { kind: "swallow" }
      : { kind: "scrollback" };
  }

  // The app asked for wheel events: they are its to interpret, on either
  // screen. This is the conventional `requestedEvents.wheel` branch, and it is
  // what makes wheel-scrolling work inside Claude Code, vim `set mouse=a`,
  // htop and every other mouse-aware TUI.
  if (reporting) return { kind: "send", seq: mouseSequence(ctx) };

  // Alt screen, no mouse tracking: there is no scrollback to show (the
  // alternate screen has none by definition), so the only useful thing a
  // terminal can do is translate the wheel into cursor keys. Exactly ONE
  // per event, as mainstream emulators do — `less`/`vim` move a line per tick.
  if (ctx.alternateScreen) {
    const intro = ctx.applicationCursor ? "\x1bO" : "\x1b[";
    return { kind: "send", seq: `${intro}${ctx.lines < 0 ? "A" : "B"}` };
  }

  return { kind: "scrollback" };
}

/** Wheel report for the cell under the pointer. Encoding lives in `mouse.ts`. */
export function mouseSequence(ctx: WheelContext): string {
  return encodeMouse({
    button: ctx.lines < 0 ? BUTTON_WHEEL_UP : BUTTON_WHEEL_DOWN,
    col: ctx.col,
    row: ctx.row,
    sgr: ctx.sgrMouse,
    shift: ctx.shift,
    alt: ctx.alt,
    ctrl: ctx.ctrl,
  });
}

/**
 * Pixel deltas → whole lines, keeping the remainder.
 *
 * A macOS trackpad emits a stream of small `DOM_DELTA_PIXEL` events; a
 * mouse wheel emits ~120 at a time. Rounding each event on its own would
 * either drop every trackpad event (`Math.floor`) or turn each into a full
 * line (`Math.ceil`). Carrying the remainder is what a conventional
 * core-mouse wheel accumulator does, and it is why a slow trackpad
 * drag scrolls smoothly instead of in bursts.
 */
export class WheelAccumulator {
  private carry = 0;

  /**
   * @param deltaY  the event's deltaY
   * @param deltaMode 0 pixel, 1 line, 2 page
   * @param cellHeight device-independent px of one row (>0)
   * @param rows viewport rows, for page mode
   */
  consume(
    deltaY: number,
    deltaMode: number,
    cellHeight: number,
    rows: number,
  ): number {
    if (deltaY === 0) return 0;
    let lines: number;
    if (deltaMode === 1) lines = deltaY;
    else if (deltaMode === 2) lines = deltaY * rows;
    else lines = deltaY / (cellHeight > 0 ? cellHeight : 20);

    // Direction change: a leftover carry from the other direction would
    // eat the first event back the other way.
    if (this.carry !== 0 && Math.sign(this.carry) !== Math.sign(lines)) {
      this.carry = 0;
    }
    const total = this.carry + lines;
    const whole = Math.trunc(total);
    this.carry = total - whole;
    // `Math.trunc(-0.5)` is -0, which `wheelOutcome` would read as a
    // direction rather than as "nothing yet".
    return whole === 0 ? 0 : whole;
  }

  reset(): void {
    this.carry = 0;
  }
}
