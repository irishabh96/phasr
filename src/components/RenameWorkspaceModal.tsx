import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { useUpdateWorkspace, useWorkspace } from "@/lib/hooks/useWorkspaces";
import { humanizeError } from "@/lib/humanizeError";
import { reportP0Error } from "@/lib/sentry";
import { useUiStore } from "@/lib/store";

const FORM_ID = "rename-workspace-form";

/**
 * Shell-mounted rename modal driven by `pendingRenameWorkspaceId`.
 * Set the id from anywhere (currently the sidebar workspace right-click
 * menu) and this pops with a single name field. Built on the shared
 * `Dialog` shell so it inherits the focus trap, Esc/scrim close, exit
 * animation, and the required a11y description.
 */
export function RenameWorkspaceModal() {
  const workspaceId = useUiStore((s) => s.pendingRenameWorkspaceId);
  const clear = useUiStore((s) => s.clearPendingRenameWorkspace);
  const open = workspaceId !== null;

  const { data: workspace } = useWorkspace(workspaceId);
  const update = useUpdateWorkspace(workspaceId ?? "");
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed the field each time a rename opens (and whenever the target
  // workspace finishes loading) so a stale edit can't survive between
  // subsequent opens. Not cleared on close, so the value doesn't flash
  // empty during the exit animation.
  useEffect(() => {
    if (open && workspace) setName(workspace.name);
  }, [open, workspace]);

  const trimmed = name.trim();
  const unchanged = workspace ? trimmed === workspace.name : false;
  const canSubmit = trimmed.length > 0 && !unchanged && !update.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !workspaceId) return;
    try {
      await update.mutateAsync({ name: trimmed });
      clear();
    } catch (err) {
      reportP0Error("Rename workspace failed", err, {
        area: "workspace",
        operation: "rename_workspace",
        workspaceId,
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && clear()}
      title="Rename workspace"
      description={
        <span className="sr-only">Give this workspace a new name.</span>
      }
      initialFocusRef={inputRef}
      footer={
        <>
          <GlassButton variant="outline" size="sm" onClick={clear}>
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={!canSubmit}
          >
            {update.isPending ? "Saving…" : "Save"}
          </GlassButton>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="space-y-3">
        <GlassInput
          ref={inputRef}
          aria-label="Workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Workspace name"
        />
        {update.error && (
          <p role="alert" className="text-[11px] text-(--color-danger)">
            {humanizeError(update.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
