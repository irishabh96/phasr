import { useSyncExternalStore } from "react";

/**
 * Settings › Agents & keys "Suggest replies" (default on). Local to this
 * machine like the other frontend-only preferences: the backend never
 * needs it, because it's what decides whether `suggest_replies` (the only
 * thing that spends a Haiku call) is called at all.
 */
const PREF_KEY = "phasr.suggestReplies";
const PREF_EVENT = "phasr:suggest-replies-changed";

export function readSuggestReplies(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSuggestReplies(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(PREF_EVENT));
}

function subscribe(listener: () => void) {
  window.addEventListener(PREF_EVENT, listener);
  // Another window of the app changed it.
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(PREF_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useSuggestReplies(): boolean {
  return useSyncExternalStore(subscribe, readSuggestReplies, () => true);
}
