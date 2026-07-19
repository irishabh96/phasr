import {
  deriveAgentState,
  type AgentLiveness,
  type AgentUiState,
} from "@/lib/deriveAgentState";
import type {
  BoardState,
  WorkspaceContract,
  WorkspaceDependency,
  Workspace,
} from "@/lib/types";

/**
 * The board-card state — a superset of the honest agent `AgentUiState`
 * (Step 0: `working | idle | wedged | done | failed | resolving | …`) plus two
 * board-only buckets the backend NEVER emits and NEVER stores (spec claim #10,
 * exactly like `resolving`/`stopped` are frontend-only in Step 0):
 *
 * - `blocked`       — a `pending` subtask with an unsatisfied incoming edge:
 *                     a dependency whose producer has no published contract.
 *                     Rendered NEUTRAL/MUTED, never coral — "it is not on you".
 * - `needs-review`  — this subtask finished its job (its contract is published,
 *                     or it exited cleanly / `done`) and is awaiting integration.
 */
export type BoardCardState = AgentUiState | "blocked" | "needs-review";

/** The four read-only board lanes, left → right. States are DERIVED, not draggable. */
export type BoardColumn = "backlog" | "in-progress" | "review" | "done";

export interface BoardCardResult {
  state: BoardCardState;
  /** Cosmetic "Ns ago" elapsed, forwarded from the honest agent state. */
  since: number | null;
}

/** Just the edge/contract slices `deriveBoardState` reads from a board. */
type BoardGraph = Pick<BoardState, "dependencies" | "contracts">;

function hasPublishedContract(
  subtaskId: string,
  contracts: readonly WorkspaceContract[],
): boolean {
  return contracts.some(
    (c) => c.subtaskId === subtaskId && c.publishedAt != null,
  );
}

/** Incoming edges into `subtaskId` (edges where it is the consumer). */
function incomingEdges(
  subtaskId: string,
  dependencies: readonly WorkspaceDependency[],
): WorkspaceDependency[] {
  return dependencies.filter((d) => d.toSubtaskId === subtaskId);
}

/**
 * A `pending` consumer is blocked while ANY incoming edge's producer has not
 * yet published a contract. A subtask with no incoming edge (the root, e.g.
 * `backend`) is never blocked.
 */
function isBlocked(subtask: Workspace, board: BoardGraph): boolean {
  if (subtask.status !== "pending") return false;
  const incoming = incomingEdges(subtask.id, board.dependencies);
  if (incoming.length === 0) return false;
  return incoming.some(
    (edge) => !hasPublishedContract(edge.fromSubtaskId, board.contracts),
  );
}

/**
 * Derive one subtask card's board state. PURE — unit-tested across every
 * precedence branch. Reuses Step 0's `deriveAgentState` for the honest running
 * status, then layers the two board-only buckets on top. Precedence:
 *
 *   1. published contract → `needs-review`  (handoff complete, strongest signal)
 *   2. honest `done`      → `needs-review`  (clean exit = ready for review)
 *   3. pending + unsatisfied incoming edge → `blocked`
 *   4. otherwise the honest `deriveAgentState` value (working/idle/wedged/…)
 */
export function deriveBoardState(
  subtask: Workspace,
  board: BoardGraph,
  liveness: AgentLiveness | undefined,
  now: number,
): BoardCardResult {
  const agent = deriveAgentState(subtask, liveness, now);

  // 1. A published contract is the strongest "this subtask finished its job"
  //    signal — ready for review regardless of whether the PTY is still up.
  if (hasPublishedContract(subtask.id, board.contracts)) {
    return { state: "needs-review", since: agent.since };
  }

  // 2. A cleanly-exited subtask is also ready for review.
  if (agent.state === "done") {
    return { state: "needs-review", since: agent.since };
  }

  // 3. A pending consumer whose producer hasn't published is blocked — neutral,
  //    never coral. This is derived, never a stored `WorkspaceStatus`.
  if (isBlocked(subtask, board)) {
    return { state: "blocked", since: null };
  }

  // 4. Otherwise the honest Step 0 liveness state.
  return { state: agent.state, since: agent.since };
}

/**
 * The producer roles a blocked subtask is waiting on, for the "waiting for
 * backend" chip. Resolves each unsatisfied incoming edge's producer id to its
 * `role`. Empty when the subtask isn't blocked.
 */
export function blockingRoles(
  subtask: Workspace,
  board: BoardState,
): string[] {
  if (!isBlocked(subtask, board)) return [];
  const roles: string[] = [];
  for (const edge of incomingEdges(subtask.id, board.dependencies)) {
    if (hasPublishedContract(edge.fromSubtaskId, board.contracts)) continue;
    const producer = board.subtasks.find((s) => s.id === edge.fromSubtaskId);
    const label = producer?.role ?? producer?.name ?? "upstream";
    if (!roles.includes(label)) roles.push(label);
  }
  return roles;
}

/** Which read-only lane a card lands in, derived from its board-card state. */
export function boardColumn(state: BoardCardState): BoardColumn {
  switch (state) {
    // Waiting to start / blocked upstream / queued — nothing is running yet.
    case "blocked":
    case "resolving":
    case "stopped":
      return "backlog";
    // A live (or attention-needing) agent is in flight.
    case "working":
    case "idle":
    case "wedged":
    case "failed":
    case "interrupted":
      return "in-progress";
    // Contract published / clean exit — awaiting the human's integrate review.
    case "needs-review":
      return "review";
    // Integrated (P0: only the parent lands here once integration ships).
    case "done":
      return "done";
  }
}
