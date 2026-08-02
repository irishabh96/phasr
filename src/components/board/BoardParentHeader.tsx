import { useState } from "react";
import { ExternalLink, Loader2, UploadCloud } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog } from "@/components/ui/Dialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { AutopilotToggle } from "@/components/board/AutopilotToggle";
import { NextGateButton } from "@/components/board/NextGateButton";
import { IntegrationDiff } from "@/components/board/IntegrationDiff";
import { deriveNextGate, type NextGate } from "@/lib/deriveNextGate";
import {
  boardKeys,
  isIntegrationConflict,
  useIntegrateParent,
} from "@/lib/hooks/useBoard";
import { useSetAutopilot } from "@/lib/hooks/useAutopilot";
import { useGitPushDefaultBranch } from "@/lib/hooks/useGit";
import { useOpenPullRequest } from "@/lib/hooks/useWorkspaces";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useQueryClient } from "@tanstack/react-query";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import type { BoardState } from "@/lib/types";

/**
 * The epic header (the decomposition itself). A single calm summary card:
 * a quiet "Workflow" overline over the goal title, a muted meta line (ticket count ·
 * contract progress), and — balanced on the right — the neutral Autopilot toggle
 * beside the epic's ONE derived next gate (Integrate → Ship, §G1/R7) via the
 * shared {@link NextGateButton}.
 *
 * A CLEAN integrate opens the ONE combined diff against the parent id (the R7
 * "legible reward"); a CONFLICT routes into the EXISTING conflict-resolution
 * surface (`ChangesPanel`) keyed on the parent id — never a dead end (DDR-002).
 * Ship (once integrated) reuses `MergeToMainDialog`'s existing merge + conflict
 * flow verbatim. Coral is reserved for that one enabled primary gate.
 */
