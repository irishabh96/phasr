import { Link, useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  PanelLeft,
  PanelLeftClose,
  Plus,
} from "lucide-react";
import { useState } from "react";
import { RepositorySidebarMenu } from "@/components/RepositorySidebarMenu";
import { GlassButton } from "@/components/ui/GlassButton";
import { PanelState } from "@/components/ui/PanelState";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { WorkspaceSidebarMenu } from "@/components/WorkspaceSidebarMenu";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  AgentStatusIndicator,
  AgentStatusMetaLine,
} from "@/components/ui/AgentStatusIndicator";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import { useAgentLiveness } from "@/lib/agentLiveness";
import { deriveAgentState } from "@/lib/deriveAgentState";
import { useNow } from "@/lib/useNow";
import type { Workspace, Repository } from "@/lib/types";

export function AppSidebar() {
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const repositories = useRepositories();
  const openAddRepositoryPicker = useUiStore((s) => s.openAddRepositoryPicker);
  const params = useParams({ strict: false });
  const activeRepoId =
    (params as { repositoryId?: string }).repositoryId ?? null;
  const activeWorkspaceId =
    (params as { workspaceId?: string }).workspaceId ?? null;

  if (sidebarMode === "hidden") return null;

  const isExpanded = sidebarMode === "pinned";

  return (
    <aside
      aria-label="Sidebar"
      style={isExpanded ? { width: sidebarWidth } : undefined}
      className={cn(
        "relative shrink-0",
        "flex flex-col",
        "bg-(--color-bg-sidebar) border-r border-(--color-border-subtle)",
        // Suppress the width animation while actively dragging so the
        // sidebar tracks the pointer instead of lagging behind it.
        !resizing && "transition-[width] duration-[220ms]",
        "[transition-timing-function:var(--ease-glass)]",
        !isExpanded && "w-[52px]",
      )}
    >
      {isExpanded && (
        <ResizeHandle
          edge="right"
          width={sidebarWidth}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
          onResize={setSidebarWidth}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <nav aria-label="Repositories" className="flex flex-col gap-2 px-1.5">
          {repositories.isLoading && !repositories.data ? (
            isExpanded ? (
              <PanelState kind="loading" rows={4} className="px-1 pt-1" />
            ) : null
          ) : repositories.isError ? (
            isExpanded ? (
              <PanelState
                kind="error"
                title="Couldn't load repositories"
                error={repositories.error}
                onRetry={() => void repositories.refetch()}
              />
            ) : null
          ) : repositories.data && repositories.data.length === 0 ? (
            isExpanded ? (
              <PanelState
                kind="empty"
                icon={<FolderGit2 />}
                title="No repositories yet"
                description="Add a repository to start creating workspaces."
                action={
                  <GlassButton
                    variant="primary"
                    size="sm"
                    onClick={openAddRepositoryPicker}
                  >
                    <Plus size={12} />
                    Add repository
                  </GlassButton>
                }
              />
            ) : null
          ) : (
            repositories.data?.map((repo) => (
              <RepoBlock
                key={repo.id}
                repo={repo}
                isExpanded={isExpanded}
                isActive={repo.id === activeRepoId}
                activeWorkspaceId={activeWorkspaceId}
              />
            ))
          )}
        </nav>
      </div>
      <SidebarFooter isExpanded={isExpanded} onToggle={toggleSidebarPin} />
    </aside>
  );
}

function RepoBlock({
  repo,
  isExpanded,
  isActive,
  activeWorkspaceId,
}: {
  repo: Repository;
  isExpanded: boolean;
  isActive: boolean;
  activeWorkspaceId: string | null;
}) {
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const navigateToRepoEntry = useNavigateToRepoEntry();
  const workspaceExpanded = useUiStore(
    (s) => s.repoWorkspaceExpanded[repo.id] ?? true,
  );
  const toggleWorkspaceExpanded = useUiStore(
    (s) => s.toggleRepoWorkspaceExpanded,
  );
  // Spread-index so emoji / non-BMP first characters aren't split into a
  // lone surrogate half.
  const initial = ([...repo.name][0] ?? "").toUpperCase();
  const ExpandIcon = workspaceExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col">
      <RepositorySidebarMenu repository={repo}>
        <div
          role="button"
          tabIndex={0}
          aria-label={repo.name}
          aria-current={isActive ? "page" : undefined}
          onClick={() => void navigateToRepoEntry(repo.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void navigateToRepoEntry(repo.id);
            }
          }}
          className={cn(
            "group/repo flex h-[38px] cursor-pointer items-center rounded-[10px]",
            isExpanded ? "pl-3 pr-1" : "justify-center",
            "outline-none transition-colors duration-150",
            "hover:bg-(--color-bg-hover)",
            "focus-visible:bg-(--color-bg-hover) focus-visible:ring-1 focus-visible:ring-(--color-border-strong)",
            "data-[state=open]:bg-(--color-bg-elevated)",
            isActive && "bg-(--color-bg-selected)",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              isExpanded ? "" : "justify-center",
            )}
          >
            <GlassTooltip
              content={repo.name}
              side="right"
              disabled={isExpanded}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]",
                  "text-[11px] font-semibold leading-none",
                  "transition-colors duration-150",
                  isActive
                    ? "bg-(--color-accent-500) text-(--color-accent-onfill)"
                    : "bg-(--color-bg-hover) text-(--color-text-secondary)",
                )}
              >
                {initial}
              </span>
            </GlassTooltip>
            {isExpanded && (
              <span
                className={cn(
                  "ml-2.5 min-w-0 flex-1 truncate text-[14px] font-medium leading-none",
                  isActive
                    ? "text-(--color-text-primary)"
                    : "text-(--color-text-secondary)",
                )}
              >
                {repo.name}
              </span>
            )}
          </div>
          {isExpanded && (
            <>
              <GlassTooltip
                content={
                  workspaceExpanded ? "Hide workspaces" : "Show workspaces"
                }
                side="right"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    toggleWorkspaceExpanded(repo.id);
                  }}
                  aria-label={`${workspaceExpanded ? "Hide" : "Show"} workspaces in ${repo.name}`}
                  className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-active) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                >
                  <ExpandIcon size={12} />
                </button>
              </GlassTooltip>
              <GlassTooltip content="New workspace (⌘N)" side="right">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    requestNewWorkspace(repo.id);
                  }}
                  aria-label={`New workspace in ${repo.name}`}
                  className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-active) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                >
                  <Plus size={12} />
                </button>
              </GlassTooltip>
            </>
          )}
        </div>
      </RepositorySidebarMenu>
      {workspaceExpanded && (
        <RepoWorkspaces
          repoId={repo.id}
          activeWorkspaceId={activeWorkspaceId}
          isExpanded={isExpanded}
        />
      )}
    </div>
  );
}

