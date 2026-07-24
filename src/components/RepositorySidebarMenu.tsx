import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useNavigate } from "@tanstack/react-router";
import {
  FolderOpen,
  GitFork,
  Plus,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useDeleteRepository } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Repository } from "@/lib/types";

interface RepositorySidebarMenuProps {
  repository: Repository;
  children: ReactNode;
}

/**
 * Wraps a sidebar repo row in a Radix context menu. Left-click the row
 * navigates to the repository entry; RIGHT-click opens a glass menu with
 * repository actions:
 *
 *   1. Open project — navigates to the repository entry route.
 *   2. New workspace — sets `pendingNewWorkspaceRepoId`; the shell-mounted
 *      NewTaskModal picks it up and opens (the single-agent path).
 *   3. New epic — sets `pendingDecomposeRepoId`; the shell-mounted DecomposeModal
 *      picks it up and opens (the planner-driven, multi-agent decomposition —
 *      the ticket count is whatever the planner proposes, NOT a fixed 2).
 *   4. Settings — navigate to /repositories/<id>/settings.
 *   5. Remove project — opens a glass confirm dialog; on confirm,
 *      deletes only the DB row (local clone untouched).
 */
export function RepositorySidebarMenu({
  repository,
  children,
}: RepositorySidebarMenuProps) {
  const navigate = useNavigate();
  const navigateToRepoEntry = useNavigateToRepoEntry();
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const requestDecompose = useUiStore((s) => s.requestDecompose);
  const deleteRepo = useDeleteRepository();
  const [confirming, setConfirming] = useState(false);

  const onOpenProject = () => {
    void navigateToRepoEntry(repository.id);
  };

  const onNewWorkspace = () => {
    requestNewWorkspace(repository.id);
  };

  const onNewEpic = () => {
    requestDecompose(repository.id);
  };

  const onOpenSettings = () => {
    navigate({
      to: "/repositories/$repositoryId/settings",
      params: { repositoryId: repository.id },
    });
  };

  const onConfirmRemove = () => {
    deleteRepo.mutate(repository.id, {
      onSuccess: () => {
        setConfirming(false);
        // Navigation is owned by useDeleteRepository — it only bounces
        // home when you're viewing the repo you just deleted, so removing
        // a background repo leaves your current view intact.
      },
    });
  };

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={cn(
              "z-(--z-dropdown) min-w-[180px] overflow-hidden p-1",
              "glass-modal animate-[modal-in_140ms_var(--ease-glass)]",
            )}
          >
            <Item icon={<FolderOpen size={13} />} onSelect={onOpenProject}>
              Open project
            </Item>
            <Item icon={<Plus size={13} />} onSelect={onNewWorkspace}>
              New workspace
            </Item>
            <Item icon={<GitFork size={13} />} onSelect={onNewEpic}>
              New epic
            </Item>
            <Item icon={<SettingsIcon size={13} />} onSelect={onOpenSettings}>
              Settings
            </Item>
            <Separator />
            <Item
              icon={<Trash2 size={13} />}
              onSelect={() => setConfirming(true)}
              danger
            >
              Remove project
            </Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {confirming && (
        <RemoveConfirm
          name={repository.name}
          pending={deleteRepo.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirmRemove}
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

function RemoveConfirm({
  name,
  pending,
  onCancel,
  onConfirm,
}: {
  name: string;
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
        <Dialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-(--z-modal) w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="border-b border-(--glass-border-hairline) px-5 py-3.5">
              <Dialog.Title asChild>
                <h3 className="text-[13.5px] font-semibold leading-none">
                  Remove project &quot;{name}&quot;?
                </h3>
              </Dialog.Title>
            </header>
            <div className="px-5 py-4 text-[12.5px] leading-relaxed text-(--color-text-secondary)">
              The project will be removed from Phasr. Your local clone on disk
              stays untouched.
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
                variant="danger"
                size="sm"
                onClick={onConfirm}
                disabled={pending}
              >
                {pending ? "Removing…" : "Remove project"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
