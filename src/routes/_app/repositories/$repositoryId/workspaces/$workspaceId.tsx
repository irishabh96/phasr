import { useQueryClient } from "@tanstack/react-query";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NotesPanel } from "@/components/NotesPanel";
import { OpenInMenu } from "@/components/OpenInMenu";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandTerminal } from "@/components/RunCommandTerminal";
import { ChangesPane } from "@/components/session/ChangesPane";
import { ReviewPane } from "@/components/review/ReviewPane";
import { ReviewInspector } from "@/components/review/ReviewInspector";
import { ApprovalCard } from "@/components/session/ApprovalCard";
import { useSettingsRoute } from "@/components/settings/useSettingsRoute";
import { useRespondToAttention, useTaskAgentState } from "@/lib/hooks/useAgentSignals";
import { Composer } from "@/components/session/Composer";
import { FilesPane } from "@/components/session/FilesPane";
import { Inspector } from "@/components/session/Inspector";
import { SessionPaneBar } from "@/components/session/SessionPaneBar";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { PanelState } from "@/components/ui/PanelState";
import { WorkspaceActionsMenu } from "@/components/WorkspaceActionsMenu";
import { WorkspaceTabContent } from "@/components/WorkspaceTabContent";
import { useWatchWorkspaceGit } from "@/lib/hooks/useGit";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { humanizeError } from "@/lib/humanizeError";
import { originFromWorkspace } from "@/lib/noteProvenance";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

