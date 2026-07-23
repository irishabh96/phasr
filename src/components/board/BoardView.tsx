import { AutopilotHaltedBanner } from "@/components/AutopilotHaltedBanner";
import { BoardCardView } from "@/components/board/BoardCard";
import { BoardParentHeader } from "@/components/board/BoardParentHeader";
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
} from "@/lib/deriveNextGate";
import {
  useRequestReview,
  useResolveReview,
  useValidateTicket,
} from "@/lib/hooks/useBoard";
import { useNavigate } from "@tanstack/react-router";
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

/**
 * Per-lane empty copy — a calm, honest hint (never a dead em-dash box). Each
 * lane says what its emptiness MEANS, since the columns are derived (not a
 * drop-target), so the placeholder describes state, not an invitation to drag.
 */
const EMPTY_HINT: Record<BoardColumn, string> = {
  backlog: "Nothing queued",
  "in-progress": "Nothing running",
  review: "Nothing to review",
  done: "Nothing done yet",
};

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
          agent={subtask.agent}
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

      {/* Four fixed lanes in a SINGLE horizontally-scrolling row (the
          Linear/Trello model). Each lane floors at 264px and grows equally to
          fill; once four lanes no longer fit (below ~1100px) the row scrolls
          sideways instead of WRAPPING to a second grid row — so a tall lane can
          never overflow onto the lane "below" it, because there is no row below.
          Each lane also scrolls its own cards vertically when the board is
          height-constrained, so cards never collide at any width. */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full gap-4">
          {COLUMNS.map(({ key, label }) => {
            const columnCards = cards.filter((c) => c.column === key);
            return (
              <section
                key={key}
                data-testid={`board-column-${key}`}
                className="flex min-h-0 min-w-[264px] flex-1 flex-col gap-2.5"
              >
                <header className="flex shrink-0 items-center gap-2 px-0.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-(--color-text-muted)">
                    {label}
                  </h3>
                  <span className="text-[11px] font-medium tabular-nums text-(--color-text-muted)">
                    {columnCards.length}
                  </span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
                  {columnCards.length ? (
                    columnCards.map((c) => c.render)
                  ) : (
                    <EmptyLane hint={EMPTY_HINT[key]} />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * A calm empty-lane placeholder — a soft, hairline-bordered tile that keeps the
 * column's card rhythm without shouting. Never a dead box or a lonely dash: it
 * carries an honest, muted one-liner for what this stage's emptiness means.
 */
function EmptyLane({ hint }: { hint: string }) {
  return (
    <p className="flex items-center justify-center rounded-(--radius-panel) border border-(--color-border-subtle) px-3 py-6 text-center text-[11.5px] text-(--color-text-muted)">
      {hint}
    </p>
  );
}
