import { ChangesPanel } from "@/components/ChangesPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface WorkspaceRightSidebarProps {
  workspaceId: string;
}

/**
 * Right-hand sidebar that hosts the Changes and History panels.
 * Owns the tab strip at the top (replacing the prior "CHANGES N"
 * header inside ChangesPanel) and dispatches to the active panel.
 * Selected tab persists per-workspace via useUiStore.
 */
export function WorkspaceRightSidebar({ workspaceId }: WorkspaceRightSidebarProps) {
  const { data: changes } = useGitStatus(workspaceId);
  const activeTab =
    useUiStore((s) => s.rightPanelTab[workspaceId]) ?? "changes";
  const setTab = useUiStore((s) => s.setRightPanelTab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-(--color-border-subtle) px-2">
        <TabButton
          label="Changes"
          count={changes?.length ?? 0}
          active={activeTab === "changes"}
          onClick={() => setTab(workspaceId, "changes")}
        />
        <TabButton
          label="History"
          active={activeTab === "history"}
          onClick={() => setTab(workspaceId, "history")}
        />
      </div>
      <div className="min-h-0 flex-1">
        {activeTab === "changes" ? (
          <ChangesPanel workspaceId={workspaceId} />
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
        "flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium uppercase tracking-[0.08em]",
        "transition-colors duration-100",
        active
          ? "bg-(--color-bg-active) text-(--color-text-primary)"
          : "text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" && count > 0 && (
        <span className="text-(--color-text-secondary)">{count}</span>
      )}
    </button>
  );
}
