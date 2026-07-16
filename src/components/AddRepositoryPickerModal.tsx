import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpen, Sparkles, X } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useOpenExistingFlow } from "@/lib/hooks/useOpenExistingFlow";
import { useUiStore } from "@/lib/store";

/**
 * Two-choice picker that fans out the sidebar's single "Add repository"
 * footer button. "New project" → navigates to /new-project (center pane).
 * "Open existing" → fires the native folder picker inline via
 * `useOpenExistingFlow`.
 *
 * Mounted at the app shell; driven by `addRepositoryPickerOpen`.
 */
export function AddRepositoryPickerModal() {
  const open = useUiStore((s) => s.addRepositoryPickerOpen);
  const close = useUiStore((s) => s.closeAddRepositoryPicker);
  const navigate = useNavigate();
  const openExistingFlow = useOpenExistingFlow();

  const onNewProject = () => {
    close();
    void navigate({ to: "/new-project" });
  };
  const onOpenExisting = () => {
    close();
    void openExistingFlow();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[16vh] z-[190] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  Add a repository
                </h2>
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
            <div className="grid grid-cols-2 gap-3 p-5">
              <PickerCard
                icon={
                  <Sparkles size={18} className="text-(--color-accent-text)" />
                }
                title="New project"
                description="Empty repo, clone from URL, or start from a template."
                onClick={onNewProject}
              />
              <PickerCard
                icon={
                  <FolderOpen
                    size={18}
                    className="text-(--color-text-secondary)"
                  />
                }
                title="Open existing"
                description="Point Phasr at a folder on disk that's already a git repo."
                onClick={onOpenExisting}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PickerCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-panel group flex flex-col gap-2 p-4 text-left transition-all duration-150 hover:border-(--glass-border-strong)"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[13.5px] font-medium leading-none">{title}</span>
      </div>
      <p className="text-[12px] text-(--color-text-secondary)">{description}</p>
    </button>
  );
}
