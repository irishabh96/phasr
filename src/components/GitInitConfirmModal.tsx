import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useGitInitRepository, useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { GlassButton } from "@/components/ui/GlassButton";

/**
 * Shell-mounted confirm dialog driven by `pendingGitInitRepoId`. Fired by
 * the open-existing inline flow and the new-project Empty flow when the
 * resolved folder isn't already a git repository.
 *
 * Initialize Git → runs `git init` on the repo's local path and navigates
 * to the repo home. Cancel → leaves the repo non-git; the repo home shows
 * a banner offering to re-init.
 */
export function GitInitConfirmModal() {
  const pendingId = useUiStore((s) => s.pendingGitInitRepoId);
  const clear = useUiStore((s) => s.clearPendingGitInit);
  const { data: repositories } = useRepositories();
  const gitInit = useGitInitRepository();
  const navigateToRepoEntry = useNavigateToRepoEntry();

  const open = pendingId !== null;
  const repo = pendingId ? repositories?.find((r) => r.id === pendingId) : null;

  const handleInitialize = async () => {
    if (!pendingId) return;
    await gitInit.mutateAsync(pendingId);
    clear();
    void navigateToRepoEntry(pendingId);
  };

  const handleCancel = () => {
    if (!pendingId) {
      clear();
      return;
    }
    const id = pendingId;
    clear();
    // Still navigate to the repo home — the pane will show a banner
    // offering to re-init so the action doesn't feel swallowed.
    void navigateToRepoEntry(id);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[30vh] z-[190] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="flex h-11 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  Initialize Git Repository?
                </h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={handleCancel}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>
            <Dialog.Description asChild>
              <div className="px-4 py-3 text-[13px] text-(--color-text-secondary)">
                <span className="font-medium text-(--color-text-primary)">
                  {repo?.name ?? "This folder"}
                </span>{" "}
                is not a git repository. Would you like to initialize one?
              </div>
            </Dialog.Description>
            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton variant="outline" size="sm" onClick={handleCancel}>
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                size="sm"
                onClick={handleInitialize}
                disabled={gitInit.isPending}
              >
                {gitInit.isPending ? "Initializing…" : "Initialize Git"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
