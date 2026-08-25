/**
 * Turn a terminal's CELLS back into bytes — the source a width change
 * rebuilds from.
 *
 * ## Why this exists
 *
 * A width change cannot reflow (ghostty-web's `ghostty_terminal_resize`
 * loses the anchor — ADR-002, fourth pass), so phasr rebuilds the grid at
 * the new width and re-feeds it. The question is *what* it re-feeds.
 *
 * Until now it re-fed **the raw PTY bytes**, retained in a 1 MiB ring. That
 * is wrong by construction, and a real terminal proves it in one line. zsh
 * emits this before every prompt (`PROMPT_EOL_MARK`, on by default):
 *
 * ```
 * ESC[1m ESC[7m % ESC[27m ESC[1m ESC[0m  <COLUMNS-1 spaces>  CR  SPACE  CR
 * ```
 *
 * At the width it was written for, the spaces fill the row exactly, the CR
 * comes back to column 0 of the *same* row, and the SPACE erases the `%`:
 * the whole sequence is invisible and costs nothing. Replay it into a
 * NARROWER grid and the spaces wrap, the CR lands on the row below, the
 * SPACE erases a blank instead — so a reverse-video `%` is left stranded at
 * column 0 and the content below it is one row lower. Once per prompt, for
 * every prompt still inside the window.
 *
 * That is the user's bug, measured: at 122 columns the buffer holds **zero**
 * rows that are just a `%`; rebuild the same terminal at 77 and it holds
 * **22**, with the prompt pushed nine rows down the screen. A reflow cannot
 * invent a cell — only a re-parse at the wrong width can.
 *
 * And `PROMPT_EOL_MARK` is only the specimen. Absolute cursor addressing
 * (`ESC[52;1H` from a TUI), width-computed padding, erases whose extent
 * depends on where the cursor wrapped — every one of them means the same
 * thing: **a byte stream is only true at the geometry it was written for.**
 * A four-day-old ring is full of geometries that no longer exist.
 *
 * ## What this does instead
 *
 * Reads the grid the user is actually looking at — text, colours,
 * attributes — and emits bytes that reproduce it at any width: literal
 * lines, SGR runs, and relative cursor motion. Nothing absolute, nothing
 * width-derived. The `%` cannot come back because it is not in the cells;
 * the live terminal erased it four days ago.
 *
 * ## What it is not
 *
 * Not a transcript. Attributes phasr's renderer cannot see are not in the
 * cells and so are not preserved: OSC 8 hyperlink targets (ghostty-web
 * 0.4.0's `getHyperlinkUri` returns `null`, so the URI is unreadable), and
 * the pen state a program left mid-run — the stream ends with `ESC[0m`, so
 * a program that had set a colour and not yet used it gets a clean pen.
 * Both were already lost the moment the bytes that carried them aged out of
 * the old ring, so neither is a new cost.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * One cell, already resolved by the reader: the grapheme it shows, and the
 * colours it shows it in. `null` means "the terminal's default", which is
 * what SGR 39 / 49 restore — keeping it distinct from an explicit colour
 * matters, because a default cell must follow a later theme change and an
 * explicitly-coloured one must not.
 */
export interface SnapshotCell {
  /** The grapheme cluster. Empty for the right half of a wide character. */
  text: string;
  fg: RGB | null;
  bg: RGB | null;
  /** ghostty-web's `CellFlags` bitfield. */
  flags: number;
}

export interface SnapshotRow {
  cells: readonly SnapshotCell[];
  /**
   * Does this row continue into the next one?
   *
   * True only where the engine can say so. `ghostty_terminal_is_row_wrapped`
   * takes an ACTIVE-SCREEN row and there is no scrollback equivalent in
   * 0.4.0 — `IBuffer.getLine` hardcodes `isWrapped = false` for every
   * history row — so the reader guesses for history. See `looksWrapped`.
   */
  wrapped: boolean;
}

