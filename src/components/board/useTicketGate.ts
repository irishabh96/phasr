import { useAgentLiveness } from "@/lib/agentLiveness";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import {
  blockingRoles,
  deriveBoardState,
  type BoardCardState,
} from "@/lib/deriveBoardState";
import { deriveNextGate, type GateVerb, type NextGate } from "@/lib/deriveNextGate";
import {
  useBoard,
  useBoardGates,
  useRequestReview,
  useResolveReview,
  useStartTicket,
  useValidateTicket,
} from "@/lib/hooks/useBoard";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useNow } from "@/lib/useNow";
import type { ReviewRecord, ValidateResult, Workspace } from "@/lib/types";

/**
 * The forward/in-progress lanes where re-running Validate is meaningful (checks
 * can actually run against a live-or-recent worktree). `deriveNextGate`'s own
 * contract invites "re-run Validate from the chip / ⌘K" even when the single
 * next gate has moved on to a disabled Request-review — so the command surfaces
 * expose Validate here, off the already-derived `state` (never a second ladder).
 */
const VALIDATABLE_STATES: ReadonlySet<BoardCardState> = new Set<BoardCardState>([
  "working",
  "idle",
  "wedged",
  "failed",
  "interrupted",
  "stopped",
  "resolving",
  "qas-changes-requested",
  "needs-review",
]);

export interface TicketGateController {
  /** The single derived next gate — the SAME `deriveNextGate` result the header/card render. */
  gate: NextGate;
  state: BoardCardState;
  review: ReviewRecord | null;
  validateResult: ValidateResult | null;
  checksConfigured: boolean;
  /** Re-run Validate is available in a forward state with checks configured. */
  canValidate: boolean;
  /** Disabled-with-reason copy for a Validate that can't run right now. */
  validateReason: string | null;
  /** Any of the ticket-gate mutations is in flight. */
  pending: boolean;
  /** Dispatch a gate verb via the EXISTING `tauri.ts` mutation (validate/request-review/approve). */
  run: (verb: GateVerb) => Promise<unknown>;
  /** Bounce-back (changes requested) with a required comment. */
  bounce: (comment: string) => Promise<unknown>;
}

/**
 * The ticket's gate controller — the derivation + dispatch wiring lifted out of
 * {@link TicketNextGate} so every human command surface (the header button, the
 * ⌘K Commands group, the ⋯ menu) reads the SAME `deriveNextGate` ladder and
 * fires the SAME `useBoard` mutations. Returns `null` when `workspace` is not a
 * started subtask (no epic / board), so a caller can render nothing.
 *
 * Hooks run unconditionally (Rules of Hooks); passing `null`/a non-subtask keeps
 * every query disabled (`enabled: !!parentId`) and returns `null` after the hook
 * calls — so it is safe to mount on any workspace, or none.
 */
export function useTicketGate(
  workspace: Workspace | null | undefined,
): TicketGateController | null {
  const isSubtask = workspace?.workspaceKind === "subtask";
  const parentId = isSubtask ? (workspace?.parentId ?? null) : null;
  const repositoryId = workspace?.repositoryId ?? "";

  const { data: board } = useBoard(parentId ?? undefined);
  const { data: gates } = useBoardGates(parentId ?? undefined);
  const { data: runCommands } = useRunCommands(repositoryId);

  const live = useAgentLiveness(workspace?.id);
  const now = useNow(
    isLiveState(
      live?.derivedState ??
        (workspace?.status === "running" ? "working" : "stopped"),
    ),
  );

  const validate = useValidateTicket(parentId ?? "");
  const requestReview = useRequestReview(parentId ?? "");
  const resolveReview = useResolveReview(parentId ?? "");
  const startTicket = useStartTicket(parentId ?? "");

  if (!workspace || !isSubtask || !parentId || !board) return null;

  const review = gates?.reviews.find((r) => r.subtaskId === workspace.id) ?? null;
  const validateResult =
    gates?.validations.find((v) => v.subtaskId === workspace.id) ?? null;
  const checksConfigured = (runCommands ?? []).some((c) => c.runInValidate);

  const { state } = deriveBoardState(workspace, board, live, now, review ?? undefined);
  const blockedOn = state === "blocked" ? blockingRoles(workspace, board) : [];

  const gate = deriveNextGate({
    kind: "ticket",
    state,
    validate: validateResult,
    review,
    checksConfigured,
    blockedOn,
    // Ready-but-unscheduled (pending, edges satisfied) → the Start override.
    queued: workspace.status === "pending" && state !== "blocked",
    // The owning epic's autopilot flag rides on the already-fetched board DTO
    // (`board.parent` is this ticket's epic). Threading it downgrades an
    // autopilot-owned AUTO gate (Validate / Request-review) from coral primary
    // to neutral "autopilot-driving" — so the ticket-detail header + ⌘K palette
    // read the SAME intent the board/worklist already do. Off/absent ⇒ the exact
    // pre-autopilot ladder (parity preserved).
    autopilotEnabled: board.parent.autopilotEnabled,
  });

  const canValidate = checksConfigured && VALIDATABLE_STATES.has(state);
  const validateReason = !checksConfigured
    ? "No validate checks configured for this repository"
    : state === "blocked"
      ? "This ticket hasn't started yet"
      : state === "in-review"
        ? "In review — awaiting your decision"
        : !canValidate
          ? "Nothing to validate right now"
          : null;

  const pending =
    validate.isPending ||
    requestReview.isPending ||
    resolveReview.isPending ||
    startTicket.isPending;

  const run = (verb: GateVerb): Promise<unknown> => {
    switch (verb) {
      case "start":
        return startTicket.mutateAsync(workspace.id);
      case "validate":
        return validate.mutateAsync(workspace.id);
      case "request-review":
        return requestReview.mutateAsync(workspace.id);
      case "approve":
        return resolveReview.mutateAsync({
          subtaskId: workspace.id,
          decision: "approve",
        });
      default:
        return Promise.resolve();
    }
  };

  const bounce = (comment: string): Promise<unknown> =>
    resolveReview.mutateAsync({
      subtaskId: workspace.id,
      decision: "bounce",
      comment,
    });

  return {
    gate,
    state,
    review,
    validateResult,
    checksConfigured,
    canValidate,
    validateReason,
    pending,
    run,
    bounce,
  };
}
