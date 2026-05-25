import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { useUpdateWorkspace, useWorkspace } from "@/lib/hooks/useWorkspaces";
import { reportP0Error } from "@/lib/sentry";
import { useUiStore } from "@/lib/store";

/**
 * Shell-mounted rename modal driven by `pendingRenameWorkspaceId`.
 * Set the id from anywhere (currently the sidebar workspace right-click
 * menu) and this pops with a single name field.
 */
export function RenameWorkspaceModal() {
  const workspaceId = useUiStore((s) => s.pendingRenameWorkspaceId);
  const clear = useUiStore((s) => s.clearPendingRenameWorkspace);
  const open = workspaceId !== null;

  // Re-key the body so input state resets between subsequent open/close cycles.
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && clear()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[18vh] z-[190] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">Rename workspace</h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={clear}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>
            {workspaceId && <RenameBody key={workspaceId} workspaceId={workspaceId} onDone={clear} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RenameBody({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const { data: workspace } = useWorkspace(workspaceId);
  const update = useUpdateWorkspace(workspaceId);
  const [name, setName] = useState("");

  useEffect(() => {
    if (workspace) setName(workspace.name);
  }, [workspace]);

  const trimmed = name.trim();
  const unchanged = workspace ? trimmed === workspace.name : false;
  const canSubmit = trimmed.length > 0 && !unchanged && !update.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await update.mutateAsync({ name: trimmed });
      onDone();
    } catch (err) {
      reportP0Error("Rename workspace failed", err, {
        area: "workspace",
        operation: "rename_workspace",
        workspaceId,
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-5">
      <GlassInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workspace name"
        autoFocus
      />
      {update.error && (
        <p className="text-[11px] text-(--color-danger)">{String(update.error)}</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="outline" size="sm" type="button" onClick={onDone}>
          Cancel
        </GlassButton>
        <GlassButton variant="primary" size="sm" type="submit" disabled={!canSubmit}>
          {update.isPending ? "Saving…" : "Save"}
        </GlassButton>
      </div>
    </form>
  );
}
