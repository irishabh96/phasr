import { useQueries, useQuery } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DiffList } from "@/components/diff/DiffList";
import { DiffModeToggle, type DiffViewMode } from "@/components/diff/DiffView";
import type { DiffCardFile } from "@/components/diff/DiffCard";
import { PanelState } from "@/components/ui/PanelState";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type { FileChange } from "@/lib/types";

const DIFF_MODE_KEY = "phasr.diff.viewMode";
// Cards auto-expanded on load; only expanded cards fetch their diff, so this
// is also the cap on how many per-file diffs we fetch up front (mirrors
// ChangesPanel's `DEFAULT_EXPANDED_PER_SECTION`).
const DEFAULT_EXPANDED = 10;

/** TanStack keys for the combined branch-vs-base integration review. */
export const integrationDiffKeys = {
  fileList: (parentId: string) =>
    ["board", "integrationDiff", parentId] as const,
  fileDiff: (parentId: string, path: string) =>
    ["board", "integrationFileDiff", parentId, path] as const,
};

function readDiffMode(): DiffViewMode {
  if (typeof window === "undefined") return "side-by-side";
  return window.localStorage.getItem(DIFF_MODE_KEY) === "inline"
    ? "inline"
    : "side-by-side";
}

/**
 * The CLEAN-case integration review (P0-1). Unlike {@link ChangesPanel} — which
 * reads the worktree and is EMPTY right after a clean `integrate_parent`, since
 * the merge already committed everything — this reads the integration BRANCH
 * against its base via two board commands, so the review shows the combined diff
 * the agents actually produced:
 *
 *   - `board_integration_diff(parentId)`  → the combined `FileChange[]` list.
 *   - `board_integration_file_diff(parentId, path)` → one file's raw unified
 *     diff, LAZY-loaded per file only when its card is expanded (same
 *     `enabled: expanded` gate `ChangesPanel`/`useGitDiff` use to avoid fetching
 *     collapsed cards).
 *
 * It reuses the exact diff-rendering chrome (`DiffList` → `DiffCard` →
 * `DiffView`) — only the fetch source differs. Read-only: no stage / unstage /
 * discard / commit, because a clean integration is already committed on its
 * branch; this is purely the R7 "legible reward" surface before merging to main.
 */
export function IntegrationDiff({ parentId }: { parentId: string }) {
  const {
    data: files,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: integrationDiffKeys.fileList(parentId),
    queryFn: () => tauri.boardIntegrationDiff(parentId),
    enabled: !!parentId,
  });

  // View mode + its ⌘\ shortcut live HERE (not in each DiffCard) so split/inline
  // flips every file at once and only ONE keyboard listener runs — mirrors
  // ChangesPanel. DiffList/DiffView see `mode` + `onModeChange` (controlled), so
  // they install none of their own.
  const [diffMode, setDiffMode] = useState<DiffViewMode>(readDiffMode);
  const handleDiffModeChange = useCallback((next: DiffViewMode) => {
    setDiffMode(next);
    try {
      window.localStorage.setItem(DIFF_MODE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!matchShortcut(e, SHORTCUTS.toggleDiffMode)) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      e.preventDefault();
      handleDiffModeChange(
        diffMode === "side-by-side" ? "inline" : "side-by-side",
      );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [diffMode, handleDiffModeChange]);

  // Expansion owned HERE so the per-file diff fetch can gate on it: only
  // expanded cards fetch their raw diff, so collapsed cards issue ZERO
  // board_integration_file_diff calls.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const filesKey = useMemo(
    () => (files ?? []).map((c) => c.path).join(" "),
    [files],
  );
  useEffect(() => {
    const list = files ?? [];
    setExpandedPaths((prev) => {
      // Keep the user's toggles for paths that survive; otherwise auto-seed the
      // first N (a fresh file list / first load).
      const surviving = new Set<string>();
      for (const c of list) if (prev.has(c.path)) surviving.add(c.path);
      if (surviving.size > 0) return surviving;
      const seed = new Set<string>();
      for (let i = 0; i < Math.min(list.length, DEFAULT_EXPANDED); i++) {
        const p = list[i]?.path;
        if (p) seed.add(p);
      }
      return seed;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);
  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const diffFiles = useIntegrationDiffFiles(parentId, files ?? [], expandedPaths);

  if (isError) {
    return (
      <PanelState
        kind="error"
        className="h-full justify-center"
        title="Couldn't load the combined diff"
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading || files === undefined) {
    return <PanelState kind="loading" rows={6} className="p-3" />;
  }

  if (files.length === 0) {
    return (
      <PanelState
        kind="empty"
        className="h-full justify-center"
        icon={<GitMerge />}
        title="Nothing to review"
        description="The integration branch has no changes against its base."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-(--color-border-subtle) px-2 py-1.5">
        <DiffModeToggle mode={diffMode} onChange={handleDiffModeChange} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <DiffList
          files={diffFiles}
          expanded={expandedPaths}
          onToggle={toggleExpanded}
          mode={diffMode}
          onModeChange={handleDiffModeChange}
          onCopyPath={(p) => void navigator.clipboard?.writeText(p)}
        />
      </div>
    </div>
  );
}

/**
 * Fetch each file's raw diff in parallel via `useQueries`, gated on expansion so
 * collapsed cards never hit the backend — the same shape as ChangesPanel's
 * `useDiffFiles`, only the fetcher (`board_integration_file_diff`) and the
 * absence of a per-file scope differ. Collapsed cards still render their
 * +N·-N badge from the `FileChange` numstat counts with no fetch.
 */
function useIntegrationDiffFiles(
  parentId: string,
  changes: FileChange[],
  expandedPaths: Set<string>,
): DiffCardFile[] {
  const results = useQueries({
    queries: changes.map((c) => ({
      queryKey: integrationDiffKeys.fileDiff(parentId, c.path),
      queryFn: () => tauri.boardIntegrationFileDiff(parentId, c.path),
      // Raw diff ONLY for expanded cards — collapsed cards draw their badge
      // from the numstat counts on the FileChange, so they never fetch.
      enabled: !!parentId && expandedPaths.has(c.path),
    })),
  });

  return useMemo(
    () =>
      changes.map((c, i) => {
        const r = results[i];
        const file: DiffCardFile = {
          path: c.path,
          raw: r?.data ?? null,
          loading: r?.isLoading ?? false,
          staged: c.staged,
          unstaged: c.unstaged,
          oldPath: c.oldPath,
          adds: c.adds,
          removes: c.removes,
        };
        if (r?.error) {
          file.errorMessage = String((r.error as Error).message ?? r.error);
        }
        return file;
      }),
    [changes, results],
  );
}
