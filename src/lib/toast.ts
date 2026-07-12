import { useSyncExternalStore } from "react";

export type ToastIntent = "error" | "info" | "success" | "warning";

/**
 * A toast's action button. Two variants:
 * - `url`     — opened in the user's browser via `openUrl` (existing).
 * - `onClick` — an in-app handler, e.g. router navigation (DDR-003 §5).
 *
 * `AppToaster` branches on `"url" in action` to pick the behavior.
 */
export type ToastAction =
  | {
      label: string;
      /** URL opened in the user's browser when the action is clicked. */
      url: string;
    }
  | {
      label: string;
      /** In-app handler invoked when the action is clicked. */
      onClick: () => void;
    };

export type AppToast = {
  id: string;
  title: string;
  message?: string;
  code?: string;
  intent: ToastIntent;
  action?: ToastAction;
};

type ToastInput = Omit<AppToast, "id"> & {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 7000;
const MAX_TOASTS = 4;

let toasts: AppToast[] = [];
const listeners = new Set<() => void>();

/**
 * Per-toast auto-dismiss timer. `persistent` toasts (errors, or any toast with
 * an action) are never scheduled — they wait for an explicit dismiss so the
 * action never vanishes mid-reach. Hover/focus pauses by banking `remaining`.
 */
type ToastTimer = {
  timeoutMs: number;
  remaining: number;
  startedAt: number;
  handle: number | null;
  persistent: boolean;
};

const timers = new Map<string, ToastTimer>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return toasts;
}

function createToastId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clearTimerHandle(timer: ToastTimer) {
  if (timer.handle != null) {
    window.clearTimeout(timer.handle);
    timer.handle = null;
  }
}

function startTimer(id: string) {
  const timer = timers.get(id);
  if (!timer || timer.persistent) return;
  clearTimerHandle(timer);
  timer.startedAt = Date.now();
  timer.handle = window.setTimeout(() => dismissToast(id), timer.remaining);
}

export function dismissToast(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearTimerHandle(timer);
    timers.delete(id);
  }
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/**
 * Pause a toast's auto-dismiss (pointer/focus entered). Banks the time already
 * elapsed into `remaining` so a subsequent resume finishes the countdown.
 */
export function pauseToast(id: string) {
  const timer = timers.get(id);
  if (!timer || timer.persistent || timer.handle == null) return;
  timer.remaining = Math.max(
    0,
    timer.remaining - (Date.now() - timer.startedAt),
  );
  clearTimerHandle(timer);
}

/** Resume a paused toast's auto-dismiss (pointer/focus left). */
export function resumeToast(id: string) {
  const timer = timers.get(id);
  if (!timer || timer.persistent || timer.handle != null) return;
  startTimer(id);
}

export function showToast(input: ToastInput) {
  const toast: AppToast = {
    id: createToastId(),
    title: input.title,
    intent: input.intent,
    ...(input.message ? { message: input.message } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.action ? { action: input.action } : {}),
  };

  const combined = [toast, ...toasts];
  toasts = combined.slice(0, MAX_TOASTS);
  // Drop timers for any toast pushed past the cap so they don't leak/fire.
  for (const dropped of combined.slice(MAX_TOASTS)) {
    const timer = timers.get(dropped.id);
    if (timer) {
      clearTimerHandle(timer);
      timers.delete(dropped.id);
    }
  }
  emit();

  // Never auto-dismiss errors or action toasts — they persist until dismissed.
  const persistent = input.intent === "error" || input.action != null;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  timers.set(toast.id, {
    timeoutMs,
    remaining: timeoutMs,
    startedAt: Date.now(),
    handle: null,
    persistent,
  });
  if (!persistent) startTimer(toast.id);

  return toast.id;
}

export function useToasts() {
  // Intentionally no unmount cleanup here: an earlier version wiped ALL toasts
  // whenever any consumer unmounted, nuking global state (K4). Timers are owned
  // per-toast and cleared on dismiss instead.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
