import { useCallback, useEffect, useState } from "react";
import { ChangesPanel } from "@/components/ChangesPanel";
import { DiffModeToggle, type DiffViewMode } from "@/components/diff/DiffView";
import { HistoryPanel } from "@/components/HistoryPanel";
import { useGitStatus } from "@/lib/hooks/useGit";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface WorkspaceRightSidebarProps {
  workspaceId: string;
}

const DIFF_MODE_KEY = "phasr.diff.viewMode";

function readDiffMode(): DiffViewMode {
  if (typeof window === "undefined") return "side-by-side";
  return window.localStorage.getItem(DIFF_MODE_KEY) === "inline"
    ? "inline"
    : "side-by-side";
}

/**
 * Right-hand sidebar that hosts the Changes and History panels. Owns the tab
 * strip AND — folded onto the SAME row — the Split/Inline toggle, so the panel
 * opens with a single hairline instead of two stacked dividers. The diff view
 * mode + its ⌘\ shortcut live here (lifted out of ChangesPanel) so one listener
 * drives every diff section and the toggle can sit beside the tabs. Selected tab
 * persists per-workspace via useUiStore.
 */
export function WorkspaceRightSidebar({
  workspaceId,
}: WorkspaceRightSidebarProps) {
  const { data: changes } = useGitStatus(workspaceId);
  const activeTab =
    useUiStore((s) => s.rightPanelTab[workspaceId]) ?? "changes";
  const setTab = useUiStore((s) => s.setRightPanelTab);

  const [diffMode, setDiffMode] = useState<DiffViewMode>(readDiffMode);
  const handleDiffModeChange = useCallback((next: DiffViewMode) => {
    setDiffMode(next);
    try {
      window.localStorage.setItem(DIFF_MODE_KEY, next);
    } catch {
      /* ignore quota / sandboxed iframe */
    }
  }, []);
  // ⌘\ flips split↔inline for every diff section at once. Skip when a text
  // field is focused (commit message) so typing a backslash never toggles it.
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

  const changeCount = changes?.length ?? 0;
  const showToggle = activeTab === "changes" && changeCount > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-(--color-border-subtle) pl-3 pr-2">
        <TabButton
          label="Changes"
          count={changeCount}
          active={activeTab === "changes"}
          onClick={() => setTab(workspaceId, "changes")}
        />
        <TabButton
          label="History"
          active={activeTab === "history"}
          onClick={() => setTab(workspaceId, "history")}
        />
        {showToggle && (
          <div className="ml-auto">
            <DiffModeToggle mode={diffMode} onChange={handleDiffModeChange} />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {activeTab === "changes" ? (
          <ChangesPanel
            workspaceId={workspaceId}
            diffMode={diffMode}
            onDiffModeChange={handleDiffModeChange}
          />
        ) : (
          <HistoryPanel workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-10 items-center gap-1.5 px-1 text-[12.5px]",
        "transition-colors duration-100",
        active
          ? "font-medium text-(--color-text-primary)"
          : "text-(--color-text-muted) hover:text-(--color-text-secondary)",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1.5",
            "text-[10.5px] font-medium tabular-nums leading-none",
            active
              ? "bg-(--color-bg-elevated) text-(--color-text-secondary)"
              : "bg-(--color-bg-hover) text-(--color-text-muted)",
          )}
        >
          {count}
        </span>
      )}
      {active && (
        <span
          aria-hidden
          // Neutral active indicator — coral in this panel is reserved for the
          // Commit primary below, so the tab underline stays neutral (the bold
          // primary label already carries the selection).
          className="pointer-events-none absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-(--color-text-primary)"
        />
      )}
    </button>
  );
}
