/**
 * Lazy Shiki highlighter for the diff viewer.
 *
 * Built on `@shikijs/core` (`createHighlighterCore`) with the JavaScript
 * regex engine (`@shikijs/engine-javascript`) instead of the full
 * `shiki` bundle + Oniguruma engine. This removes the ~231 KB-gz WASM
 * blob that the full bundle compiles on the first diff render, and ships
 * only a curated grammar set instead of all 300+ grammars.
 *
 * A single shared highlighter instance carries both `github-dark` and
 * `github-light` themes plus the curated languages, all loaded up front
 * at construction. Anything outside the curated set falls back to
 * plaintext (no per-language dynamic grammar chunks).
 *
 * The highlighter is cached at module scope. A second call to
 * `getHighlighter()` returns the same Promise. Tests can call
 * `__resetHighlighterForTests()` to start over.
 */

import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";

import langTypescript from "@shikijs/langs/typescript";
import langTsx from "@shikijs/langs/tsx";
import langJavascript from "@shikijs/langs/javascript";
import langJsx from "@shikijs/langs/jsx";
import langJson from "@shikijs/langs/json";
import langRust from "@shikijs/langs/rust";
import langPython from "@shikijs/langs/python";
import langGo from "@shikijs/langs/go";
import langCss from "@shikijs/langs/css";
import langHtml from "@shikijs/langs/html";
import langMarkdown from "@shikijs/langs/markdown";
import langBash from "@shikijs/langs/bash";
import langYaml from "@shikijs/langs/yaml";
import langToml from "@shikijs/langs/toml";

/** Synchronous highlighter handle produced by `createHighlighterCore`. */
type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

export type DiffShikiTheme = "github-dark" | "github-light";

/**
 * Curated grammar set — the languages the diff viewer realistically
 * renders. Keeps the current preloaded ts/tsx/js/jsx/json plus the
 * common languages phasr users work in. Everything else falls back to
 * plaintext. Each `@shikijs/langs/*` module default-exports an array of
 * `LanguageRegistration` (grammar + its embedded deps); Shiki flattens
 * and dedupes them.
 */
const CURATED_LANGS = [
  langTypescript,
  langTsx,
  langJavascript,
  langJsx,
  langJson,
  langRust,
  langPython,
  langGo,
  langCss,
  langHtml,
  langMarkdown,
  langBash,
  langYaml,
  langToml,
];

/**
 * Canonical grammar names in `CURATED_LANGS`, matching the identifiers
 * produced by `languageFromPath`. Used for the synchronous "is this
 * grammar available?" check in the render path (bash also covers
 * shell/sh/zsh via its aliases).
 */
const PRELOADED_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "rust",
  "python",
  "go",
  "css",
  "html",
  "markdown",
  "bash",
  "yaml",
  "toml",
];

const THEMES = [githubDark, githubLight];

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const loadedLanguages = new Set<string>(PRELOADED_LANGS);

export function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: THEMES,
      langs: CURATED_LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/**
 * Ensure the highlighter (and its curated grammars) are ready, and
 * resolve the requested language to one we can actually render.
 * The curated set is loaded up front, so this just gates on the shared
 * highlighter and returns the language name (or `"text"` for anything
 * outside the set / unknown languages).
 */
export async function ensureLanguage(lang: string): Promise<string> {
  if (!lang || lang === "text" || lang === "plaintext") return "text";
  await getHighlighter();
  return loadedLanguages.has(lang) ? lang : "text";
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
  loadedLanguages.clear();
  for (const l of PRELOADED_LANGS) loadedLanguages.add(l);
}
