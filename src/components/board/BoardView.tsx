import { useState } from "react";
import { GitMerge, Loader2 } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { Dialog } from "@/components/ui/Dialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { BoardCardView } from "@/components/board/BoardCard";
import { useAllAgentLiveness } from "@/lib/agentLiveness";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import {
  blockingRoles,
  boardColumn,
  deriveBoardState,
  type BoardCardState,
  type BoardColumn,
} from "@/lib/deriveBoardState";
import {
  boardKeys,
  isIntegrationConflict,
  useIntegrateParent,
  usePublishContract,
} from "@/lib/hooks/useBoard";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { useNow } from "@/lib/useNow";
import type { BoardState, Workspace } from "@/lib/types";

const COLUMNS: ReadonlyArray<{ key: BoardColumn; label: string }> = [
  { key: "backlog", label: "Backlog" },
  { key: "in-progress", label: "In progress" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

interface DerivedCard {
  subtask: Workspace;
  state: BoardCardState;
  column: BoardColumn;
  render: React.ReactNode;
}

/** A subtask is "review-ready" once its contract is published or it exited clean. */
function isReviewReady(state: BoardCardState): boolean {
  return state === "needs-review" || state === "done";
}

/**
 * The read-only task board (S2-T1). Places the parent + its subtask cards into
 * four DERIVED lanes (Backlog → In progress → Review → Done) via
 * `deriveBoardState` — the lanes are NOT draggable; a card's column is a pure
 * function of its honest state (edges × contracts × liveness).
 *
 * Liveness is read once from the module store (`useAllAgentLiveness`) so there
 * is no per-card hook in a variable-length loop; the "Ns ago" clock ticks only
 * while at least one subtask is actually live.
 */
export function BoardView({ board }: { board: BoardState }) {
  const livenessMap = useAllAgentLiveness();
  const publish = usePublishContract(board.parent.id);
  const navigate = useNavigate();

  // Tick the shared clock only while a subtask carries a live counter.
  const anyLive = board.subtasks.some((s) => {
    const snapshot = livenessMap[s.id];
    return isLiveState(
      snapshot?.derivedState ?? (s.status === "running" ? "working" : "stopped"),
    );
  });
  const now = useNow(anyLive);

  const cards: DerivedCard[] = board.subtasks.map((subtask) => {
    const { state, since } = deriveBoardState(
      subtask,
      board,
      livenessMap[subtask.id],
      now,
    );
    const blockedOnRoles = state === "blocked" ? blockingRoles(subtask, board) : [];

    // The "Mark done" affordance rides ONLY on a producer subtask (the `from`
    // side of an edge) that hasn't published its contract — publishing it is
    // what unblocks the downstream consumer. A blocked consumer or an
    // already-published producer never shows it (nothing to publish).
    const isProducer = board.dependencies.some(
      (d) => d.fromSubtaskId === subtask.id,
    );
    const hasPublished = board.contracts.some(
      (c) => c.subtaskId === subtask.id && c.publishedAt != null,
    );
    const canPublish = isProducer && !hasPublished;

    return {
      subtask,
      state,
      column: boardColumn(state),
      render: (
        <BoardCardView
          key={subtask.id}
          role={subtask.role}
          name={subtask.name}
          state={state}
          since={since}
          exitCode={subtask.exitCode}
          blockedOnRoles={blockedOnRoles}
          onOpen={() =>
            void navigate({
              to: "/repositories/$repositoryId/workspaces/$workspaceId",
              params: {
                repositoryId: subtask.repositoryId,
                workspaceId: subtask.id,
              },
            })
          }
          {...(canPublish
            ? {
                onMarkDone: () => publish.mutate(subtask.id),
                markDonePending:
                  publish.isPending && publish.variables === subtask.id,
              }
            : {})}
        />
      ),
    };
  });

  // Integrable once EVERY subtask reached a review-ready state (published a
  // contract or exited clean) — the honest "the parallel work is done, it's the
  // human's turn to integrate" moment. Deliberately not over-gated on liveness.
  const integrable = cards.length > 0 && cards.every((c) => isReviewReady(c.state));

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid="board-view">
      <BoardParentHeader board={board} integrable={integrable} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map(({ key, label }) => {
          const columnCards = cards.filter((c) => c.column === key);
          return (
            <section
              key={key}
              data-testid={`board-column-${key}`}
              className="flex min-h-0 flex-col gap-2 rounded-(--radius-panel) bg-[color-mix(in_oklab,var(--color-bg-surface)_50%,transparent)] p-2"
            >
              <header className="flex items-center justify-between px-1 pt-0.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-(--color-text-muted)">
                  {label}
                </h3>
                <span className="text-[11px] tabular-nums text-(--color-text-muted)">
                  {columnCards.length}
                </span>
              </header>
              <div className="flex flex-col gap-2">
                {columnCards.length ? (
                  columnCards.map((c) => c.render)
                ) : (
                  <p className="px-1 py-2 text-[11px] text-(--color-text-muted)">
                    —
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The parent (the decomposition itself). Rendered as a summary header, NOT a
 * lane card — a parent has no PTY and no agent status, so forcing it into a
 * status lane would make it lie. It shows the goal + progress and hosts the
 * "Integrate & review" action.
 *
 * Integration (E3-T1) mints the parent's integration worktree and merges every
 * subtask branch topologically. A CLEAN run opens the ONE combined diff against
 * the parent id (the R7 "legible reward"). A CONFLICT routes into the EXISTING
 * conflict-resolution surface (`ChangesPanel` drives `git_merge_in_progress` /
 * `git_resolve_conflict` / `git_continue_merge` / `git_abort_merge`) keyed on
 * the parent id — never a dead end (DDR-002). Both surfaces are the same
 * `ChangesPanel` pointed at the parent worktree; which one shows is a pure
 * function of the worktree's own state.
 */
function BoardParentHeader({
  board,
  integrable,
}: {
  board: BoardState;
  integrable: boolean;
}) {
  const queryClient = useQueryClient();
  const integrate = useIntegrateParent(board.parent.id);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewMode, setReviewMode] = useState<"clean" | "conflict">("clean");

  const done = board.contracts.filter((c) => c.publishedAt != null).length;
  const goal = board.parent.prompt?.trim() || board.parent.name;

  const handleIntegrate = async () => {
    // D1 in-flight guard — also enforced by the button's `disabled`, but belt +
    // braces so a queued keypress can't fan out a second integration.
    if (integrate.isPending) return;
    try {
      await integrate.mutateAsync();
      // CLEAN: the parent now carries the integration branch/worktree; open the
      // combined diff against the parent id.
      setReviewMode("clean");
      setReviewOpen(true);
    } catch (err) {
      if (isIntegrationConflict(err)) {
        // CONFLICT: integration stopped mid-merge but already pointed the parent
        // row at the integration worktree. Re-read the board, then route into the
        // interactive conflict surface keyed on the parent id.
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

  return (
    <div
      data-testid="board-parent-card"
      className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-surface) p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Parent · {board.subtasks.length} subtasks
        </span>
        <h2 className="truncate text-[15px] font-semibold text-(--color-text-primary)">
          {goal}
        </h2>
        <span className="text-[11px] text-(--color-text-muted)">
          {done}/{board.subtasks.length} contracts published
        </span>
      </div>

      {integrable ? (
        <GlassButton
          variant="primary"
          size="sm"
          data-testid="board-integrate"
          className="gap-1.5"
          disabled={integrate.isPending}
          onClick={handleIntegrate}
        >
          {integrate.isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <GitMerge className="size-3.5" aria-hidden="true" />
          )}
          {integrate.isPending ? "Integrating…" : "Integrate & review"}
        </GlassButton>
      ) : (
        // Present but calm until every subtask is review-ready, so the action is
        // never a dead end and its unlock condition is legible.
        <span
          data-testid="board-integrate-pending"
          title="Integration unlocks once every subtask is ready for review."
          className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-2 py-1 text-[11px] text-(--color-text-muted)"
        >
          <GitMerge className="size-3.5" aria-hidden="true" />
          Integrate when ready
        </span>
      )}

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
            : "The combined diff of every subtask merged into the parent's integration worktree. Review it here before merging to your main branch."
        }
      >
        <div data-testid="board-combined-diff" className="h-[62vh] min-h-0">
          <ChangesPanel workspaceId={board.parent.id} />
        </div>
      </Dialog>
    </div>
  );
}
