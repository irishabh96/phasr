import { useUser } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { FolderOpen, Plus, Sparkles } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { isClerkConfigured } from "@/lib/clerk";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import type { Repository } from "@/lib/types";

/**
 * Cheap wrapper around useUser() — only invokes the Clerk hook when
 * Clerk is configured (without a ClerkProvider parent the hook throws).
 * Returns null in local-only mode.
 */
function useFirstNameSafe(): string | null {
  if (!isClerkConfigured) return null;
  return useUserFirstName();
}

function useUserFirstName(): string | null {
  const { user } = useUser();
  return user?.firstName ?? null;
}

function Home() {
  const firstName = useFirstNameSafe();
  const { data: repositories, isLoading } = useRepositories();
  const mostRecentRepo = repositories?.[0];
  const { data: workspaces, isLoading: wsLoading } = useWorkspaces(mostRecentRepo?.id);

  if (isLoading || (mostRecentRepo && wsLoading)) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Loading…
      </div>
    );
  }

  if (!repositories || repositories.length === 0) {
    return <WelcomeState firstName={firstName} />;
  }

  const repo = mostRecentRepo!;
  const ws = workspaces?.[0];

  if (ws) {
    return (
      <Navigate
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: repo.id, workspaceId: ws.id }}
        replace
      />
    );
  }

  // Repo exists but has no workspaces — show a contextual landing for
  // that repo. The user gets a clear "+ New workspace" CTA instead of
  // an auto-popped modal that re-opens itself if dismissed.
  return <RepoEmptyState repo={repo} />;
}

function RepoEmptyState({ repo }: { repo: Repository }) {
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);

  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-md text-center">
        <h1 className="truncate text-[22px] font-semibold leading-tight tracking-tight">
          {repo.name}
        </h1>
        <p className="mt-2 text-[13px] text-(--color-text-secondary)">
          No workspaces yet. Spin one up to start working.
        </p>
        {repo.localPath && (
          <code className="mt-3 block truncate text-[11.5px] text-(--color-text-muted)">
            {repo.localPath}
          </code>
        )}
        <div className="mt-8 flex items-center justify-center">
          <GlassButton
            variant="primary"
            size="md"
            onClick={() => requestNewWorkspace(repo.id)}
          >
            <Plus size={13} />
            New workspace
          </GlassButton>
        </div>
      </div>
    </div>
  );
}

function WelcomeState({ firstName }: { firstName: string | null }) {
  const openNewProject = useUiStore((s) => s.openNewProjectModal);
  const openExisting = useUiStore((s) => s.openOpenExistingModal);

  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-2xl text-center">
        <h1 className="text-[24px] font-semibold tracking-tight leading-none">
          Welcome to Phasr{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-3 text-[13px] text-(--color-text-secondary)">
          Run multiple coding agents in parallel, each in its own isolated git worktree.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={openNewProject}
            className="glass-panel group p-6 text-left transition-all duration-150 hover:border-(--glass-border-strong)"
          >
            <div className="flex items-center gap-2 text-(--color-accent-400)">
              <Sparkles size={15} />
              <span className="text-[13px] font-medium">New project</span>
            </div>
            <p className="mt-2 text-[12px] text-(--color-text-secondary)">
              Empty repo, clone from URL, or start from a template.
            </p>
            <span className="mt-4 inline-flex h-7 items-center gap-1 rounded-[8px] border border-(--glass-border-hairline) bg-(--color-bg-hover) px-2.5 text-[12px] text-(--color-text-primary)">
              Get started →
            </span>
          </button>

          <button
            type="button"
            onClick={openExisting}
            className="glass-panel group p-6 text-left transition-all duration-150 hover:border-(--glass-border-strong)"
          >
            <div className="flex items-center gap-2 text-(--color-text-secondary)">
              <FolderOpen size={15} />
              <span className="text-[13px] font-medium">Open existing project</span>
            </div>
            <p className="mt-2 text-[12px] text-(--color-text-muted)">
              Point Phasr at a folder on disk that's already a git repo.
            </p>
            <span className="mt-4 inline-flex h-7 items-center gap-1 rounded-[8px] border border-(--glass-border-hairline) px-2.5 text-[12px] text-(--color-text-secondary)">
              Browse…
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_app/")({
  component: Home,
});
