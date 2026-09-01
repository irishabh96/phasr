import type { SurfaceDisposable } from "@/lib/terminal/surface";

/**
 * Mouse-BUTTON reporting for the ghostty backend.
 *
 * `wheel.ts` taught phasr to report the wheel when an app asks for mouse
 * tracking. Buttons were never reported at all — not by phasr, and not by
 * ghostty-web, whose bundle contains no mouse sequence of any kind
 * (`\x1b[<` and `\x1b[M` each appear zero times in `dist/ghostty-web.js`).
 * Its canvas mouse listeners drive only its own drag-selection, link
 * activation and scrollbar.
 *
 * So a click inside a phasr terminal reached the program as nothing at
 * all, and every mouse-aware TUI was half-alive: the wheel scrolled it
 * (that was the 0.4.1 fix) but nothing in it could be clicked. Claude Code
 * emits `\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h` at startup and
 * makes its agent rows, task list and menu options clickable; `vim` with
 * `set mouse=a`, `htop`, `lazygit` and `tmux` all ask for the same modes.
 *
 * This module is the button half of `wheel.ts`, in the same shape: a pure
 * policy over mode state, the protocol encoder both halves share, and a
 * thin DOM installer.
 *
 * ## What the policy deliberately does NOT report
 *
 * - **Right-click.** ghostty-web installs its own `contextmenu` handler
 *   that fills the hidden textarea so WebKit's native Copy/Paste menu
 *   works on a canvas (see `clipboard.ts`) — and inside a terminal that
 *   menu is phasr's only pointer-driven paste. Reporting button 2 would
 *   trade it away in every tracking app. `encodeMouse` can encode it; the
 *   policy declines to.
 * - **Anything with shift held.** The xterm escape hatch, and the same
 *   bypass `wheel.ts` takes: shift-drag still selects text, and
 *   shift+wheel still reaches the scrollback, while an app owns the mouse.
 */

/** DECSET 9. Presses only — no release, no motion, no modifier bits. */
export const DEC_MOUSE_X10 = 9;
/** DECSET 1000. Press and release. */
export const DEC_MOUSE_BUTTON = 1000;
/** DECSET 1002. 1000 plus motion while a button is held. */
export const DEC_MOUSE_DRAG = 1002;
/** DECSET 1003. 1002 plus motion with no button held. */
export const DEC_MOUSE_ANY = 1003;
/** DECSET 1006. SGR encoding — coordinates unbounded, releases labelled. */
export const DEC_SGR_MOUSE = 1006;

const BUTTON_LEFT = 0;
const BUTTON_MIDDLE = 1;
/** X10's "a button came up". The encoding has no room to say which one. */
const BUTTON_RELEASE = 3;
/** Bit 5: this report is motion, not a press. */
const FLAG_MOTION = 32;

const MOD_SHIFT = 4;
const MOD_ALT = 8;
const MOD_CTRL = 16;

