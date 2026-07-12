import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
  GitMerge,
  GitPullRequest,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { ConfirmDialog, ErrorDialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { useGitBranchStatus } from "@/lib/hooks/useGit";
import { useRepository } from "@/lib/hooks/useRepositories";
import {
  useArchiveWorkspace,
  useCheckWorkspaceDelete,
  useDeleteWorkspace,
  useOpenPullRequest,
} from "@/lib/hooks/useWorkspaces";
import { dismissToast, showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";

interface WorkspaceActionsMenuProps {
  workspace: Workspace;
}

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function WorkspaceActionsMenu({ workspace }: WorkspaceActionsMenuProps) {
  const { data: repository } = useRepository(workspace.repositoryId);
  const { data: branchStatus } = useGitBranchStatus(workspace.id);
  const navigate = useNavigate();
  const archive = useArchiveWorkspace();
  const openPr = useOpenPullRequest();
  const checkDelete = useCheckWorkspaceDelete();
  const deleteWorkspace = useDeleteWorkspace();

  // After archive/delete, kick the user back to home — the sidebar will
  // surface a different workspace to select.
  const leaveWorkspace = () => {
    void navigate({ to: "/" });
  };

  const [open, setOpen] = useState(false);
  const [errorState, setErrorState] = useState<{
    title: string;
    error: unknown;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isLocalWorkspace = workspace.workspaceKind === "local";
  const canOpenPr =
    !isLocalWorkspace && !!workspace.branch && !!repository?.remoteUrl;
  const canArchive = !isLocalWorkspace && workspace.status !== "archived";
  const canMergeToMain =
    !isLocalWorkspace && !!workspace.branch && !!repository?.localPath;
  const mergeBlocked = !branchStatus
    ? null
    : branchStatus.aheadOfTarget === 0
      ? "Nothing to merge"
      : branchStatus.behindOfTarget > 0
        ? `Branch is behind ${repository?.defaultBranch ?? "main"} — sync first`
        : null;

  // Raw error is humanized inside ErrorDialog (never shown raw).
  const showError = (title: string, error: unknown) => {
    setErrorState({ title, error });
  };

  const handleArchive = () => {
    setOpen(false);
    archive.mutate(workspace.id, {
      onSuccess: leaveWorkspace,
      onError: (err) => showError("Couldn't archive workspace", err),
    });
  };

  const handleOpenPr = async () => {
    setOpen(false);
    // Open PR pushes the branch then opens the compare page — several
    // seconds during which the menu is already gone. Surface a toast so
    // the action isn't silent; dismiss it once the browser opens (or an
    // error dialog takes over).
    const toastId = showToast({
      title: "Opening pull request…",
      message: "Pushing your branch, then opening the compare page.",
      intent: "info",
      timeoutMs: 30000,
    });
    try {
      const result = await openPr.mutateAsync(workspace.id);
      dismissToast(toastId);
      await openUrl(result.url);
    } catch (err) {
      dismissToast(toastId);
      showError("Couldn't open pull request", err);
    }
  };

  const handleDelete = async () => {
    setOpen(false);
    let warning = "";
    try {
      const check = await checkDelete.mutateAsync(workspace.id);
      if (check.hasUnpushedCommits) {
        warning =
          "\n\nThis branch has commits that haven't been pushed to origin.";
      }
    } catch {
      /* non-blocking */
    }
    setConfirmState({
      title: `Delete workspace "${workspace.name}"?`,
      body:
        `This stops the agent, removes the worktree, and deletes the branch ` +
        `${workspace.branch ?? ""}. The agent's commits on this branch will be gone.${warning}`,
      confirmLabel: "Delete workspace",
      destructive: true,
      onConfirm: () => {
        setConfirmState(null);
        deleteWorkspace.mutate(
          { id: workspace.id, repositoryId: workspace.repositoryId },
          {
            onSuccess: leaveWorkspace,
            onError: (err) => showError("Couldn't delete workspace", err),
          },
        );
      },
    });
  };

  // Local workspaces expose no header actions here — the only one was a
  // destructive "Remove from Phasr", which still lives in the sidebar's
  // right-click menu. Render nothing.
  if (isLocalWorkspace) return null;

  return (
    <>
      <div ref={containerRef} className="relative">
        <GlassButton
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          title="Workspace actions"
          className="gap-0.5 px-1.5"
        >
          <MoreHorizontal size={13} />
          <ChevronDown size={11} />
        </GlassButton>

        {open && (
          <div className="absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden glass-modal animate-[modal-in_180ms_var(--ease-glass)]">
            <ul className="p-1 text-[12.5px]">
              {canMergeToMain && (
                <MenuItem
                  icon={<GitMerge size={12} />}
                  label={`Merge to ${repository?.defaultBranch ?? "main"}`}
                  onClick={() => {
                    setOpen(false);
                    setMergeOpen(true);
                  }}
                  disabled={!!mergeBlocked}
                  {...(mergeBlocked ? { title: mergeBlocked } : {})}
                />
              )}
              {canOpenPr && (
                <MenuItem
                  icon={<GitPullRequest size={12} />}
                  label={
                    openPr.isPending
                      ? "Pushing & opening…"
                      : "Open pull request"
                  }
                  onClick={handleOpenPr}
                  disabled={openPr.isPending}
                />
              )}
              {canArchive && (
                <MenuItem
                  icon={<Archive size={12} />}
                  label="Archive"
                  onClick={handleArchive}
                  disabled={archive.isPending}
                />
              )}
              {(canMergeToMain || canOpenPr || canArchive) && (
                <li
                  className="my-1 h-px bg-(--glass-border-hairline)"
                  aria-hidden
                />
              )}
              <MenuItem
                icon={<Trash2 size={12} />}
                label="Delete workspace"
                onClick={handleDelete}
                disabled={deleteWorkspace.isPending}
                danger
              />
            </ul>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmState !== null}
        onOpenChange={(o) => !o && setConfirmState(null)}
        title={confirmState?.title ?? ""}
        description={confirmState?.body ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? "Confirm"}
        destructive={confirmState?.destructive ?? false}
        onConfirm={() => confirmState?.onConfirm()}
      />

      <ErrorDialog
        open={errorState !== null}
        onOpenChange={(o) => !o && setErrorState(null)}
        title={errorState?.title}
        error={errorState?.error}
      />

      <MergeToMainDialog
        workspace={workspace}
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
      />
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={cn(
          "flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left",
          "transition-colors duration-100",
          "hover:bg-(--color-bg-hover)",
          danger
            ? "text-(--color-danger) hover:bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)]"
            : "text-(--color-text-primary)",
          "disabled:opacity-60",
        )}
      >
        {icon}
        <span className="flex-1 leading-none">{label}</span>
      </button>
    </li>
  );
}