function RepoWorkspaces({
  repoId,
  activeWorkspaceId,
  isExpanded,
}: {
  repoId: string;
  activeWorkspaceId: string | null;
  isExpanded: boolean;
}) {
  const workspaces = useWorkspaces(repoId);
  const visibleWorkspaces = [...(workspaces.data ?? [])]
    .filter((ws) => ws.status !== "archived")
    // Progressive disclosure (S2-T3 / spec §B6): board `parent`/`subtask` rows
    // live only on the board route, never as loose rows in the flat sidebar.
    // A single agent on a single task looks EXACTLY as it does today.
    .filter(
      (ws) => ws.workspaceKind === "agent" || ws.workspaceKind === "local",
    )
    .sort((a, b) => {
      if (a.workspaceKind !== b.workspaceKind)
        return a.workspaceKind === "local" ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });

  if (!visibleWorkspaces.length) return null;

  return (
    <div
      className={cn(
        "mt-1.5 flex flex-col gap-0.5",
        isExpanded
          ? "ml-3.5 border-l border-(--glass-border-hairline) pl-2"
          : "items-center",
      )}
    >
      {visibleWorkspaces.map((ws) => (
        <WorkspaceLink
          key={ws.id}
          ws={ws}
          repoId={repoId}
          active={ws.id === activeWorkspaceId}
          isExpanded={isExpanded}
        />
      ))}
    </div>
  );
}

