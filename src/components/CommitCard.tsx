import { useQueries } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { DiffList } from "@/components/diff/DiffList";
import type { DiffCardFile } from "@/components/diff/DiffCard";
import type { DiffViewMode } from "@/components/diff/DiffView";
import { useGitCommitFiles } from "@/lib/hooks/useGit";
import { tauri } from "@/lib/tauri";
import type { Commit, CommitFileChange, FileStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CommitCardProps {
  workspaceId: string;
  commit: Commit;
  /**
   * Width-gated diff view mode + setter, threaded from the sidebar so a
   * commit's expanded diff honors the SAME split↔inline gate as the Changes
   * panel — never side-by-side in a panel too narrow to hold two columns (B2).
   * Omitted (standalone use) → the inner DiffList owns its own mode.
   */
  mode?: DiffViewMode;
  onModeChange?: (m: DiffViewMode) => void;
}

/**
 * One commit row in the HistoryPanel list. Collapsed by default; click
 * to expand and load this commit's per-file diff via DiffList. Reuses
 * the same parallel-fetch pattern as ChangesPanel.useDiffFiles, with
 * the call swapped to gitCommitDiff so the diff is scoped to the
 * commit instead of the worktree state.
 */
export function CommitCard({
  workspaceId,
  commit,
  mode,
  onModeChange,
}: CommitCardProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="overflow-hidden rounded-md border border-(--color-border-default) bg-(--color-bg-surface)">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-(--color-bg-hover) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
      >
        <span className="mt-[1px] text-(--color-text-muted)">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <code className="shrink-0 font-mono text-[10.5px] text-(--color-text-muted)">
              {commit.shortSha}
            </code>
            <span className="min-w-0 flex-1 truncate text-[12px] text-(--color-text-primary)">
              {commit.subject}
            </span>
            {commit.parents.length > 1 && (
              <span className="shrink-0 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-(--color-text-muted)">
                merge
              </span>
            )}
          </div>
          <p
            className="mt-0.5 text-[10.5px] text-(--color-text-muted)"
            title={formatAbsolute(commit.authorDate)}
          >
            {commit.authorName} • {formatRelative(commit.authorDate)}
          </p>
        </div>
      </button>
      {expanded && (
        <div className={cn("border-t border-(--color-border-subtle) p-2")}>
          <CommitDiffList
            workspaceId={workspaceId}
            sha={commit.sha}
            {...(mode ? { mode } : {})}
            {...(onModeChange ? { onModeChange } : {})}
          />
        </div>
      )}
    </article>
  );
}

function CommitDiffList({
  workspaceId,
  sha,
  mode,
  onModeChange,
}: {
  workspaceId: string;
  sha: string;
  mode?: DiffViewMode;
  onModeChange?: (m: DiffViewMode) => void;
}) {
  const { data: files, isLoading, error } = useGitCommitFiles(workspaceId, sha);
  const cards = useCommitDiffFiles(workspaceId, sha, files ?? []);

  if (isLoading) {
    return (
      <p className="px-1 py-1.5 text-[11px] text-(--color-text-muted)">
        Loading diff…
      </p>
    );
  }
  if (error) {
    return (
      <p className="px-1 py-1.5 text-[11px] text-(--color-danger)">
        {String((error as Error).message ?? error)}
      </p>
    );
  }
  if (cards.length === 0) {
    return (
      <p className="px-1 py-1.5 text-[11px] text-(--color-text-muted)">
        No file changes in this commit.
      </p>
    );
  }
  return (
    <DiffList
      files={cards}
      defaultExpanded={3}
      onCopyPath={(p) => void navigator.clipboard?.writeText(p)}
      {...(mode && onModeChange ? { mode, onModeChange } : {})}
    />
  );
}

function useCommitDiffFiles(
  workspaceId: string,
  sha: string,
  files: CommitFileChange[],
): DiffCardFile[] {
  const results = useQueries({
    queries: files.map((f) => ({
      queryKey: ["git", "commitDiff", workspaceId, sha, f.path],
      queryFn: () => tauri.gitCommitDiff(workspaceId, sha, f.path),
      enabled: !!workspaceId && !!sha,
      staleTime: Infinity,
    })),
  });

  return useMemo(
    () =>
      files.map((f, i) => {
        const r = results[i];
        const card: DiffCardFile = {
          path: f.path,
          raw: r?.data ?? null,
          loading: r?.isLoading ?? false,
          // Stage indicator on the DiffCard's edge bar. For commits
          // we treat the file's commit-status as the visual status.
          // staged/unstaged props are read by DiffCard only for
          // stage/unstage button visibility (which we don't pass
          // callbacks for here), so set them to "other" to avoid
          // showing those buttons accidentally.
          staged: mapStatus(f.status),
          unstaged: "other" as FileStatus,
        };
        if (r?.error) {
          card.errorMessage = String((r.error as Error).message ?? r.error);
        }
        return card;
      }),
    [files, results],
  );
}

function mapStatus(s: FileStatus): FileStatus {
  // The DiffCard reads `staged` for the edge color hint. Pass through
  // as-is — conflicted is impossible here but treat as other for
  // safety.
  if (s === "conflicted") return "other";
  return s;
}

/** Full, locale-aware timestamp for the row's hover title (the absolute time
 *  behind the relative "2h ago"). */
function formatAbsolute(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRelative(iso: string): string {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  const d = new Date(date);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