function WorkspaceDetail() {
  const { repositoryId, workspaceId } = Route.useParams();
  const { data: repos } = useRepositories();
  const workspaceQuery = useWorkspace(workspaceId);
  const workspace = workspaceQuery.data;
  const navigateToRepoEntry = useNavigateToRepoEntry();
  // Own the workspace's fs-watcher here, at the route root, so exactly one
  // watcher/listener exists for the whole workspace lifetime — the many
  // components that read `useGitStatus` (this header, ChangesPanel, the
  // right sidebar) no longer each spawn their own.
  useWatchWorkspaceGit(workspaceId);
  const { data: runCommands } = useRunCommands(repositoryId);
  const setActiveWorkspaceContext = useUiStore(
    (s) => s.setActiveWorkspaceContext,
  );
  const setLastWorkspace = useUiStore((s) => s.setLastWorkspace);
  const ensureInnerTabs = useUiStore((s) => s.ensureInnerTabs);
  const queryClient = useQueryClient();
  const innerState = useUiStore((s) => s.innerTabs[workspaceId]);
  const pane = useUiStore((s) => s.sessionPane[workspaceId] ?? "tabs");
  const setPane = useUiStore((s) => s.setSessionPane);
  const runPanel = useUiStore((s) => s.runPanel);
  const [stopOpen, setStopOpen] = useState(false);
  const inspectorCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const [changesView, setChangesView] = useState<"review" | "stage">("review");
  const agentState = useTaskAgentState(workspaceId);
  const respond = useRespondToAttention();
  const { open: openSettings } = useSettingsRoute();
  const { pane: paneParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (!paneParam) return;
    setPane(workspaceId, paneParam);
    void navigate({
      search: (p) => {
        const { pane: _consumed, ...rest } = p;
        return rest;
      },
      replace: true,
    });
  }, [paneParam, workspaceId, setPane, navigate]);
  // Panes mount on first visit and then stay mounted (hidden), so a diff
  // scroll position or a selected file survives switching back and forth.
  const [visited, setVisited] = useState<{ changes?: boolean; files?: boolean; notes?: boolean }>({});
  useEffect(() => {
    if ((pane === "changes" || pane === "files" || pane === "notes") && !visited[pane]) {
      setVisited((v) => ({ ...v, [pane]: true }));
    }
  }, [pane, visited]);
  // A run tab opened from anywhere (inspector, palette, ⌘1–9) comes forward.
  const runActive = runPanel.activeTab;
  useEffect(() => {
    if (runActive && runCommands?.some((rc) => rc.id === runActive)) setPane(workspaceId, "run");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runActive]);

  // Session shortcuts: ⌘⇧R review, ⌘. stop, ⌘⌥1–9 focus pane N.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchShortcut(e, SHORTCUTS.reviewChanges)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPane(workspaceId, "changes");
        return;
      }
      if (matchShortcut(e, SHORTCUTS.stopAgent)) {
        const ws = queryClient.getQueryData<Workspace>(["workspaces", "detail", workspaceId]);
        if (ws?.workspaceKind !== "agent" || ws.status !== "running") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setStopOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5)) - 1;
        const tabs = Array.from(
          document.querySelectorAll<HTMLElement>('[aria-label="Workspace tabs"] [role="tab"]'),
        );
        const target = tabs[n];
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        target.click();
        target.focus();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [workspaceId, setPane, queryClient]);

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
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return; // ⌘⌥N focuses panes
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

  const isAgent = workspace.workspaceKind === "agent";
  const activeInner = innerState?.tabs.find((t) => t.id === innerState.activeTabId) ?? null;
  const showComposer =
    isAgent && pane === "tabs" && activeInner?.kind === "main" && workspace.status === "running";
  const openedRunTabs = runPanel.openTabs.filter((id) => runCommands?.some((rc) => rc.id === id));

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SessionPaneBar
          workspace={workspace}
          actions={
            <>
              <RunCommandPicker repositoryId={repositoryId} />
              {workspace.worktreePath && <OpenInMenu path={workspace.worktreePath} />}
              {isAgent && workspace.status === "running" ? (
                <Button variant="danger" size="sm" className="h-[26px]" onClick={() => setStopOpen(true)}>
                  Stop
                </Button>
              ) : null}
              <WorkspaceActionsMenu workspace={workspace} />
            </>
          }
        />
        <div className="relative min-h-0 flex-1 bg-(--color-bg-base)">
          <div className={cn("absolute inset-0 flex flex-col", pane !== "tabs" && "invisible")}>
            <WorkspaceTabContent
              workspaceId={workspaceId}
              workspace={workspace}
              onMainExit={refresh}
              suspended={pane !== "tabs"}
            />
          </div>
          {openedRunTabs.map((id) => (
            <div
              key={id}
              className={cn("absolute inset-0", !(pane === "run" && runPanel.activeTab === id) && "invisible")}
            >
              <RunCommandTerminal
                runCommandId={id}
                workspaceId={workspace.worktreePath ? workspaceId : null}
                visible={pane === "run" && runPanel.activeTab === id}
              />
            </div>
          ))}
          {visited.changes && workspace.worktreePath ? (
            <div className={cn("absolute inset-0", pane !== "changes" && "hidden")}>
              <div className="flex h-full min-h-0 flex-col">
                {isAgent ? (
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-4">
                    <SegmentedControl
                      label="Changes view"
                      value={changesView}
                      onChange={setChangesView}
                      options={[
                        { value: "review", label: "Review" },
                        { value: "stage", label: "Stage & commit" },
                      ]}
                    />
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  {isAgent && changesView === "review" ? (
                    <ReviewPane workspaceId={workspaceId} />
                  ) : (
                    <ChangesPane workspaceId={workspaceId} />
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {visited.files && workspace.worktreePath ? (
            <div className={cn("absolute inset-0", pane !== "files" && "hidden")}>
              <FilesPane workspace={workspace} visible={pane === "files"} />
            </div>
          ) : null}
          {visited.notes ? (
            <div className={cn("absolute inset-0 mx-auto max-w-[760px]", pane !== "notes" && "hidden")}>
              <NotesPanel
                repositoryId={repositoryId}
                getOrigin={() => {
                  const inner = useUiStore.getState().innerTabs[workspaceId];
                  const active = inner?.tabs.find((t) => t.id === inner.activeTabId);
                  return originFromWorkspace(workspaceId, active);
                }}
              />
            </div>
          ) : null}
        </div>
        {agentState?.state === "needs-you" && agentState.attention ? (
          <ApprovalCard
            agent={workspace.agent}
            attention={agentState.attention}
            worktree={workspace.worktreePath}
            busy={respond.isPending}
            allowForTask={workspace.workspaceKind !== "local"}
            onRespond={(response) =>
              respond.mutate(
                { taskId: workspaceId, attentionId: agentState.attention!.id, response },
                {
                  onError: (err) =>
                    showToast(
                      String(err).includes("stale attention")
                        ? { intent: "info", title: "That prompt already changed", message: "Showing the agent's current request." }
                        : { intent: "error", title: "Couldn't answer the agent", message: humanizeError(err) },
                    ),
                },
              )
            }
            onOpenTerminal={() => {
              const main = innerState?.tabs.find((t) => t.kind === "main");
              if (main) useUiStore.getState().setActiveInnerTab(workspaceId, main.id);
            }}
            onChangeDefault={() => openSettings("agents", { row: "permission-mode" })}
          />
        ) : null}
        {showComposer ? <Composer taskId={workspaceId} agent={workspace.agent} /> : null}
      </div>
      {isAgent && pane === "changes" && changesView === "review" && !inspectorCollapsed ? (
        <ReviewInspector workspace={workspace} />
      ) : (
      <Inspector
        workspace={workspace}
        onReview={() => setPane(workspaceId, "changes")}
        onOpenNotes={() => setPane(workspaceId, "notes")}
      />
      )}
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title={`Stop ${workspace.agent ? AGENT_META[workspace.agent].label : "the agent"}?`}
        description="The agent process is interrupted, then killed if it doesn't exit. The worktree and its changes stay."
        confirmLabel="Stop agent"
        destructive
        onConfirm={() => {
          setStopOpen(false);
          void tauri
            .stopTask(workspaceId)
            .then(refresh)
            .catch((err) =>
              showToast({ intent: "error", title: "Couldn't stop the agent", message: humanizeError(err) }),
            );
        }}
      />
    </div>
  );
}

export const Route = createFileRoute(
  "/_app/repositories/$repositoryId/workspaces/$workspaceId",
)({
  component: WorkspaceDetail,
  // `?pane=changes|files|notes` deep-links a pane (board review cards,
  // palette, notifications). Consumed once on arrival, then dropped.
  validateSearch: (search: Record<string, unknown>): { pane?: "changes" | "files" | "notes" } =>
    search.pane === "changes" || search.pane === "files" || search.pane === "notes" ? { pane: search.pane } : {},
});