export interface GridSnapshot {
  /** Oldest first. */
  history: readonly SnapshotRow[];
  /** The active screen, top row first. */
  screen: readonly SnapshotRow[];
  /** Cursor position on the active screen. */
  cursor: { x: number; y: number };
}

/**
 * The write sequence for a rebuild, split where the cursor has to be
 * remembered.
 *
 * It is a list rather than one string because **the terminal does the
 * wrapping arithmetic, not us**. After `segments[cursorAfter]` is written,
 * the emulator's cursor is standing exactly where the user's cursor
 * belongs; the caller records it, writes the rest, and walks back with a
 * relative move. Working the row out ourselves would mean re-deriving how
 * many rows each line wraps into — the same class of width arithmetic that
 * caused the bug this file exists to fix.
 */
export interface RebuildPlan {
  segments: readonly string[];
  /** Index in `segments` after which the cursor is where it must end up. */
  cursorAfter: number;
}

/** ghostty-web `CellFlags`, mirrored so this file needs no engine import. */
const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;
const INVERSE = 16;
const INVISIBLE = 32;
const BLINK = 64;
const FAINT = 128;

/** Flags that paint a cell even when it holds no character. */
const PAINTS_WHEN_BLANK = UNDERLINE | STRIKETHROUGH | INVERSE;

const SGR_RESET = "\x1b[0m";

function sameColor(a: RGB | null, b: RGB | null): boolean {
  if (a === null || b === null) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** Does this cell need any SGR at all, or is it plain default text? */
function isPlain(cell: SnapshotCell): boolean {
  return cell.fg === null && cell.bg === null && cell.flags === 0;
}

function sameStyle(a: SnapshotCell, b: SnapshotCell): boolean {
  return a.flags === b.flags && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg);
}

/**
 * The SGR that moves the pen from "reset" to this cell's style.
 *
 * Always written from reset rather than diffed against the previous run:
 * turning attributes *off* individually needs a second table (22/23/24/…)
 * and the only thing it would buy is a handful of bytes on a stream that is
 * written once and thrown away.
 */
export function sgrFor(cell: SnapshotCell): string {
  if (isPlain(cell)) return SGR_RESET;
  const p: (string | number)[] = [0];
  const f = cell.flags;
  if (f & BOLD) p.push(1);
  if (f & FAINT) p.push(2);
  if (f & ITALIC) p.push(3);
  if (f & UNDERLINE) p.push(4);
  if (f & BLINK) p.push(5);
  if (f & INVERSE) p.push(7);
  if (f & INVISIBLE) p.push(8);
  if (f & STRIKETHROUGH) p.push(9);
  // Truecolor, because that is what the cell holds: the engine resolves
  // palette indices to RGB on the way in and does not keep the index.
  if (cell.fg) p.push(`38;2;${cell.fg.r};${cell.fg.g};${cell.fg.b}`);
  if (cell.bg) p.push(`48;2;${cell.bg.r};${cell.bg.g};${cell.bg.b}`);
  return `\x1b[${p.join(";")}m`;
}

/** A cell that would look identical to an untouched one. */
function isBlank(cell: SnapshotCell): boolean {
  if (cell.text !== "" && cell.text !== " ") return false;
  if (cell.bg !== null) return false;
  return (cell.flags & PAINTS_WHEN_BLANK) === 0;
}

/**
 * Cells → bytes, as SGR runs.
 *
 * Trailing blanks are dropped: a row is `cols` cells wide whether or not
 * anything was written to it, and re-emitting 122 spaces per line would
 * turn every short line into a full-width one — which then *does* wrap at a
 * narrower width, reintroducing the drift from the other end.
 *
 * `trimTrailing: false` is for the run that ENDS AT THE CURSOR, where the
 * blanks are load-bearing: an indented prompt is spaces, and dropping them
 * would leave the cursor at column 0.
 */
