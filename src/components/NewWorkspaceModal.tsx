import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { NewWorkspaceForm } from "@/components/NewWorkspaceForm";
import { GlassButton } from "@/components/ui/GlassButton";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";

/**
 * Shell-mounted modal driven by `pendingNewWorkspaceRepoId`. Set the
 * pending repo id from anywhere (sidebar `+` icon, ⌘N hotkey, repo
 * context menu, post-create flows) and this modal pops with the
 * existing NewWorkspaceForm scoped to that repo.
 */
export function NewWorkspaceModal() {
  const repoId = useUiStore((s) => s.pendingNewWorkspaceRepoId);
  const clearPending = useUiStore((s) => s.clearPendingNewWorkspace);
  const repositories = useRepositories();
  const navigate = useNavigate();

  const open = repoId !== null;
  const repo = repoId ? repositories.data?.find((r) => r.id === repoId) : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && clearPending()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-[190] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  New workspace{repo ? ` · ${repo.name}` : ""}
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
                <NewWorkspaceForm
                  repositoryId={repoId}
                  onCreated={(workspace) => {
                    clearPending();
                    void navigate({
                      to: "/repositories/$repositoryId/workspaces/$workspaceId",
                      params: {
                        repositoryId: workspace.repositoryId,
                        workspaceId: workspace.id,
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
