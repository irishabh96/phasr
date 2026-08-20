import type { GhosttyCell } from "ghostty-web";
import {
  logicalLineRange,
  runAtColumn,
  type ColumnRange,
} from "@/lib/terminal/selection";
import type { SurfaceDisposable } from "@/lib/terminal/surface";

/**
 * Double-click-to-select-a-word and triple-click-to-select-a-line for the
 * ghostty backend.
 *
 * ## Why phasr owns this gesture instead of using ghostty-web's
 *
 * ghostty-web@0.4.0 does ship a `dblclick` handler, so "double-click is
 * missing" was not the problem. What it does is:
 *
 * ```js
 * const g = this.pixelToCell(B.offsetX, B.offsetY),      // VIEWPORT row
 *       E = this.getWordAtCell(g.col, g.row);
 * …
 * getWordAtCell(A, B) { const g = this.wasmTerm.getLine(B); … }
 * ```
 *
 * `wasmTerm.getLine(row)` indexes the **active screen**, but `g.row` is a
 * viewport row — and those are only the same thing while the terminal is
 * scrolled to the bottom. Scroll up into the scrollback and the word is
 * computed from whatever happens to be on the active screen at that row
 * index: normally the blank space below a shell prompt, where there is no
 * word, so **nothing is selected and nothing paints**. Reproduced in
 * `e2e/terminal-selection.spec.ts`: scrolled back, double-clicking a word
 * that is plainly on screen selected nothing at all.
 *
 * There is no triple-click of any kind in the bundle, and the public
 * `select()` / `selectLines()` had the same class of bug in the other
 * direction (`viewportY + row` instead of `scrollbackLength + row -
 * viewportY`), fixed in `patches/ghostty-web@0.4.0.patch` so the API this
 * file drives is correct.
 *
 * ## Shape of the fix
 *
 * Keyed off `mousedown`'s click count rather than the `dblclick` event —
 * one code path for both gestures, feedback on press, and no dependence on
 * a second event type being dispatched. Registered CAPTURE-phase on the
 * surface element, which is an ancestor of the canvas, so it runs before
 * ghostty-web's own canvas listeners; `stopPropagation()` then keeps
 * upstream's mousedown from resetting the selection we just made. The
 * upstream `dblclick` handler is swallowed the same way — otherwise it
 * would fire afterwards and overwrite a correct selection with its own.
 */

/** The slice of ghostty-web's WASM terminal this needs. */
export interface GhosttySelectionWasm {
  getDimensions(): { cols: number; rows: number };
  getScrollbackLength(): number;
  /** @param row row of the ACTIVE SCREEN, scrollback excluded. */
  getLine(row: number): GhosttyCell[] | null;
  /** @param offset 0 = oldest scrollback line. */
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  /** @param row active-screen row. True iff it soft-wraps into `row + 1`. */
  isRowWrapped(row: number): boolean;
}

/** The slice of ghostty-web's `Terminal` this needs. */
export interface GhosttySelectionTerminal {
  readonly wasmTerm?: GhosttySelectionWasm | undefined;
  readonly renderer?:
    | {
        readonly charWidth: number;
        readonly charHeight: number;
        getCanvas(): HTMLCanvasElement;
      }
    | undefined;
  /** Fractional while a smooth scroll is animating. */
  getViewportY(): number;
  select(column: number, row: number, length: number): void;
  selectLines(start: number, end: number): void;
  clearSelection(): void;
  getSelection(): string;
  focus(): void;
}

export interface GhosttySelectionOptions {
  /** Copy-on-select, to match what a drag already does. */
  copy: (text: string) => void;
}

/** 0-based cell in VIEWPORT coordinates. */
interface ViewportCell {
  col: number;
  row: number;
}

export function installGhosttySelection(
  element: HTMLElement,
  term: GhosttySelectionTerminal,
  { copy }: GhosttySelectionOptions,
): SurfaceDisposable {
  const onMouseDown = (event: MouseEvent) => {
    // Left button only, and only the 2nd click onwards: a plain click is
    // ghostty-web's own drag-select anchor and must reach it untouched.
    if (event.button !== 0 || event.detail < 2) return;
    const cell = cellAt(term, event);
    if (!cell) return;

    // preventDefault: `Terminal.open()` sets contenteditable="true" on this
    // element, so a double-click here is also a DOM word-selection (and the
    // start of a text drag) in WebKit. stopPropagation: ghostty-web's own
    // canvas mousedown would clear the selection this handler is about to
    // make, and leave `isSelecting` set so the following mouseup copies.
    event.preventDefault();
    event.stopPropagation();
    term.focus();

    const selected =
      event.detail === 2 ? selectWord(term, cell) : selectLogicalLine(term, cell);
    if (!selected) return;
    const text = term.getSelection();
    if (text) copy(text);
  };

  // Ours already ran on the 2nd mousedown; upstream's dblclick would
  // recompute the word from the wrong row and overwrite it.
  const swallowDblClick = (event: MouseEvent) => event.stopPropagation();

  element.addEventListener("mousedown", onMouseDown, { capture: true });
  element.addEventListener("dblclick", swallowDblClick, { capture: true });
  return {
    dispose() {
      element.removeEventListener("mousedown", onMouseDown, { capture: true });
      element.removeEventListener("dblclick", swallowDblClick, {
        capture: true,
      });
    },
  };
}