function WorkspaceLink({
  ws,
  repoId,
  active,
  isExpanded,
}: {
  ws: Workspace;
  repoId: string;
  active: boolean;
  isExpanded: boolean;
}) {
  const isAgent = ws.workspaceKind === "agent";
  // Latest liveness snapshot + a scoped 1 Hz clock so the honest "Ns ago"
  // counter ticks — only for a running agent, never the whole tree (S0.1).
  const live = useAgentLiveness(ws.id);
  const now = useNow(
    isAgent &&
      isLiveState(
        live?.derivedState ?? (ws.status === "running" ? "working" : "stopped"),
      ),
  );
  const derived = isAgent ? deriveAgentState(ws, live, now) : null;

  return (
    <WorkspaceSidebarMenu workspace={ws}>
      <Link
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: repoId, workspaceId: ws.id }}
        className={cn(
          "flex items-center rounded-[8px]",
          isExpanded
            ? "min-h-[36px] w-full px-2 py-1"
            : "h-7 w-7 justify-center",
          "transition-colors duration-150",
          "hover:bg-(--color-bg-elevated)",
          "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          active && "bg-(--color-bg-selected)",
        )}
      >
        <GlassTooltip content={ws.name} side="right" disabled={isExpanded}>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {derived ? (
              <AgentStatusIndicator state={derived.state} />
            ) : (
              <StatusDot status={ws.status} />
            )}
          </span>
        </GlassTooltip>
        {isExpanded && (
          <span className="ml-2 flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-left text-[13px] leading-none",
                active
                  ? "text-(--color-text-primary)"
                  : "text-(--color-text-secondary)",
              )}
            >
              {ws.name}
            </span>
            {/* Honest status replaces the branch on agent rows (S0.1-T3); the
                branch relocated to the workspace header. Local rows keep it. */}
            {derived ? (
              <AgentStatusMetaLine
                state={derived.state}
                since={derived.since}
                exitCode={ws.exitCode}
              />
            ) : (
              ws.branch && (
                <code className="truncate text-left text-[10.5px] leading-none text-(--color-text-muted)">
                  {ws.branch}
                </code>
              )
            )}
          </span>
        )}
      </Link>
    </WorkspaceSidebarMenu>
  );
}

function SidebarFooter({
  isExpanded,
  onToggle,
}: {
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const openAddRepositoryPicker = useUiStore((s) => s.openAddRepositoryPicker);

  return (
    <div className="flex flex-col gap-1 border-t border-(--color-border-subtle) p-1.5">
      {isExpanded ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={openAddRepositoryPicker}
            className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2.5 text-[13px] font-medium text-(--color-text-secondary) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
          >
            <Plus size={13} className="text-(--color-accent-text)" />
            Add repository
          </button>
          <GlassTooltip content="Collapse sidebar (⌘B)" side="right">
            <button
              type="button"
              onClick={onToggle}
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
            >
              <PanelLeftClose size={14} />
            </button>
          </GlassTooltip>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <GlassTooltip content="Add repository" side="right">
            <button
              type="button"
              onClick={openAddRepositoryPicker}
              aria-label="Add repository"
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-(--color-accent-text) transition-colors duration-150 hover:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
            >
              <Plus size={14} />
            </button>
          </GlassTooltip>
          <GlassTooltip content="Expand sidebar (⌘B)" side="right">
            <button
              type="button"
              onClick={onToggle}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
            >
              <PanelLeft size={14} />
            </button>
          </GlassTooltip>
        </div>
      )}
    </div>
  );
}
