/**
 * The output a terminal keeps so its grid can be REBUILT instead of
 * reflowed.
 *
 * ghostty-web's `ghostty_terminal_resize` loses the anchor on every width
 * change — see ADR-002, "the reflow anchor". phasr's answer is to never
 * ask it to rewrap live content: when the width settles at a new value the
 * surface throws the whole grid away and re-parses the bytes that built it
 * into a fresh one (`backends/ghostty.ts`, `rebuildGrid`). This is where
 * those bytes are kept.
 *
 * **A tail, not a transcript.** The log is bounded, so a rebuild
 * reconstructs the most recent `budget` bytes of output and nothing older.
 * That is the one thing a user loses to this design, and it is the same
 * trade the LRU eviction path already makes (`cache.ts`) — there with a
 * 128 KB Rust-side buffer, here with a budget several times larger,
 * because a panel toggle is a far more casual act than a cache eviction.
 *
 * Chunks are retained by reference, never copied: every caller
 * (`decodePtyChunk`, and the surface's own grapheme-tail splitting) hands
 * over a freshly allocated array it does not keep.
 */
export type RetainedChunk = string | Uint8Array;

function sizeOf(chunk: RetainedChunk): number {
  // A string's UTF-16 length under-counts its UTF-8 bytes for non-ASCII.
  // This is a budget, not an invoice: the only consequence is retaining
  // slightly more of a CJK-heavy stream than the number suggests.
  return typeof chunk === "string" ? chunk.length : chunk.byteLength;
}

export class ReplayLog {
  private chunks: RetainedChunk[] = [];
  private bytes = 0;
  private nextSeq = 0;
  private firstSeq = 0;

  /** @param budget bytes to retain. See the class comment for the cost. */
  constructor(private readonly budget: number) {}

  /** Bytes currently retained. */
  get size(): number {
    return this.bytes;
  }

  /**
   * Sequence number of the chunk appended most recently. Monotonic for the
   * life of the terminal, never reused.
   *
   * It exists so a caller can remember WHERE in the stream something
   * happened and later ask whether that point is still inside the window —
   * see `hasRetained`. The surface uses it for the alternate screen: a
   * rebuild replaying a stream that no longer contains `\x1b[?1049h` would
   * paint a TUI's frames into the primary screen, on top of the user's
   * scrollback.
   */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Is that point in the stream still retained, in full? */
  hasRetained(seq: number): boolean {
    return seq >= this.firstSeq && seq < this.nextSeq;
  }

  /** Has anything been written to this terminal at all? */
  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  /**
   * Retain a chunk, evicting from the front until the budget holds.
   *
   * Eviction is by whole chunk, so the retained stream can begin part-way
   * through an escape sequence. The emulator resynchronizes within a few
   * bytes and the damage lands at the very top of reconstructed
   * scrollback — the oldest, least-looked-at line. Splitting cleanly would
   * need a VT parser on this side of the boundary, which is exactly what
   * phasr does not have and does not want.
   */
  append(chunk: RetainedChunk): void {
    if (sizeOf(chunk) === 0) return;
    this.chunks.push(chunk);
    this.nextSeq += 1;
    this.bytes += sizeOf(chunk);
    while (this.bytes > this.budget && this.chunks.length > 1) {
      this.bytes -= sizeOf(this.chunks.shift()!);
      this.firstSeq += 1;
    }
    // One chunk on its own can exceed the budget (a log replay, a
    // `yes`-sized burst). Keep its tail rather than letting a single write
    // pin unbounded memory.
    const only = this.chunks.length === 1 ? this.chunks[0] : undefined;
    if (only !== undefined && this.bytes > this.budget) {
      const tail =
        typeof only === "string"
          ? only.slice(only.length - this.budget)
          : only.subarray(only.length - this.budget);
      this.chunks[0] = tail;
      this.bytes = sizeOf(tail);
      // Its head is gone, so it no longer counts as retained. The bytes
      // stay — they are still the best reconstruction available — but a
      // caller asking "is my marker still in there" gets the honest no.
      this.firstSeq += 1;
    }
  }

  /** The retained stream, oldest chunk first. */
  read(): readonly RetainedChunk[] {
    return this.chunks;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.firstSeq = this.nextSeq;
  }
}
