import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { Pencil, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { disposeSessionXterm } from "@/components/SessionTerminalTab";
import { disposeMainXterm } from "@/components/Terminal";
import { GlassButton } from "@/components/ui/GlassButton";
import { useCheckWorkspaceDelete, useDeleteWorkspace } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";

interface WorkspaceSidebarMenuProps {
  workspace: Workspace;
  children: ReactNode;
}

/**
 * Wraps a sidebar workspace row in a Radix context menu. Right-click
 * exposes three actions:
 *
 *   1. New terminal — navigates to the workspace and opens a fresh
 *      terminal inner tab.
 *   2. Rename… — sets `pendingRenameWorkspaceId`; the shell-mounted
 *      RenameWorkspaceModal picks it up.
 *   3. Close workspace (danger) — opens a confirmation dialog. On
 *      confirm, calls deleteWorkspace which tears down the worktree
 *      and the workspace record.
 */
export function WorkspaceSidebarMenu({ workspace, children }: WorkspaceSidebarMenuProps) {
  const navigate = useNavigate();
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);
  const requestRename = useUiStore((s) => s.requestRenameWorkspace);
  const checkDelete = useCheckWorkspaceDelete();
  const deleteWorkspace = useDeleteWorkspace();

  const [confirming, setConfirming] = useState(false);
  const [unpushedWarning, setUnpushedWarning] = useState(false);

  const onNewTerminal = async () => {
    await navigate({
      to: "/repositories/$repositoryId/workspaces/$workspaceId",
      params: { repositoryId: workspace.repositoryId, workspaceId: workspace.id },
    });
    openInnerTerminalTab(workspace.id);
  };

  const onCloseWorkspace = async () => {
    setUnpushedWarning(false);
    try {
      const check = await checkDelete.mutateAsync(workspace.id);
      if (check.hasUnpushedCommits) setUnpushedWarning(true);
    } catch {
      /* non-blocking — proceed with the basic confirmation */
    }
    setConfirming(true);
  };

  const onConfirmClose = () => {
    deleteWorkspace.mutate(
      { id: workspace.id, repositoryId: workspace.repositoryId },
      {
        onSuccess: () => {
          setConfirming(false);

          // Free cached xterm instances for this workspace before the
          // record disappears from the store / route.
          const store = useUiStore.getState();
          const inner = store.innerTabs[workspace.id];
          if (inner) {
            for (const tab of inner.tabs) {
              if (tab.kind === "terminal") disposeSessionXterm(tab.id);
              else if (tab.kind === "main") disposeMainXterm(workspace.id);
            }
          }
          // Belt-and-braces: dispose the main xterm even if there was no
          // open main tab (e.g. user closed it explicitly earlier and
          // hasn't reopened it but the cache might still hold an entry
          // from a prior session).
          disposeMainXterm(workspace.id);

          // If the closed workspace is currently active in the main area,
          // bounce the user home. Otherwise the sidebar mutation suffices.
          if (store.activeWorkspaceContext?.workspaceId === workspace.id) {
            void navigate({ to: "/" });
          }
        },
      },
    );
  };

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={cn(
              "z-[200] min-w-[180px] overflow-hidden p-1",
              "glass-modal animate-[modal-in_140ms_var(--ease-glass)]",
            )}
          >
            <Item icon={<TerminalIcon size={12} />} onSelect={() => void onNewTerminal()}>
              New terminal
            </Item>
            <Item icon={<Pencil size={12} />} onSelect={() => requestRename(workspace.id)}>
              Rename…
            </Item>
            <Separator />
            <Item icon={<Trash2 size={12} />} onSelect={() => void onCloseWorkspace()} danger>
              Close workspace
            </Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {confirming && (
        <CloseConfirm
          name={workspace.name}
          branch={workspace.branch}
          unpushedWarning={unpushedWarning}
          pending={deleteWorkspace.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirmClose}
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
  return <ContextMenu.Separator className="my-1 h-px bg-(--glass-border-hairline)" />;
}

function CloseConfirm({
  name,
  branch,
  unpushedWarning,
  pending,
  onCancel,
  onConfirm,
}: {
  name: string;
  branch: string | null;
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

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[150] bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[160] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="border-b border-(--glass-border-hairline) px-5 py-3.5">
              <Dialog.Title asChild>
                <h3 className="text-[13.5px] font-semibold leading-none">
                  Close workspace &quot;{name}&quot;?
                </h3>
              </Dialog.Title>
            </header>
            <div className="space-y-2 px-5 py-4 text-[12.5px] leading-relaxed text-(--color-text-secondary)">
              <p>
                Stops the agent, removes the worktree, and deletes the branch
                {branch ? ` ${branch}` : ""}. The agent&apos;s commits on this branch will be gone.
              </p>
              {unpushedWarning && (
                <p className="text-(--color-warning)">
                  This branch has commits that haven&apos;t been pushed to origin.
                </p>
              )}
            </div>
            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton variant="outline" size="sm" onClick={onCancel} disabled={pending}>
                Cancel
              </GlassButton>
              <GlassButton variant="danger" size="sm" onClick={onConfirm} disabled={pending}>
                {pending ? "Closing…" : "Close workspace"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
