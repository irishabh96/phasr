/**
 * Hold back the trailing bytes of a PTY chunk that a following chunk could
 * still extend.
 *
 * The render loop is `requestAnimationFrame`-driven and independent of
 * `write()`, so whatever is in the grid when a frame fires gets painted. That
 * is fine for a half-parsed escape sequence — the parser is a state machine
 * and simply has not produced a cell yet — but it is NOT fine for a grapheme
 * cluster, because the base codepoint IS a complete, paintable cell on its
 * own and only becomes something else when the rest of the cluster lands.
 *
 * `☁` (U+2601) followed by VARIATION SELECTOR-16 (U+FE0F) is the case that
 * bites: alone it is a small monochrome dingbat painted in the cell's
 * foreground; with the selector it is a two-cell colour emoji. A chunk
 * boundary between them therefore paints the wrong glyph and corrects it a
 * frame later — a visible flicker on every prompt that carries an emoji.
 *
 * Widening the Rust coalescer would fix it too, but that adds latency to
 * every keystroke echo. This holds back only the bytes that are actually
 * ambiguous: an incomplete UTF-8 sequence, a trailing ZERO WIDTH JOINER, or
 * a trailing codepoint that a variation selector is allowed to follow. ASCII
 * — which is all of a keystroke echo and most of a TUI frame — is never
 * held, so the fast path is untouched.
 */

/** ZERO WIDTH JOINER — an emoji ZWJ sequence continues past it. */
const ZWJ = 0x200d;

/**
 * Codepoints a VARIATION SELECTOR (U+FE0E/U+FE0F) may follow — Unicode's
 * `Emoji=Yes` set, as ranges rather than a shipped table.
 *
 * Deliberately tight where a terminal is concerned. Box drawing
 * (U+2500–U+257F), block elements (U+2580–U+259F) and Braille
 * (U+2800–U+28FF) are the glyphs a TUI frame is *made of*; they are not
 * emoji and must never be held, or every frame gains a tail of latency.
 */
function takesVariationSelector(cp: number): boolean {
  if (cp === 0x00a9 || cp === 0x00ae) return true; // © ®
  if (cp >= 0x203c && cp <= 0x2049) return true; // ‼ ⁉
  if (cp >= 0x2122 && cp <= 0x2139) return true; // ™ ℹ
  if (cp >= 0x2194 && cp <= 0x21aa) return true; // arrows
  if (cp >= 0x231a && cp <= 0x23fa) return true; // watch, media controls
  if (cp === 0x24c2) return true; // Ⓜ
  if (cp >= 0x25aa && cp <= 0x25fe) return true; // geometric (NOT box drawing)
  if (cp >= 0x2600 && cp <= 0x27bf) return true; // misc symbols + dingbats (☁)
  if (cp >= 0x2934 && cp <= 0x2935) return true;
  if (cp >= 0x2b05 && cp <= 0x2b55) return true;
  if (cp === 0x3030 || cp === 0x303d) return true;
  if (cp === 0x3297 || cp === 0x3299) return true;
  return cp >= 0x1f000 && cp <= 0x1faff; // emoji planes
}

/** Length of the UTF-8 sequence a lead byte introduces, or 0 if not a lead. */
function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

/** Decode the UTF-8 sequence starting at `start`, or null if malformed. */
function codepointAt(bytes: Uint8Array, start: number, length: number): number | null {
  if (length === 1) return bytes[start]!;
  let cp = bytes[start]! & (0xff >> (length + 1));
  for (let i = 1; i < length; i += 1) {
    const b = bytes[start + i];
    if (b === undefined || !isContinuation(b)) return null;
    cp = (cp << 6) | (b & 0x3f);
  }
  return cp;
}

/**
 * Index at which `bytes` should be cut so that everything before it is safe
 * to write immediately. Returns `bytes.length` when nothing needs holding.
 */
export function safeWriteEnd(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n === 0) return 0;

  // Walk back to the last lead byte — at most 3 continuation bytes.
  let start = n - 1;
  let steps = 0;
  while (start > 0 && isContinuation(bytes[start]!) && steps < 3) {
    start -= 1;
    steps += 1;
  }
  const lead = bytes[start]!;
  const need = sequenceLength(lead);

  // Not a valid lead byte: nothing useful to hold, let the engine deal.
  if (need === 0) return n;

  // The final sequence is truncated — hold it until its rest arrives.
  if (start + need > n) return start;

  // ASCII can never be extended by a selector or a joiner. This is the hot
  // path (keystroke echo, TUI frames) and must not allocate or hold.
  if (need === 1) return n;

  const cp = codepointAt(bytes, start, need);
  if (cp === null) return n;
  if (cp === ZWJ || takesVariationSelector(cp)) return start;
  return n;
}
