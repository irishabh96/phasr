import { useEffect } from "react";
import { useUiStore } from "@/lib/store";

/** Below this window width both side panels fold to rails (A-Compact). */
export const COMPACT_BREAKPOINT = 1360;

const PREF_KEY = "phasr.autoCollapse";

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
}

/**
 * A-Compact: at a 1280px window the task list and inspector collapse to
 * their rails so the terminal keeps its width. Only fires when the width
 * CROSSES the breakpoint, so a manual ⌘B / ⌘I in between always wins until
 * the window is resized past it again. Growing back restores what auto-
 * collapse folded, not panels the user closed themselves.
 */
export function useAutoCollapse() {
  useEffect(() => {
    if (!readAutoCollapse()) return;
    let wasCompact = window.innerWidth < COMPACT_BREAKPOINT;
    let autoFolded = { sidebar: false, inspector: false };

    const fold = () => {
      const s = useUiStore.getState();
      autoFolded = {
        sidebar: s.sidebarMode === "pinned",
        inspector: !s.rightPanelCollapsed,
      };
      if (autoFolded.sidebar) s.setSidebarMode("collapsed");
      if (autoFolded.inspector) s.setRightPanelCollapsed(true);
    };
    const unfold = () => {
      const s = useUiStore.getState();
      if (autoFolded.sidebar && s.sidebarMode === "collapsed") s.setSidebarMode("pinned");
      if (autoFolded.inspector && s.rightPanelCollapsed) s.setRightPanelCollapsed(false);
      autoFolded = { sidebar: false, inspector: false };
    };

    if (wasCompact) fold();
    const onResize = () => {
      const compact = window.innerWidth < COMPACT_BREAKPOINT;
      if (compact === wasCompact) return;
      wasCompact = compact;
      if (compact) fold();
      else unfold();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
}
