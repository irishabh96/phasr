import { open } from "@tauri-apps/plugin-dialog";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, FolderOpen, GitBranch, Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { NewWorkspaceForm } from "@/components/NewWorkspaceForm";
import { RepositoryQuickActions } from "@/components/RepositoryQuickActions";
import { RepoTabBar } from "@/components/RepoTabBar";
import { RepoTabContent } from "@/components/RepoTabContent";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { StatusDot } from "@/components/ui/StatusDot";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import {
  useDeleteRepository,
  useGitInitRepository,
  useRepository,
  useUpdateRepository,
} from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { Repository, Workspace, WorkspaceStatus } from "@/lib/types";

const STATUS_ORDER: WorkspaceStatus[] = [
  "running",
  "pending",
  "completed",
  "failed",
  "stopped",
  "archived",
];

function RepositoryView() {
  const { repositoryId } = Route.useParams();
  const navigate = useNavigate();
  const { data: repository } = useRepository(repositoryId);
  const { data: workspaces } = useWorkspaces(repositoryId);
  const { data: runCommands } = useRunCommands(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);
  const ensureTabs = useUiStore((s) => s.ensureTabs);
  const pendingNewWorkspaceRepoId = useUiStore((s) => s.pendingNewWorkspaceRepoId);
  const clearPendingNewWorkspace = useUiStore((s) => s.clearPendingNewWorkspace);

  const localPath = repository?.localPath ?? null;
  const validation = useQuery({
    queryKey: ["repoPathValidation", repositoryId, localPath],
    queryFn: () => tauri.validateRepositoryPath(localPath ?? ""),
    enabled: !!localPath,
  });

  const pinnedRunCommands = (runCommands ?? []).filter((rc) => rc.pinned);
  const hasPickerCommands = (runCommands ?? []).length > 0;
  const hasHeaderActions = pinnedRunCommands.length > 0 || hasPickerCommands;

  const [showForm, setShowForm] = useState(false);

  // Initialize the tab strip for this repo on first visit.
  useEffect(() => {
    ensureTabs(repositoryId);
  }, [repositoryId, ensureTabs]);

  // ⌘W → close active tab (instead of the OS-default Close Window).
  // The Tauri menu in `lib.rs` strips the OS accelerator so this listener
  // gets the keystroke first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "w" || e.shiftKey) return;
      const state = useUiStore.getState().repoTabs[repositoryId];
      if (!state) return;
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      if (!active?.closable) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const closed = useUiStore.getState().closeRepoTab(repositoryId, active.id);
      if (closed?.kind === "terminal" && closed.ptySessionId) {
        void tauri.stopSessionTerminal(closed.ptySessionId).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [repositoryId]);

  // Right-click menu's "New workspace" sets a Zustand flag and navigates
  // here. Consume + clear so the form opens once.
  useEffect(() => {
    if (pendingNewWorkspaceRepoId === repositoryId) {
      setShowForm(true);
      clearPendingNewWorkspace();
    }
  }, [pendingNewWorkspaceRepoId, repositoryId, clearPendingNewWorkspace]);

  if (repository && localPath && validation.data && !validation.data.isGitRepo) {
    return (
      <BrokenRepositoryView
        repositoryId={repositoryId}
        repositoryName={repository.name}
        localPath={localPath}
        folderExists={validation.data.exists && validation.data.isDir}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasHeaderActions && (
        <div className="flex shrink-0 items-center justify-end gap-1 px-6 pt-3">
          {pinnedRunCommands.map((rc) => (
            <GlassButton
              key={rc.id}
              variant="outline"
              size="sm"
              onClick={() => runPanel.openTab(rc.id)}
              title={rc.command}
            >
              <Play size={10} fill="currentColor" />
              {rc.name}
            </GlassButton>
          ))}
          <RunCommandPicker repositoryId={repositoryId} />
        </div>
      )}

      <RepoTabBar repositoryId={repositoryId} />

      <RepoTabContent
        repositoryId={repositoryId}
        repoPath={localPath ?? ""}
        workspacesContent={
          <WorkspacesTabBody
            repository={repository}
            workspaces={workspaces ?? []}
            repositoryId={repositoryId}
            showForm={showForm}
            onCancelForm={() => setShowForm(false)}
            onWorkspaceCreated={(workspace) => {
              setShowForm(false);
              navigate({
                to: "/repositories/$repositoryId/workspaces/$workspaceId",
                params: { repositoryId, workspaceId: workspace.id },
              });
            }}
            onNewWorkspace={() => setShowForm(true)}
          />
        }
      />

      <RunCommandsPane repositoryId={repositoryId} />
    </div>
  );
}

