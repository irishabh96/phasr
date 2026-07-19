import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { tauri } from "@/lib/tauri";
import type { TaskStatusPayload } from "@/lib/types";

export const boardKeys = {
  all: ["board"] as const,
  detail: (parentId: string) => [...boardKeys.all, parentId] as const,
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

/**
 * Keep the board fresh off the EXISTING `phasr://task-status` bus — the same
 * stream the global `useTaskEvents` already feeds the liveness store from (§C
 * default (a): no new board event). When an event fires for one of THIS
 * parent's subtasks (the scheduler spawned it, an exit landed, a contract was
 * detected), invalidate the board query so `get_board` re-reads the DAG.
 *
 * `subtaskIds` is the current membership; a brand-new subtask id that isn't in
 * the set yet still lands via the periodic refetch + the next event once the
 * board query re-includes it.
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
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<TaskStatusPayload>("phasr://task-status", (event) => {
      // Refetch when the event is for a known subtask of this board. (The
      // global useTaskEvents has already fed the liveness store; this only
      // owns the board query invalidation.)
      if (ids.has(event.payload.taskId)) {
        queryClient.invalidateQueries({ queryKey: boardKeys.detail(parentId) });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [parentId, idsKey, queryClient]);
}
