import { GitBranch } from "lucide-react";
import { ChangesPanel } from "@/components/ChangesPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { NotesPanel } from "@/components/NotesPanel";
import { PanelState } from "@/components/ui/PanelState";
import { PanelTab, PanelTabBar } from "@/components/ui/PanelTabs";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useNotes } from "@/lib/hooks/useNotes";
import { originFromWorkspace } from "@/lib/noteProvenance";
import { useUiStore } from "@/lib/store";

interface WorkspaceRightSidebarProps {
  workspaceId: string;
  repositoryId: string;
  /** Changes/History need a worktree; Notes never does. */
  hasWorktree: boolean;
}

/**
 * Right-hand sidebar hosting the Changes, History, and Notes panels.
 * Owns the tab strip and dispatches to the active panel; selected tab
 * persists per-workspace via useUiStore. Notes are repository-scoped —
 * the same list renders on every workspace of the repo.
 */
export function WorkspaceRightSidebar({
  workspaceId,
  repositoryId,
  hasWorktree,
}: WorkspaceRightSidebarProps) {
  const { data: changes } = useGitStatus(hasWorktree ? workspaceId : null);
  const { data: notes } = useNotes(repositoryId);
  const activeTab =
    useUiStore((s) => s.rightPanelTab[workspaceId]) ?? "changes";
  const setTab = useUiStore((s) => s.setRightPanelTab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelTabBar>
        <PanelTab
          label="Changes"
          count={changes?.length ?? 0}
          active={activeTab === "changes"}
          onClick={() => setTab(workspaceId, "changes")}
        />
        <PanelTab
          label="History"
          active={activeTab === "history"}
          onClick={() => setTab(workspaceId, "history")}
        />
        <PanelTab
          label="Notes"
          count={notes?.filter((n) => !n.doneAt).length ?? 0}
          active={activeTab === "notes"}
          onClick={() => setTab(workspaceId, "notes")}
        />
      </PanelTabBar>
      <div className="min-h-0 flex-1">
        {activeTab === "notes" ? (
          <NotesPanel
            repositoryId={repositoryId}
            getOrigin={() => {
              const inner = useUiStore.getState().innerTabs[workspaceId];
              const active = inner?.tabs.find(
                (t) => t.id === inner.activeTabId,
              );
              return originFromWorkspace(workspaceId, active);
            }}
          />
        ) : !hasWorktree ? (
          // The rail is no longer gated on worktreePath (Notes must
          // always be reachable) — the git panels state their own
          // precondition instead of erroring.
          <PanelState
            kind="empty"
            icon={<GitBranch />}
            title="No worktree yet"
            description="Changes and history appear once this workspace has a worktree."
          />
        ) : activeTab === "history" ? (
          <HistoryPanel workspaceId={workspaceId} />
        ) : (
          <ChangesPanel workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
