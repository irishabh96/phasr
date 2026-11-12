import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "@tanstack/react-router";
import { Archive, GitMerge, GitPullRequest, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { ConfirmDialog, ErrorDialog } from "@/components/ui/Dialog";
import { useGitBranchStatus } from "@/lib/hooks/useGit";
import { mergeTargetBranch } from "@/lib/mergeTarget";
import { useRepository } from "@/lib/hooks/useRepositories";
import {
  useArchiveWorkspace,
  useCheckWorkspaceDelete,
  useDeleteWorkspace,
  useOpenPullRequest,
} from "@/lib/hooks/useWorkspaces";
import { dismissToast, showToast } from "@/lib/toast";
import type { Workspace } from "@/lib/types";

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

/** One task-level action, rendered as a menu item by the caller. */
export interface WorkspaceAction {
  id: "merge" | "open-pr" | "archive" | "delete";
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it's disabled (shown as the item's tooltip). */
  title?: string;
  danger?: boolean;
}

/**
 * The task's git/lifecycle actions — Merge into base, Open pull request,
 * Archive, Delete — plus the dialogs they open. They used to sit in the
 * session bar's "…" menu; the A-Workspace bar folds them into "Open in ▾".
 *
 * The dialogs live outside any menu (a menu unmounts its content as it
 * closes), so the caller renders `dialogs` next to its menu.
 *
 * Local workspaces return no actions: the only one was a destructive
 * "Remove from Phasr", which lives in the sidebar's right-click menu.
 */
export function useWorkspaceActions(workspace: Workspace): {
  actions: WorkspaceAction[];
  dialogs: ReactNode;
} {
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

  const [errorState, setErrorState] = useState<{
    title: string;
    error: unknown;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);

  const isLocalWorkspace = workspace.workspaceKind === "local";
  const canOpenPr =
    !isLocalWorkspace && !!workspace.branch && !!repository?.remoteUrl;
  const canArchive = !isLocalWorkspace && workspace.status !== "archived";
  const canMergeToMain =
    !isLocalWorkspace && !!workspace.branch && !!repository?.localPath;
  // Merges go into the task's base branch, not the repository default.
  const mergeTarget = mergeTargetBranch(branchStatus, workspace, repository);
  const mergeBlocked = !branchStatus
    ? null
    : branchStatus.aheadOfTarget === 0
      ? "Nothing to merge"
      : branchStatus.behindOfTarget > 0
        ? `Branch is behind ${mergeTarget} — sync first`
        : null;

  // Raw error is humanized inside ErrorDialog (never shown raw).
  const showError = (title: string, error: unknown) => {
    setErrorState({ title, error });
  };

  const handleArchive = () => {
    archive.mutate(workspace.id, {
      onSuccess: leaveWorkspace,
      onError: (err) => showError("Couldn't archive workspace", err),
    });
  };

  const handleOpenPr = async () => {
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

  const actions: WorkspaceAction[] = [];
  if (!isLocalWorkspace) {
    if (canOpenPr) {
      actions.push({
        id: "open-pr",
        icon: <GitPullRequest size={13} />,
        label: openPr.isPending ? "Pushing & opening…" : "Open pull request",
        onSelect: () => void handleOpenPr(),
        disabled: openPr.isPending,
      });
    }
    if (canMergeToMain) {
      actions.push({
        id: "merge",
        icon: <GitMerge size={13} />,
        label: `Merge into ${mergeTarget}`,
        onSelect: () => setMergeOpen(true),
        disabled: !!mergeBlocked,
        ...(mergeBlocked ? { title: mergeBlocked } : {}),
      });
    }
    if (canArchive) {
      actions.push({
        id: "archive",
        icon: <Archive size={13} />,
        label: "Archive",
        onSelect: handleArchive,
        disabled: archive.isPending,
      });
    }
    actions.push({
      id: "delete",
      icon: <Trash2 size={13} />,
      label: "Delete workspace",
      onSelect: () => void handleDelete(),
      disabled: deleteWorkspace.isPending,
      danger: true,
    });
  }

  const dialogs = (
    <>
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

      {isLocalWorkspace ? null : (
        <MergeToMainDialog
          workspace={workspace}
          open={mergeOpen}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </>
  );

  return { actions, dialogs };
}
