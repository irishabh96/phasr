import { useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Loader2, PanelRight, PanelRightClose } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentStatusBadge } from "@/components/AgentStatusBadge";
import { BranchChip } from "@/components/BranchChip";
import { OpenInMenu } from "@/components/OpenInMenu";
import { SyncButton } from "@/components/SyncButton";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { PanelState } from "@/components/ui/PanelState";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { WorkspaceRightSidebar } from "@/components/WorkspaceRightSidebar";
import { PinnedRunCommandsToolbar } from "@/components/PinnedRunCommandsToolbar";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { WorkspaceActionsMenu } from "@/components/WorkspaceActionsMenu";
import { WorkspaceAgentToolbar } from "@/components/WorkspaceAgentToolbar";
import { WorkspaceInnerTabBar } from "@/components/WorkspaceInnerTabBar";
import { WorkspaceTabContent } from "@/components/WorkspaceTabContent";
import { useBoard } from "@/lib/hooks/useBoard";
import { blockingRoles } from "@/lib/deriveBoardState";
import { useGitStatus, useWatchWorkspaceGit } from "@/lib/hooks/useGit";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { SHORTCUTS } from "@/lib/shortcuts";
import {
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  useUiStore,
} from "@/lib/store";
import { cn } from "@/lib/utils";

function WorkspaceDetail() {
  const { repositoryId, workspaceId } = Route.useParams();
  const { data: repos } = useRepositories();
  const workspaceQuery = useWorkspace(workspaceId);
  const workspace = workspaceQuery.data;
  const navigate = useNavigate();
  const navigateToRepoEntry = useNavigateToRepoEntry();
  // A subtask drill-in reuses this route verbatim; its owning epic is
  // `parentId`. Fetch that parent's board (shared cache with the board route) so
  // the breadcrumb can show the epic goal and the "waiting" pane can name the
  // producer this subtask is blocked on. `enabled` gates on a real subtask.
  const subtaskParentId =
    workspace?.workspaceKind === "subtask" ? workspace.parentId : null;
  const { data: parentBoard } = useBoard(subtaskParentId ?? undefined);
  // Own the workspace's fs-watcher here, at the route root, so exactly one
  // watcher/listener exists for the whole workspace lifetime — the many
  // components that read `useGitStatus` (this header, ChangesPanel, the
  // right sidebar) no longer each spawn their own.
  useWatchWorkspaceGit(workspaceId);
  const { data: changes } = useGitStatus(workspaceId);
  const { data: runCommands } = useRunCommands(repositoryId);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const [resizing, setResizing] = useState(false);
  const setActiveWorkspaceContext = useUiStore(
    (s) => s.setActiveWorkspaceContext,
  );
  const setLastWorkspace = useUiStore((s) => s.setLastWorkspace);
  const ensureInnerTabs = useUiStore((s) => s.ensureInnerTabs);
  const queryClient = useQueryClient();

  // Publish the active workspace context so global hotkeys (⌘T/⌘N/⌘W/⌘P)
  // can act on it. Cleared on unmount so home/settings routes can no-op.
  // Also persist it as the last-open workspace (`phasr.lastWorkspace`) so a
  // relaunch restores *this* workspace — and, unlike the active context, we
  // deliberately do NOT clear it on unmount so it survives across sessions.
  useEffect(() => {
    setActiveWorkspaceContext({ workspaceId, repositoryId });
    setLastWorkspace({ workspaceId, repositoryId });
    return () => setActiveWorkspaceContext(null);
  }, [workspaceId, repositoryId, setActiveWorkspaceContext, setLastWorkspace]);

  // Seed the pinned "main" tab once we have the workspace record (need
  // `command` for the title). ensureInnerTabs is a no-op if already set.
  useEffect(() => {
    if (!workspace) return;
    ensureInnerTabs(workspaceId, workspace.command || workspace.name || "Main");
  }, [workspace, workspaceId, ensureInnerTabs]);

  // ⌘1..⌘9 launch pinned run commands (ordered by sortOrder), matching
  // the numbered chips on the PinnedRunCommandsToolbar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key < "1" || e.key > "9") return;
      const pinned = [...(runCommands ?? [])]
        .filter((c) => c.pinned)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const target = pinned[Number(e.key) - 1];
      if (!target) return;
      e.preventDefault();
      useUiStore.getState().runPanel.openTab(target.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runCommands]);

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

  if (workspaceQuery.isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-(--color-text-muted)">
        <Loader2
          className="size-5 animate-spin text-(--color-info)"
          aria-hidden="true"
        />
        <span className="text-[13px]">Loading workspace…</span>
      </div>
    );
  }

  // `tauri.getWorkspace(id)` REJECTS with "not found" for a missing/deleted
  // record (it never resolves null), so a not-found lands in `isError`.
  // Treat that as an empty "not found" state (with a Back CTA) and reserve
  // the retryable error surface for genuine load failures.
  if (workspaceQuery.isError || !workspace) {
    const message =
      workspaceQuery.error instanceof Error
        ? workspaceQuery.error.message
        : String(workspaceQuery.error ?? "");
    const notFound = !workspaceQuery.isError || /not\s*found/i.test(message);
    if (notFound) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <PanelState
            kind="empty"
            title="Workspace not found"
            description="It may have been deleted or moved."
            action={
              <GlassButton
                variant="primary"
                size="sm"
                onClick={() => void navigateToRepoEntry(repositoryId)}
              >
                Back to repository
              </GlassButton>
            }
          />
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center p-6">
        <PanelState
          kind="error"
          title="Couldn't load workspace"
          error={workspaceQuery.error}
          onRetry={() => void workspaceQuery.refetch()}
        />
      </div>
    );
  }

  const changeCount = changes?.length ?? 0;

  const isSubtask = workspace.workspaceKind === "subtask";
  const boardParentId = isSubtask ? workspace.parentId : null;
  const epicGoal = parentBoard
    ? parentBoard.parent.prompt?.trim() || parentBoard.parent.name
    : null;

  // An honest "not started yet" pane for a subtask with no worktree — it hasn't
  // been spawned yet (blocked upstream / queued). Reuses the existing
  // no-worktree gating: the row is a real Link that lands here, never a disabled
  // dead click. The CTA routes back to the board (never a dead end).
  if (isSubtask && boardParentId && !workspace.worktreePath) {
    const blocking =
      parentBoard && workspace.parentId
        ? blockingRoles(workspace, parentBoard)
        : [];
    const waitingDesc = blocking.length
      ? `Waiting for ${blocking.join(", ")} to publish its contract before this agent starts.`
      : "This subtask hasn't started yet — it spins up once its upstream work is ready.";
    return (
      <div className="flex h-full min-h-0 flex-col">
        <SubtaskBreadcrumb
          repositoryId={repositoryId}
          parentId={boardParentId}
          goal={epicGoal}
          role={workspace.role}
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <PanelState
            kind="empty"
            title="Not started yet"
            description={waitingDesc}
            action={
              <GlassButton
                variant="primary"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/repositories/$repositoryId/board/$parentId",
                    params: { repositoryId, parentId: boardParentId },
                  })
                }
              >
                View board
              </GlassButton>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isSubtask && boardParentId && (
        <SubtaskBreadcrumb
          repositoryId={repositoryId}
          parentId={boardParentId}
          goal={epicGoal}
          role={workspace.role}
        />
      )}
      <header className="flex shrink-0 flex-col border-b border-(--color-border-subtle)">
        <div className="flex h-[var(--layout-header-height)] items-center gap-3 pl-4 pr-2">
          <div className="flex shrink-0 items-center gap-2">
            {workspace.worktreePath && <BranchChip workspaceId={workspaceId} />}
            {workspace.workspaceKind !== "local" && (
              <AgentStatusBadge
                workspaceId={workspaceId}
                repositoryId={repositoryId}
                changeCount={changeCount}
              />
            )}
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
            style={rightPanelCollapsed ? undefined : { width: rightPanelWidth }}
            className={cn(
              "relative flex h-full shrink-0 flex-col overflow-hidden border-l border-(--glass-border-hairline) bg-(--color-bg-surface)",
              !resizing &&
                "transition-[width] duration-[220ms] [transition-timing-function:var(--ease-glass)]",
              rightPanelCollapsed && "w-0 border-l-0",
            )}
          >
            {!rightPanelCollapsed && (
              <ResizeHandle
                edge="left"
                width={rightPanelWidth}
                min={RIGHT_PANEL_WIDTH_MIN}
                max={RIGHT_PANEL_WIDTH_MAX}
                onResize={setRightPanelWidth}
                onResizeStart={() => setResizing(true)}
                onResizeEnd={() => setResizing(false)}
              />
            )}
            <div
              className="flex h-full flex-col"
              style={{ width: rightPanelWidth, minWidth: rightPanelWidth }}
            >
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
  const shortcut = SHORTCUTS.toggleRightPanel.display.join("");
  const label = collapsed ? "Show changes" : "Hide changes";
  return (
    <GlassTooltip content={`${label} (${shortcut})`} side="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        className={cn(
          "relative flex h-8 items-center gap-1.5 rounded-[8px] px-2",
          "text-[12px] text-(--color-text-secondary)",
          "transition-colors duration-150",
          "hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
          "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          !collapsed && "bg-(--color-bg-active) text-(--color-text-primary)",
        )}
      >
        <Icon size={13} />
        <span className="leading-none">Changes</span>
        {count > 0 && (
          <span
            className={cn(
              "ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1",
              "bg-(--color-accent-500) text-[10px] font-semibold leading-none text-(--color-accent-onfill)",
            )}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    </GlassTooltip>
  );
}

