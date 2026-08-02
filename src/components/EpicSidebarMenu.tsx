import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { Archive, Kanban, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  useArchiveEpic,
  useCheckWorkspaceDelete,
  useDeleteWorkspace,
} from "@/lib/hooks/useWorkspaces";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";

/**
 * The workflow (epic) node's right-click menu — the sibling of
 * `WorkspaceSidebarMenu`, closing the sidebar's last dead end (workflows had
 * NO way to be renamed, archived, or deleted):
 *
 *   1. Open board — the node's click target, repeated for discoverability.
 *   2. Rename… — the shared RenameWorkspaceModal (a parent row renames the
 *      workflow everywhere: sidebar, board header, worklist).
 *   3. Archive workflow — cascade: every ticket + the parent stamped
 *      archived, worktrees reclaimed, BRANCHES KEPT. Calm confirm.
 *   4. Delete workflow (danger) — cascade removes rows, worktrees AND
 *      branches; the confirm says so, with the unpushed-work warning when the
 *      integration branch carries commits origin never saw.
 */
export function EpicSidebarMenu({
  epic,
  subtaskIds,
  children,
}: {
  epic: Workspace;
  /** For the post-action bounce: a deleted/archived child can't stay open. */
  subtaskIds: readonly string[];
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const requestRename = useUiStore((s) => s.requestRenameWorkspace);
  const archiveEpic = useArchiveEpic();
  const checkDelete = useCheckWorkspaceDelete();
  const deleteWorkspace = useDeleteWorkspace();

  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(
    null,
  );
  const [unpushedWarning, setUnpushedWarning] = useState(false);

  const openBoard = () =>
    void navigate({
      to: "/repositories/$repositoryId/board/$parentId",
      params: { repositoryId: epic.repositoryId, parentId: epic.id },
    });

  /** The open route may be this workflow's board or one of its tickets —
   *  after archive/delete it must not stay on a retired surface. */
  const bounceIfInside = () => {
    const ctx = useUiStore.getState().activeWorkspaceContext;
    const insideTicket =
      !!ctx &&
      (ctx.workspaceId === epic.id ||
        subtaskIds.includes(ctx.workspaceId ?? ""));
    const onThisBoard = window.location.pathname.includes(
      `/board/${epic.id}`,
    );
    if (insideTicket || onThisBoard) void navigate({ to: "/worklist" });
  };

  const onRequestDelete = async () => {
    setUnpushedWarning(false);
    try {
      const check = await checkDelete.mutateAsync(epic.id);
      if (check.hasUnpushedCommits) setUnpushedWarning(true);
    } catch {
      /* non-blocking — proceed with the basic confirmation */
    }
    setConfirming("delete");
  };

  const onConfirm = () => {
    if (confirming === "archive") {
      archiveEpic.mutate(
        { parentId: epic.id, repositoryId: epic.repositoryId },
        {
          onSuccess: () => {
            setConfirming(null);
            showToast({ title: "Workflow archived", intent: "success" });
            bounceIfInside();
          },
          onError: (err) =>
            showToast({
              title: "Couldn't archive the workflow",
              intent: "error",
              message: humanizeError(err),
            }),
        },
      );
      return;
    }
    deleteWorkspace.mutate(
      { id: epic.id, repositoryId: epic.repositoryId },
      {
        onSuccess: () => {
          setConfirming(null);
          showToast({ title: "Workflow deleted", intent: "success" });
          bounceIfInside();
        },
        onError: (err) =>
          showToast({
            title: "Couldn't delete the workflow",
            intent: "error",
            message: humanizeError(err),
          }),
      },
    );
  };

  const pending = archiveEpic.isPending || deleteWorkspace.isPending;

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={cn(
              "z-(--z-dropdown) min-w-[190px] overflow-hidden p-1",
              "glass-modal animate-[modal-in_140ms_var(--ease-glass)]",
            )}
          >
            <Item icon={<Kanban size={13} />} onSelect={openBoard}>
              Open board
            </Item>
            <Item
              icon={<Pencil size={13} />}
              onSelect={() => requestRename(epic.id)}
            >
              Rename…
            </Item>
            <Separator />
            <Item
              icon={<Archive size={13} />}
              onSelect={() => setConfirming("archive")}
            >
              Archive workflow
            </Item>
            <Item
              icon={<Trash2 size={13} />}
              onSelect={() => void onRequestDelete()}
              danger
            >
              Delete workflow
            </Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {confirming && (
        <EpicConfirm
          mode={confirming}
          name={epic.name || epic.prompt || "this workflow"}
          ticketCount={subtaskIds.length}
          unpushedWarning={confirming === "delete" && unpushedWarning}
          pending={pending}
          onCancel={() => setConfirming(null)}
          onConfirm={onConfirm}
        />
      )}
    </>
  );
}

function Item({
  icon,
  children,
  onSelect,
  danger,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5",
        "text-[12.5px] leading-none outline-none",
        "transition-colors duration-100",
        "data-[highlighted]:bg-(--color-bg-hover)",
        danger
          ? "text-(--color-danger) data-[highlighted]:bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)]"
          : "text-(--color-text-primary)",
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
    </ContextMenu.Item>
  );
}

function Separator() {
  return (
    <ContextMenu.Separator className="my-1 h-px bg-(--glass-border-hairline)" />
  );
}

function EpicConfirm({
  mode,
  name,
  ticketCount,
  unpushedWarning,
  pending,
  onCancel,
  onConfirm,
}: {
  mode: "archive" | "delete";
  name: string;
  ticketCount: number;
  unpushedWarning: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const tickets = `${ticketCount} ticket${ticketCount === 1 ? "" : "s"}`;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-(--z-modal) w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="border-b border-(--glass-border-hairline) px-5 py-3.5">
              <Dialog.Title asChild>
                <h3 className="truncate text-[13.5px] font-semibold leading-none">
                  {mode === "archive" ? "Archive" : "Delete"} workflow &quot;
                  {name}&quot;?
                </h3>
              </Dialog.Title>
            </header>
            <div className="space-y-2 px-5 py-4 text-[12.5px] leading-relaxed text-(--color-text-secondary)">
              {mode === "archive" ? (
                <p>
                  Stops any running agents and removes the worktrees for{" "}
                  {tickets}. Branches are kept — the work stays in git, and the
                  workflow moves to Completed.
                </p>
              ) : (
                <p>
                  Stops any running agents, then removes {tickets}, their
                  worktrees AND their branches, plus the integration branch.
                  Unmerged work on those branches will be gone.
                </p>
              )}
              {unpushedWarning && (
                <p className="text-(--color-warning)">
                  The integration branch has commits that haven&apos;t been
                  pushed to origin.
                </p>
              )}
            </div>
            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={pending}
              >
                Cancel
              </GlassButton>
              <GlassButton
                variant={mode === "delete" ? "danger" : "primary"}
                size="sm"
                onClick={onConfirm}
                disabled={pending}
              >
                {pending
                  ? mode === "archive"
                    ? "Archiving…"
                    : "Deleting…"
                  : mode === "archive"
                    ? "Archive workflow"
                    : "Delete workflow"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