/**
 * Word (or whitespace run, or punctuation run) under the cell.
 *
 * @returns false when the row cannot be read at all — a one-character run
 *          still "succeeds" even though ghostty-web's `hasSelection()`
 *          reports a single cell as no selection (see the caveat below).
 */
function selectWord(
  term: GhosttySelectionTerminal,
  cell: ViewportCell,
): boolean {
  const chars = readViewportRow(term, cell.row);
  if (!chars) return false;
  const range = runAtColumn(chars, cell.col);
  if (!range) return false;
  applyRange(term, cell.row, range);
  return true;
}

/** The soft-wrapped logical line through the cell, clamped to the viewport. */
function selectLogicalLine(
  term: GhosttySelectionTerminal,
  cell: ViewportCell,
): boolean {
  const wasm = term.wasmTerm;
  if (!wasm) return false;
  const { rows } = wasm.getDimensions();
  const range = logicalLineRange(cell.row, 0, rows - 1, (row) =>
    wrapsIntoNext(term, row),
  );
  // Marks the outgoing selection's rows dirty; without it the previous
  // highlight stays painted when the new one does not cover the same rows
  // (nothing else in ghostty-web erases it — `requestRender()` is an empty
  // function and the render loop only repaints rows it thinks are dirty).
  term.clearSelection();
  term.selectLines(range.startRow, range.endRow);
  return true;
}

function applyRange(
  term: GhosttySelectionTerminal,
  row: number,
  range: ColumnRange,
): void {
  term.clearSelection();
  term.select(range.startCol, row, range.endCol - range.startCol + 1);
}

/**
 * Viewport row → absolute buffer row. The one mapping upstream got wrong:
 * an absolute row counts the scrollback first, so it is
 * `scrollbackLength + row - viewportY`, not `viewportY + row`.
 */
function absoluteRow(
  wasm: GhosttySelectionWasm,
  viewportY: number,
  row: number,
): number {
  return wasm.getScrollbackLength() + row - Math.max(0, Math.floor(viewportY));
}

/** One entry per column (`""` for an unwritten cell), or null. */
function readViewportRow(
  term: GhosttySelectionTerminal,
  row: number,
): string[] | null {
  const wasm = term.wasmTerm;
  if (!wasm) return null;
  const cells = readAbsoluteRow(wasm, absoluteRow(wasm, term.getViewportY(), row));
  if (!cells) return null;
  const { cols } = wasm.getDimensions();
  const chars: string[] = [];
  for (let col = 0; col < cols; col += 1) chars.push(cellChar(cells[col]));
  return chars;
}

function readAbsoluteRow(
  wasm: GhosttySelectionWasm,
  row: number,
): GhosttyCell[] | null {
  if (row < 0) return null;
  const scrollback = wasm.getScrollbackLength();
  return row < scrollback
    ? wasm.getScrollbackLine(row)
    : wasm.getLine(row - scrollback);
}

/** Mirrors ghostty-web's own cell → string: 0 is an unwritten cell. */
function cellChar(cell: GhosttyCell | undefined): string {
  const code = cell?.codepoint ?? 0;
  if (code <= 0 || code > 0x10ffff) return "";
  if (code >= 0xd800 && code <= 0xdfff) return "";
  return String.fromCodePoint(code);
}

/**
 * Does this viewport row soft-wrap into the next one?
 *
 * The engine only answers that for the ACTIVE SCREEN
 * (`ghostty_terminal_is_row_wrapped` takes an active-screen row and there
 * is no scrollback equivalent in the WASM exports, so
 * `buffer.active.getLine(row).isWrapped` is hardcoded to false for every
 * scrollback line). For scrollback we therefore infer it: a row whose last
 * column is written is one the terminal had to break. That is wrong only
 * for a hard-wrapped line that happens to be exactly `cols` long, which
 * over-selects by one row — strictly better than the alternative, which
 * silently copies a third of a long command.
 */
function wrapsIntoNext(term: GhosttySelectionTerminal, row: number): boolean {
  const wasm = term.wasmTerm;
  if (!wasm) return false;
  const absolute = absoluteRow(wasm, term.getViewportY(), row);
  const scrollback = wasm.getScrollbackLength();
  if (absolute >= scrollback) {
    try {
      return wasm.isRowWrapped(absolute - scrollback);
    } catch {
      return false;
    }
  }
  const cells = wasm.getScrollbackLine(absolute);
  if (!cells) return false;
  const { cols } = wasm.getDimensions();
  return cellChar(cells[cols - 1]).trim() !== "";
}

/** Pointer → viewport cell, or null when the point is off the grid. */
function cellAt(
  term: GhosttySelectionTerminal,
  event: MouseEvent,
): ViewportCell | null {
  const renderer = term.renderer;
  const wasm = term.wasmTerm;
  if (!renderer || !wasm) return null;
  const width = renderer.charWidth;
  const height = renderer.charHeight;
  if (width <= 0 || height <= 0) return null;
  const rect = renderer.getCanvas().getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  // Outside the canvas is the surface's own padding (or the overlay
  // scrollbar strip): not a cell, and not ours to handle.
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  const { cols, rows } = wasm.getDimensions();
  const col = Math.min(cols - 1, Math.floor(x / width));
  const row = Math.min(rows - 1, Math.floor(y / height));
  if (col < 0 || row < 0) return null;
  return { col, row };
}
