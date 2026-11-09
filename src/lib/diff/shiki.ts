/**
 * Lazy Shiki highlighter for the diff viewer and file preview.
 *
 * Built on `@shikijs/core` (`createHighlighterCore`) with the JavaScript
 * regex engine (`@shikijs/engine-javascript`) instead of the full
 * `shiki` bundle + Oniguruma engine. This removes the ~231 KB-gz WASM
 * blob that the full bundle compiles on the first diff render, and ships
 * only a curated grammar set instead of all 300+ grammars.
 *
 * Nothing here is imported statically: this module only holds `import()`
 * thunks, so the route chunks that render diffs don't carry Shiki.
 *
 * - `getHighlighter()` loads the core, the regex engine and the
 *   `github-dark` / `github-light` themes on first call, and builds a
 *   single shared highlighter with no grammars.
 * - `ensureLanguage(lang)` loads one grammar (its own chunk) on demand
 *   and registers it with that highlighter.
 *
 * Anything outside the curated set falls back to plaintext without
 * loading Shiki at all.
 *
 * Both are cached at module scope: a second call returns the same
 * Promise. Tests can call `__resetHighlighterForTests()` to start over.
 */

import type { HighlighterCore, LanguageRegistration } from "@shikijs/core";

/** Synchronous highlighter handle produced by `createHighlighterCore`. */
type ShikiHighlighter = HighlighterCore;

export type DiffShikiTheme = "github-dark" | "github-light";

type LangModule = { default: LanguageRegistration[] };

/**
 * Curated grammar set: the languages the diff viewer realistically
 * renders, keyed by the identifiers `languageFromPath` produces (bash
 * also covers sh/zsh). Each `@shikijs/langs/*` module default-exports an
 * array of `LanguageRegistration` (the grammar plus its embedded deps);
 * Shiki flattens and dedupes them. Every entry is a separate dynamic
 * chunk, so only the grammars a user actually opens are loaded.
 */
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  bash: () => import("@shikijs/langs/bash"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
};

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
/** In-flight or settled grammar loads, keyed by language id. */
const languagePromises = new Map<string, Promise<string>>();
/** Grammars registered with the highlighter (sync check for the render path). */
const loadedLanguages = new Set<string>();

/** Whether `lang` has a grammar in the curated set. Synchronous; loads nothing. */
export function isSupportedLanguage(lang: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANG_LOADERS, lang);
}

export function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    const pending = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight] =
        await Promise.all([
          import("@shikijs/core"),
          import("@shikijs/engine-javascript"),
          import("@shikijs/themes/github-dark"),
          import("@shikijs/themes/github-light"),
        ]);
      return createHighlighterCore({
        themes: [githubDark.default, githubLight.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
    // A failed chunk load shouldn't poison the cache for the session.
    pending.catch(() => {
      if (highlighterPromise === pending) highlighterPromise = null;
    });
    highlighterPromise = pending;
  }
  return highlighterPromise;
}

/**
 * Ensure the highlighter and the grammar for `lang` are loaded, and
 * resolve the requested language to one we can actually render: the
 * language name, or `"text"` for anything outside the curated set,
 * unknown languages, or a grammar that failed to load. Unsupported
 * languages resolve immediately without loading Shiki.
 */
export function ensureLanguage(lang: string): Promise<string> {
  const loader = lang && isSupportedLanguage(lang) ? LANG_LOADERS[lang] : undefined;
  if (!loader) return Promise.resolve("text");
  let pending = languagePromises.get(lang);
  if (!pending) {
    pending = (async () => {
      const [highlighter, mod] = await Promise.all([getHighlighter(), loader()]);
      await highlighter.loadLanguage(mod.default);
      loadedLanguages.add(lang);
      return lang;
    })().catch(() => {
      // Retry on the next request rather than pinning plaintext forever.
      languagePromises.delete(lang);
      return "text";
    });
    languagePromises.set(lang, pending);
  }
  return pending;
}

/**
 * Tokenise a single source line and return inline-styled HTML
 * fragments. We render line-by-line so the diff gutter and side-by-side
 * pairing stay aligned; multiline-aware grammars (e.g. JSX) lose a bit
 * of context this way but the trade-off is worth it.
 */
export function tokenizeLine(
  highlighter: ShikiHighlighter,
  source: string,
  lang: string,
  theme: DiffShikiTheme,
): { color: string; content: string }[] {
  if (!source) return [];
  const resolvedLang = loadedLanguages.has(lang) ? lang : "text";
  const tokens = highlighter.codeToTokensBase(source, {
    lang: resolvedLang,
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
  languagePromises.clear();
  loadedLanguages.clear();
}
