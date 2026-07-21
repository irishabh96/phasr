import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { AutopilotHaltedBanner } from "@/components/AutopilotHaltedBanner";
import { AutopilotToggle } from "@/components/board/AutopilotToggle";
import { BoardCardView } from "@/components/board/BoardCard";
import { NextGateButton } from "@/components/board/NextGateButton";
import { IntegrationDiff } from "@/components/board/IntegrationDiff";
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
  deriveNextGate,
  isAutopilotOwnedGate,
  isIntegrateEligible,
  type NextGate,
} from "@/lib/deriveNextGate";
import {
  boardKeys,
  isIntegrationConflict,
  useIntegrateParent,
  useRequestReview,
  useResolveReview,
  useValidateTicket,
} from "@/lib/hooks/useBoard";
import { useSetAutopilot } from "@/lib/hooks/useAutopilot";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { useNow } from "@/lib/useNow";
import type {
  BoardGates,
  BoardState,
  ReviewRecord,
  ValidateResult,
  Workspace,
} from "@/lib/types";

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
  /** The driver owns this ticket's next move (an AUTO gate) under autopilot. */
  autopilotOwned: boolean;
  render: React.ReactNode;
}

/**
 * The read-only task board (S2-T1, extended for Phase 3 gates). Places the
 * parent + its subtask cards into four DERIVED lanes (Backlog → In progress →
 * Review → Done) via `deriveBoardState` — the lanes are NOT draggable; a card's
 * column is a pure function of its honest state (edges × contracts × liveness),
 * now layered with the review decision (`review.json`) from {@link BoardGates}.
 *
 * Each card + the epic header render the shared {@link NextGateButton} off the
 * pure `deriveNextGate` ladder (G1), and each card shows the Validate chip (V2)
 * + the review chips (R2). Gates are fed in via `gates`/`checksConfigured`/
 * `shipped` (the route fetches them; `/design-test` passes fixtures) so this
 * component performs no IPC of its own.
 */
