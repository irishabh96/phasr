/**
 * Render-only diff component. Consumes a raw unified-diff string and
 * renders side-by-side or inline with Shiki syntax highlighting.
 *
 * This is the shared rendering core used by:
 *   - DiffViewer (fetches from Tauri, then delegates here)
 *   - RawDiffViewer (callers supply the diff text directly — used by
 *     the dev preview route and the unit tests)
 */

import { useEffect, useMemo, useState } from "react";
import { Columns2, Rows3 } from "lucide-react";
import { useShiki } from "@/lib/hooks/useShiki";
import {
  languageFromPath,
  pairForSideBySide,
  parseUnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type ParsedDiff,
} from "@/lib/diff/parse";
import { cn } from "@/lib/utils";
import { GlassButton } from "@/components/ui/GlassButton";

export type DiffViewMode = "side-by-side" | "inline";

const VIEW_MODE_KEY = "phasr.diff.viewMode";
/**
 * Cap on rendered hunks. Very large diffs (e.g. a generated lockfile)
 * would otherwise create tens of thousands of DOM nodes and freeze the
 * pane. Beyond this cap the user sees a "Show more" button.
 * `react-window` was considered, but pairing rows for side-by-side
 * complicates virtualisation and a v1 doesn't need it.
 */
const HUNK_BATCH_SIZE = 50;

export interface DiffViewProps {
  /** Raw unified-diff text. `null` while loading. */
  raw: string | null;
  /** Used for language detection. */
  filePath: string;
  /** Title shown in the header. Defaults to `filePath`. */
  displayName?: string;
  /** Optional error message displayed in place of the body. */
  errorMessage?: string;
  /** Show a loading placeholder. */
  loading?: boolean;
  className?: string;
  /** Override the persisted view mode (mainly for stories/tests). */
  initialMode?: DiffViewMode;
}

function readStoredMode(): DiffViewMode {
  if (typeof window === "undefined") return "side-by-side";
  const raw = window.localStorage.getItem(VIEW_MODE_KEY);
  return raw === "inline" ? "inline" : "side-by-side";
}

export function DiffView({
  raw,
  filePath,
  displayName,
  errorMessage,
  loading,
  className,
  initialMode,
}: DiffViewProps) {
  const [mode, setMode] = useState<DiffViewMode>(() => initialMode ?? readStoredMode());
  const [visibleHunks, setVisibleHunks] = useState(HUNK_BATCH_SIZE);

  // ⌘\ / Ctrl+\ toggles split↔inline. Skip when a text input is focused.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "\\") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      e.preventDefault();
      setMode((m) => {
        const next: DiffViewMode = m === "side-by-side" ? "inline" : "side-by-side";
        try {
          window.localStorage.setItem(VIEW_MODE_KEY, next);
        } catch {
          /* ignore quota / sandboxed iframe */
        }
        return next;
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const setModeStored = (next: DiffViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const parsed = useMemo<ParsedDiff | null>(
    () => (raw === null ? null : parseUnifiedDiff(raw)),
    [raw],
  );
  const language = useMemo(() => languageFromPath(filePath), [filePath]);

  useEffect(() => {
    setVisibleHunks(HUNK_BATCH_SIZE);
  }, [raw, filePath]);

  const title = displayName ?? filePath;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col text-(--color-text-primary)",
        className,
      )}
    >
      <DiffHeader
        title={title}
        mode={mode}
        onChangeMode={setModeStored}
        parsed={parsed}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <DiffMessage>Loading diff…</DiffMessage>}
        {!loading && errorMessage && (
          <DiffMessage tone="danger">{errorMessage}</DiffMessage>
        )}
        {!loading && !errorMessage && parsed && (
          <DiffBody
            parsed={parsed}
            mode={mode}
            language={language}
            visibleHunks={visibleHunks}
            onShowMore={() => setVisibleHunks((n) => n + HUNK_BATCH_SIZE)}
          />
        )}
      </div>
    </div>
  );
}

// ── header ───────────────────────────────────────────────────────────

