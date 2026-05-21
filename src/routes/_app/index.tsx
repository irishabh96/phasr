import { useUser } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import {
  ExternalLink,
  FolderOpen,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { isClerkConfigured } from "@/lib/clerk";
import { useDeleteRepository, useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Repository } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  const openFileSearch = useUiStore((s) => s.openFileSearch);
  const deleteRepo = useDeleteRepository();
  const [confirming, setConfirming] = useState(false);

  const openTerminal = useCallback(() => {
    requestNewWorkspace(repo.id);
  }, [repo.id, requestNewWorkspace]);

  const openInEditor = useCallback(() => {
    if (!repo.localPath) return;
    void tauri.launchApp("vscode", repo.localPath).catch(() => {
      /* VS Code not installed; menu would catch this via toast in a real wire-up */
    });
  }, [repo.localPath]);

  const searchFiles = useCallback(() => {
    if (!repo.localPath) return;
    openFileSearch(repo.id, repo.localPath);
  }, [repo.id, repo.localPath, openFileSearch]);

  // Local keyboard shortcuts — only active while this screen is mounted.
  // The global ⌘T/⌘P in `_app.tsx` require an active workspace context;
  // here there's none yet, so we provide our own.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (key === "t") {
        e.preventDefault();
        e.stopImmediatePropagation();
        openTerminal();
      } else if (key === "o") {
        e.preventDefault();
        openInEditor();
      } else if (key === "p") {
        e.preventDefault();
        searchFiles();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [openTerminal, openInEditor, searchFiles]);

  const handleDelete = async () => {
    await deleteRepo.mutateAsync(repo.id);
    setConfirming(false);
  };

  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-md">
        <ul className="flex flex-col">
          <ActionRow
            icon={<SquareTerminal size={15} />}
            label="Open Terminal"
            shortcut={["⌘", "T"]}
            onClick={openTerminal}
          />
          <ActionRow
            icon={<ExternalLink size={15} />}
            label="Open in VS Code"
            shortcut={["⌘", "O"]}
            onClick={openInEditor}
            disabled={!repo.localPath}
          />
          <ActionRow
            icon={<Search size={15} />}
            label="Search Files"
            shortcut={["⌘", "P"]}
            onClick={searchFiles}
            disabled={!repo.localPath}
          />
        </ul>

        <div className="mt-8 flex justify-center">
          {confirming ? (
            <div className="flex items-center gap-2 text-[12px] text-(--color-text-secondary)">
              <span>
                Delete <span className="font-medium">{repo.name}</span>?
              </span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteRepo.isPending}
                className="rounded px-2 py-0.5 text-(--color-danger) hover:bg-(--color-bg-hover)"
              >
                {deleteRepo.isPending ? "Deleting…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded px-2 py-0.5 text-(--color-text-muted) hover:bg-(--color-bg-hover)"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12.5px] text-(--color-text-muted)/60 transition-colors hover:text-(--color-danger)"
            >
              <Trash2 size={12} />
              Delete repository
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  shortcut,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  shortcut: string[];
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "enabled:hover:bg-(--color-bg-hover)",
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-(--color-text-muted) group-enabled:group-hover:text-(--color-text-primary)">
          {icon}
        </span>
        <span className="flex-1 truncate text-[13px] text-(--color-text-secondary) group-enabled:group-hover:text-(--color-text-primary)">
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
          {shortcut.map((k, i) => (
            <kbd
              key={i}
              className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-1.5 text-(--color-text-muted)"
            >
              {k}
            </kbd>
          ))}
        </span>
      </button>
    </li>
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
