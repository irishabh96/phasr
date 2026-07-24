import { GitCommitHorizontal, Search, X } from "lucide-react";
import { useState } from "react";
import { CommitCard } from "@/components/CommitCard";
import type { DiffViewMode } from "@/components/diff/DiffView";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { PanelState } from "@/components/ui/PanelState";
import { useGitLog } from "@/lib/hooks/useGit";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";
import { cn } from "@/lib/utils";

interface HistoryPanelProps {
  workspaceId: string;
  /**
   * Width-gated diff view mode + setter, threaded from the sidebar so an
   * expanded commit's diff honors the same split↔inline gate as the Changes
   * panel — never side-by-side in a panel too narrow for two columns (B2).
   */
  diffMode?: DiffViewMode;
  onDiffModeChange?: (m: DiffViewMode) => void;
}

/**
 * History tab inside the workspace right sidebar. Renders a search input, a
 * branch-only / all toggle, and a paginated commit list. Each row is a
 * CommitCard that expands inline to show its per-file diff. Loading, empty,
 * and error states reuse the shared PanelState (skeleton / centered CTA /
 * humanized error + Retry), matching the Changes panel.
 */
export function HistoryPanel({
  workspaceId,
  diffMode,
  onDiffModeChange,
}: HistoryPanelProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [branchOnly, setBranchOnly] = useState(true);

  const log = useGitLog(workspaceId, {
    branchOnly,
    ...(debouncedSearch ? { messageGrep: debouncedSearch } : {}),
  });

  const commits = log.data?.pages.flat() ?? [];

  // A fresh repo / unborn branch makes `git log` exit non-zero ("does not have
  // any commits yet"). That's not a failure to surface in red — it's the empty
  // state. Treat it as empty; only genuine failures render the error panel.
  const rawErr =
    log.error instanceof Error
      ? log.error.message
      : log.error != null
        ? String(log.error)
        : "";
  const isUnborn =
    /does not have any commits|bad default revision|unknown revision|ambiguous argument/i.test(
      rawErr,
    );
  const showError = log.isError && !isUnborn;

  const emptyTitle = debouncedSearch
    ? `No commits match “${debouncedSearch}”`
    : "No commits yet";
  const emptyDescription = debouncedSearch
    ? undefined
    : branchOnly
      ? "This branch has no commits yet. Anything you or the agent commits shows up here."
      : "This repository has no commits yet.";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-(--color-border-subtle) p-2">
        <div className="relative">
          <Search
            size={11}
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-(--color-text-muted)"
          />
          <GlassInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search commits"
            aria-label="Search commits"
            className={cn("!h-7 pl-7 text-[12px]", search && "pr-7")}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ScopeToggle
            label="Branch"
            active={branchOnly}
            onClick={() => setBranchOnly(true)}
          />
          <ScopeToggle
            label="All"
            active={!branchOnly}
            onClick={() => setBranchOnly(false)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {log.isLoading ? (
          <PanelState kind="loading" rows={6} className="p-1" />
        ) : showError ? (
          <PanelState
            kind="error"
            title="Couldn't load history"
            error={log.error}
            onRetry={() => void log.refetch()}
          />
        ) : commits.length === 0 ? (
          <PanelState
            kind="empty"
            icon={<GitCommitHorizontal aria-hidden="true" />}
            title={emptyTitle}
            {...(emptyDescription ? { description: emptyDescription } : {})}
            {...(debouncedSearch
              ? {
                  action: (
                    <GlassButton
                      variant="outline"
                      size="sm"
                      onClick={() => setSearch("")}
                    >
                      Clear search
                    </GlassButton>
                  ),
                }
              : {})}
          />
        ) : (
          <>
            <ul className="flex flex-col gap-1.5">
              {commits.map((c) => (
                <li key={c.sha}>
                  <CommitCard
                    workspaceId={workspaceId}
                    commit={c}
                    {...(diffMode ? { mode: diffMode } : {})}
                    {...(onDiffModeChange
                      ? { onModeChange: onDiffModeChange }
                      : {})}
                  />
                </li>
              ))}
            </ul>

            {log.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <GlassButton
                  variant="outline"
                  size="sm"
                  onClick={() => void log.fetchNextPage()}
                  disabled={log.isFetchingNextPage}
                >
                  {log.isFetchingNextPage ? "Loading…" : "Load more"}
                </GlassButton>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ScopeToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative h-6 rounded px-2 text-[11.5px]",
        "transition-colors duration-100",
        "focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none",
        active
          ? "font-medium text-(--color-text-primary)"
          : "text-(--color-text-muted) hover:text-(--color-text-secondary)",
      )}
    >
      {label}
      {active && (
        <span
          aria-hidden
          // Neutral active indicator matching the parent Changes/History tab
          // strip — coral in this sidebar is reserved for the Commit primary.
          className="pointer-events-none absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-(--color-text-primary)"
        />
      )}
    </button>
  );
}
