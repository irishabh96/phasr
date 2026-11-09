/**
 * Coalesce a stream of keyed events into at most one flush per interval.
 *
 * Agent events arrive at whatever rate the agent works: a tool-heavy turn
 * emits `phasr://task-agent-state` for every tool call, and each event used
 * to be its own `setQueryData`, i.e. its own cache notification and its own
 * React render of every subscriber. The design's budget is "agent stream →
 * store at ≤ 30 Hz" (specs/ui-mission-control-polish-spec.md §6.2, P4).
 *
 * Throttle, not debounce: the first event of a quiet period is applied on
 * the next macrotask (no added latency worth the name), and a sustained
 * burst flushes once per `intervalMs` (so the UI keeps moving during it
 * rather than freezing until the burst ends). Within one window the LAST
 * value per key wins — every event this is used for carries a full
 * snapshot, so an intermediate value nobody saw is safe to drop.
 *
 * Timers, not `requestAnimationFrame`: rAF stops in a hidden window, and the
 * query cache must keep up while the app is in the background (the board a
 * user comes back to, the needs-you count). A flush is a cache patch, not a
 * paint, so it does not need a frame. And timers only — no clock reads — so
 * a wall-clock jump cannot stall or double a flush.
 */

/** ~30 Hz. */
export const AGENT_EVENT_INTERVAL_MS = 33;

export interface KeyedCoalescer<T> {
  /** Queue `value` under `key`, replacing anything queued for it. */
  push(key: string, value: T): void;
  /** Apply whatever is queued now (no-op when empty). */
  flush(): void;
  /** Drop anything queued and cancel every pending timer. */
  dispose(): void;
}

/**
 * @param onFlush receives every key queued since the last flush, in the
 *   order each key was FIRST queued, with its latest value.
 */
export function createKeyedCoalescer<T>(
  onFlush: (batch: Map<string, T>) => void,
  intervalMs = AGENT_EVENT_INTERVAL_MS,
): KeyedCoalescer<T> {
  let pending = new Map<string, T>();
  /** The next-tick flush that opens a quiet period. */
  let leading: ReturnType<typeof setTimeout> | null = null;
  /** Running while a flush happened less than `intervalMs` ago. */
  let cooldown: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const coolDown = () => {
    cooldown = setTimeout(() => {
      cooldown = null;
      // Whatever arrived during the window goes now, and opens the next.
      if (pending.size > 0) flush();
    }, intervalMs);
  };

  const flush = () => {
    if (leading !== null) {
      clearTimeout(leading);
      leading = null;
    }
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    if (cooldown !== null) clearTimeout(cooldown);
    coolDown();
    onFlush(batch);
  };

  return {
    push(key, value) {
      if (disposed) return;
      pending.set(key, value);
      // Inside a window the cooldown's end flushes; otherwise the next tick.
      if (cooldown !== null || leading !== null) return;
      leading = setTimeout(flush, 0);
    },
    flush,
    dispose() {
      disposed = true;
      if (leading !== null) clearTimeout(leading);
      if (cooldown !== null) clearTimeout(cooldown);
      leading = cooldown = null;
      pending = new Map();
    },
  };
}
