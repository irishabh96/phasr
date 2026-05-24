import { useEffect, useState } from "react";
import {
  ensureLanguage,
  getHighlighter,
  tokenizeLine,
  type DiffShikiTheme,
} from "@/lib/diff/shiki";
import { useUiStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";

interface ShikiState {
  ready: boolean;
  /**
   * Synchronous tokenizer. Returns plaintext spans (no color) until the
   * highlighter and the requested grammar are loaded.
   */
  highlight: (source: string) => { color: string; content: string }[];
  theme: DiffShikiTheme;
}

/**
 * Returns a syntax-highlight callback for a single source language.
 * Re-renders when the highlighter or the active grammar finishes
 * loading, and when the user toggles light/dark mode.
 */
export function useShiki(lang: string): ShikiState {
  const theme = useUiStore((s) => s.theme);
  const [resolved, setResolved] = useState(() =>
    typeof window === "undefined" ? "dark" : resolveTheme(theme),
  );
  const [ready, setReady] = useState(false);
  const [activeLang, setActiveLang] = useState<string>("text");

  // Keep the resolved theme in sync with the user's preference and the
  // system theme (only matters when theme === "system").
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setResolved(resolveTheme(theme));
    update();
    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void (async () => {
      await getHighlighter();
      const loaded = await ensureLanguage(lang);
      if (cancelled) return;
      setActiveLang(loaded);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const shikiTheme: DiffShikiTheme = resolved === "light" ? "github-light" : "github-dark";

  const highlight = (source: string): { color: string; content: string }[] => {
    if (!ready) return [{ color: "currentColor", content: source }];
    // Use the cached promise resolution synchronously via the loaded
    // language list. getHighlighter() resolves immediately if ready was
    // set, but we need a sync handle — pull it from the module cache.
    const hl = highlighterSync();
    if (!hl) return [{ color: "currentColor", content: source }];
    return tokenizeLine(hl, source, activeLang, shikiTheme);
  };

  return { ready, highlight, theme: shikiTheme };
}

// ── private: synchronous handle to the highlighter once resolved ─────

// Shiki returns a Promise; we want a sync handle in the render path.
// We resolve once and stash it. Tests reset this via getHighlighter
// returning a fresh promise.
let cached: Awaited<ReturnType<typeof getHighlighter>> | null = null;
void getHighlighter().then((h) => {
  cached = h;
});

function highlighterSync(): typeof cached {
  return cached;
}