function WorkspacesTabBody({
  repository,
  workspaces,
  repositoryId,
  showForm,
  onCancelForm,
  onWorkspaceCreated,
  onNewWorkspace,
}: {
  repository: Repository | undefined;
  workspaces: Workspace[];
  repositoryId: string;
  showForm: boolean;
  onCancelForm: () => void;
  onWorkspaceCreated: (workspace: Workspace) => void;
  onNewWorkspace: () => void;
}) {
  const grouped = groupWorkspaces(workspaces);
  const isEmpty = workspaces.length === 0 && !showForm;

  // Empty state: center QuickActions vertically + horizontally in the
  // entire tab area so the page reads as a focused entry point.
  if (isEmpty && repository) {
    return (
      <div className="flex h-full w-full items-center justify-center px-8 py-8">
        <RepositoryQuickActions repository={repository} onNewWorkspace={onNewWorkspace} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      {showForm && (
        <GlassPanel className="p-4">
          <NewWorkspaceForm
            repositoryId={repositoryId}
            onCreated={onWorkspaceCreated}
            onCancel={onCancelForm}
          />
        </GlassPanel>
      )}

      <div className={cn(showForm && "mt-8", "space-y-6")}>
        {STATUS_ORDER.map((status) => {
          const list = grouped[status];
          if (!list || list.length === 0) return null;
          return (
            <section key={status}>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
                {status} <span className="text-(--color-text-secondary)">{list.length}</span>
              </h2>
              <GlassPanel className="mt-2 divide-y divide-(--glass-border-hairline)">
                {list.map((workspace) => (
                  <WorkspaceRow
                    key={workspace.id}
                    repositoryId={repositoryId}
                    workspace={workspace}
                  />
                ))}
              </GlassPanel>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceRow({
  repositoryId,
  workspace,
}: {
  repositoryId: string;
  workspace: Workspace;
}) {
  return (
    <Link
      to="/repositories/$repositoryId/workspaces/$workspaceId"
      params={{ repositoryId, workspaceId: workspace.id }}
      className={cn(
        "flex items-center gap-3 px-4 py-2.5",
        "transition-colors duration-150",
        "hover:bg-[color-mix(in_oklab,white_4%,transparent)]",
      )}
    >
      <StatusDot status={workspace.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-none">{workspace.name}</div>
        <code className="mt-1 block truncate text-[11px] text-(--color-text-muted)">
          {workspace.command}
        </code>
      </div>
      <span className="shrink-0 text-[11px] text-(--color-text-muted)">
        {relativeTime(workspace.createdAt)}
      </span>
    </Link>
  );
}

function BrokenRepositoryView({
  repositoryId,
  repositoryName,
  localPath,
  folderExists,
}: {
  repositoryId: string;
  repositoryName: string;
  localPath: string;
  folderExists: boolean;
}) {
  const navigate = useNavigate();
  const initRepository = useGitInitRepository();
  const updateRepository = useUpdateRepository(repositoryId);
  const deleteRepository = useDeleteRepository();
  const [error, setError] = useState<string | null>(null);

  const handleInit = async () => {
    setError(null);
    try {
      await initRepository.mutateAsync(repositoryId);
    } catch (err) {
      setError(String(err));
    }
  };

  const handlePickAnother = async () => {
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Pick a different folder for this repository",
    });
    if (typeof selected !== "string") return;
    try {
      await updateRepository.mutateAsync({ localPath: selected });
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove "${repositoryName}" from Phasr?`)) return;
    try {
      await deleteRepository.mutateAsync(repositoryId);
      navigate({ to: "/" });
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        to="/"
        className="text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-primary)"
      >
        ← All repositories
      </Link>
      <h1 className="mt-1 truncate text-[20px] font-semibold tracking-tight leading-none">
        {repositoryName}
      </h1>
      <code className="mt-1 block truncate text-[11.5px] text-(--color-text-muted)">
        {localPath}
      </code>

      <GlassPanel className="mt-8 p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-(--color-warning)" />
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium">
              {folderExists
                ? "This folder isn't a git repository"
                : "This folder no longer exists on disk"}
            </h2>
            <p className="mt-1 text-[12px] text-(--color-text-secondary)">
              {folderExists
                ? "Phasr needs git to isolate agent work in worktrees. Choose one:"
                : "It may have been moved or deleted. Pick a different folder, or remove the repository."}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-col items-start gap-2">
          {folderExists && (
            <GlassButton
              variant="primary"
              size="sm"
              onClick={handleInit}
              disabled={initRepository.isPending}
            >
              <GitBranch size={12} />
              {initRepository.isPending ? "Initializing…" : "Initialize git here"}
            </GlassButton>
          )}
          <GlassButton
            variant="outline"
            size="sm"
            onClick={handlePickAnother}
            disabled={updateRepository.isPending}
          >
            <FolderOpen size={12} />
            Pick a different folder
          </GlassButton>
          <GlassButton
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={deleteRepository.isPending}
            className="text-(--color-danger) hover:bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)]"
          >
            <Trash2 size={12} />
            Remove this repository
          </GlassButton>
        </div>

        {error && <p className="mt-4 text-[12px] text-(--color-danger)">{error}</p>}
      </GlassPanel>
    </div>
  );
}

function groupWorkspaces(workspaces: Workspace[]) {
  const groups: Record<string, Workspace[]> = {};
  for (const workspace of workspaces) {
    (groups[workspace.status] ??= []).push(workspace);
  }
  return groups;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/")({
  component: RepositoryView,
});
