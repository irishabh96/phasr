import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  createFileRoute,
  useNavigate,
} from "@tanstack/react-router";
import {
  ChevronLeft,
  Hourglass,
  Loader2,
  PanelRight,
  PanelRightClose,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentStatusBadge } from "@/components/AgentStatusBadge";
import { SubtaskStatusBadge } from "@/components/SubtaskStatusBadge";
import { BranchChip } from "@/components/BranchChip";
import { SyncButton } from "@/components/SyncButton";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { PanelState } from "@/components/ui/PanelState";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { WorkspaceRightSidebar } from "@/components/WorkspaceRightSidebar";
import { PinnedRunCommandsToolbar } from "@/components/PinnedRunCommandsToolbar";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { WorkspaceActionsMenu } from "@/components/WorkspaceActionsMenu";
import { TicketNextGate } from "@/components/board/TicketNextGate";
import { WorkspaceAgentToolbar } from "@/components/WorkspaceAgentToolbar";
import { WorkspaceInnerTabBar } from "@/components/WorkspaceInnerTabBar";
import { WorkspaceTabContent } from "@/components/WorkspaceTabContent";
import { useBoard } from "@/lib/hooks/useBoard";
import { blockingRoles } from "@/lib/deriveBoardState";
import { useElementWidth } from "@/lib/hooks/useElementWidth";
import { useGitStatus, useWatchWorkspaceGit } from "@/lib/hooks/useGit";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useTicketBrief } from "@/lib/hooks/useTicketBrief";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { SHORTCUTS } from "@/lib/shortcuts";
import {
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  useUiStore,
} from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Below this header-row width, the low-priority toolbar controls (the pinned
 * `dev` runner + the standalone Sync button) fold into the ⋯ overflow so the
 * branch chip can flex-shrink and the single primary gate is NEVER pushed off
 * the right edge (H2). Measured on the row itself, not the window, so a wider
 * or collapsed left sidebar is accounted for.
 */
