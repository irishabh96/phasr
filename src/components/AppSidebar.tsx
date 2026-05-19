import { Link, useParams } from "@tanstack/react-router";
import { Plus, PanelLeftClose, PanelLeft } from "lucide-react";
import { RepositorySidebarMenu } from "@/components/RepositorySidebarMenu";
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
  const activeRepoId = (params as { repositoryId?: string }).repositoryId ?? null;
  const activeWorkspaceId = (params as { workspaceId?: string }).workspaceId ?? null;

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
          <NewRepoButton isExpanded={isExpanded} />
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
  const initial = repo.name.charAt(0).toUpperCase();
  return (
    <div className="flex flex-col">
      <RepositorySidebarMenu repository={repo}>
        <Link
          to="/repositories/$repositoryId"
          params={{ repositoryId: repo.id }}
          className={cn(
            "flex h-[38px] items-center rounded-[10px]",
            isExpanded ? "px-3" : "justify-center",
            "transition-colors duration-150",
            "hover:bg-(--color-bg-elevated)",
            isActive && "bg-[color-mix(in_oklab,var(--color-accent-500)_12%,transparent)]",
          )}
        >
          <GlassTooltip content={repo.name} side="right" disabled={isExpanded}>
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]",
                "text-[11px] font-semibold leading-none",
                "transition-colors duration-150",
                isActive
                  ? "bg-(--color-accent-500) text-white"
                  : "bg-[color-mix(in_oklab,white_6%,transparent)] text-(--color-text-secondary)",
              )}
            >
              {initial}
            </span>
          </GlassTooltip>
          {isExpanded && (
            <span
              className={cn(
                "ml-2.5 min-w-0 flex-1 truncate text-left text-[14px] font-medium leading-none",
                isActive ? "text-(--color-text-primary)" : "text-(--color-text-secondary)",
              )}
            >
              {repo.name}
            </span>
          )}
        </Link>
      </RepositorySidebarMenu>
      {isActive && (
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
  if (!workspaces.data?.length) return null;
  return (
    <div
      className={cn(
        "mt-1.5 flex flex-col gap-0.5",
        isExpanded ? "ml-3.5 border-l border-(--glass-border-hairline) pl-2" : "items-center",
      )}
    >
      {workspaces.data.map((ws) => (
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
    <Link
      to="/repositories/$repositoryId/workspaces/$workspaceId"
      params={{ repositoryId: repoId, workspaceId: ws.id }}
      className={cn(
        "flex h-7 items-center rounded-[8px]",
        isExpanded ? "w-full px-2" : "h-7 w-7 justify-center",
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
        <span
          className={cn(
            "ml-2 min-w-0 flex-1 truncate text-left text-[13px] leading-none",
            active ? "text-(--color-text-primary)" : "text-(--color-text-secondary)",
          )}
        >
          {ws.name}
        </span>
      )}
    </Link>
  );
}

function NewRepoButton({ isExpanded }: { isExpanded: boolean }) {
  const openWizard = useUiStore((s) => s.openNewProjectModal);
  return (
    <button
      type="button"
      onClick={openWizard}
      className={cn(
        "flex h-[38px] items-center rounded-[10px]",
        isExpanded ? "px-3" : "justify-center",
        "text-(--color-text-muted)",
        "transition-colors duration-150",
        "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
      )}
    >
      <GlassTooltip content="New project" side="right" disabled={isExpanded}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]">
          <Plus size={14} />
        </span>
      </GlassTooltip>
      {isExpanded && (
        <span className="ml-2.5 min-w-0 flex-1 truncate text-left text-[14px] font-medium leading-none">
          New project
        </span>
      )}
    </button>
  );
}

function SidebarFooter({
  isExpanded,
  onToggle,
}: {
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "border-t border-(--color-border-subtle) p-1.5",
        isExpanded ? "flex justify-end" : "flex justify-center",
      )}
    >
      <GlassTooltip
        content={isExpanded ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"}
        side="right"
      >
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-[8px]",
            "text-(--color-text-muted)",
            "transition-colors duration-150",
            "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
          )}
        >
          {isExpanded ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
        </button>
      </GlassTooltip>
    </div>
  );
}