function DiffHeader({
  title,
  mode,
  onChangeMode,
  parsed,
}: {
  title: string;
  mode: DiffViewMode;
  onChangeMode: (m: DiffViewMode) => void;
  parsed: ParsedDiff | null;
}) {
  const addCount = useMemo(() => countLines(parsed, "add"), [parsed]);
  const removeCount = useMemo(() => countLines(parsed, "remove"), [parsed]);

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-(--color-border-subtle) px-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[12px] font-medium">{title}</span>
        {parsed?.isNewFile && <Pill tone="success">new</Pill>}
        {parsed?.isDeletedFile && <Pill tone="danger">deleted</Pill>}
        {parsed?.isRename && <Pill tone="info">renamed</Pill>}
        {parsed?.isBinary && <Pill tone="muted">binary</Pill>}
        {addCount > 0 && (
          <span className="font-mono text-[11px] text-(--color-success)">
            +{addCount}
          </span>
        )}
        {removeCount > 0 && (
          <span className="font-mono text-[11px] text-(--color-danger)">
            −{removeCount}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <GlassButton
          variant={mode === "side-by-side" ? "outline" : "ghost"}
          size="sm"
          onClick={() => onChangeMode("side-by-side")}
          aria-pressed={mode === "side-by-side"}
          title="Side-by-side  (⌘\)"
        >
          <Columns2 size={12} />
          Split
        </GlassButton>
        <GlassButton
          variant={mode === "inline" ? "outline" : "ghost"}
          size="sm"
          onClick={() => onChangeMode("inline")}
          aria-pressed={mode === "inline"}
          title="Inline  (⌘\)"
        >
          <Rows3 size={12} />
          Inline
        </GlassButton>
      </div>
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "success" | "danger" | "info" | "muted";
}) {
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "danger"
        ? "var(--color-danger)"
        : tone === "info"
          ? "var(--color-info)"
          : "var(--color-text-muted)";
  return (
    <span
      className="rounded-full border px-1.5 py-px text-[10px] uppercase tracking-[0.08em]"
      style={{ color, borderColor: "color-mix(in oklab, currentColor 35%, transparent)" }}
    >
      {children}
    </span>
  );
}

// ── body ─────────────────────────────────────────────────────────────

type HighlightFn = (s: string) => { color: string; content: string }[];

function DiffBody({
  parsed,
  mode,
  language,
  visibleHunks,
  onShowMore,
}: {
  parsed: ParsedDiff;
  mode: DiffViewMode;
  language: string;
  visibleHunks: number;
  onShowMore: () => void;
}) {
  const shiki = useShiki(language);

  if (parsed.isEmpty) return <DiffMessage>No changes.</DiffMessage>;
  if (parsed.isBinary) {
    return <DiffMessage>Binary file — no preview available.</DiffMessage>;
  }
  if (parsed.hunks.length === 0) {
    return <DiffMessage>No textual changes.</DiffMessage>;
  }

  const shown = parsed.hunks.slice(0, visibleHunks);
  const remaining = parsed.hunks.length - shown.length;

  return (
    <div className="font-mono text-[11.5px] leading-[1.55]">
      {shown.map((hunk, idx) =>
        mode === "side-by-side" ? (
          <SideBySideHunk key={hunk.header + idx} hunk={hunk} highlight={shiki.highlight} />
        ) : (
          <InlineHunk key={hunk.header + idx} hunk={hunk} highlight={shiki.highlight} />
        ),
      )}
      {remaining > 0 && (
        <div className="flex items-center justify-center border-t border-(--color-border-subtle) bg-(--color-bg-elevated)/40 py-2">
          <GlassButton variant="ghost" size="sm" onClick={onShowMore}>
            Show {Math.min(remaining, HUNK_BATCH_SIZE)} more hunk
            {Math.min(remaining, HUNK_BATCH_SIZE) === 1 ? "" : "s"}
            <span className="ml-1 text-(--color-text-muted)">({remaining} hidden)</span>
          </GlassButton>
        </div>
      )}
    </div>
  );
}

function DiffMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-6 text-center text-[12px]",
        tone === "danger" ? "text-(--color-danger)" : "text-(--color-text-muted)",
      )}
    >
      {children}
    </div>
  );
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="flex items-center gap-3 border-y border-(--color-border-subtle) bg-(--color-bg-elevated)/60 px-3 py-1 text-[11px] text-(--color-text-muted)">
      <span className="font-mono">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </span>
      {hunk.section && <span className="truncate">{hunk.section}</span>}
    </div>
  );
}