const HEADER_COMPACT_WIDTH = 940;

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
  // A subtask owns a versioned brief (Phase 2). Read it here — shared cache with
  // the Brief tab — so the Comments inner-tab badge shows its `commentCount`.
  const isSubtaskWorkspace = workspace?.workspaceKind === "subtask";
  const { data: ticketBrief } = useTicketBrief(
    repositoryId,
    workspaceId,
    isSubtaskWorkspace,
  );
  // Own the workspace's fs-watcher here, at the route root, so exactly one
  // watcher/listener exists for the whole workspace lifetime — the many
  // components that read `useGitStatus` (this header, ChangesPanel, the
  // right sidebar) no longer each spawn their own.
  useWatchWorkspaceGit(workspaceId);
  const { data: changes } = useGitStatus(workspaceId);
  const { data: runCommands } = useRunCommands(repositoryId);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setRightPanelCollapsed = useUiStore((s) => s.setRightPanelCollapsed);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const [resizing, setResizing] = useState(false);
  // Responsive header: fold low-priority controls into ⋯ below a width so the
  // primary gate is never clipped (H2). Measured on the row (see constant).
  const [headerRowRef, headerWidth] = useElementWidth<HTMLDivElement>();
  const compactHeader =
    headerWidth !== null && headerWidth < HEADER_COMPACT_WIDTH;
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
    const isSubtaskKind = workspace.workspaceKind === "subtask";
    // A subtask seeds [brief, main, comments] (mockup Page 04); agent/local
    // seeds stay the single "main" tab. A subtask whose agent has ALREADY been
    // spawned (it owns a worktree → real terminal output exists) lands on the
    // live "main" Terminal so the user immediately sees what the agent is doing;
    // a not-yet-started subtask (no worktree) still lands on the Brief.
    const seedActive: "brief" | "main" =
      isSubtaskKind && workspace.worktreePath ? "main" : "brief";
    ensureInnerTabs(
      workspaceId,
      workspace.command || workspace.name || "Main",
      isSubtaskKind,
      seedActive,
    );
  }, [workspace, workspaceId, ensureInnerTabs]);

  // #6 — Make a task's changes discoverable. The diff lives in the collapsible
  // right panel; when it's collapsed the user can miss that the agent produced
  // changes. Auto-open the panel the first time a workspace surfaces changes —
  // ONCE per workspace, so a deliberate re-collapse always sticks, and never
  // when there's nothing to show.
  const autoOpenedChangesRef = useRef<string | null>(null);
  useEffect(() => {
    const count = changes?.length ?? 0;
    if (!workspace?.worktreePath || count === 0) return;
    if (autoOpenedChangesRef.current === workspaceId) return;
    autoOpenedChangesRef.current = workspaceId;
    if (rightPanelCollapsed) setRightPanelCollapsed(false);
  }, [
    changes,
    workspace?.worktreePath,
    workspaceId,
    rightPanelCollapsed,
    setRightPanelCollapsed,
  ]);

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
            icon={<Hourglass aria-hidden="true" />}
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
        <div
          ref={headerRowRef}
          className="flex h-[var(--layout-header-height)] items-center gap-3 pl-4 pr-2"
        >
          {/* Left cluster flex-SHRINKS: the branch chip truncates (with its
              native tooltip) so it yields room instead of shoving the gate off
              the right edge. Status badge stays fixed-size. */}
          <div className="flex min-w-0 items-center gap-2">
            {workspace.worktreePath && <BranchChip workspaceId={workspaceId} />}
            {/* Honest status — the SAME derivation the board card + sidebar use,
                so a card and its detail can never disagree (board vs item). An
                agent reads its Step 0 `deriveAgentState`; a subtask reads the
                board-aware `deriveBoardState` (working/idle/wedged · blocked ·
                needs-review), never a raw "Running" `WorkspaceStatus`. */}
            {workspace.workspaceKind === "agent" && (
              <div className="shrink-0">
                <AgentStatusBadge
                  workspaceId={workspaceId}
                  repositoryId={repositoryId}
                  changeCount={changeCount}
                />
              </div>
            )}
            {workspace.workspaceKind === "subtask" && (
              <div className="shrink-0">
                <SubtaskStatusBadge
                  workspaceId={workspaceId}
                  repositoryId={repositoryId}
                  changeCount={changeCount}
                />
              </div>
            )}
          </div>
          <WorkspaceInnerTabBar
            workspaceId={workspaceId}
            compact={compactHeader}
            {...(ticketBrief ? { commentCount: ticketBrief.commentCount } : {})}
          />
          {/* Flex spacer: pushes the action cluster to the right edge in wide
              layouts and collapses to 0 when space is tight — so the tab bar
              (content-sized, scrollable) is never squeezed to width 0 and the
              shrink-0 action cluster is never clipped (H2). */}
          <div aria-hidden className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1">
            {/* Low-priority controls (pinned `dev` runner + standalone Sync) fold
                into the ⋯ overflow below HEADER_COMPACT_WIDTH so the gate stays
                visible (H2). Both remain reachable there (Run section / the
                compact Sync item). Run/Open-in already live in ⋯ (M3). */}
            {!compactHeader && (
              <>
                <PinnedRunCommandsToolbar repositoryId={repositoryId} />
                {workspace.worktreePath &&
                  workspace.workspaceKind !== "local" && (
                    <SyncButton workspaceId={workspaceId} />
                  )}
              </>
            )}
            {workspace.worktreePath && (
              <ChangesToggle
                count={changeCount}
                collapsed={rightPanelCollapsed}
                onToggle={toggleRightPanel}
                compact={compactHeader}
              />
            )}
            {/* The ticket's single derived next gate (Page 04): Request review /
                Approve+Bounce / Validate — the one primary per §G1. Always
                visible; never folded away. */}
            {isSubtask && workspace.worktreePath && (
              <TicketNextGate workspace={workspace} />
            )}
            <WorkspaceActionsMenu workspace={workspace} compact={compactHeader} />
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
  compact,
}: {
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  compact: boolean;
}) {
  const Icon = collapsed ? PanelRight : PanelRightClose;
  const shortcut = SHORTCUTS.toggleRightPanel.display.join("");
  const label = collapsed ? "Show changes" : "Hide changes";
  // M3: when the panel is OPEN its own "Changes N | History" tab already owns
  // the label + count, so the header button de-emphasizes to an icon-only
  // "hide" affordance — removing the redundant second "Changes N" and freeing
  // header width. Collapsed, it's the full labelled toggle that surfaces the
  // count (the panel isn't there to show it) — except in a compact header,
  // where it stays icon-only so it never crowds the primary gate (H2).
  const iconOnly = !collapsed || compact;
  return (
    <GlassTooltip content={`${label} (${shortcut})`} side="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-label={iconOnly ? `${label} (${count} changed)` : label}
        className={cn(
          "relative flex h-8 items-center gap-1.5 rounded-[8px]",
          "text-[12px] text-(--color-text-secondary)",
          "transition-colors duration-150",
          "hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
          "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          iconOnly
            ? "w-8 justify-center"
            : "px-2",
          !collapsed && "bg-(--color-bg-active) text-(--color-text-primary)",
        )}
      >
        <Icon size={13} />
        {!iconOnly && (
          <>
            <span className="leading-none">Changes</span>
            {count > 0 && (
              <span
                className={cn(
                  "ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1",
                  // Neutral counter — coral is reserved for the single next-gate
                  // in this row (Validate), so the count never competes with it.
                  "border border-(--color-border-default) bg-(--color-bg-elevated)",
                  "text-[10px] font-semibold leading-none text-(--color-text-secondary)",
                )}
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
          </>
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
