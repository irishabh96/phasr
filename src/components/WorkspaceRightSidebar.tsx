import { useCallback, useEffect, useState } from "react";
import { ChangesPanel } from "@/components/ChangesPanel";
import { DiffModeToggle, type DiffViewMode } from "@/components/diff/DiffView";
import { HistoryPanel } from "@/components/HistoryPanel";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useElementWidth } from "@/lib/hooks/useElementWidth";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface WorkspaceRightSidebarProps {
  workspaceId: string;
}

const DIFF_MODE_KEY = "phasr.diff.viewMode";

/**
 * Below this panel width, side-by-side is force-disabled and the diff renders
 * inline regardless of the persisted pref: two ~half-width columns wrap real
 * code into an overlapping, unreadable mess. Split stays available on the
 * full-width diff route and once the user drags this panel wider than this.
 */
const SPLIT_MIN_WIDTH = 520;

function readDiffMode(): DiffViewMode {
  // Inline (unified) is the default in this narrow (~380px) sidebar: side-by-side
  // halves the width and wraps real code into an unreadable mess here. The user
  // can still switch to side-by-side (persisted — e.g. after widening the panel).
  if (typeof window === "undefined") return "inline";
  return window.localStorage.getItem(DIFF_MODE_KEY) === "side-by-side"
    ? "side-by-side"
    : "inline";
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

  // Measure THIS panel (user-resizable, 300–640px). Below SPLIT_MIN_WIDTH we
  // force inline regardless of the persisted pref; above it we honor the pref.
  // `null` (pre-measure) is treated as narrow so the first paint never flashes
  // an overlapping split.
  const [rootRef, panelWidth] = useElementWidth<HTMLDivElement>();
  const canSplit = panelWidth !== null && panelWidth >= SPLIT_MIN_WIDTH;

  const [diffMode, setDiffMode] = useState<DiffViewMode>(readDiffMode);
  const handleDiffModeChange = useCallback((next: DiffViewMode) => {
    setDiffMode(next);
    try {
      window.localStorage.setItem(DIFF_MODE_KEY, next);
    } catch {
      /* ignore quota / sandboxed iframe */
    }
  }, []);

  // The pref persists (so widening the panel restores the user's split), but
  // the mode ACTUALLY rendered is gated on width — never side-by-side when the
  // panel is too narrow to hold two readable columns.
  const effectiveMode: DiffViewMode = canSplit ? diffMode : "inline";

  // ⌘\ flips split↔inline for every diff section at once. Skip when a text
  // field is focused (commit message) so typing a backslash never toggles it.
  // A no-op below the split threshold — the panel can't render split there, so
  // the shortcut leaves the persisted pref untouched (it re-applies once wide).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!matchShortcut(e, SHORTCUTS.toggleDiffMode)) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (!canSplit) return;
      e.preventDefault();
      handleDiffModeChange(
        diffMode === "side-by-side" ? "inline" : "side-by-side",
      );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canSplit, diffMode, handleDiffModeChange]);

  const changeCount = changes?.length ?? 0;
  // Show the Split/Inline toggle whenever a diff can appear: the Changes tab
  // (when there are changes) OR the History tab (an expanded commit renders a
  // diff). Threading `effectiveMode` into History keeps commit diffs width-
  // gated too, so they never render split in a panel too narrow (B2).
  const showToggle =
    (activeTab === "changes" && changeCount > 0) || activeTab === "history";

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
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
            <DiffModeToggle
              mode={effectiveMode}
              onChange={handleDiffModeChange}
              splitDisabled={!canSplit}
              splitDisabledTitle="Widen the panel to view side-by-side"
            />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {activeTab === "changes" ? (
          <ChangesPanel
            workspaceId={workspaceId}
            diffMode={effectiveMode}
            onDiffModeChange={handleDiffModeChange}
          />
        ) : (
          <HistoryPanel
            workspaceId={workspaceId}
            diffMode={effectiveMode}
            onDiffModeChange={handleDiffModeChange}
          />
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
