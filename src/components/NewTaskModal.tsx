import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { NewTaskForm } from "@/components/NewTaskForm";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";

/**
 * Shell-mounted "new task" modal (plan section 8).
 *
 * Opened via:
 *   - ⌘T global shortcut (scoped to the active task's repository)
 *   - sidebar `+` icon per repo row
 *   - command palette
 *   - any other call to `requestNewWorkspace(repoId)`
 *
 * On submit, navigates to the new task's detail pane.
 *
 * Naming: the underlying state slice is still called
 * `pendingNewWorkspaceRepoId` because the schema renamed `tasks` →
 * `workspaces` in migration 0002. The user-facing label is "New task".
 */
export function NewTaskModal() {
  const repoId = useUiStore((s) => s.pendingNewWorkspaceRepoId);
  const clearPending = useUiStore((s) => s.clearPendingNewWorkspace);
  const repositories = useRepositories();
  const navigate = useNavigate();

  const open = repoId !== null;
  const repo = repoId ? repositories.data?.find((r) => r.id === repoId) : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && clearPending()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay) data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-(--z-modal) w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 outline-none"
          onEscapeKeyDown={(e) => {
            // Esc inside an expanded combobox (base-branch field) belongs to
            // the combobox — it closes its own list; the modal must survive.
            const target = e.target as HTMLElement | null;
            if (target?.closest('[role="combobox"][aria-expanded="true"]')) e.preventDefault();
          }}
        >
          <div className="glass-modal animate-modal-in overflow-hidden">
            <header className="flex items-center gap-2.5 border-b border-(--color-border-subtle) px-[18px] py-3.5">
              <Dialog.Title asChild>
                <h2 className="m-0 text-[14px] font-semibold leading-none">
                  New task{repo ? ` · ${repo.name}` : ""}
                </h2>
              </Dialog.Title>
              <div className="flex-1" />
              <Dialog.Close
                aria-label="Close"
                className="grid size-[26px] place-items-center rounded-(--radius-control) text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
              >
                <X className="size-3.5" aria-hidden />
              </Dialog.Close>
            </header>
            {repoId && (
              <NewTaskForm
                key={repoId}
                repositoryId={repoId}
                onCreated={(task) => {
                  clearPending();
                  void navigate({
                    to: "/repositories/$repositoryId/workspaces/$workspaceId",
                    params: { repositoryId: task.repositoryId, workspaceId: task.id },
                  });
                }}
                onCancel={clearPending}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
