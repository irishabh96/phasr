import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AddRepositoryForm } from "@/components/AddRepositoryForm";
import { GlassButton } from "@/components/ui/GlassButton";
import { useUiStore } from "@/lib/store";

/**
 * Wraps the existing AddRepositoryForm in a glass modal so the empty
 * state and the sidebar can both reach it without a route change.
 */
export function OpenExistingProjectModal() {
  const open = useUiStore((s) => s.openExistingModalOpen);
  const close = useUiStore((s) => s.closeOpenExistingModal);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-black/40 backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-[190] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">Open existing project</h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={close}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>
            <div className="p-5">
              <p className="mb-3 text-[12.5px] text-(--color-text-secondary)">
                Point Phasr at a folder that already exists on disk. We'll detect git, remote
                origin, and the default branch automatically.
              </p>
              <AddRepositoryForm />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
