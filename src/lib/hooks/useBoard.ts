import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { tauri } from "@/lib/tauri";
import type {
  BoardChangedPayload,
  MergeStrategy,
  ReviewDecision,
  TaskStatusPayload,
} from "@/lib/types";

export const boardKeys = {
  all: ["board"] as const,
  detail: (parentId: string) => [...boardKeys.all, parentId] as const,
  gates: (parentId: string) => [...boardKeys.all, parentId, "gates"] as const,
};

/** Fetch one parent's board (`get_board`). Refetches on mount. */
export function useBoard(parentId: string | null | undefined) {
  return useQuery({
    queryKey: boardKeys.detail(parentId ?? ""),
    queryFn: () => tauri.getBoard(parentId ?? ""),
    enabled: !!parentId,
  });
}

/**
 * Batched gate side-load for a board (§J8): every ticket's `review.json` +
 * `validate.json` in ONE `get_board_gates` read, so lanes + chips render in a
 * single round-trip. Fed to `deriveBoardState`/`deriveNextGate` alongside the
 * board. Invalidated by the same `phasr://board-changed` / gate-mutation paths
 * as the board query, so a lane move surfaces live.
 */
export function useBoardGates(parentId: string | null | undefined) {
  return useQuery({
    queryKey: boardKeys.gates(parentId ?? ""),
    queryFn: () => tauri.getBoardGates(parentId ?? ""),
    enabled: !!parentId,
  });
}

/**
 * True when an `integrateParent` rejection is the "stopped on conflicts" signal
 * (as opposed to a hard failure). The conflicting files ride the message; the
 * caller routes this to the interactive conflict surface, not an error toast.
 */
export function isIntegrationConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("integration stopped on conflicts");
}

/**
 * "Mark done" override (E2-T4): publish a stuck producer's handoff contract so
 * its blocked dependent unblocks on the scheduler's next tick. Seeds the board
 * cache with the returned `BoardState` and invalidates so the lanes re-derive.
 */
export function usePublishContract(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subtaskId: string) => tauri.publishContract(subtaskId),
    onSuccess: (board) => {
      queryClient.setQueryData(boardKeys.detail(parentId), board);
      queryClient.invalidateQueries({ queryKey: boardKeys.detail(parentId) });
    },
  });
}

/**
 * Integration (E3-T1). `mutateAsync` RESOLVES with the board whose
 * `parent.branch`/`worktreePath` now point at the integration worktree on a
 * clean merge, or REJECTS with the "integration stopped on conflicts…" signal
 * ({@link isIntegrationConflict}) when a merge conflicts. Either outcome mutated
 * the parent row (a conflict still recorded the integration branch/worktree
 * before stopping), so we invalidate the board query in both cases — the caller
 * handles opening the combined diff vs. the conflict surface.
 */
export function useIntegrateParent(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.integrateParent(parentId),
    onSuccess: (board) => {
      queryClient.setQueryData(boardKeys.detail(parentId), board);
      queryClient.invalidateQueries({ queryKey: boardKeys.detail(parentId) });
    },
    onError: () => {
      // A conflict still pointed the parent row at the integration worktree, so
      // re-read the board (its lanes + the parent's now-set worktree) regardless.
      queryClient.invalidateQueries({ queryKey: boardKeys.detail(parentId) });
    },
  });
}

/** Invalidate BOTH the board DAG query and its gate side-load in one place. */
function invalidateBoard(
  queryClient: ReturnType<typeof useQueryClient>,
  parentId: string,
) {
  queryClient.invalidateQueries({ queryKey: boardKeys.detail(parentId) });
  queryClient.invalidateQueries({ queryKey: boardKeys.gates(parentId) });
}

/**
 * Validate a ticket (Phase 3 V2): run the opted-in checks in its worktree and
 * cache `validate.json`. Refreshes the board's gate side-load so the Validate
 * chip + the Request-review precondition re-derive from the fresh result.
 */
export function useValidateTicket(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subtaskId: string) => tauri.validateTicket(subtaskId),
    onSuccess: () => invalidateBoard(queryClient, parentId),
  });
}

