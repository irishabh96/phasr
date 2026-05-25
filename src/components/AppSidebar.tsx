import { Link, useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  PanelLeft,
  PanelLeftClose,
  Plus,
} from "lucide-react";
import { RepositorySidebarMenu } from "@/components/RepositorySidebarMenu";
import { WorkspaceSidebarMenu } from "@/components/WorkspaceSidebarMenu";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { StatusDot } from "@/components/ui/StatusDot";
import type { Workspace, Repository } from "@/lib/types";

export function AppSidebar() {
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const repositories = useRepositories();
  const params = useParams({ strict: false });
  const activeRepoId =
    (params as { repositoryId?: string }).repositoryId ?? null;
  const activeWorkspaceId =
    (params as { workspaceId?: string }).workspaceId ?? null;

  if (sidebarMode === "hidden") return null;

  const isExpanded = sidebarMode === "pinned";

  return (
    <aside
      className={cn(
        "relative shrink-0",
        "flex flex-col",
        "bg-(--color-bg-sidebar) border-r border-(--color-border-subtle)",
        "transition-[width] duration-[220ms]",
        "[transition-timing-function:var(--ease-glass)]",
        isExpanded ? "w-[var(--layout-sidebar-width)]" : "w-[52px]",
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <nav className="flex flex-col gap-2 px-1.5">
          {repositories.data?.map((repo) => (
            <RepoBlock
              key={repo.id}
              repo={repo}
              isExpanded={isExpanded}
              isActive={repo.id === activeRepoId}
              activeWorkspaceId={activeWorkspaceId}
            />
          ))}
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
  const workspaceExpanded = useUiStore(
    (s) => s.repoWorkspaceExpanded[repo.id] ?? true,
  );
  const toggleWorkspaceExpanded = useUiStore(
    (s) => s.toggleRepoWorkspaceExpanded,
  );
  const initial = repo.name.charAt(0).toUpperCase();
  const ExpandIcon = workspaceExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col">
      <RepositorySidebarMenu repository={repo}>
        <div
          onClick={() => toggleWorkspaceExpanded(repo.id)}
          className={cn(
            "group/repo flex h-[38px] cursor-pointer items-center rounded-[10px]",
            isExpanded ? "pl-3 pr-1" : "justify-center",
            "outline-none transition-colors duration-150",
            "hover:bg-(--color-bg-hover)",
            "focus-visible:bg-(--color-bg-hover) focus-visible:ring-1 focus-visible:ring-(--color-border-strong)",
            "data-[state=open]:bg-(--color-bg-elevated)",
            isActive &&
              "bg-[color-mix(in_oklab,var(--color-accent-500)_12%,transparent)]",
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
                    ? "bg-(--color-accent-500) text-(--color-text-inverse)"
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
                  title={
                    workspaceExpanded ? "Hide workspaces" : "Show workspaces"
                  }
                  aria-label={`${workspaceExpanded ? "Hide" : "Show"} workspaces in ${repo.name}`}
                  className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-active) hover:text-(--color-text-primary)"
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
                  title="New workspace"
                  aria-label={`New workspace in ${repo.name}`}
                  className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-(--color-text-muted) opacity-0 transition-all duration-150 hover:bg-(--color-bg-active) hover:text-(--color-text-primary) group-hover/repo:opacity-100 focus-visible:opacity-100"
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
          active && "bg-(--color-bg-elevated)",
        )}
      >
        <GlassTooltip content={ws.name} side="right" disabled={isExpanded}>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <StatusDot status={ws.status} />
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
            {ws.branch && (
              <code className="truncate text-left text-[10.5px] leading-none text-(--color-text-muted)">
                {ws.branch}
              </code>
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
            className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2.5 text-[13px] font-medium text-(--color-text-secondary) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          >
            <Plus size={13} className="text-(--color-accent-400)" />
            Add repository
          </button>
          <GlassTooltip content="Collapse sidebar (⌘B)" side="right">
            <button
              type="button"
              onClick={onToggle}
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
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
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-(--color-accent-400) transition-colors duration-150 hover:bg-(--color-bg-hover)"
            >
              <Plus size={14} />
            </button>
          </GlassTooltip>
          <GlassTooltip content="Expand sidebar (⌘B)" side="right">
            <button
              type="button"
              onClick={onToggle}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
            >
              <PanelLeft size={14} />
            </button>
          </GlassTooltip>
        </div>
      )}
    </div>
  );
}
