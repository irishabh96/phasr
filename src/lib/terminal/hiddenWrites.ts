/**
 * A5 — hidden sessions yield WASM compute, not just IPC
 * (perf phase 4, criterion 9).
 *
 * phasr's normal state is many hidden agent sessions streaming behind the
 * one on screen. The Rust half of criterion 8/9 already widens a hidden
 * PTY's flush window to ~50 ms — fewer, larger events — but every event
 * that does arrive was still parsed SYNCHRONOUSLY in the engine's WASM on
 * the main thread, right in the middle of whatever frame the visible
 * terminal was trying to paint. iTerm2 deprioritizes background sessions
 * in token execution for exactly this reason: a busy hidden session stops
 * mid-batch when a visible one has pending tokens.
 *
 * This queue is the JS half. A parked surface's chunks are enqueued
 * instead of parsed, and drained in slices bounded by `BUDGET_MS` of
 * actual parse time, one slice per macrotask — so between any two slices
 * the visible terminal's rAF (and everything else) gets the thread back.
 * ~4 ms is the same per-tick budget the architect set for F4's scrollback
 * scans: small enough to never cost a visible frame its 16.7 ms, large
 * enough to parse several coalesced 32 KiB chunks per slice.
 *
 * What it deliberately does NOT change:
 *
 *  - **Byte order and byte completeness.** Chunks leave in arrival order,
 *    through the same write path (grapheme tail included). P3's zero-drop
 *    guarantee is untouched — bytes wait, they never die.
 *  - **What "hidden" means.** The caller flushes synchronously before the
 *    surface becomes visible again (`setActive(true)`), so a revealed
 *    terminal is always current before it paints.
 *  - **Memory bounds.** A queue that outgrows `MAX_QUEUED_BYTES` is
 *    drained inline until it fits — under a genuinely unbounded hidden
 *    flood the behaviour degrades toward the old synchronous parse
 *    instead of holding an unbounded backlog. The cap is far above what
 *    the widened 50 ms flush window delivers between slices in practice.
 */

/** Parse-time budget per slice, in ms of wall clock actually spent. */
export const HIDDEN_PARSE_BUDGET_MS = 4;

/**
 * Queue bytes past which the drain stops yielding and parses inline.
 * 8 MiB ≈ a few seconds of a very busy hidden TUI — far past anything the
 * 50 ms flush window accumulates between two macrotasks on a live main
 * thread, so hitting it means the thread is saturated anyway.
 */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export interface HiddenWriteQueueHooks {
  /** Parse one chunk for real — the surface's live write path. */
  write(data: string | Uint8Array): void;
  /** Schedule `drain()` for a later macrotask. Injectable for tests. */
  schedule(drain: () => void): void;
  now(): number;
}

export class HiddenWriteQueue {
  private readonly queue: (string | Uint8Array)[] = [];
  private queuedBytes = 0;
  private scheduled = false;

  constructor(private readonly hooks: HiddenWriteQueueHooks) {}

  get bytes(): number {
    return this.queuedBytes;
  }

  get length(): number {
    return this.queue.length;
  }

  /**
   * Accept a chunk for a hidden surface. Never parses the chunk it was
   * handed — even over the cap, what runs inline is the drain of OLDER
   * chunks, so order is preserved by construction.
   */
  enqueue(data: string | Uint8Array): void {
    this.queue.push(data);
    this.queuedBytes += data.length;
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      // Saturated: shed the backlog inline (no budget) until back under
      // the cap. Deliberately not a full flush — one over-cap chunk must
      // not force parsing megabytes in one go.
      while (this.queuedBytes > MAX_QUEUED_BYTES && this.queue.length > 0) {
        this.writeOne();
      }
    }
    this.scheduleDrain();
  }

  /** Parse everything, now. The reveal path — and any grid read. */
  flush(): void {
    while (this.queue.length > 0) this.writeOne();
  }

  /** Drop everything unparsed. The dispose path. */
  clear(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  /** One budget-bounded slice; re-schedules itself while work remains. */
  private drain = (): void => {
    this.scheduled = false;
    const start = this.hooks.now();
    while (this.queue.length > 0) {
      this.writeOne();
      if (this.hooks.now() - start >= HIDDEN_PARSE_BUDGET_MS) break;
    }
    this.scheduleDrain();
  };

  private writeOne(): void {
    const data = this.queue.shift();
    if (data === undefined) return;
    this.queuedBytes -= data.length;
    this.hooks.write(data);
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    this.hooks.schedule(this.drain);
  }
}
