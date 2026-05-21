import { FileCode2, Home, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { disposeSessionXterm } from "@/components/SessionTerminalTab";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { SHORTCUTS } from "@/lib/shortcuts";
import { REPO_HOME_TAB_ID, useUiStore, type RepoInnerTab } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface RepoInnerTabBarProps {
  repositoryId: string;
}

/**
 * Per-repository tab strip shown on the empty-repo screen (and any future
 * repo-scoped surface). Mirrors `WorkspaceInnerTabBar`:
 *  - "home"     — pinned default, not closable. Action list lives here.
 *  - "preview"  — read-only file viewer; added by the file-search modal.
 *  - "terminal" — ad-hoc shells; the `+` at the end of the strip spawns one
 *                 (or ⌘T from `RepoHomeContent`).
 */
export function RepoInnerTabBar({ repositoryId }: RepoInnerTabBarProps) {
  const state = useUiStore((s) => s.repoInnerTabs[repositoryId]);
  const setActive = useUiStore((s) => s.setActiveRepoInnerTab);
  const close = useUiStore((s) => s.closeRepoInnerTab);
  const openTerminal = useUiStore((s) => s.openRepoInnerTerminalTab);

  if (!state || state.tabs.length === 0) return null;

  const handleClose = (tab: RepoInnerTab) => {
    const closed = close(repositoryId, tab.id);
    if (!closed) return;
    if (closed.kind === "terminal") {
      if (closed.ptySessionId) {
        void tauri.stopSessionTerminal(closed.ptySessionId).catch(() => {});
      }
      disposeSessionXterm(closed.id);
    }
  };

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
          onClose={() => handleClose(tab)}
        />
      ))}
      <GlassTooltip
        content={`${SHORTCUTS.newTerminal.label} (${SHORTCUTS.newTerminal.display.join("")})`}
        side="bottom"
      >
        <button
          type="button"
          aria-label={SHORTCUTS.newTerminal.label}
          onClick={() => openTerminal(repositoryId)}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
        >
          <Plus size={13} />
        </button>
      </GlassTooltip>
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
    tab.kind === "terminal" ? (
      <TerminalIcon size={11} />
    ) : tab.id === REPO_HOME_TAB_ID || tab.kind === "home" ? (
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
