import { useQueryClient } from "@tanstack/react-query";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { PanelRight, PanelRightClose } from "lucide-react";
import { useCallback, useEffect } from "react";
import { BranchChip } from "@/components/BranchChip";
import { OpenInMenu } from "@/components/OpenInMenu";
import { SyncButton } from "@/components/SyncButton";
import { WorkspaceRightSidebar } from "@/components/WorkspaceRightSidebar";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { WorkspaceActionsMenu } from "@/components/WorkspaceActionsMenu";
import { WorkspaceAgentToolbar } from "@/components/WorkspaceAgentToolbar";
import { WorkspaceInnerTabBar } from "@/components/WorkspaceInnerTabBar";
import { WorkspaceTabContent } from "@/components/WorkspaceTabContent";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

function WorkspaceDetail() {
  const { repositoryId, workspaceId } = Route.useParams();
  const { data: repos } = useRepositories();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: changes } = useGitStatus(workspaceId);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setActiveWorkspaceContext = useUiStore(
    (s) => s.setActiveWorkspaceContext,
  );
  const ensureInnerTabs = useUiStore((s) => s.ensureInnerTabs);
  const queryClient = useQueryClient();

  // Publish the active workspace context so global hotkeys (⌘T/⌘N/⌘W/⌘P)
  // can act on it. Cleared on unmount so home/settings routes can no-op.
  useEffect(() => {
    setActiveWorkspaceContext({ workspaceId, repositoryId });
    return () => setActiveWorkspaceContext(null);
  }, [workspaceId, repositoryId, setActiveWorkspaceContext]);

  // Seed the pinned "main" tab once we have the workspace record (need
  // `command` for the title). ensureInnerTabs is a no-op if already set.
  useEffect(() => {
    if (!workspace) return;
    ensureInnerTabs(workspaceId, workspace.command || workspace.name || "Main");
  }, [workspace, workspaceId, ensureInnerTabs]);


  const refresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["workspaces", "detail", workspaceId],
    });
    queryClient.invalidateQueries({
      queryKey: ["workspaces", "repository", repositoryId],
    });
  }, [queryClient, workspaceId, repositoryId]);

  // The parent repo is gone (e.g. just deleted) — bounce home instead of
  // showing this orphaned workspace (and its stale terminal) forever.
  if (repos && !repos.some((r) => r.id === repositoryId)) {
    return <Navigate to="/" replace />;
  }

  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-(--color-text-muted)">
        Loading workspace…
      </div>
    );
  }

  const changeCount = changes?.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col border-b border-(--color-border-subtle)">
        <div className="flex h-[var(--layout-header-height)] items-center gap-3 pl-4 pr-2">
          <div className="flex shrink-0 items-center gap-2">
            {workspace.worktreePath && <BranchChip workspaceId={workspaceId} />}
          </div>
          <WorkspaceInnerTabBar workspaceId={workspaceId} />
          <div className="flex shrink-0 items-center gap-1">
<RunCommandPicker repositoryId={repositoryId} />
            {workspace.worktreePath && workspace.workspaceKind !== "local" && (
              <SyncButton workspaceId={workspaceId} />
            )}
            {workspace.worktreePath && (
              <OpenInMenu path={workspace.worktreePath} />
            )}
            {workspace.worktreePath && (
              <ChangesToggle
                count={changeCount}
                collapsed={rightPanelCollapsed}
                onToggle={toggleRightPanel}
              />
            )}
            <WorkspaceActionsMenu workspace={workspace} />
          </div>
        </div>
        {workspace.worktreePath && (
          <WorkspaceAgentToolbar workspaceId={workspaceId} />
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <WorkspaceTabContent
          workspaceId={workspaceId}
          workspace={workspace}
          onMainExit={refresh}
        />
        {workspace.worktreePath && (
          <aside
            aria-hidden={rightPanelCollapsed}
            className={cn(
              "flex h-full shrink-0 flex-col overflow-hidden border-l border-(--glass-border-hairline) bg-(--color-bg-surface)",
              "transition-[width] duration-[220ms] [transition-timing-function:var(--ease-glass)]",
              rightPanelCollapsed ? "w-0 border-l-0" : "w-[360px]",
            )}
          >
            <div className="flex h-full w-[360px] min-w-[360px] flex-col">
              <WorkspaceRightSidebar workspaceId={workspaceId} />
            </div>
          </aside>
        )}
      </div>
      <RunCommandsPane repositoryId={repositoryId} />
    </div>
  );
}

function ChangesToggle({
  count,
  collapsed,
  onToggle,
}: {
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Icon = collapsed ? PanelRight : PanelRightClose;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={collapsed ? "Show changes (⌘J)" : "Hide changes (⌘J)"}
      className={cn(
        "relative flex h-7 items-center gap-1.5 rounded-[8px] px-2",
        "text-[12px] text-(--color-text-secondary)",
        "transition-colors duration-150",
        "hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
        !collapsed && "bg-(--color-bg-active) text-(--color-text-primary)",
      )}
    >
      <Icon size={13} />
      <span className="leading-none">Changes</span>
      {count > 0 && (
        <span
          className={cn(
            "ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1",
            "bg-(--color-accent-500) text-[10px] font-semibold leading-none text-(--color-text-inverse)",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export const Route = createFileRoute(
  "/_app/repositories/$repositoryId/workspaces/$workspaceId",
)({
  component: WorkspaceDetail,
});
