import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Sparkles } from "lucide-react";
import { RepoHomeShell } from "@/components/RepoHomeShell";
import {
  desktopSessionGreetingName,
  readDesktopSession,
} from "@/lib/desktopAuth";
import { useOpenExistingFlow } from "@/lib/hooks/useOpenExistingFlow";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import type { Repository } from "@/lib/types";

function Home() {
  const { data: repositories, isLoading } = useRepositories();
  const lastWorkspace = useUiStore((s) => s.lastWorkspace);
  const mostRecentRepo = repositories?.[0];

  // Re-entry restore: prefer the *actual* last-open workspace over the
  // newest one. Only trust the stored repo if it still exists in the live
  // list (guards stale/cross-account values); otherwise fall back to the
  // most-recent repo. We load whichever repo's workspaces we might redirect
  // into, so the query key is stable regardless of which path we take.
  const storedRepoValid =
    !!lastWorkspace &&
    !!repositories?.some((r) => r.id === lastWorkspace.repositoryId);
  const targetRepo = storedRepoValid
    ? repositories!.find((r) => r.id === lastWorkspace!.repositoryId)
    : mostRecentRepo;
  const { data: workspaces, isLoading: wsLoading } = useWorkspaces(
    targetRepo?.id,
  );

  if (isLoading || (targetRepo && wsLoading)) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Loading…
      </div>
    );
  }

  if (!repositories || repositories.length === 0) {
    return <WelcomeState />;
  }

  const repo = targetRepo ?? mostRecentRepo!;

  // Restore the real last-open workspace when it still resolves in its
  // repo's list. A stale workspace id (deleted since last session) simply
  // falls through to the newest-workspace behavior below — never a dead-end.
  if (storedRepoValid) {
    const restored = workspaces?.find(
      (w) => w.id === lastWorkspace!.workspaceId,
    );
    if (restored) {
      return (
        <Navigate
          to="/repositories/$repositoryId/workspaces/$workspaceId"
          params={{ repositoryId: repo.id, workspaceId: restored.id }}
          replace
        />
      );
    }
  }

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

  return <RepoEmptyState repo={repo} />;
}

function RepoEmptyState({ repo }: { repo: Repository }) {
  return <RepoHomeShell repo={repo} />;
}

function WelcomeState() {
  const navigate = useNavigate();
  const openExisting = useOpenExistingFlow();

  const greeting = greetingForHour(
    new Date().getHours(),
    desktopSessionGreetingName(readDesktopSession()),
  );

  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-2xl text-center">
        <h1 className="text-[24px] font-semibold tracking-tight leading-none">
          {greeting}
        </h1>

        <div className="mx-auto mt-10 grid w-full max-w-[720px] grid-cols-1 justify-items-center gap-6 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void navigate({ to: "/new-project" })}
            className="glass-panel group flex h-full w-full max-w-[320px] flex-col items-start p-6 text-left transition-all duration-150 hover:border-(--glass-border-strong)"
          >
            <div className="flex items-center gap-2 text-(--color-accent-text)">
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
            onClick={() => void openExisting()}
            className="glass-panel group flex h-full w-full max-w-[320px] flex-col items-start p-6 text-left transition-all duration-150 hover:border-(--glass-border-strong)"
          >
            <div className="flex items-center gap-2 text-(--color-text-secondary)">
              <FolderOpen size={15} />
              <span className="text-[13px] font-medium">
                Open existing project
              </span>
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

/**
 * Time-of-day greeting in local time. We skip "Good night" intentionally
 * — Phasr is a productivity tool and the late-hours bucket stays as
 * "Good evening" to avoid suggesting the user should sign off.
 */
function greetingForHour(hour: number, name: string | null): string {
  const greeting =
    hour >= 5 && hour < 12
      ? "Good morning"
      : hour >= 12 && hour < 17
        ? "Good afternoon"
        : "Good evening";

  return name ? `${greeting}, ${name}` : greeting;
}

export const Route = createFileRoute("/_app/")({
  component: Home,
});
