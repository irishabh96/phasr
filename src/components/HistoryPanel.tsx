import { Search } from "lucide-react";
import { useState } from "react";
import { CommitCard } from "@/components/CommitCard";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { useGitLog } from "@/lib/hooks/useGit";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";
import { cn } from "@/lib/utils";

interface HistoryPanelProps {
  workspaceId: string;
}

/**
 * History tab inside the workspace right sidebar. Renders a search
 * input, a branch-only / all toggle, and a paginated commit list.
 * Each commit row is a CommitCard (next commit) that expands inline
 * to show its DiffList. For now, until CommitCard lands, rows are
 * minimal placeholders.
 */
export function HistoryPanel({ workspaceId }: HistoryPanelProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [branchOnly, setBranchOnly] = useState(true);

  const log = useGitLog(workspaceId, {
    branchOnly,
    ...(debouncedSearch ? { messageGrep: debouncedSearch } : {}),
  });

  const commits = log.data?.pages.flat() ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-(--color-border-subtle) p-2">
        <div className="relative">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-(--color-text-muted)"
          />
          <GlassInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search commits"
            className="!h-7 pl-7 text-[12px]"
          />
        </div>
        <div className="flex items-center gap-1">
          <ScopeToggle
            label="Branch only"
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
        {log.isLoading && (
          <p className="px-2 py-3 text-[12px] text-(--color-text-muted)">Loading…</p>
        )}
        {log.isError && (
          <p className="px-2 py-3 text-[12px] text-(--color-danger)">
            {String((log.error as Error)?.message ?? log.error)}
          </p>
        )}
        {!log.isLoading && commits.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-(--color-text-muted)">
            {debouncedSearch
              ? `No commits match "${debouncedSearch}".`
              : branchOnly
                ? "No commits on this branch yet."
                : "No commits in this repository yet."}
          </p>
        )}

        <ul className="flex flex-col gap-1.5">
          {commits.map((c) => (
            <li key={c.sha}>
              <CommitCard workspaceId={workspaceId} commit={c} />
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
      className={cn(
        "h-6 rounded-[6px] px-2 text-[10.5px] font-medium uppercase tracking-[0.08em]",
        "transition-colors duration-100",
        active
          ? "bg-(--color-bg-active) text-(--color-text-primary)"
          : "text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)",
      )}
    >
      {label}
    </button>
  );
}

