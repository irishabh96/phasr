import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { NewTaskForm } from "@/components/NewTaskForm";
import { RepoMark } from "@/components/ui/RepoMark";
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
 * A-NewTask: 640px, surface, radius 12, the floating shadow, no dividers.
 * The header is a breadcrumb, `[■ repo] › New task`, plus a 24px close.
 * Its own Radix dialog rather than ui/Dialog: that shell's h-11 title row
 * and padded body don't fit a form that runs edge to edge.
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
          onOpenAutoFocus={(e) => {
            // The prompt first, never the close × (Radix's default would
            // pick it: it's the first tabbable, in the header).
            const prompt = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("#new-task-prompt");
            if (!prompt) return;
            e.preventDefault();
            prompt.focus();
          }}
          className="fixed left-1/2 top-1/2 z-(--z-modal) w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 outline-none"
          onEscapeKeyDown={(e) => {
            // Esc inside an expanded combobox (base-branch field) belongs to
            // the combobox — it closes its own list; the modal must survive.
            const target = e.target as HTMLElement | null;
            if (target?.closest('[role="combobox"][aria-expanded="true"]')) e.preventDefault();
          }}
        >
          <div className="glass-modal animate-modal-in overflow-hidden bg-(--color-bg-surface)">
            {/* px, not rem: the root font is 13px. */}
            <header className="flex items-center gap-[8px] px-[18px] pt-[16px]">
              {repo ? (
                <>
                  <span
                    aria-hidden
                    className="flex h-[22px] min-w-0 items-center gap-[6px] rounded-[5px] bg-(--color-bg-elevated) px-[8px] text-[12px] text-(--color-text-secondary)"
                  >
                    <RepoMark id={repo.id} name={repo.name} size={12} />
                    <span className="truncate">{repo.name}</span>
                  </span>
                  <span aria-hidden className="text-[12px] text-(--color-text-faint)">
                    ›
                  </span>
                </>
              ) : null}
              <Dialog.Title asChild>
                {/* The accessible name keeps the repo: "New task · phasr". */}
                <h2 className="m-0 text-[12px] font-normal leading-none text-(--color-text-secondary)">
                  New task{repo ? <span className="sr-only"> · {repo.name}</span> : null}
                </h2>
              </Dialog.Title>
              <div className="flex-1" />
              <Dialog.Close
                aria-label="Close"
                className="grid size-[24px] place-items-center rounded-(--radius-control) text-(--color-text-muted) transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
              >
                <X className="size-[14px]" aria-hidden />
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
