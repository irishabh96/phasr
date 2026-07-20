import { deriveBoardState } from "@/lib/deriveBoardState";
import { isIntegrateEligible } from "@/lib/deriveNextGate";
import type { AgentLiveness } from "@/lib/deriveAgentState";
import type { BoardState, ReviewRecord } from "@/lib/types";

/**
 * Whether an epic is integrate-eligible — the SAME predicate `BoardView` uses
 * for the header's Integrate gate (`cards.every(isIntegrateEligible)`), lifted
 * into a pure helper so the ⌘K palette + the ⋯ menu can derive the epic's
 * Integrate/Ship gate WITHOUT re-mounting the board. Each subtask's lane is the
 * one honest `deriveBoardState` value (edges × contracts × liveness × review);
 * the ladder itself still lives solely in `deriveNextGate` — this only computes
 * one of its inputs.
 */
export function deriveEpicIntegrable(
  board: Pick<BoardState, "subtasks" | "dependencies" | "contracts">,
  reviews: readonly ReviewRecord[] | undefined,
  liveness: Record<string, AgentLiveness>,
  now: number,
): boolean {
  if (board.subtasks.length === 0) return false;
  return board.subtasks.every((s) => {
    const review = reviews?.find((r) => r.subtaskId === s.id);
    const { state } = deriveBoardState(s, board, liveness[s.id], now, review);
    return isIntegrateEligible(state);
  });
}
