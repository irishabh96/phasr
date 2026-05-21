import { FileCode2, Home, X } from "lucide-react";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { REPO_HOME_TAB_ID, useUiStore, type RepoInnerTab } from "@/lib/store";
import { cn } from "@/lib/utils";

interface RepoInnerTabBarProps {
  repositoryId: string;
}

/**
 * Per-repository tab strip shown on the empty-repo screen (and any future
 * repo-scoped surface). Mirrors `WorkspaceInnerTabBar`:
 *  - "home"    — pinned default, not closable. The action list lives here.
 *  - "preview" — read-only file viewer. Added by the file-search modal
 *                when there's no active workspace; closable.
 */
export function RepoInnerTabBar({ repositoryId }: RepoInnerTabBarProps) {
  const state = useUiStore((s) => s.repoInnerTabs[repositoryId]);
  const setActive = useUiStore((s) => s.setActiveRepoInnerTab);
  const close = useUiStore((s) => s.closeRepoInnerTab);

  if (!state || state.tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Repository tabs"
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-(--color-border-subtle) px-2"
    >
      {state.tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === state.activeTabId}
          onActivate={() => setActive(repositoryId, tab.id)}
          onClose={() => close(repositoryId, tab.id)}
        />
      ))}
    </div>
  );
}

function TabPill({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: RepoInnerTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const icon =
    tab.id === REPO_HOME_TAB_ID || tab.kind === "home" ? (
      <Home size={11} />
    ) : (
      <FileCode2 size={11} />
    );

  return (
    <GlassTooltip
      content={tab.kind === "preview" && tab.filePath ? tab.filePath : tab.title}
      side="bottom"
    >
      <div
        role="tab"
        aria-selected={active}
        onClick={onActivate}
        className={cn(
          "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] px-2 text-[12px]",
          "transition-colors",
          active
            ? "bg-(--color-bg-hover) text-(--color-text-primary)"
            : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
        )}
      >
        <span className="shrink-0 text-(--color-text-muted) group-aria-selected:text-(--color-text-primary)">
          {icon}
        </span>
        <span className="max-w-[180px] truncate">{tab.title}</span>
        {tab.closable && (
          <button
            type="button"
            aria-label={`Close ${tab.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex h-4 w-4 items-center justify-center rounded text-(--color-text-muted) opacity-0 hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) group-hover:opacity-100 aria-selected:opacity-100"
          >
            <X size={10} />
          </button>
        )}
      </div>
    </GlassTooltip>
  );
}
