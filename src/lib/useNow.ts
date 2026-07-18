import { useSyncExternalStore } from "react";

/**
 * A single shared 1 Hz clock for the cosmetic "Ns ago" counters. All mounted
 * status indicators subscribe to ONE module-level `setInterval`, and only they
 * re-render on a tick — never the whole tree (spec: "do NOT re-render the whole
 * tree — scope it").
 *
 * The interval only runs while there is ≥1 *active* subscriber, so a tree with
 * no live counters (an app showing only finished/idle-forever agents) never
 * ticks. Pass `active = false` from a component whose state has no live counter
 * (e.g. `resolving`, or a long-finished terminal state) to opt it out.
 */
const TICK_MS = 1000;

let now = Date.now();
const listeners = new Set<() => void>();
let handle: ReturnType<typeof setInterval> | null = null;

function start() {
  if (handle != null) return;
  handle = setInterval(() => {
    now = Date.now();
    for (const listener of listeners) listener();
  }, TICK_MS);
}

function stop() {
  if (handle != null) {
    clearInterval(handle);
    handle = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const noopSubscribe = () => () => {};

function getSnapshot() {
  return now;
}

/**
 * Returns `Date.now()` advancing once a second while `active`. When inactive,
 * the component doesn't subscribe (no timer-driven re-renders) and simply reads
 * the shared clock's current value on its own renders.
 */
export function useNow(active = true): number {
  return useSyncExternalStore(
    active ? subscribe : noopSubscribe,
    getSnapshot,
    getSnapshot,
  );
}
