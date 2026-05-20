import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
  GitPullRequest,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useRepository } from "@/lib/hooks/useRepositories";
import {
  useArchiveWorkspace,
  useCheckWorkspaceDelete,
  useDeleteWorkspace,
  useOpenPullRequest,
} from "@/lib/hooks/useWorkspaces";
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
  const [errorTitle, setErrorTitle] = useState("Action failed");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
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

  const canOpenPr = !!workspace.branch && !!repository?.remoteUrl;
  const canArchive = workspace.status !== "archived";

  const showError = (title: string, message: string) => {
    setErrorTitle(title);
    setErrorMessage(message);
  };

  const handleArchive = () => {
    setOpen(false);
    archive.mutate(workspace.id, {
      onSuccess: leaveWorkspace,
      onError: (err) => showError("Couldn't archive workspace", String(err)),
    });
  };

  const handleOpenPr = async () => {
    setOpen(false);
    try {
      const result = await openPr.mutateAsync(workspace.id);
      await openUrl(result.url);
    } catch (err) {
      showError("Couldn't open pull request", String(err));
    }
  };

  const handleDelete = async () => {
    setOpen(false);
    let warning = "";
    try {
      const check = await checkDelete.mutateAsync(workspace.id);
      if (check.hasUnpushedCommits) {
        warning = "\n\nThis branch has commits that haven't been pushed to origin.";
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
            onError: (err) => showError("Couldn't delete workspace", String(err)),
          },
        );
      },
    });
  };

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
              {canOpenPr && (
                <MenuItem
                  icon={<GitPullRequest size={12} />}
                  label={openPr.isPending ? "Pushing & opening…" : "Open pull request"}
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
              <li className="my-1 h-px bg-(--glass-border-hairline)" aria-hidden />
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

      {confirmState && <ConfirmDialog state={confirmState} onCancel={() => setConfirmState(null)} />}

      {errorMessage && (
        <ErrorDialog
          title={errorTitle}
          message={errorMessage}
          onClose={() => setErrorMessage(null)}
        />
      )}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
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

function ConfirmDialog({ state, onCancel }: { state: ConfirmState; onCancel(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-(--color-bg-overlay) p-4 backdrop-blur-md"
      onClick={onCancel}
    >
      <div
        className="glass-modal w-full max-w-md animate-[modal-in_200ms_var(--ease-glass)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-(--glass-border-hairline) px-5 py-3.5">
          <h3 className="text-[13.5px] font-semibold leading-none">{state.title}</h3>
        </header>
        <div className="whitespace-pre-line px-5 py-4 text-[12.5px] leading-relaxed text-(--color-text-secondary)">
          {state.body}
        </div>
        <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
          <GlassButton variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </GlassButton>
          <GlassButton
            variant={state.destructive ? "danger" : "primary"}
            size="sm"
            onClick={state.onConfirm}
          >
            {state.confirmLabel}
          </GlassButton>
        </footer>
      </div>
    </div>
  );
}

function ErrorDialog({
  title,
  message,
  onClose,
}: {
  title: string;
  message: string;
  onClose(): void;
}) {
  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-(--color-bg-overlay) p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="glass-modal w-full max-w-md animate-[modal-in_200ms_var(--ease-glass)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-(--glass-border-hairline) px-5 py-3.5">
          <h3 className="text-[13.5px] font-semibold leading-none">{title}</h3>
        </header>
        <div className="px-5 py-4 text-[12.5px] leading-relaxed text-(--color-danger)">
          {message}
        </div>
        <footer className="flex justify-end border-t border-(--glass-border-hairline) px-4 py-3">
          <GlassButton variant="outline" size="sm" onClick={onClose}>
            Close
          </GlassButton>
        </footer>
      </div>
    </div>
  );
}
