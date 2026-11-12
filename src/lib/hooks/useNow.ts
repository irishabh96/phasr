import { useSyncExternalStore } from "react";

/**
 * Shared clocks for relative times. `useNow(true)` ticks every second (live
 * timers: "4m 12s"); `useNow(false)` ticks every minute ("18m ago",
 * "finished 1h ago") — coarse, but never frozen. One interval per cadence
 * for the whole app, running only while something subscribes.
 *
 * getSnapshot must be stable between ticks (useSyncExternalStore re-renders
 * on every change), so each clock reads its own module-level value.
 */
function makeClock(intervalMs: number) {
  let now = Date.now();
  const listeners = new Set<() => void>();
  let timer: number | null = null;
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      if (timer === null) {
        now = Date.now();
        timer = window.setInterval(() => {
          now = Date.now();
          for (const l of listeners) l();
        }, intervalMs);
      }
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      };
    },
    get: () => now,
  };
}

const seconds = makeClock(1000);
const minutes = makeClock(60_000);

export function useNow(live = true): number {
  const clock = live ? seconds : minutes;
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}
