import { deriveAgentState } from "@/lib/deriveAgentState";
import {
  blockingRoles,
  deriveBoardState,
  type BoardCardState,
} from "@/lib/deriveBoardState";
import type { AgentLiveness } from "@/lib/deriveAgentState";
import type { Agent, Workspace, WorklistState } from "@/lib/types";

/**
 * The four cross-repo attention buckets of the Worklist home (mockup Page 01),
 * grouped by DERIVED honest state — NOT by hierarchy. Ordered by attention cost:
 *
 * - `needs-you` — a human decision is owed: wedged / failed / interrupted, or a
 *                 finished ticket awaiting integration (`needs-review`).
 * - `running`   — the factory is working for you: an agent in flight (working /
 *                 idle / resolving). Calm, not an alert.
 * - `waiting`   — `blocked` upstream. The CALM group — NEVER "Needs you": a
 *                 blocked ticket is not the user's fault (spec §A4 / claim #10).
 * - `recent`    — settled: cleanly done or stopped.
 */
export type WorklistBucket = "needs-you" | "running" | "waiting" | "recent";

/**
 * Map one derived board-card state to its worklist bucket. PURE — unit-tested
 * across every `BoardCardState`. This is the single source of truth for the
 * worklist grouping, the sibling of `boardColumn()` (which maps the same states
 * to the per-epic board lanes). Only STATUS carries meaning here; the bucketing
 * itself is honest and time-independent.
 *
 * Bucket map (spec §F1 AC):
 *   wedged | failed | interrupted | needs-review | in-review |
 *     qas-changes-requested                       → needs-you
 *   working | idle | resolving                    → running
 *   blocked                                        → waiting
 *   done | stopped                                 → recent
 *
 * The Phase 3 review buckets both surface to the human: `in-review` awaits the
 * reviewer's Approve/Bounce, and `qas-changes-requested` was bounced back and
 * needs re-work — both belong in "needs-you".
 */
export function worklistBucket(state: BoardCardState): WorklistBucket {
  switch (state) {
    case "wedged":
    case "failed":
    case "interrupted":
    case "needs-review":
    case "in-review":
    case "qas-changes-requested":
      return "needs-you";
    case "working":
    case "idle":
    case "resolving":
      return "running";
    case "blocked":
      return "waiting";
    case "done":
    case "stopped":
      return "recent";
  }
}

/** The buckets in render order (mockup Page 01). */
export const WORKLIST_BUCKET_ORDER: readonly WorklistBucket[] = [
  "needs-you",
  "running",
  "waiting",
  "recent",
] as const;

/** Human labels for each bucket header (mockup Page 01). */
export const WORKLIST_BUCKET_LABEL: Record<WorklistBucket, string> = {
  "needs-you": "Needs you",
  running: "Running",
  waiting: "Waiting",
  recent: "Recent",
};

/**
 * One flat, ready-to-render worklist row. A `subtask` row belongs to an epic
 * (its `epicGoal`/`parentId` are set); a `loose` row is standalone single-agent
 * work (no epic). `open` navigates to the same target for both — the ticket /
 * workspace detail (a subtask id IS a workspace id, spec §D2).
 */
export interface WorklistItem {
  /** Workspace id — the drill-in target + the React key. */
  id: string;
  repositoryId: string;
  repoName: string;
  /** Ticket / agent display name. */
  name: string;
  /** Persona / DAG-slot chip (neutral). `null` for loose single-agent work. */
  role: string | null;
  /** Agent-type mark (C/O/G…); `null` for a `local` (no agent) workspace. */
  agent: Agent | null;
  /** Owning epic's short label (parent name) for the sub-line + chip; `null` for loose work. */
  epicName: string | null;
  /** Owning epic (`parent`) id for the epic filter chip; `null` for loose work. */
  parentId: string | null;
  /** Branch / merge-target hint for the sub-line + search. */
  branch: string | null;
  /** Whether the ticket was integrated/merged (drives the "merged into main" sub-line). */
  merged: boolean;
  /** Producer roles a `blocked` row is waiting on ("waiting for backend"); `[]` otherwise. */
  blockedOnRoles: string[];
  /** Process exit code for the honest `failed` badge; `null` when not applicable. */
  exitCode: number | null;
  state: BoardCardState;
  /** Cosmetic "Ns ago" elapsed forwarded from the honest state. */
  since: number | null;
  bucket: WorklistBucket;
  /** Lowercased haystack for client-side search (repo · epic · name · branch · role). */
  haystack: string;
}

