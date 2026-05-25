/**
 * Lazy Shiki highlighter for the diff viewer.
 *
 * We use a single shared highlighter instance with both `github-dark`
 * and `github-light` themes preloaded. Languages are loaded on demand
 * — Shiki ≥ 1.0 supports `loadLanguage` after construction, which keeps
 * the initial chunk small (no need to bundle every grammar up front).
 *
 * The highlighter is cached at module scope. A second call to
 * `getHighlighter()` returns the same Promise. Tests can call
 * `__resetHighlighterForTests()` to start over.
 */

import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type BundledTheme,
} from "shiki";

export type DiffShikiTheme = Extract<BundledTheme, "github-dark" | "github-light">;

const PRELOADED_LANGS: BundledLanguage[] = ["typescript", "tsx", "javascript", "jsx", "json"];
const THEMES: DiffShikiTheme[] = ["github-dark", "github-light"];

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>(PRELOADED_LANGS);

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: THEMES,
      langs: PRELOADED_LANGS,
    });
  }
  return highlighterPromise;
}

/**
 * Ensure a language grammar is loaded into the shared highlighter.
 * No-op for `text` / unknown languages.
 */
export async function ensureLanguage(lang: string): Promise<string> {
  if (!lang || lang === "text" || lang === "plaintext") return "text";
  const highlighter = await getHighlighter();
  if (loadedLanguages.has(lang)) return lang;
  try {
    await highlighter.loadLanguage(lang as BundledLanguage);
    loadedLanguages.add(lang);
    return lang;
  } catch {
    // Grammar isn't bundled with Shiki — fall back to plaintext rather
    // than throwing in the render path.
    return "text";
  }
}

/**
 * Tokenise a single source line and return inline-styled HTML
 * fragments. We render line-by-line so the diff gutter and side-by-side
 * pairing stay aligned; multiline-aware grammars (e.g. JSX) lose a bit
 * of context this way but the trade-off is worth it.
 *
 * Returns `null` when no highlighter is ready yet — callers should
 * render plaintext until the consumer's `useShiki` hook resolves.
 */
export function tokenizeLine(
  highlighter: Highlighter,
  source: string,
  lang: string,
  theme: DiffShikiTheme,
): { color: string; content: string }[] {
  if (!source) return [];
  const resolvedLang = loadedLanguages.has(lang) ? lang : "text";
  const tokens = highlighter.codeToTokensBase(source, {
    lang: resolvedLang as BundledLanguage,
    theme,
    includeExplanation: false,
  });
  // codeToTokensBase returns token rows per line — we feed one line at
  // a time so always take row 0.
  const row = tokens[0] ?? [];
  return row.map((t) => ({ color: t.color ?? "currentColor", content: t.content }));
}

export function __resetHighlighterForTests(): void {
  highlighterPromise = null;
  loadedLanguages.clear();
  for (const l of PRELOADED_LANGS) loadedLanguages.add(l);
}
