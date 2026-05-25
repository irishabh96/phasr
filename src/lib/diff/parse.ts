/**
 * Lightweight unified-diff parser.
 *
 * The Rust backend (`src-tauri/src/git/diff.rs`) returns raw `git diff`
 * text rather than structured hunks, including a synthesised
 * "everything-is-new" diff for untracked files. The viewer needs row
 * data with old/new line numbers to render side-by-side, so parse on
 * the client.
 *
 * Intentionally minimal — handles the three forms we actually produce:
 *   • tracked file diff (zero or more hunks, optionally with the
 *     `\ No newline at end of file` trailer)
 *   • new file diff (`new file` header, `--- /dev/null`)
 *   • deleted file diff (`+++ /dev/null`)
 *
 * Binary-file markers are surfaced as a single info row so the UI can
 * say "binary file changed" instead of rendering garbage.
 */

export type DiffLineKind = "context" | "add" | "remove" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Raw line content WITHOUT the leading +/-/space prefix. */
  content: string;
  /** 1-based line number in the pre-change file, or null. */
  oldLine: number | null;
  /** 1-based line number in the post-change file, or null. */
  newLine: number | null;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` header text (without the trailing section context). */
  header: string;
  /** Optional function/section context shown after the `@@ ... @@` marker. */
  section: string | null;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** Path inside the worktree. May differ from a/b if renamed. */
  path: string | null;
  oldPath: string | null;
  newPath: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
  isBinary: boolean;
  isRename: boolean;
  hunks: DiffHunk[];
  /** Hint to the UI: an empty diff means "no changes for this scope". */
  isEmpty: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(raw: string): ParsedDiff {
  const result: ParsedDiff = {
    path: null,
    oldPath: null,
    newPath: null,
    isNewFile: false,
    isDeletedFile: false,
    isBinary: false,
    isRename: false,
    hunks: [],
    isEmpty: false,
  };

  const trimmed = raw.replace(/\r\n/g, "\n");
  if (trimmed.trim().length === 0) {
    result.isEmpty = true;
    return result;
  }

  const lines = trimmed.split("\n");
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.startsWith("diff --git ")) {
      // `diff --git a/foo b/bar` — extract a/b paths if possible.
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        result.oldPath = match[1] ?? null;
        result.newPath = match[2] ?? null;
        result.path = result.newPath ?? result.oldPath;
        if (result.oldPath && result.newPath && result.oldPath !== result.newPath) {
          result.isRename = true;
        }
      }
      current = null;
      continue;
    }

    if (line === "new file" || line.startsWith("new file mode ")) {
      result.isNewFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      result.isDeletedFile = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      result.oldPath = line.slice("rename from ".length);
      result.isRename = true;
      continue;
    }
    if (line.startsWith("rename to ")) {
      result.newPath = line.slice("rename to ".length);
      result.path = result.newPath;
      result.isRename = true;
      continue;
    }
    if (line.startsWith("Binary files ") || line.includes("GIT binary patch")) {
      result.isBinary = true;
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("similarity ") ||
      line.startsWith("dissimilarity ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ")
    ) {
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      if (path === "/dev/null") {
        result.isNewFile = true;
      } else if (path.startsWith("a/")) {
        result.oldPath = result.oldPath ?? path.slice(2);
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") {
        result.isDeletedFile = true;
      } else if (path.startsWith("b/")) {
        result.newPath = result.newPath ?? path.slice(2);
        result.path = result.path ?? result.newPath;
      }
      continue;
    }

    const hunkMatch = line.match(HUNK_RE);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1] ?? "0");
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3] ?? "0");
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      const section = (hunkMatch[5] ?? "").trim();
      current = {
        header: line,
        section: section.length > 0 ? section : null,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      oldCursor = oldStart;
      newCursor = newStart;
      result.hunks.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith("\\")) {
      // `\ No newline at end of file` — attach as meta on the last
      // content row but don't otherwise occupy space.
      continue;
    }

    if (line.startsWith("+")) {
      current.lines.push({
        kind: "add",
        content: line.slice(1),
        oldLine: null,
        newLine: newCursor,
      });
      newCursor += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({
        kind: "remove",
        content: line.slice(1),
        oldLine: oldCursor,
        newLine: null,
      });
      oldCursor += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        kind: "context",
        content: line.slice(1),
        oldLine: oldCursor,
        newLine: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
    } else if (line.length === 0) {
      // Trailing blank line at end of patch — ignore.
      continue;
    } else {
      // Unknown line shape — record as meta so the UI doesn't drop it.
      current.lines.push({
        kind: "meta",
        content: line,
        oldLine: null,
        newLine: null,
      });
    }
  }

  if (result.hunks.length === 0 && !result.isBinary && !result.isRename) {
    result.isEmpty = true;
  }

  return result;
}

/**
 * Pair removed/added lines within a hunk into rows suitable for
 * side-by-side rendering. Heuristic: a maximal run of `remove` lines
 * followed by a run of `add` lines is paired index-by-index. Excess
 * removes or adds spill to one side only.
 */
export interface SideBySideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function pairForSideBySide(lines: DiffLine[]): SideBySideRow[] {
  const out: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.kind === "context" || line.kind === "meta") {
      out.push({ left: line, right: line });
      i += 1;
      continue;
    }
    // Collect contiguous removes, then contiguous adds.
    const removes: DiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === "remove") {
      removes.push(lines[i] as DiffLine);
      i += 1;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === "add") {
      adds.push(lines[i] as DiffLine);
      i += 1;
    }
    const max = Math.max(removes.length, adds.length);
    for (let k = 0; k < max; k++) {
      out.push({ left: removes[k] ?? null, right: adds[k] ?? null });
    }
  }
  return out;
}

/**
 * Map a path's extension to a Shiki language id. Returns "text" when
 * unknown so highlighting is a no-op rather than a crash.
 */
export function languageFromPath(path: string | null | undefined): string {
  if (!path) return "text";
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "swift":
      return "swift";
    case "c":
    case "h":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hh":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "json":
      return "json";
    case "jsonc":
      return "jsonc";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "md":
    case "markdown":
      return "markdown";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "fish":
      return "fish";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "sql":
      return "sql";
    case "vue":
      return "vue";
    case "svelte":
      return "svelte";
    case "lock":
      return "yaml";
    default:
      // Common filenames without extensions.
      if (lower.endsWith("dockerfile")) return "dockerfile";
      if (lower.endsWith("makefile")) return "makefile";
      return "text";
  }
}
