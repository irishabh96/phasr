import { openUrl } from "@tauri-apps/plugin-opener";
import { showToast } from "@/lib/toast";
import { tauri } from "@/lib/tauri";
import type { LinkSource, SurfaceLink } from "@/lib/terminal/surface";

/**
 * ⌘-click links for terminal output — URLs open in the default browser,
 * file paths open in the user's editor (iTerm's semantic-history model).
 *
 * Activation is gated on ⌘ so a plain click still just focuses the
 * terminal / places selection, matching iTerm and VS Code.
 */

/**
 * http(s) URLs. Trailing sentence punctuation is excluded so
 * "see https://example.com." doesn't capture the full stop.
 */
const URL_TOKEN_RE =
  /(https?:\/\/[^\s"'`<>()[\]{}]*[^\s"'`<>()[\]{}.,:;!?])/g;

/**
 * Path-like tokens: absolute (`/a/b`), explicitly relative (`./x`,
 * `../x`), or bare-with-a-slash (`src/lib/foo.ts`), each with an
 * optional `:line` / `:line:col` suffix. `~/` is deliberately NOT
 * matched — nothing on the frontend can expand it, and a link that
 * errors on click is worse than plain text. URLs never match: the
 * character before a candidate must be line start, whitespace, or a
 * quote/bracket, which excludes the `//` after a scheme.
 */
const PATH_TOKEN_RE =
  /(?<=^|[\s"'`([])((?:\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)+|\.{1,2}\/[\w@.+-]+)((?::\d+){0,2})/g;

export interface PathToken {
  /** The path portion, without any :line suffix. */
  path: string;
  /** 0-based start index of the whole token in the scanned string. */
  start: number;
  /** 0-based end index (exclusive), including the :line suffix. */
  end: number;
}

export interface LinkToken {
  kind: "url" | "path";
  /** URL, or the path without its :line suffix. */
  target: string;
  start: number;
  end: number;
}

/**
 * Every openable token on a line, URLs first so a path-looking segment
 * inside a URL can never be claimed twice. Exported for unit tests.
 */
export function findLinkTokens(text: string): LinkToken[] {
  const tokens: LinkToken[] = [];
  for (const m of text.matchAll(URL_TOKEN_RE)) {
    if (m.index === undefined) continue;
    tokens.push({
      kind: "url",
      target: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const p of findPathTokens(text)) {
    const overlaps = tokens.some((t) => p.start < t.end && p.end > t.start);
    if (overlaps) continue;
    tokens.push({ kind: "path", target: p.path, start: p.start, end: p.end });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

/** Exported for unit tests. */
export function findPathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const path = m[1];
    if (path === undefined || m.index === undefined) continue;
    tokens.push({
      path,
      start: m.index,
      end: m.index + path.length + (m[2]?.length ?? 0),
    });
  }
  return tokens;
}

/** Exported for unit tests. Resolves a token against the surface cwd. */
export function resolvePathToken(
  path: string,
  cwd: string | null,
): string | null {
  if (path.startsWith("/")) return path;
  if (!cwd) return null;
  const stripped = path.startsWith("./") ? path.slice(2) : path;
  return `${cwd.replace(/\/+$/, "")}/${stripped}`;
}

export interface TerminalLinkOptions {
  /** Worktree/repo root for resolving relative paths; null = absolute only. */
  getCwd: () => string | null;
  /**
   * The user's default editor launcher id (`user_settings.defaultEditor`)
   * at click time; null shows a "configure an editor" toast.
   */
  getEditorId: () => string | null;
}

function openPathInEditor(path: string, editorId: string | null): void {
  if (!editorId) {
    showToast({
      intent: "error",
      title: "No default editor configured",
      message: "Pick one in Settings → General to open files from links.",
    });
    return;
  }
  void tauri.launchApp(editorId, path).catch((err) => {
    showToast({
      intent: "error",
      title: "Couldn't open file",
      message: String(err),
    });
  });
}

/** Open an http(s) URL externally, surfacing a failure instead of eating it. */
function openExternalUrl(url: string): void {
  void openUrl(url).catch((err) => {
    showToast({
      intent: "error",
      title: "Couldn't open link",
      message: String(err),
    });
  });
}

/** Only ever hand the OS an http(s) URL from terminal output. */
export function isOpenableUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

/**
 * Both link layers for one terminal, in backend-neutral terms. A backend
 * adapter binds this to whatever its emulator's link API looks like, so
 * all policy lives here and no backend can quietly weaken it.
 *
 * `activateHyperlink` is the OSC 8 path — the escape sequence a program
 * uses to say "this text IS a link" (Claude Code emits its URLs this
 * way). The scheme is re-checked at activation because OSC 8 lets the
 * program pick an arbitrary target and terminal output is untrusted
 * (it's whatever an agent printed).
 *
 * `provide` detects URLs itself rather than via a library's link addon:
 * the previous engine's web-links addon registered a provider that never
 * yielded a link (verified — clicking a URL did nothing even with this provider
 * removed), so it was silently dead weight. One provider also means URLs
 * and paths can't fight over the same span.
 */
export function createTerminalLinkSource(
  opts: TerminalLinkOptions,
): LinkSource {
  return {
    activateHyperlink(uri, event) {
      if (!event.metaKey) return;
      if (!isOpenableUrl(uri)) return;
      openExternalUrl(uri);
    },

    provide(_row, lineText) {
      const links: SurfaceLink[] = [];
      for (const token of findLinkTokens(lineText)) {
        const open =
          token.kind === "url"
            ? () => openExternalUrl(token.target)
            : (() => {
                const resolved = resolvePathToken(token.target, opts.getCwd());
                if (!resolved) return null;
                return () => openPathInEditor(resolved, opts.getEditorId());
              })();
        if (!open) continue;
        links.push({
          text: lineText.slice(token.start, token.end),
          // 0-based, half-open — the same indices findLinkTokens reports.
          // Each backend translates into its own convention.
          span: { startCol: token.start, endCol: token.end },
          activate(event) {
            if (!event.metaKey) return;
            open();
          },
        });
      }
      return links;
    },
  };
}
