import { useNavigate } from "@tanstack/react-router";
import { DecomposeForm } from "@/components/DecomposeForm";
import { Dialog } from "@/components/ui/Dialog";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";

/**
 * Shell-mounted "New epic" modal — the REAL entry point into a multi-agent
 * decomposition (mirrors NewTaskModal for the single-agent flow).
 *
 * Opened via `requestDecompose(repoId)`:
 *   - the "New epic" button on the repo home pane
 *   - the sidebar repo context menu → "New epic (2 agents)"
 *
 * Reuses the shared Radix `Dialog` shell (no bespoke chrome) and the existing
 * `DecomposeForm` (the "Start 2 agents" approval gate). On success, `onStarted`
 * fires with the freshly-created `BoardState`; we close the dialog and navigate
 * to that parent's board so the user lands on the live task board.
 *
 * Progressive disclosure: this is a SEPARATE surface from the single-agent
 * "New task" path — the flat sidebar filters out the parent/subtask rows a
 * decomposition creates, so the single-agent experience is unchanged.
 */
export function DecomposeModal() {
  const repoId = useUiStore((s) => s.pendingDecomposeRepoId);
  const clearPending = useUiStore((s) => s.clearPendingDecompose);
  const repositories = useRepositories();
  const navigate = useNavigate();

  const open = repoId !== null;
  const repo = repoId
    ? repositories.data?.find((r) => r.id === repoId)
    : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && clearPending()}
      size="lg"
      title={`New epic${repo ? ` · ${repo.name}` : ""}`}
      description="Split one goal into two agents — a backend and a frontend — that hand off through a published contract. Review the plan, then start both at once."
    >
      {repoId && (
        <DecomposeForm
          key={repoId}
          repositoryId={repoId}
          onStarted={(board) => {
            clearPending();
            void navigate({
              to: "/repositories/$repositoryId/board/$parentId",
              params: { repositoryId: repoId, parentId: board.parent.id },
            });
          }}
          onCancel={clearPending}
        />
      )}
    </Dialog>
  );
}
