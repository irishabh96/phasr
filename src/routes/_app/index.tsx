import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Sparkles } from "lucide-react";
import {
  desktopSessionGreetingName,
  readDesktopSession,
} from "@/lib/desktopAuth";
import { useOpenExistingFlow } from "@/lib/hooks/useOpenExistingFlow";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";

function Home() {
  const { data: repositories, isLoading } = useRepositories();
  const lastWorkspace = useUiStore((s) => s.lastWorkspace);

  // Re-entry restore (open decision #5): prefer the *actual* last-open
  // workspace so returning users' muscle memory is preserved. Only trust the
  // stored repo if it still exists in the live list (guards stale/cross-account
  // values). We load ONLY the restore repo's workspaces — a no-restore boot
  // falls through to the Worklist home (below) without needing that fetch.
  const storedRepoValid =
    !!lastWorkspace &&
    !!repositories?.some((r) => r.id === lastWorkspace.repositoryId);
  const restoreRepo = storedRepoValid
    ? repositories!.find((r) => r.id === lastWorkspace!.repositoryId)
    : undefined;
  const { data: workspaces, isLoading: wsLoading } = useWorkspaces(
    restoreRepo?.id,
  );

  if (isLoading || (restoreRepo && wsLoading)) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Loading…
      </div>
    );
  }

  if (!repositories || repositories.length === 0) {
    return <WelcomeState />;
  }

  // Restore the real last-open workspace when it still resolves in its repo's
  // list. A stale/deleted id simply falls through to the Worklist — never a
  // dead-end.
  if (restoreRepo) {
    const restored = workspaces?.find(
      (w) => w.id === lastWorkspace!.workspaceId,
    );
    if (restored) {
      return (
        <Navigate
          to="/repositories/$repositoryId/workspaces/$workspaceId"
          params={{ repositoryId: restoreRepo.id, workspaceId: restored.id }}
          replace
        />
      );
    }
  }

  // No valid last-workspace but ≥1 repo → the cross-repo Worklist home (story
  // F2). New users land here instead of a bare repo empty-state; returning
  // users kept their restore above.
  return <Navigate to="/worklist" replace />;
}

function WelcomeState() {
  const navigate = useNavigate();
  const openExisting = useOpenExistingFlow();

  const greeting = greetingForHour(
    new Date().getHours(),
    desktopSessionGreetingName(readDesktopSession()),
  );

  return (
    // Bias the greeting toward optical center (~42vh) — true-centering it leaves
    // a heavy gap above and reads as sitting low.
    <div className="flex h-full items-center justify-center px-8 pb-[20vh]">
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