export function BoardParentHeader({
  board,
  integrable,
  shipped,
  autopilotEnabled,
  autopilotDriving,
}: {
  board: BoardState;
  integrable: boolean;
  shipped: boolean;
  autopilotEnabled: boolean;
  autopilotDriving: boolean;
}) {
  const queryClient = useQueryClient();
  const integrate = useIntegrateParent(board.parent.id);
  const setAutopilot = useSetAutopilot(board.parent.id);
  const pushMain = useGitPushDefaultBranch(board.parent.repositoryId);
  const openPr = useOpenPullRequest();
  const { data: repository } = useRepository(board.parent.repositoryId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewMode, setReviewMode] = useState<"clean" | "conflict">("clean");
  const [shipOpen, setShipOpen] = useState(false);

  const ticketCount = board.subtasks.length;
  const done = board.contracts.filter((c) => c.publishedAt != null).length;
  const goal = board.parent.prompt?.trim() || board.parent.name;

  // The parent carries an integration branch/worktree once integrated.
  const integrated = !!board.parent.branch;

  const epicGate = deriveNextGate({
    kind: "epic",
    ticketCount,
    integrable,
    integrated,
    shipped,
    autopilotEnabled,
    ...(repository?.defaultBranch
      ? { baseBranch: repository.defaultBranch }
      : {}),
  });

  // Ship's confirm IS the MergeToMainDialog (strategy + conflict flow), so the
  // NextGateButton must not layer its own ConfirmDialog on top of it.
  const headerGate: NextGate =
    epicGate.verb === "ship" ? { ...epicGate, confirm: false } : epicGate;

  const handleIntegrate = async () => {
    // D1 in-flight guard — belt + braces on top of the button's own pending.
    if (integrate.isPending) return;
    try {
      await integrate.mutateAsync();
      setReviewMode("clean");
      setReviewOpen(true);
    } catch (err) {
      if (isIntegrationConflict(err)) {
        queryClient.invalidateQueries({
          queryKey: boardKeys.detail(board.parent.id),
        });
        setReviewMode("conflict");
        setReviewOpen(true);
        showToast({
          title: "Integration paused on conflicts",
          intent: "warning",
          message: humanizeError(err),
        });
      } else {
        showToast({
          title: "Integration failed",
          intent: "error",
          message: humanizeError(err),
        });
      }
    }
  };

  const runEpicGate = (verb: string): Promise<void> | void => {
    if (verb === "integrate") return handleIntegrate();
    if (verb === "ship") {
      setShipOpen(true);
      return;
    }
  };

  return (
    <div
      data-testid="board-parent-card"
      className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-surface) px-5 py-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-(--color-text-muted)">
          Workflow
        </span>
        <h2 className="truncate text-[15px] font-semibold leading-tight text-(--color-text-primary)">
          {goal}
        </h2>
        <div className="flex items-center gap-1.5 text-[11.5px] text-(--color-text-muted)">
          <span className="tabular-nums">
            {ticketCount} {ticketCount === 1 ? "ticket" : "tickets"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {done}/{ticketCount} contracts published
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5">
        <AutopilotToggle
          enabled={autopilotEnabled}
          driving={autopilotDriving}
          pending={setAutopilot.isPending}
          onToggle={(next) =>
            setAutopilot.mutate(next, {
              onError: (err) =>
                showToast({
                  title: next
                    ? "Couldn't turn on autopilot"
                    : "Couldn't turn off autopilot",
                  intent: "error",
                  message: humanizeError(err),
                }),
            })
          }
        />
        {/* Post-ship, the explicit publish follow-ups live HERE durably (the
            Ship dialog is transient — closing it must not orphan them). Quiet
            ghosts beside the terminal pill; remote repos only; never coral. */}
        {shipped && repository?.remoteUrl ? (
          <>
            <GlassTooltip
              content={`Push ${repository.defaultBranch} to origin`}
              side="bottom"
            >
              <GlassButton
                variant="ghost"
                size="sm"
                data-testid="board-push-main"
                onClick={() =>
                  pushMain.mutate(undefined, {
                    onSuccess: (out) =>
                      showToast({
                        title: `Pushed ${out.branch} to origin`,
                        intent: "success",
                      }),
                    onError: (err) =>
                      showToast({
                        title: "Push failed",
                        intent: "error",
                        message: humanizeError(err),
                      }),
                  })
                }
                disabled={pushMain.isPending}
              >
                {pushMain.isPending ? (
                  <Loader2 size={13} className="animate-spin" aria-hidden />
                ) : (
                  <UploadCloud size={13} aria-hidden />
                )}
                Push
              </GlassButton>
            </GlassTooltip>
            <GlassTooltip
              content="Push the integration branch and open a compare page"
              side="bottom"
            >
              <GlassButton
                variant="ghost"
                size="sm"
                data-testid="board-open-pr"
                onClick={() =>
                  openPr.mutate(board.parent.id, {
                    onSuccess: async (out) => {
                      await openUrl(out.url);
                      showToast({
                        title: `Opened ${out.provider} compare page`,
                        intent: "success",
                        message: `${out.headBranch} → ${out.baseBranch}`,
                      });
                    },
                    onError: (err) =>
                      showToast({
                        title: "Couldn't open a PR",
                        intent: "error",
                        message: humanizeError(err),
                      }),
                  })
                }
                disabled={openPr.isPending}
              >
                {openPr.isPending ? (
                  <Loader2 size={13} className="animate-spin" aria-hidden />
                ) : (
                  <ExternalLink size={13} aria-hidden />
                )}
                PR
              </GlassButton>
            </GlassTooltip>
          </>
        ) : null}
        <NextGateButton
          gate={headerGate}
          size="sm"
          pending={integrate.isPending}
          onRun={runEpicGate}
        />
      </div>

      <Dialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        size="min(1080px, 94vw)"
        title={
          reviewMode === "conflict"
            ? "Resolve integration conflicts"
            : "Integration review"
        }
        description={
          reviewMode === "conflict"
            ? "Integration paused on a merge conflict in the parent's integration worktree. Resolve each file, then continue the merge — or abort to unwind it."
            : "The combined diff of every ticket merged into the parent's integration worktree. Review it here before merging to your main branch."
        }
      >
        <div data-testid="board-combined-diff" className="h-[62vh] min-h-0">
          {reviewMode === "conflict" ? (
            <ChangesPanel workspaceId={board.parent.id} />
          ) : (
            <IntegrationDiff parentId={board.parent.id} />
          )}
        </div>
      </Dialog>

      <MergeToMainDialog
        workspace={board.parent}
        open={shipOpen}
        onClose={() => setShipOpen(false)}
      />
    </div>
  );
}
