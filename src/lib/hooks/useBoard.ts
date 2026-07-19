import { useQuery, useQueryClient } from "@tanstack/react-query";
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
