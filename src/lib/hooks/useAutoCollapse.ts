import { useEffect } from "react";
import { useUiStore } from "@/lib/store";

/** Below this window width both side panels fold to rails (A-Compact). */
export const COMPACT_BREAKPOINT = 1360;

const PREF_KEY = "phasr.autoCollapse";
const PREF_EVENT = "phasr:auto-collapse-changed";

/** Settings › Appearance "Fold side panels on narrow windows" (default on). */
export function readAutoCollapse(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAutoCollapse(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  // Applies now, not on the next launch.
  window.dispatchEvent(new Event(PREF_EVENT));
}

/**
 * A-Compact: at a 1280px window the task list and inspector collapse to
 * their rails so the terminal keeps its width. Only acts when the width
 * CROSSES the breakpoint (or the setting flips), so a manual ⌘B / ⌘I in
 * between always wins. Growing back — or turning the setting off — restores
 * only what auto-collapse folded, never panels the user closed.
 */
export function useAutoCollapse() {
  useEffect(() => {
    let folded = { sidebar: false, inspector: false };
    let compact = false;

    const fold = () => {
      const s = useUiStore.getState();
      folded = { sidebar: s.sidebarMode === "pinned", inspector: !s.rightPanelCollapsed };
      if (folded.sidebar) s.setSidebarMode("collapsed");
      if (folded.inspector) s.setRightPanelCollapsed(true);
    };
    const unfold = () => {
      const s = useUiStore.getState();
      if (folded.sidebar && s.sidebarMode === "collapsed") s.setSidebarMode("pinned");
      if (folded.inspector && s.rightPanelCollapsed) s.setRightPanelCollapsed(false);
      folded = { sidebar: false, inspector: false };
    };
    /** Effective state = narrow window AND setting on. */
    const evaluate = () => {
      const next = readAutoCollapse() && window.innerWidth < COMPACT_BREAKPOINT;
      if (next === compact) return;
      compact = next;
      if (next) fold();
      else unfold();
    };

    evaluate();
    window.addEventListener("resize", evaluate);
    window.addEventListener(PREF_EVENT, evaluate);
    return () => {
      window.removeEventListener("resize", evaluate);
      window.removeEventListener(PREF_EVENT, evaluate);
    };
  }, []);
}
