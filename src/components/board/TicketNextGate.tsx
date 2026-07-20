import { NextGateButton } from "@/components/board/NextGateButton";
import { ValidateChip } from "@/components/board/GateChips";
import { useTicketGate } from "@/components/board/useTicketGate";
import type { Workspace } from "@/lib/types";

/**
 * The ticket-detail header's single derived next gate (mockup Page 04) — the
 * same `deriveNextGate` ladder the board card reads, rendered as the header's
 * one primary ("Request review", Approve + Bounce, …) alongside the Validate
 * chip. All derivation + dispatch lives in the shared {@link useTicketGate}
 * controller, so this header, the ⌘K Commands group, and the ⋯ menu stay in
 * lockstep (one ladder, one set of mutations). Renders nothing unless the
 * workspace is a started subtask with a loaded board.
 */
export function TicketNextGate({ workspace }: { workspace: Workspace }) {
  const ctrl = useTicketGate(workspace);
  if (!ctrl) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-2"
      data-testid="ticket-next-gate"
    >
      {ctrl.checksConfigured || ctrl.validateResult ? (
        <ValidateChip
          validate={ctrl.validateResult}
          checksConfigured={ctrl.checksConfigured}
        />
      ) : null}
      <NextGateButton
        gate={ctrl.gate}
        size="sm"
        pending={ctrl.pending}
        onRun={ctrl.run}
        onBounce={ctrl.bounce}
      />
    </div>
  );
}
