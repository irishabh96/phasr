import { useState } from "react";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import {
  useGitInitRepository,
  useRepositories,
} from "@/lib/hooks/useRepositories";
import { humanizeError } from "@/lib/humanizeError";
import { useUiStore } from "@/lib/store";
import { Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";

/**
 * Shell-mounted confirm dialog driven by `pendingGitInitRepoId`. Fired by
 * the open-existing inline flow and the new-project Empty flow when the
 * resolved folder isn't already a git repository.
 *
 * Initialize Git → runs `git init` on the repo's local path and navigates
 * to the repo home. Cancel → leaves the repo non-git; the repo home shows
 * a banner offering to re-init. Built on the shared `Dialog` shell.
 */
export function GitInitConfirmModal() {
  const pendingId = useUiStore((s) => s.pendingGitInitRepoId);
  const clear = useUiStore((s) => s.clearPendingGitInit);
  const { data: repositories } = useRepositories();
  const gitInit = useGitInitRepository();
  const navigateToRepoEntry = useNavigateToRepoEntry();
  const [error, setError] = useState<string | null>(null);

  const open = pendingId !== null;
  const repo = pendingId ? repositories?.find((r) => r.id === pendingId) : null;

  const handleInitialize = async () => {
    if (!pendingId) return;
    setError(null);
    try {
      await gitInit.mutateAsync(pendingId);
      clear();
      void navigateToRepoEntry(pendingId);
    } catch (err) {
      // Keep the dialog open with an inline banner so the failure isn't
      // silent and the user can retry or cancel (FORMS-F1).
      setError(humanizeError(err));
    }
  };

  const handleCancel = () => {
    // Don't allow escaping (Cancel / Esc / scrim) while an init is in
    // flight — the button is disabled and this guards the other paths.
    if (gitInit.isPending) return;
    setError(null);
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
    <Dialog
      open={open}
      onOpenChange={(o) => !o && handleCancel()}
      title="Initialize Git repository?"
      description={
        <span>
          <span className="font-medium text-(--color-text-primary)">
            {repo?.name ?? "This folder"}
          </span>{" "}
          is not a git repository. Would you like to initialize one?
        </span>
      }
      footer={
        <>
          <GlassButton
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={gitInit.isPending}
          >
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
        </>
      }
    >
      {error && (
        <p className="rounded-md border border-[color-mix(in_oklab,var(--color-danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-danger)">
          {error}
        </p>
      )}
    </Dialog>
  );
}
