import { useSyncExternalStore } from "react";

/**
 * A shared clock for elapsed timers ("4m 12s"). One interval for the whole
 * app, running only while an enabled subscriber exists. getSnapshot must
 * return a stable value between ticks (useSyncExternalStore re-renders on
 * every change), so it always reads the module-level `now`.
 */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (timer === null) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

const noopSubscribe = () => () => {};
const getNow = () => now;

export function useNow(enabled = true): number {
  return useSyncExternalStore(enabled ? subscribe : noopSubscribe, getNow, getNow);
}