/**
 * The manual Start override (Phase 5): spawn one READY ticket now instead of
 * waiting for the scheduler. The backend re-verifies readiness and answers a
 * not-ready ticket with the calm "Waiting for <roles>" reason.
 */
export function useStartTicket(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subtaskId: string) => tauri.startTicket(subtaskId),
    onSuccess: () => invalidateBoard(queryClient, parentId),
  });
}

/**
 * Request review (Phase 3 R2): writes `review.json{requested}` (and, for a
 * producer, composes `publish_contract` server-side so dependents unblock).
 * Returns the refreshed board — seed it, then invalidate so the derived Review
 * lane surfaces.
 */
export function useRequestReview(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subtaskId: string) => tauri.requestReview(subtaskId),
    onSuccess: (board) => {
      queryClient.setQueryData(boardKeys.detail(parentId), board);
      invalidateBoard(queryClient, parentId);
    },
  });
}

/**
 * Resolve a review (Phase 3 R2): `approve` → `review.json{approved}` (the ticket
 * becomes integrate-eligible); `bounce` → `review.json{changes-requested}` + a
 * thread comment (re-opens the ticket). `comment` is required for a bounce.
 */
export function useResolveReview(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      subtaskId,
      decision,
      comment,
    }: {
      subtaskId: string;
      decision: ReviewDecision;
      comment?: string;
    }) => tauri.resolveReview(subtaskId, decision, comment),
    onSuccess: (board) => {
      queryClient.setQueryData(boardKeys.detail(parentId), board);
      invalidateBoard(queryClient, parentId);
    },
  });
}

/**
 * Ship an integrated workflow: `ship_epic` merges the parent's integration
 * branch into the repo's default branch in the MAIN checkout and — on `clean`
 * — stamps the durable `shippedAt` milestone on the parent row. Local-merge
 * ONLY by decision: push / Open-PR are separate explicit post-ship actions in
 * the dialog. A `conflicts` outcome leaves the MAIN checkout mid-merge; the
 * dialog offers the repo-scoped Abort recovery. Invalidates the board so the
 * "Shipped" (terminal) state re-derives from the new fact.
 */
export function useShipEpic(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (strategy: MergeStrategy) => tauri.shipEpic(parentId, strategy),
    onSuccess: () => {
      invalidateBoard(queryClient, parentId);
      queryClient.invalidateQueries({
        queryKey: ["git", "branchStatus", parentId],
      });
    },
  });
}

/**
 * Keep the board fresh off two buses:
 *
 * 1. The EXISTING `phasr://task-status` stream (the same one `useTaskEvents`
 *    feeds the liveness store from). When an event fires for a KNOWN subtask of
 *    this board (an exit landed, a contract was detected), invalidate the board.
 *
 * 2. The NEW `phasr://board-changed { parentId }` event (Architect Stage-1 §R2 —
 *    the biggest-risk fix). A CLI/gate-driven mutation (or a brand-new sibling
 *    ticket via `phasr new-ticket`) carries an UNKNOWN subtask id, so (1) alone
 *    would never surface it. Matching on `parentId` invalidates BOTH the board
 *    DAG and its gate side-load, so lane moves AND new siblings appear live
 *    without a manual refresh.
 *
 * `subtaskIds` is the current membership only used to scope stream (1).
 */
export function useBoardTaskEvents(
  parentId: string | null | undefined,
  subtaskIds: readonly string[],
) {
  const queryClient = useQueryClient();
  // Stable string key so the effect doesn't re-subscribe on every render.
  const idsKey = [...subtaskIds].sort().join(",");

  useEffect(() => {
    if (!parentId) return;
    const ids = new Set(idsKey ? idsKey.split(",") : []);
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const track = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });

    // (1) Known-subtask lifecycle transitions.
    track(
      listen<TaskStatusPayload>("phasr://task-status", (event) => {
        if (ids.has(event.payload.taskId)) {
          invalidateBoard(queryClient, parentId);
        }
      }),
    );

    // (2) Any gate/CLI-driven change to THIS board — the live-invalidation path.
    track(
      listen<BoardChangedPayload>("phasr://board-changed", (event) => {
        if (event.payload.parentId === parentId) {
          invalidateBoard(queryClient, parentId);
        }
      }),
    );

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, [parentId, idsKey, queryClient]);
}