function InlineHunk({ hunk, highlight }: { hunk: DiffHunk; highlight: HighlightFn }) {
  return (
    <div>
      <HunkHeader hunk={hunk} />
      <table className="w-full border-collapse">
        <tbody>
          {hunk.lines.map((line, i) => (
            <InlineRow key={i} line={line} highlight={highlight} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InlineRow({ line, highlight }: { line: DiffLine; highlight: HighlightFn }) {
  const bg = rowBg(line.kind);
  const gutter = gutterColor(line.kind);
  const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
  return (
    <tr style={{ backgroundColor: bg }}>
      <td
        className="select-none px-2 text-right align-top font-mono text-[10.5px] text-(--color-text-muted)"
        style={{ width: "3.5ch" }}
      >
        {line.oldLine ?? ""}
      </td>
      <td
        className="select-none px-2 text-right align-top font-mono text-[10.5px] text-(--color-text-muted)"
        style={{ width: "3.5ch" }}
      >
        {line.newLine ?? ""}
      </td>
      <td
        className="select-none px-1 text-center align-top font-mono text-[11px]"
        style={{ color: gutter, width: "1.5ch" }}
      >
        {marker}
      </td>
      <td className="whitespace-pre-wrap break-all px-2 align-top">
        <HighlightedLine source={line.content} kind={line.kind} highlight={highlight} />
      </td>
    </tr>
  );
}

function SideBySideHunk({ hunk, highlight }: { hunk: DiffHunk; highlight: HighlightFn }) {
  const rows = useMemo(() => pairForSideBySide(hunk.lines), [hunk]);
  return (
    <div>
      <HunkHeader hunk={hunk} />
      <table className="w-full border-collapse table-fixed">
        <colgroup>
          <col style={{ width: "3.5ch" }} />
          <col />
          <col style={{ width: "3.5ch" }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <SideCell line={row.left} side="left" highlight={highlight} />
              <SideCell line={row.right} side="right" highlight={highlight} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SideCell({
  line,
  side,
  highlight,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  highlight: HighlightFn;
}) {
  const isFiller = !line;
  const effectiveKind: DiffLine["kind"] = line?.kind ?? "context";
  const bg = isFiller
    ? "color-mix(in oklab, var(--color-text-muted) 6%, transparent)"
    : rowBg(effectiveKind);
  const gutter = gutterColor(effectiveKind);
  const lineNo = side === "left" ? line?.oldLine : line?.newLine;

  return (
    <>
      <td
        className="select-none px-2 text-right align-top font-mono text-[10.5px] text-(--color-text-muted)"
        style={{ backgroundColor: bg }}
      >
        {lineNo ?? ""}
      </td>
      <td
        className="whitespace-pre-wrap break-all px-2 align-top"
        style={{ backgroundColor: bg }}
      >
        {line ? (
          <span className="inline-flex w-full items-baseline gap-1">
            <span
              className="shrink-0 select-none font-mono text-[11px]"
              style={{ color: gutter, width: "1ch" }}
            >
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </span>
            <HighlightedLine source={line.content} kind={line.kind} highlight={highlight} />
          </span>
        ) : (
          <span aria-hidden="true">&nbsp;</span>
        )}
      </td>
    </>
  );
}

function HighlightedLine({
  source,
  kind,
  highlight,
}: {
  source: string;
  kind: DiffLine["kind"];
  highlight: HighlightFn;
}) {
  if (kind === "meta") {
    return <span className="text-(--color-text-muted)">{source || "​"}</span>;
  }
  if (source.length === 0) return <span>{"​"}</span>;
  const tokens = highlight(source);
  return (
    <span>
      {tokens.map((t, i) => (
        <span key={i} style={t.color !== "currentColor" ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </span>
  );
}

function rowBg(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "color-mix(in oklab, var(--color-success) 14%, transparent)";
    case "remove":
      return "color-mix(in oklab, var(--color-danger) 14%, transparent)";
    default:
      return "transparent";
  }
}

function gutterColor(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "var(--color-success)";
    case "remove":
      return "var(--color-danger)";
    default:
      return "var(--color-text-muted)";
  }
}

function countLines(parsed: ParsedDiff | null, kind: DiffLine["kind"]): number {
  if (!parsed) return 0;
  let n = 0;
  for (const h of parsed.hunks) {
    for (const l of h.lines) {
      if (l.kind === kind) n += 1;
    }
  }
  return n;
}
