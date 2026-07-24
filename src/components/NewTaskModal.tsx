import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { NewTaskForm } from "@/components/NewTaskForm";
import { GlassButton } from "@/components/ui/GlassButton";
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
        <Dialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-(--z-modal) w-[min(560px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  New task{repo ? ` · ${repo.name}` : ""}
                </h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={clearPending}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>
            <div className="p-5">
              {repoId && (
                <NewTaskForm
                  key={repoId}
                  repositoryId={repoId}
                  onCreated={(task) => {
                    clearPending();
                    void navigate({
                      to: "/repositories/$repositoryId/workspaces/$workspaceId",
                      params: {
                        repositoryId: task.repositoryId,
                        workspaceId: task.id,
                      },
                    });
                  }}
                  onCancel={clearPending}
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
