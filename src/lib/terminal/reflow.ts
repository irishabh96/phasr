/**
 * What a terminal does when its container changes size — the policy half
 * of the fix for ADR-002's "reflow anchor", kept pure so it can be argued
 * with in a unit test instead of in a browser.
 *
 * The defect: ghostty-web's `ghostty_terminal_resize` takes `(handle,
 * cols, rows)` and no anchor, and every width round trip permanently
 * converts trailing blank rows below the cursor into leading history rows
 * above it. Content marches down the screen a row or two per panel toggle
 * and never comes back up.
 *
 * The policy: **never rewrap live content.** A row-only change is safe and
 * is applied immediately; a column change is applied by rebuilding the
 * grid at the new width and replaying the retained output into it, so the
 * buggy path is never entered with anything in the buffer.
 */

export interface Grid {
  cols: number;
  rows: number;
}

export type ResizePlan =
  /** The grid already matches the container. */
  | "none"
  /**
   * Rows changed, columns did not — nothing rewraps, so nothing can drift.
   * Measured in ADR-002: a rows-only round trip leaves `scrollback`
   * untouched. Applied immediately, which keeps a tab reveal and a
   * vertical-only window resize as snappy as they were.
   */
  | "resize"
  /**
   * The width changed. Rewrapping is the trigger, so the grid is thrown
   * away and rebuilt at the new width instead.
   */
  | "rebuild";

export function planResize(current: Grid, target: Grid): ResizePlan {
  if (target.cols === current.cols) {
    return target.rows === current.rows ? "none" : "resize";
  }
  return "rebuild";
}

/** DECSET 1049 — the alternate screen buffer. Named because the rebuild
 *  path has to reason about it on its own, not merely repair it: a replay
 *  that no longer contains the sequence which entered it has to be told
 *  which screen it belongs to. */
export const ALT_SCREEN_MODE = 1049;

/**
 * DEC private modes that must survive a rebuild.
 *
 * A rebuilt grid is a *fresh* terminal: it has forgotten every mode the
 * running program switched on. Most of them are re-established by the
 * replay — the bytes that set them are in the retained stream — but only
 * while those bytes are still inside the budget. A TUI sets its modes once
 * at startup and then runs for hours, so on any long-lived terminal they
 * are the FIRST thing to fall out of the window, and losing them is not
 * cosmetic: bracketed paste stops bracketing, the wheel stops reporting,
 * arrow keys start sending the wrong sequence, and the alternate screen
 * silently becomes the primary one.
 *
 * So the modes are read off the old grid and re-asserted on the new one
 * whenever they disagree, which makes the replay's own mode bytes a
 * bonus rather than a requirement.
 *
 * 1049 leads the list because entering the alternate screen CLEARS it: any
 * repair that followed a screen switch would be applied to a screen the
 * user is not looking at. When the replay has already put the terminal in
 * the right screen — the common case, and the one that reconstructs the
 * primary screen's scrollback underneath as well — 1049 matches and
 * nothing is emitted.
 */
export const RETAINED_DEC_MODES: readonly number[] = [
  ALT_SCREEN_MODE, // alternate screen buffer (+ save/restore cursor)
  1, // DECCKM — application cursor keys
  7, // DECAWM — autowrap
  9, // X10 mouse reporting
  12, // att610 — cursor blink
  25, // DECTCEM — cursor visibility
  1000, // mouse: button events
  1002, // mouse: button + drag
  1003, // mouse: any motion
  1004, // focus in/out reporting
  1005, // UTF-8 mouse encoding
  1006, // SGR mouse encoding
  1015, // urxvt mouse encoding
  1016, // SGR pixel mouse encoding
  2004, // bracketed paste
];

export function decModeSequence(mode: number, on: boolean): string {
  return `\x1b[?${mode}${on ? "h" : "l"}`;
}

/**
 * The sequence that moves a freshly rebuilt grid from `actual` to
 * `wanted`, in `RETAINED_DEC_MODES` order. Empty when they already agree,
 * which is what the common case should produce.
 */
export function modeRepairSequence(
  wanted: ReadonlyMap<number, boolean>,
  actual: ReadonlyMap<number, boolean>,
): string {
  let out = "";
  for (const mode of RETAINED_DEC_MODES) {
    if (!wanted.has(mode)) continue;
    const want = wanted.get(mode)!;
    if (actual.get(mode) === want) continue;
    out += decModeSequence(mode, want);
  }
  return out;
}