function repoNameOf(state: WorklistState, repositoryId: string): string {
  return (
    state.repositories.find((r) => r.id === repositoryId)?.name ?? repositoryId
  );
}

function buildHaystack(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p)
    .join(" ")
    .toLowerCase();
}

/**
 * Flatten a `WorklistState` into derived, bucketed rows — the single place the
 * worklist's "what's true" is computed (spec §A4). Every epic subtask derives
 * via `deriveBoardState` (edges × contracts × liveness); every loose agent via
 * `deriveAgentState`. Liveness is read once by the caller from the module store
 * (`useAllAgentLiveness`) so there is no per-row hook in a variable-length loop.
 *
 * PURE (given `now`) so it is trivially unit-testable and re-runs on every
 * liveness tick to re-bucket rows in place with no new subscription.
 */
export function buildWorklistItems(
  worklist: WorklistState,
  liveness: Record<string, AgentLiveness>,
  now: number,
): WorklistItem[] {
  const items: WorklistItem[] = [];

  for (const board of worklist.boards) {
    const repoName = repoNameOf(worklist, board.parent.repositoryId);
    const epicName = board.parent.name;
    const epicGoal = board.parent.prompt?.trim() || board.parent.name;
    for (const subtask of board.subtasks) {
      const { state, since } = deriveBoardState(
        subtask,
        board,
        liveness[subtask.id],
        now,
      );
      items.push({
        id: subtask.id,
        repositoryId: subtask.repositoryId,
        repoName,
        name: subtask.name,
        role: subtask.role,
        agent: subtask.agent,
        epicName,
        parentId: board.parent.id,
        branch: subtask.branch,
        merged: state === "done",
        blockedOnRoles:
          state === "blocked" ? blockingRoles(subtask, board) : [],
        exitCode: subtask.exitCode,
        state,
        since,
        bucket: worklistBucket(state),
        haystack: buildHaystack([
          repoName,
          epicName,
          epicGoal,
          subtask.name,
          subtask.role,
          subtask.branch,
        ]),
      });
    }
  }

  for (const agent of worklist.looseAgents) {
    const repoName = repoNameOf(worklist, agent.repositoryId);
    const { state, since } = deriveAgentState(agent, liveness[agent.id], now);
    items.push({
      id: agent.id,
      repositoryId: agent.repositoryId,
      repoName,
      name: agent.name,
      role: agent.role,
      agent: agent.agent,
      epicName: null,
      parentId: null,
      branch: agent.branch,
      // A cleanly-finished standalone agent reads as "merged into main" (mockup
      // Page 01 Recent/Done); a stopped one keeps its branch.
      merged: state === "done",
      blockedOnRoles: [],
      exitCode: agent.exitCode,
      state,
      since,
      bucket: worklistBucket(state),
      haystack: buildHaystack([repoName, agent.name, agent.role, agent.branch]),
    });
  }

  return items;
}

/** Count of rows that owe the user a decision — drives the sidebar Home badge. */
export function needsYouCount(items: WorklistItem[]): number {
  return items.reduce(
    (n, item) => (item.bucket === "needs-you" ? n + 1 : n),
    0,
  );
}

/**
 * Whether ANY row carries a live "Ns ago" counter — mirrors `BoardView`'s
 * `anyLive`. Computed WITHOUT `now` (state-only) so the caller can gate the
 * shared 1 Hz clock (`useNow`) before it derives the rows, and the tree never
 * ticks when every agent is finished/idle-forever.
 */
export function worklistHasLiveRow(
  worklist: WorklistState,
  liveness: Record<string, AgentLiveness>,
): boolean {
  const rows: Workspace[] = [
    ...worklist.boards.flatMap((b) => b.subtasks),
    ...worklist.looseAgents,
  ];
  return rows.some((row) => {
    const snapshot = liveness[row.id];
    const state =
      snapshot?.derivedState ??
      (row.status === "running" ? "working" : "stopped");
    return state === "working" || state === "idle" || state === "wedged";
  });
}