export function serializeCells(
  cells: readonly SnapshotCell[],
  trimTrailing = true,
): string {
  let end = cells.length;
  if (trimTrailing)
    while (end > 0 && isBlank(cells[end - 1]!)) end -= 1;

  let out = "";
  let pen: SnapshotCell | null = null;
  for (let i = 0; i < end; i++) {
    const cell = cells[i]!;
    // The right half of a wide character: the character itself was emitted
    // by the cell before it and occupies both columns on its own.
    if (cell.text === "") continue;
    if (!pen || !sameStyle(pen, cell)) {
      out += sgrFor(cell);
      pen = cell;
    }
    out += cell.text;
  }
  if (pen && !isPlain(pen)) out += SGR_RESET;
  return out;
}


/**
 * Is this row the first half of a line that ran off the end?
 *
 * The guess forced for history rows (see `SnapshotRow.wrapped`): the last
 * column holds a printable, non-space character, which is the condition
 * under which a terminal has to wrap. The false positive — a line whose
 * printed width is exactly the terminal's, followed by an independent
 * line — is irreducible at this engine version; the damage is bounded and
 * pinned in terminal-reflow-anchor.spec.ts.
 */
export function looksWrapped(row: SnapshotRow, cols: number): boolean {
  if (row.cells.length < cols) return false;
  const last = row.cells[cols - 1];
  if (!last) return false;
  return last.text !== "" && last.text !== " ";
}

/**
 * Merge rows the engine (or the history heuristic) says are one line.
 *
 * `wrapped` is LEADING: it marks a row that CONTINUES the one above it.
 * The engine's JSDoc claims the other direction ("soft-wrapped to next
 * line") and is wrong — measured, not read: under trailing semantics a
 * 96-character line at 77 columns came back as `[head]` and
 * `[tail + next line's head]`, which is exactly the 19-character `#`
 * fragment the reflow spec caught at the top of the screen.
 */