/**
 * The subtask drill-in's back-nav: `‹ {epic goal} / {role}`. The `‹ {goal}`
 * portion links back to the epic's board; `{role}` is the current page
 * (`aria-current`). Meaning rides text, not the chevron glyph alone.
 */
function SubtaskBreadcrumb({
  repositoryId,
  parentId,
  goal,
  role,
}: {
  repositoryId: string;
  parentId: string;
  goal: string | null;
  role: string | null;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="subtask-breadcrumb"
      className="flex h-9 shrink-0 items-center gap-1.5 border-b border-(--color-border-subtle) px-4 text-[13px]"
    >
      <Link
        to="/repositories/$repositoryId/board/$parentId"
        params={{ repositoryId, parentId }}
        data-testid="subtask-breadcrumb-board"
        className="-mx-1 flex items-center gap-1 rounded-[6px] px-1 py-0.5 text-(--color-text-muted) transition-colors duration-150 hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
      >
        <ChevronLeft size={13} aria-hidden="true" />
        <span className="max-w-[32ch] truncate">{goal ?? "Epic"}</span>
      </Link>
      {role && (
        <>
          <span aria-hidden="true" className="text-(--color-text-muted)">
            /
          </span>
          <span aria-current="page" className="text-(--color-text-secondary)">
            {role}
          </span>
        </>
      )}
    </nav>
  );
}

export const Route = createFileRoute(
  "/_app/repositories/$repositoryId/workspaces/$workspaceId",
)({
  component: WorkspaceDetail,
});
