import { NextGateButton } from "@/components/board/NextGateButton";
import { ValidateChip } from "@/components/board/GateChips";
import { useAgentLiveness } from "@/lib/agentLiveness";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import { blockingRoles, deriveBoardState } from "@/lib/deriveBoardState";
import { deriveNextGate } from "@/lib/deriveNextGate";
import {
  useBoard,
  useBoardGates,
  useRequestReview,
  useResolveReview,
  useValidateTicket,
} from "@/lib/hooks/useBoard";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useNow } from "@/lib/useNow";
import type { Workspace } from "@/lib/types";

/**
 * The ticket-detail header's single derived next gate (mockup Page 04) — the
 * same `deriveNextGate` ladder the board card reads, rendered as the header's
 * one primary ("Request review", Approve + Bounce, …) alongside the Validate
 * chip. Reuses the shared board-gate query cache (`useBoard`/`useBoardGates`) so
 * it stays in lockstep with the board. Mounts only on a subtask with a worktree.
 */
export function TicketNextGate({ workspace }: { workspace: Workspace }) {
  const parentId = workspace.parentId;
  const { data: board } = useBoard(parentId ?? undefined);
  const { data: gates } = useBoardGates(parentId ?? undefined);
  const { data: runCommands } = useRunCommands(workspace.repositoryId);

  const live = useAgentLiveness(workspace.id);
  const now = useNow(
    isLiveState(
      live?.derivedState ??
        (workspace.status === "running" ? "working" : "stopped"),
    ),
  );

  const validate = useValidateTicket(parentId ?? "");
  const requestReview = useRequestReview(parentId ?? "");
  const resolveReview = useResolveReview(parentId ?? "");

  if (!parentId || !board) return null;

  const review = gates?.reviews.find((r) => r.subtaskId === workspace.id);
  const validateResult =
    gates?.validations.find((v) => v.subtaskId === workspace.id) ?? null;
  const checksConfigured = (runCommands ?? []).some((c) => c.runInValidate);

  const { state } = deriveBoardState(workspace, board, live, now, review);
  const blockedOn = state === "blocked" ? blockingRoles(workspace, board) : [];

  const gate = deriveNextGate({
    kind: "ticket",
    state,
    validate: validateResult,
    review: review ?? null,
    checksConfigured,
    blockedOn,
  });

  const pending =
    validate.isPending || requestReview.isPending || resolveReview.isPending;

  const runGate = (verb: string): Promise<unknown> => {
    switch (verb) {
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

  return (
    <div
      className="flex shrink-0 items-center gap-2"
      data-testid="ticket-next-gate"
    >
      {checksConfigured || validateResult ? (
        <ValidateChip
          validate={validateResult}
          checksConfigured={checksConfigured}
        />
      ) : null}
      <NextGateButton
        gate={gate}
        size="sm"
        pending={pending}
        onRun={runGate}
        onBounce={(comment) =>
          resolveReview.mutateAsync({
            subtaskId: workspace.id,
            decision: "bounce",
            comment,
          })
        }
      />
    </div>
  );
}
