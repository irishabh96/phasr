import { useEffect, useSyncExternalStore } from "react";

export type ToastIntent = "error" | "info" | "success";

export type AppToast = {
  id: string;
  title: string;
  message?: string;
  code?: string;
  intent: ToastIntent;
};

type ToastInput = Omit<AppToast, "id"> & {
  timeoutMs?: number;
};

let toasts: AppToast[] = [];
const listeners = new Set<() => void>();

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

export function dismissToast(id: string) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function showToast(input: ToastInput) {
  const toast: AppToast = {
    id: createToastId(),
    title: input.title,
    intent: input.intent,
    ...(input.message ? { message: input.message } : {}),
    ...(input.code ? { code: input.code } : {}),
  };

  toasts = [toast, ...toasts].slice(0, 4);
  emit();

  window.setTimeout(() => dismissToast(toast.id), input.timeoutMs ?? 7000);
  return toast.id;
}

export function useToasts() {
  const activeToasts = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    return () => {
      toasts = [];
      emit();
    };
  }, []);

  return activeToasts;
}
