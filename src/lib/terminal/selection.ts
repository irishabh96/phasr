/**
 * Backend-neutral selection geometry: what a double-click and a
 * triple-click select. Pure functions over a row of characters and a
 * "does this row wrap into the next one" predicate — no emulator, no DOM,
 * so the rules are unit-testable and survive an engine swap the same way
 * `keymap.ts` and `links.ts` do.
 *
 * The engine-facing half (reading cells, mapping a click to a cell,
 * installing the listeners) lives in `backends/ghostty/selection.ts`.
 */

/**
 * Extra characters that count as part of a word, on top of letters and
 * digits.
 *
 * This is **iTerm2's documented default** for
 * `charactersConsideredPartOfAWordForSelection` (`/-+\~_.`), chosen over
 * inventing our own set: it is the behaviour the user asked to be
 * "similar to iTerm", and it is the difference between double-clicking
 * `src/lib/terminal/options.ts` and getting the whole path versus getting
 * `lib`. ghostty-web's own rule is `/[\w-]/`, i.e. a path fragments into
 * five separate double-clicks.
 *
 * Note what it deliberately does NOT include: `:` and `?`, so
 * double-clicking a URL stops at the scheme (`//example.com/a` rather than
 * the whole thing) — same as iTerm. Whole-URL selection is what ⌘-click on
 * a link is for, and phasr already has that.
 */
const WORD_PUNCTUATION = "/-+\\~_.";

export type CharClass = "word" | "space" | "other";

/**
 * Three classes, and a selection is the maximal run of ONE of them. The
 * "other" class is what makes a double-click always do something visible:
 * ghostty-web returned null for any non-word cell, so double-clicking a
 * space, a box-drawing character or a `:` did nothing at all — which is
 * indistinguishable from "double-click is broken".
 */
export function classifyChar(char: string): CharClass {
  // An unwritten cell reads as "" — treat it as whitespace so a
  // double-click past the end of a line selects the blank run.
  if (char === "" || /^\s$/u.test(char)) return "space";
  if (/^[\p{L}\p{N}]$/u.test(char) || WORD_PUNCTUATION.includes(char))
    return "word";
  return "other";
}

/** Inclusive column range — `[startCol, endCol]`, both 0-based. */
export interface ColumnRange {
  startCol: number;
  endCol: number;
}

/**
 * The run of same-class characters containing `col`.
 *
 * @param row one entry per COLUMN (`""` for an unwritten cell), so a
 *        double-wide glyph's trailing spacer reads as blank.
 * @returns `null` only when `col` is outside the row.
 */
export function runAtColumn(
  row: readonly string[],
  col: number,
): ColumnRange | null {
  if (col < 0 || col >= row.length) return null;
  const target = classifyChar(row[col] ?? "");
  let startCol = col;
  while (startCol > 0 && classifyChar(row[startCol - 1] ?? "") === target)
    startCol -= 1;
  let endCol = col;
  while (
    endCol < row.length - 1 &&
    classifyChar(row[endCol + 1] ?? "") === target
  )
    endCol += 1;
  return { startCol, endCol };
}

/** Inclusive row range — both bounds in whatever space the caller used. */
export interface RowRange {
  startRow: number;
  endRow: number;
}

/**
 * The LOGICAL line containing `row`: the run of rows joined by soft wraps.
 *
 * A terminal's buffer row is not a line — a command longer than the window
 * occupies several rows and triple-clicking any of them should select all
 * of it. `wrapsIntoNext(row)` answers "does row soft-wrap into row + 1".
 *
 * Bounded by `first`/`last` (the caller passes the visible viewport), so a
 * screen of full-width rows cannot walk the whole scrollback and a
 * selection can never be larger than what the user can see.
 */
export function logicalLineRange(
  row: number,
  first: number,
  last: number,
  wrapsIntoNext: (row: number) => boolean,
): RowRange {
  let startRow = Math.max(first, Math.min(row, last));
  let endRow = startRow;
  while (startRow > first && wrapsIntoNext(startRow - 1)) startRow -= 1;
  while (endRow < last && wrapsIntoNext(endRow)) endRow += 1;
  return { startRow, endRow };
}
