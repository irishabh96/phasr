import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { FN_KEY_EVENT } from "@/lib/events";
import type { DictationPhase } from "./useDictation";
import { readVoicePrefs } from "./prefs";

/**
 * Hold fn (🌐) to dictate into the box you're in; let go to insert the
 * text. The backend reports fn going down and up (it never reaches the
 * webview as a key); this decides which dictation box it's for.
 */

/** Held this long before the mic opens: a tap, or fn+← (Home), isn't a request to talk. */
export const HOLD_MS = 200;

/** A box that can take dictation (registered by `useDictation`). */
export interface HoldTarget {
  textarea: () => HTMLTextAreaElement | null;
  disabled: () => boolean;
  phase: () => DictationPhase;
  start: () => void;
  /** fn let go: insert what was said (or drop it if the mic hadn't opened yet). */
  release: () => void;
}

const targets = new Set<HoldTarget>();
let lastFocused: HoldTarget | null = null;
let focusListening = false;

function onFocusIn(e: FocusEvent) {
  for (const t of targets) if (t.textarea() === e.target) lastFocused = t;
}

export function registerHoldTarget(t: HoldTarget): () => void {
  targets.add(t);
  if (!focusListening && typeof document !== "undefined") {
    document.addEventListener("focusin", onFocusIn, true);
    focusListening = true;
  }
  return () => {
    targets.delete(t);
    if (lastFocused === t) lastFocused = null;
  };
}

/** On screen, and not behind a modal (Radix hides everything else from assistive tech). */
function usable(t: HoldTarget): boolean {
  const el = t.textarea();
  if (!el || !el.isConnected || t.disabled()) return false;
  if (el.closest('[aria-hidden="true"], [inert]')) return false;
  if (el.getClientRects().length === 0) return false;
  const check = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return check ? check.call(el, { visibilityProperty: true, opacityProperty: true }) : true;
}

/**
 * The box fn talks into: the focused one, else one in an open dialog (New
 * task), else the one you were last in, else any on screen.
 */
export function pickHoldTarget(): HoldTarget | null {
  const ok = [...targets].filter(usable);
  const focused = typeof document !== "undefined" ? document.activeElement : null;
  return (
    ok.find((t) => t.textarea() === focused) ??
    ok.find((t) => t.textarea()?.closest('[role="dialog"]')) ??
    (lastFocused && ok.includes(lastFocused) ? lastFocused : null) ??
    ok[ok.length - 1] ??
    null
  );
}

/** For tests. */
export function resetHoldTargets() {
  targets.clear();
  lastFocused = null;
}

/** fn events → dictation. Mounted once (useAppEvents). */
export function useFnHoldDictation() {
  useEffect(() => {
    let timer: number | null = null;
    let active: HoldTarget | null = null;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const release = () => {
      clear();
      active?.release();
      active = null;
    };
    const begin = () => {
      timer = null;
      const t = pickHoldTarget();
      if (!t || t.phase() !== "idle") return;
      const el = t.textarea();
      if (el && el !== document.activeElement) {
        // Not typing in it yet: the words go at the end.
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
      active = t;
      t.start();
    };
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<{ kind: "down" | "up" | "chord" }>(FN_KEY_EVENT, ({ payload }) => {
      if (payload.kind === "down") {
        clear();
        if (readVoicePrefs().fnHold) timer = window.setTimeout(begin, HOLD_MS);
      } else if (payload.kind === "chord") {
        // fn+key before the mic opened: a shortcut, not dictation. Once
        // talking, keys are the bar's (↵ inserts, Esc cancels).
        clear();
      } else {
        release();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    // Switched away mid-sentence: fn's release goes to the other app.
    window.addEventListener("blur", release);
    return () => {
      cancelled = true;
      unlisten?.();
      clear();
      window.removeEventListener("blur", release);
    };
  }, []);
}
