import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, PanelRight, PanelRightClose } from "lucide-react";
import { useCallback } from "react";
import { ChangesPanel } from "@/components/ChangesPanel";
import { OpenInMenu } from "@/components/OpenInMenu";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { Terminal } from "@/components/Terminal";
import { WorkspaceActionsMenu } from "@/components/WorkspaceActionsMenu";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

function WorkspaceDetail() {
  const { repositoryId, workspaceId } = Route.useParams();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: changes } = useGitStatus(workspaceId);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", workspaceId] });
    queryClient.invalidateQueries({
      queryKey: ["workspaces", "repository", repositoryId],
    });
  }, [queryClient, workspaceId, repositoryId]);

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
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-(--glass-border-hairline) px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/repositories/$repositoryId"
            params={{ repositoryId }}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-(--color-text-secondary) transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)] hover:text-(--color-text-primary)"
          >
            <ArrowLeft size={14} />
          </Link>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium leading-none">{workspace.name}</span>
            <code className="truncate text-[11.5px] text-(--color-text-muted) leading-none">
              {workspace.command}
            </code>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RunCommandPicker repositoryId={repositoryId} />
          {workspace.worktreePath && <OpenInMenu path={workspace.worktreePath} />}
          {workspace.worktreePath && (
            <ChangesToggle
              count={changeCount}
              collapsed={rightPanelCollapsed}
              onToggle={toggleRightPanel}
            />
          )}
          <WorkspaceActionsMenu workspace={workspace} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <Terminal workspaceId={workspaceId} status={workspace.status} onExit={refresh} />
        </div>
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
              <ChangesPanel workspaceId={workspaceId} />
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
        "hover:bg-[color-mix(in_oklab,white_5%,transparent)] hover:text-(--color-text-primary)",
        !collapsed && "bg-[color-mix(in_oklab,white_5%,transparent)] text-(--color-text-primary)",
      )}
    >
      <Icon size={13} />
      <span className="leading-none">Changes</span>
      {count > 0 && (
        <span
          className={cn(
            "ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1",
            "bg-(--color-accent-500) text-[10px] font-semibold leading-none text-white",
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