export function BoardView({
  board,
  gates,
  checksConfigured = false,
  shipped = false,
}: {
  board: BoardState;
  gates?: BoardGates;
  checksConfigured?: boolean;
  shipped?: boolean;
}) {
  const livenessMap = useAllAgentLiveness();
  const navigate = useNavigate();

  const validate = useValidateTicket(board.parent.id);
  const requestReview = useRequestReview(board.parent.id);
  const resolveReview = useResolveReview(board.parent.id);

  const reviewFor = (id: string): ReviewRecord | undefined =>
    gates?.reviews.find((r) => r.subtaskId === id);
  const validateFor = (id: string): ValidateResult | null =>
    gates?.validations.find((v) => v.subtaskId === id) ?? null;

  // Map a ticket card's gate verb → its mutation. Bounce is separate (it needs a
  // comment); the button surfaces it as a paired secondary.
  const runTicketGate = (verb: string, subtaskId: string): Promise<unknown> => {
    switch (verb) {
      case "validate":
        return validate.mutateAsync(subtaskId);
      case "request-review":
        return requestReview.mutateAsync(subtaskId);
      case "approve":
        return resolveReview.mutateAsync({ subtaskId, decision: "approve" });
      default:
        return Promise.resolve();
    }
  };

  // Tick the shared clock only while a subtask carries a live counter.
  const anyLive = board.subtasks.some((s) => {
    const snapshot = livenessMap[s.id];
    return isLiveState(
      snapshot?.derivedState ??
        (s.status === "running" ? "working" : "stopped"),
    );
  });
  const now = useNow(anyLive);

  // Autopilot is a per-epic flag on the parent (Phase 5a §7). When on, the AUTO
  // gates the driver fires (Validate / Request-review) render NEUTRAL instead of
  // coral, and "driving" surfaces the calm ambient chip.
  const autopilotEnabled = board.parent.autopilotEnabled;

  const cards: DerivedCard[] = board.subtasks.map((subtask) => {
    const review = reviewFor(subtask.id);
    const validateResult = validateFor(subtask.id);
    const { state, since } = deriveBoardState(
      subtask,
      board,
      livenessMap[subtask.id],
      now,
      review,
    );
    const blockedOnRoles =
      state === "blocked" ? blockingRoles(subtask, board) : [];

    const gate = deriveNextGate({
      kind: "ticket",
      state,
      validate: validateResult,
      review: review ?? null,
      checksConfigured,
      blockedOn: blockedOnRoles,
      autopilotEnabled,
    });

    // A card's gate is in flight while its underlying mutation targets THIS id.
    const gatePending =
      (validate.isPending && validate.variables === subtask.id) ||
      (requestReview.isPending && requestReview.variables === subtask.id) ||
      (resolveReview.isPending &&
        resolveReview.variables?.subtaskId === subtask.id);

    return {
      subtask,
      state,
      column: boardColumn(state),
      autopilotOwned: autopilotEnabled && isAutopilotOwnedGate(gate),
      render: (
        <BoardCardView
          key={subtask.id}
          role={subtask.role}
          name={subtask.name}
          state={state}
          since={since}
          exitCode={subtask.exitCode}
          blockedOnRoles={blockedOnRoles}
          review={review ?? null}
          validate={validateResult}
          checksConfigured={checksConfigured}
          gate={gate}
          gatePending={gatePending}
          onRunGate={(verb) => runTicketGate(verb, subtask.id)}
          onBounceGate={(comment) =>
            resolveReview.mutateAsync({
              subtaskId: subtask.id,
              decision: "bounce",
              comment,
            })
          }
          onOpen={() =>
            void navigate({
              to: "/repositories/$repositoryId/workspaces/$workspaceId",
              params: {
                repositoryId: subtask.repositoryId,
                workspaceId: subtask.id,
              },
            })
          }
        />
      ),
    };
  });

  // Every ticket integrate-eligible (§B) → the epic can integrate. Derived
  // purely off the (review-layered) card states, so approval is respected.
  const integrable =
    cards.length > 0 && cards.every((c) => isIntegrateEligible(c.state));

  // "Driving" = autopilot is on AND at least one ticket's next move is the
  // driver's (an AUTO gate) → the calm ambient chip (§7).
  const autopilotDriving =
    autopilotEnabled && cards.some((c) => c.autopilotOwned);

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid="board-view">
      <AutopilotHaltedBanner />
      <BoardParentHeader
        board={board}
        integrable={integrable}
        shipped={shipped}
        autopilotEnabled={autopilotEnabled}
        autopilotDriving={autopilotDriving}
      />

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
 * The parent (the decomposition itself). Rendered as a summary header hosting
 * the epic's single derived next gate (Integrate → Ship, §G1/R7) via the shared
 * {@link NextGateButton}. A CLEAN integrate opens the ONE combined diff against
 * the parent id (the R7 "legible reward"); a CONFLICT routes into the EXISTING
 * conflict-resolution surface (`ChangesPanel`) keyed on the parent id — never a
 * dead end (DDR-002). Ship (once integrated) reuses `MergeToMainDialog`'s
 * existing merge + conflict flow verbatim.
 */
function BoardParentHeader({
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
  const { data: repository } = useRepository(board.parent.repositoryId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewMode, setReviewMode] = useState<"clean" | "conflict">("clean");
  const [shipOpen, setShipOpen] = useState(false);

  const done = board.contracts.filter((c) => c.publishedAt != null).length;
  const goal = board.parent.prompt?.trim() || board.parent.name;

  // The parent carries an integration branch/worktree once integrated.
  const integrated = !!board.parent.branch;

  const epicGate = deriveNextGate({
    kind: "epic",
    ticketCount: board.subtasks.length,
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
      className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-surface) p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Epic · {board.subtasks.length} tickets
        </span>
        <h2 className="truncate text-[15px] font-semibold text-(--color-text-primary)">
          {goal}
        </h2>
        <span className="text-[11px] text-(--color-text-muted)">
          {done}/{board.subtasks.length} contracts published
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
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