export function joinWrapped(
  rows: readonly SnapshotRow[],
): readonly SnapshotCell[][] {
  const lines: SnapshotCell[][] = [];
  let current: SnapshotCell[] | null = null;
  for (const row of rows) {
    if (row.wrapped && current) {
      current.push(...row.cells);
    } else {
      if (current) lines.push(current);
      current = [...row.cells];
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Where the cursor's row is, counted in LOGICAL lines from the top of the
 * screen — which is what survives a width change, unlike its row index.
 */
function cursorLine(screen: readonly SnapshotRow[], cursorY: number): number {
  // LEADING semantics: a logical line starts at every row that is NOT a
  // continuation, so the cursor's line index is the count of starts at or
  // above it, minus one for its own.
  let line = -1;
  for (let r = 0; r <= cursorY && r < screen.length; r++)
    if (!screen[r]!.wrapped) line += 1;
  return Math.max(0, line);
}

/** The column the cursor sits at, counted along its whole logical line. */
function cursorColumn(
  screen: readonly SnapshotRow[],
  cursor: { x: number; y: number },
): number {
  // LEADING semantics: while the row the cursor sits on is itself a
  // continuation, the columns of every row above it on the same logical
  // line come first.
  let col = cursor.x;
  for (let r = cursor.y; r > 0 && screen[r]?.wrapped; r--)
    col += screen[r - 1]!.cells.length;
  return col;
}

/**
 * The bytes that rebuild a primary screen, and where in them the cursor is.
 *
 * The shape, and why:
 *
 * 1. **History**, one logical line per `\r\n`. It scrolls off the top of
 *    the new grid by itself; the emulator decides how many rows each line
 *    takes at the new width, which is the whole point.
 * 2. **Screen rows above the cursor's line**, the same way.
 * 3. **The cursor's line, up to the cursor** — and the plan marks this
 *    point, because it is the one position that has to survive.
 * 4. **The rest of the cursor's line**, so text to the right of the cursor
 *    (a command line the user has arrowed back into) is not thrown away.
 * 5. **Lines below the cursor**, if any. A shell has none; a full-screen
 *    program on the PRIMARY screen has plenty.
 * 6. **Blank rows, as newlines.** The screen is `rows` tall whether or not
 *    anything was written to the bottom of it, and those blanks are why a
 *    freshly-cleared terminal shows its prompt at the TOP. Emitting them as
 *    real line feeds scrolls the content up by exactly as much as it was
 *    scrolled before, and the caller then walks the cursor back up.
 */
export function planPrimary(snapshot: GridSnapshot): RebuildPlan {
  const { history, screen, cursor } = snapshot;

  // The last screen ROW that holds anything, or the cursor's, whichever is
  // lower. Everything under it is blank, and blank rows are counted, not
  // written — see step 6.
  let lastUsedRow = Math.min(cursor.y, screen.length - 1);
  for (let r = screen.length - 1; r > lastUsedRow; r--)
    if (screen[r]!.cells.some((cell) => !isBlank(cell))) {
      lastUsedRow = r;
      break;
    }
  const used = screen.slice(0, lastUsedRow + 1);

  const historyLines = joinWrapped(history);
  const screenLines = joinWrapped(used);

  const cy = cursorLine(used, cursor.y);
  const cx = cursorColumn(used, cursor);

  const before: string[] = [];
  for (const line of historyLines) before.push(serializeCells(line));
  for (let i = 0; i < cy && i < screenLines.length; i++)
    before.push(serializeCells(screenLines[i]!));

  const cursorCells = screenLines[cy] ?? [];
  const head = serializeCells(cursorCells.slice(0, cx), false);
  const rest = serializeCells(cursorCells.slice(cx));

  const below: string[] = [];
  for (let i = cy + 1; i < screenLines.length; i++)
    below.push(serializeCells(screenLines[i]!));

  const segments = [
    before.length ? before.join("\r\n") + "\r\n" : "",
    head,
    rest,
    below.length ? "\r\n" + below.join("\r\n") : "",
    // The blank rows under the content, as line feeds. On a screen that was
    // just cleared this is nearly the whole terminal, and it is the ONLY
    // reason the prompt sits at the top of it rather than the bottom.
    "\n".repeat(Math.max(0, screen.length - 1 - lastUsedRow)),
  ];
  return { segments, cursorAfter: 1 };
}

/**
 * The alternate screen, as a rectangle.
 *
 * Deliberately NOT the treatment the primary screen gets. The alternate
 * screen has no history and is not a stream of lines — it is one frame,
 * owned by a program that repaints it in full on every SIGWINCH, which a
 * rebuild always sends. So each row is CLIPPED to the new width rather than
 * wrapped: the frame keeps its shape (row 9 stays row 9) instead of
 * cascading downwards the moment one row is too long, and the program's own
 * redraw replaces it a frame later.
 */
export function serializeAlternate(
  rows: readonly SnapshotRow[],
  cols: number,
): string {
  const lines = rows.map((row) => serializeCellsClipped(row.cells, cols));
  return lines.join("\r\n");
}

function serializeCellsClipped(
  cells: readonly SnapshotCell[],
  cols: number,
): string {
  // One cell is one column, wide characters included — their second column
  // is a cell of its own that emits nothing. So the clip is a slice, with
  // one correction: a wide character split by the clip would be re-emitted
  // whole and wrap the row it was supposed to be trimmed out of.
  const kept = cells.slice(0, cols);
  if (kept.length === cols && cells[cols]?.text === "") kept.pop();
  return serializeCells(kept);
}

/**
 * Walk the cursor back to a row it was on `up` rows ago, at column `col`.
 *
 * Relative motion only — CUU, CR, CUF. An absolute `ESC[r;cH` would be
 * correct here too (we would be computing it against the grid we just
 * built, not replaying one somebody else computed years ago) but there is
 * no reason to introduce the form at all.
 */
export function restoreCursorSequence(up: number, col: number): string {
  let out = "";
  if (up > 0) out += `\x1b[${up}A`;
  out += "\r";
  if (col > 0) out += `\x1b[${col}C`;
  return out;
}
