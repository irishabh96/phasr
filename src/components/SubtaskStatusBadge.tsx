import type { CSSProperties } from "react";
import { Eye, Lock } from "lucide-react";
import { AgentStatusBadgeView } from "@/components/AgentStatusBadge";
import {
  ApprovedChip,
  ChangesRequestedChip,
  InReviewChip,
} from "@/components/board/GateChips";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import { useAgentLiveness } from "@/lib/agentLiveness";
import { deriveAgentState, type AgentUiState } from "@/lib/deriveAgentState";
import {
  blockingRoles,
  deriveBoardState,
  type BoardCardState,
} from "@/lib/deriveBoardState";
import { useBoard, useBoardGates } from "@/lib/hooks/useBoard";
import { useRestartAgent } from "@/lib/hooks/useRestartAgent";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useNow } from "@/lib/useNow";
import type { ReviewRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A board-card state that is a plain honest agent state (Step 0). */
function isAgentUiState(state: BoardCardState): state is AgentUiState {
  return (
    state !== "blocked" &&
    state !== "needs-review" &&
    state !== "in-review" &&
    state !== "qas-changes-requested"
  );
}

/**
 * Presentational: render any {@link BoardCardState} honestly. Mirrors
 * `BoardCardView`'s status block one-for-one — the honest agent family reuses
 * the Step 0 {@link AgentStatusBadgeView}; the board-only buckets get the SAME
 * calm chips the card + worklist use — so a card and its detail can never
 * disagree. Pure, so it can be unit-tested headlessly.
 */
export function BoardStateBadgeView({
  state,
  since,
  exitCode,
  changeCount,
  blockedOnRoles = [],
  review,
  onRestart,
}: {
  state: BoardCardState;
  since: number | null;
  exitCode?: number | null;
  changeCount?: number | null;
  blockedOnRoles?: string[];
  review?: ReviewRecord | null;
  onRestart?: () => void;
}) {
  if (isAgentUiState(state)) {
    return (
      <AgentStatusBadgeView
        state={state}
        since={since}
        {...(exitCode != null ? { exitCode } : {})}
        {...(changeCount != null ? { changeCount } : {})}
        {...(onRestart ? { onRestart } : {})}
      />
    );
  }
  if (state === "blocked") return <BlockedChip blockedOnRoles={blockedOnRoles} />;
  if (state === "in-review") return <InReviewChip />;
  if (state === "qas-changes-requested")
    return <ChangesRequestedChip comment={review?.comment ?? null} />;
  if (review?.state === "approved") return <ApprovedChip />;
  return <ReviewChip />;
}

/**
 * The workspace-header honest-status badge for a `subtask` — the detail-side
 * counterpart to the kanban card. Reads the SAME inputs the board card does
 * (the parent board + its gates + the liveness snapshot) and runs the SAME
 * {@link deriveBoardState}, so the header badge and the card never disagree
 * (fixes "board says running, item says idle"). Before the board loads it falls
 * back to the honest Step 0 agent state — never a raw "Running" status, never
 * an empty header.
 */
export function SubtaskStatusBadge({
  workspaceId,
  repositoryId,
  changeCount,
}: {
  workspaceId: string;
  repositoryId: string;
  changeCount?: number;
}) {
  const { data: workspace } = useWorkspace(workspaceId);
  const parentId =
    workspace?.workspaceKind === "subtask" ? workspace.parentId : null;
  const { data: board } = useBoard(parentId ?? undefined);
  const { data: gates } = useBoardGates(parentId ?? undefined);
  const live = useAgentLiveness(workspaceId);
  const restart = useRestartAgent(workspaceId, repositoryId);
  const now = useNow(
    isLiveState(
      live?.derivedState ??
        (workspace?.status === "running" ? "working" : "stopped"),
    ),
  );

  if (!workspace || workspace.workspaceKind !== "subtask") return null;

  const review =
    gates?.reviews.find((r) => r.subtaskId === workspaceId) ?? undefined;
  // The board-aware derivation once the board is in cache; the honest Step 0
  // agent state (a subset of BoardCardState) as a graceful pre-load fallback.
  const { state, since } = board
    ? deriveBoardState(workspace, board, live, now, review)
    : deriveAgentState(workspace, live, now);
  const blockedOnRoles =
    state === "blocked" && board ? blockingRoles(workspace, board) : [];

  return (
    <BoardStateBadgeView
      state={state}
      since={since}
      exitCode={workspace.exitCode}
      {...(changeCount != null ? { changeCount } : {})}
      blockedOnRoles={blockedOnRoles}
      review={review ?? null}
      onRestart={restart}
    />
  );
}

/**
 * The blocked "waiting for backend" chip. Deliberately MUTED (grey) — a blocked
 * agent is not the user's fault and never coral (mirrors `BoardCardView`).
 */
function BlockedChip({ blockedOnRoles }: { blockedOnRoles: string[] }) {
  const waiting = blockedOnRoles.length
    ? `waiting for ${blockedOnRoles.join(", ")}`
    : "waiting upstream";
  return (
    <span
      role="status"
      data-testid="subtask-blocked-chip"
      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium leading-none"
    >
      <Lock
        className="size-[13px] shrink-0 text-(--color-text-muted)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Blocked</span>
      <span className="text-(--color-text-muted)">· {waiting}</span>
    </span>
  );
}

/** The "ready for review" chip — a soft `info` invite for the human's turn. */
function ReviewChip() {
  const chipStyle: CSSProperties = {
    background:
      "color-mix(in oklab, var(--color-info) 14%, var(--color-bg-surface))",
    borderColor: "color-mix(in oklab, var(--color-info) 34%, transparent)",
  };
  return (
    <span
      role="status"
      data-testid="subtask-review-chip"
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2",
        "text-[12px] font-medium leading-none",
      )}
      style={chipStyle}
    >
      <Eye
        className="size-[13px] shrink-0 text-(--color-info)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Ready for review</span>
    </span>
  );
}
