import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PanelRight, PanelRightClose } from "lucide-react";
import { useCallback, useEffect } from "react";
import { BranchChip } from "@/components/BranchChip";
import { OpenInMenu } from "@/components/OpenInMenu";
import { PinnedRunCommandsToolbar } from "@/components/PinnedRunCommandsToolbar";
import { SyncButton } from "@/components/SyncButton";
import { WorkspaceRightSidebar } from "@/components/WorkspaceRightSidebar";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { WorkspaceActionsMenu } from "@/components/WorkspaceActionsMenu";
import { WorkspaceAgentToolbar } from "@/components/WorkspaceAgentToolbar";
import { WorkspaceInnerTabBar } from "@/components/WorkspaceInnerTabBar";
import { WorkspaceTabContent } from "@/components/WorkspaceTabContent";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

function WorkspaceDetail() {
  const { repositoryId, workspaceId } = Route.useParams();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: changes } = useGitStatus(workspaceId);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setActiveWorkspaceContext = useUiStore(
    (s) => s.setActiveWorkspaceContext,
  );
  const ensureInnerTabs = useUiStore((s) => s.ensureInnerTabs);
  const runPanel = useUiStore((s) => s.runPanel);
  const { data: runCommands } = useRunCommands(repositoryId);
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

  // Global ⌘1..⌘9 dispatcher for pinned run commands. We bind here
  // (per workspace route mount) so the keys only fire while a
  // workspace is active. Keys land on the Nth pinned command in
  // sort_order; the PinnedRunCommandsToolbar chips show the same
  // mapping. Bails when focused inside a text input so ⌘1 in a
  // textarea reaches the textarea instead of stealing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      const digit = parsePositiveDigit(e.key);
      if (digit === null) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const pinned = [...(runCommands ?? [])]
        .filter((c) => c.pinned)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const target_rc = pinned[digit - 1];
      if (!target_rc) return;
      e.preventDefault();
      runPanel.openTab(target_rc.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runCommands, runPanel]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["workspaces", "detail", workspaceId],
    });
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
      <header className="flex shrink-0 flex-col border-b border-(--color-border-subtle)">
        <div className="flex h-[var(--layout-header-height)] items-center gap-3 pl-4 pr-2">
          <div className="flex shrink-0 items-center gap-2">
            {workspace.worktreePath && <BranchChip workspaceId={workspaceId} />}
          </div>
          <WorkspaceInnerTabBar workspaceId={workspaceId} />
          <div className="flex shrink-0 items-center gap-1">
            <PinnedRunCommandsToolbar repositoryId={repositoryId} />
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

function parsePositiveDigit(key: string): number | null {
  if (key.length !== 1) return null;
  const n = key.charCodeAt(0) - "0".charCodeAt(0);
  return n >= 1 && n <= 9 ? n : null;
}

export const Route = createFileRoute(
  "/_app/repositories/$repositoryId/workspaces/$workspaceId",
)({
  component: WorkspaceDetail,
});