/** One report, before the button number is turned into bytes. */
export interface MouseEncoding {
  /** Protocol button number — modifier bits NOT yet applied. */
  button: number;
  /** 0-based cell. Encoded 1-based, as the protocol counts. */
  col: number;
  row: number;
  /** DECSET 1006 is on. */
  sgr: boolean;
  /** This is a release. */
  release?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/**
 * SGR (DECSET 1006) or X10 mouse encoding — shared with `wheel.ts`.
 *
 * SGR: `CSI < Cb ; Cx ; Cy` then `M` for a press or motion and `m` for a
 * release, so the button survives the release. That is the whole reason
 * 1006 exists.
 * X10: `CSI M` then `Cb+32`, `Cx+32`, `Cy+32` as single bytes, which caps
 * coordinates at 223 and collapses every release onto button 3. Apps that
 * never request 1006 are old enough to expect exactly that.
 */
export function encodeMouse(event: MouseEncoding): string {
  let button = event.release && !event.sgr ? BUTTON_RELEASE : event.button;
  if (event.shift) button += MOD_SHIFT;
  if (event.alt) button += MOD_ALT;
  if (event.ctrl) button += MOD_CTRL;

  const col = Math.max(0, event.col) + 1;
  const row = Math.max(0, event.row) + 1;

  if (event.sgr) {
    return `\x1b[<${button};${col};${row}${event.release ? "m" : "M"}`;
  }

  const clamp = (v: number) => String.fromCharCode(32 + Math.min(v, 223));
  return `\x1b[M${clamp(button)}${clamp(col)}${clamp(row)}`;
}

/** What a pointer event should do, given the terminal's mode state. */
export type MouseOutcome =
  /** Bytes for the PTY. */
  | { kind: "send"; seq: string }
  /** The app owns the mouse but this event carries nothing it asked for. */
  | { kind: "swallow" }
  /** Not the app's: phasr's selection, hover and link handling should run. */
  | { kind: "passthrough" };

export type MouseEventKind = "down" | "up" | "move";

export interface MouseContext {
  type: MouseEventKind;
  /** DOM `MouseEvent.button`: 0 left, 1 middle, 2 right. Ignored for motion. */
  button: number;
  /** DOM `MouseEvent.buttons` bitmask: 1 left, 2 right, 4 middle. */
  buttons: number;
  /** `wasmTerm.hasMouseTracking()` — any of 9 / 1000 / 1002 / 1003. */
  mouseTracking: boolean;
  x10: boolean;
  dragTracking: boolean;
  anyMotion: boolean;
  sgrMouse: boolean;
  /** 0-based cell under the pointer, clamped to the grid. */
  col: number;
  row: number;
  /**
   * Motion only: is this a different cell from the last one reported?
   * A pointer crossing one 8×17px cell emits dozens of `mousemove`s and
   * the protocol has no sub-cell resolution, so reporting every one would
   * flood the PTY with duplicates. Every mainstream emulator reports
   * motion on cell change.
   */
  cellChanged: boolean;
  /**
   * Move and release only: is this part of a gesture whose press we
   * reported? Such a gesture stays ours to the end, shift or no shift.
   */
  wasReported?: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * The whole policy, as a pure function of mode state — testable without a
 * canvas, a wasm instance or a DOM event.
 */
export function mouseOutcome(ctx: MouseContext): MouseOutcome {
  if (!ctx.mouseTracking) return { kind: "passthrough" };

  // Shift is the escape hatch, and it is read at PRESS time only. Once a
  // gesture is ours the whole of it is ours: a shift pressed mid-drag that
  // handed the moves back would let the selection layer paint underneath
  // the app, and a shift held at release would drop a release the app is
  // owed, leaving it believing the button is still down.
  if (ctx.shift && !ctx.wasReported) return { kind: "passthrough" };

  if (ctx.type === "move") return motionOutcome(ctx);

  const button = protocolButton(ctx.button);
  // Right-click and the exotic buttons stay phasr's — see the header.
  if (button === null) return { kind: "passthrough" };

  // DECSET 9 reports presses only, and carries no modifier bits at all.
  if (ctx.x10) {
    if (ctx.type === "up") return { kind: "swallow" };
    return {
      kind: "send",
      seq: encodeMouse({
        button,
        col: ctx.col,
        row: ctx.row,
        sgr: ctx.sgrMouse,
      }),
    };
  }

  return {
    kind: "send",
    seq: encodeMouse({
      button,
      col: ctx.col,
      row: ctx.row,
      sgr: ctx.sgrMouse,
      release: ctx.type === "up",
      alt: ctx.alt,
      ctrl: ctx.ctrl,
    }),
  };
}

function motionOutcome(ctx: MouseContext): MouseOutcome {
  const held = heldButton(ctx.buttons);

  // Nothing held and the app never asked for hover (1003): the pointer is
  // just passing over. Let phasr's link hover keep working.
  if (held === null && !ctx.anyMotion) return { kind: "passthrough" };

  // A button IS held, so this is a drag the app already owns through the
  // press we reported — never hand it to the selection layer, even when
  // the app asked for no motion at all (1000, or 9).
  if (held !== null && !(ctx.dragTracking || ctx.anyMotion)) {
    return { kind: "swallow" };
  }
  if (ctx.x10)
    return held === null ? { kind: "passthrough" } : { kind: "swallow" };

  if (!ctx.cellChanged) return { kind: "swallow" };

  return {
    kind: "send",
    seq: encodeMouse({
      button: (held ?? BUTTON_RELEASE) + FLAG_MOTION,
      col: ctx.col,
      row: ctx.row,
      sgr: ctx.sgrMouse,
      alt: ctx.alt,
      ctrl: ctx.ctrl,
    }),
  };
}

/** DOM button → protocol button, or null for one phasr does not report. */
export function protocolButton(button: number): number | null {
  if (button === 0) return BUTTON_LEFT;
  if (button === 1) return BUTTON_MIDDLE;
  return null;
}

/** Lowest-numbered held button the policy reports, from `MouseEvent.buttons`. */
export function heldButton(buttons: number): number | null {
  if (buttons & 1) return BUTTON_LEFT;
  if (buttons & 4) return BUTTON_MIDDLE;
  return null;
}

/** DEC mode state, read fresh on every event. */
export interface MouseModes {
  mouseTracking: boolean;
  x10: boolean;
  dragTracking: boolean;
  anyMotion: boolean;
  sgrMouse: boolean;
}

/** What the installer needs from the surface. */
export interface GhosttyMouseHost {
  /** Null while the engine is still loading. */
  modes(): MouseModes | null;
  /**
   * 0-based cell under the pointer, or null when the point is not a cell of
   * this terminal's grid — the surface padding, the strip below the last
   * row, or ghostty-web's overlay scrollbar. Those belong to whatever draws
   * them, not to the app.
   */
  cellAt(event: MouseEvent): { col: number; row: number } | null;
  send(seq: string): void;
  focus(): void;
}

/**
 * Report buttons and motion to the PTY whenever a program asked for them.
 *
 * ## Where the listeners live, and what each one is allowed to stop
 *
 * All three are on the WINDOW in capture phase, which runs before every
 * element listener whatever the registration order — and a drag has to be
 * followed off the canvas anyway, or a release outside it never arrives and
 * the app believes the button is held for the rest of the session.
 *
 * What they may STOP is the delicate part, because three different parties
 * listen for the same press (all verified in `dist/ghostty-web.js`):
 *
 * - ghostty-web's `handleMouseDown`, element capture — the overlay
 *   SCROLLBAR only. It returns immediately unless the point is in the 8px
 *   strip at the right edge, and not at all when there is no scrollback.
 * - ghostty-web's drag-selection, on the DOCUMENT: `mousedown` anchors,
 *   `mousemove` extends, `mouseup` finalises and copies.
 * - phasr's own menus (`WorkspaceActionsMenu`, `OpenInMenu`, `SyncButton`,
 *   `RunCommandPicker`), also `document` `mousedown` — which is how they
 *   close when you click outside them.
 *
 * The last two are indistinguishable by phase, so stopping a PRESS to
 * suppress the selection would also wedge every open menu the moment you
 * clicked into a terminal. A press is therefore never stopped, only
 * `preventDefault()`ed — which the contenteditable host needs regardless.
 * An anchor with no extension and no finalise paints nothing and copies
 * nothing, so suppressing the DRAG is enough: `mousemove` and `mouseup` are
 * stopped, and only while we hold a press we reported.
 *
 * `installGhosttySelection` is gated on the same condition rather than by
 * propagation, so a double-click under a tracking app goes to the app
 * instead of selecting a word.
 *
 * `click` is deliberately untouched. `preventDefault()` on a mousedown does
 * not suppress the later `click`, so the pane's own
 * `onClick={() => surface.focus()}` and ghostty-web's link activation both
 * still fire.
 */
export function installGhosttyMouse(
  element: HTMLElement,
  host: GhosttyMouseHost,
): SurfaceDisposable {
  /**
   * Protocol buttons whose press we reported, so we report their release.
   * A set, not a slot: a second button pressed while the first is held
   * would otherwise overwrite it, and the first release would go missing.
   */
  const pressed = new Set<number>();
  let lastCell: { col: number; row: number } | null = null;

  const decide = (
    event: MouseEvent,
    type: MouseEventKind,
    cell: { col: number; row: number },
    wasReported = false,
  ): MouseOutcome | null => {
    const modes = host.modes();
    if (!modes) return null;
    return mouseOutcome({
      type,
      button: event.button,
      buttons: event.buttons,
      ...modes,
      col: cell.col,
      row: cell.row,
      cellChanged:
        lastCell === null ||
        lastCell.col !== cell.col ||
        lastCell.row !== cell.row,
      wasReported,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
    });
  };

  /**
   * `Terminal.open()` sets contenteditable="true" on this element, so the
   * default action of a mousedown here is WebKit caret placement and the
   * start of a text drag on a div whose only content is a canvas. The state
   * that leaves behind eats keystrokes until the surface is remounted — the
   * same trap `selection.ts` documents.
   */
  const onMouseDown = (event: MouseEvent) => {
    if (!isInside(element, event)) return;
    const cell = host.cellAt(event);
    if (!cell) return;
    const outcome = decide(event, "down", cell);
    if (!outcome || outcome.kind === "passthrough") return;
    event.preventDefault();
    host.focus();
    if (outcome.kind === "send") {
      host.send(outcome.seq);
      const button = protocolButton(event.button);
      if (button !== null) pressed.add(button);
      lastCell = cell;
    }
  };

  const onMouseMove = (event: MouseEvent) => {
    // Hover is ours only with nothing held: a button already down that we
    // did not report belongs to whoever claimed that press — the scrollbar
    // thumb, some future splitter — and its drag keeps its own stream even
    // while the pointer crosses the terminal.
    const dragging = pressed.size > 0;
    if (!dragging && !(event.buttons === 0 && isInside(element, event))) return;
    // A drag we own that wanders into the padding or over the scrollbar is
    // still ours: fall back to the last reported cell rather than handing
    // the move to the selection layer half way through.
    const cell = host.cellAt(event) ?? (dragging ? lastCell : null);
    if (!cell) return;
    const outcome = decide(event, "move", cell, dragging);
    if (!outcome || outcome.kind === "passthrough") return;
    event.preventDefault();
    // Only a drag we own may be taken away from the selection layer.
    if (dragging) event.stopImmediatePropagation();
    if (outcome.kind === "send") {
      host.send(outcome.seq);
      lastCell = cell;
    }
  };

  const onMouseUp = (event: MouseEvent) => {
    const button = protocolButton(event.button);
    // A press we passed through — right-click, shift-held, off-grid — must
    // have its release passed through too, or the app sees a release for a
    // press it never got.
    if (button === null || !pressed.delete(button)) return;
    // A release outside the grid still belongs to the app: report it
    // against the last cell the pointer was reported at.
    const cell = host.cellAt(event) ?? lastCell ?? { col: 0, row: 0 };
    const outcome = decide(event, "up", cell, true);
    if (!outcome || outcome.kind === "passthrough") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (outcome.kind === "send") host.send(outcome.seq);
  };

  window.addEventListener("mousedown", onMouseDown, { capture: true });
  window.addEventListener("mousemove", onMouseMove, { capture: true });
  window.addEventListener("mouseup", onMouseUp, { capture: true });
  return {
    dispose() {
      window.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("mousemove", onMouseMove, { capture: true });
      window.removeEventListener("mouseup", onMouseUp, { capture: true });
    },
  };
}

function isInside(element: HTMLElement, event: MouseEvent): boolean {
  const target = event.target;
  return target instanceof Node && element.contains(target);
}
