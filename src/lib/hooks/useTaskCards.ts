import { listen } from "@tauri-apps/api/event";
import {
  notifyManager,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { createKeyedCoalescer } from "@/lib/coalesce";
import {
  CLOUD_SYNC_ERROR_EVENT,
  CLOUD_SYNC_UPDATED_EVENT,
  TASK_CARDS_CHANGED_EVENT,
  TASK_STATUS_EVENT,
} from "@/lib/events";
import { tauri, type CreateTaskDraftInput } from "@/lib/tauri";
import type {
  StartedTask,
  TaskAgentState,
  TaskCard,
  TaskCardsChangedPayload,
  TaskStatusPayload,
  Workspace,
} from "@/lib/types";

/**
 * Board (M7): task cards in backend-derived lanes, drafts, the queue, and
 * the system counts (sync state for the account menu and bell).
 *
 * Freshness without polling:
 * - `phasr://task-cards-changed` (coalesced by the backend whenever a lane
 *   may have moved — status, agent state, diff) and `phasr://task-status`
 *   refetch the affected cards.
 * - `phasr://task-agent-state` patches the matching card's `agentState` in
 *   place, so the running card's activity line stays live without a
 *   refetch per tool call. (Lane changes it causes arrive as
 *   cards-changed.) That listener is `useAgentSignalEvents`, which
 *   coalesces it and calls `applyAgentStatesToCards`.
 */

export const taskCardKeys = {
  all: ["task-cards"] as const,
  /** `null` = every repository. */
  list: (repositoryId: string | null) =>
    [...taskCardKeys.all, "list", repositoryId ?? "*"] as const,
  systemStatus: () => [...taskCardKeys.all, "system-status"] as const,
};

/** Replace one task's agent state inside a card list. Pure; exported for tests. */
export function patchCardAgentState(
  cards: TaskCard[] | undefined,
  state: TaskAgentState,
): TaskCard[] | undefined {
  return patchCardAgentStates(cards, [state]);
}

/**
 * Several tasks' agent states patched into ONE new list. Cards it does not
 * touch keep their identity (so their memoised rows skip the render), and
 * a list with nothing to patch is returned as-is. Pure; exported for tests.
 */
export function patchCardAgentStates(
  cards: TaskCard[] | undefined,
  states: Iterable<TaskAgentState>,
): TaskCard[] | undefined {
  if (!cards) return cards;
  let copy: TaskCard[] | null = null;
  for (const state of states) {
    const i = (copy ?? cards).findIndex((c) => c.workspace.id === state.taskId);
    const card = (copy ?? cards)[i];
    if (!card || card.agentState === state) continue;
    copy ??= cards.slice();
    copy[i] = { ...card, agentState: state };
  }
  return copy ?? cards;
}

/**
 * Patch a batch of agent states into every cached card list it concerns
 * (its repository's and the all-repositories one). Lists with no matching
 * card are not written at all, so their subscribers are not notified.
 */
export function applyAgentStatesToCards(
  queryClient: QueryClient,
  states: TaskAgentState[],
): void {
  const byList = new Map<string | null, TaskAgentState[]>([[null, states]]);
  for (const state of states) {
    const list = byList.get(state.repositoryId) ?? [];
    list.push(state);
    byList.set(state.repositoryId, list);
  }
  notifyManager.batch(() => {
    for (const [repo, forList] of byList) {
      const key = taskCardKeys.list(repo);
      const prev = queryClient.getQueryData<TaskCard[]>(key);
      const next = patchCardAgentStates(prev, forList);
      if (next !== prev) queryClient.setQueryData<TaskCard[]>(key, next);
    }
  });
}

/** Whether a change in `repositoryId` concerns the list for `listRepo`. */
function concerns(listRepo: string | null, repositoryId: string): boolean {
  return listRepo === null || listRepo === repositoryId;
}

/** Coalescer key for "the status bar counts are stale". */
const SYSTEM_STATUS = "\0system-status";

/**
 * Subscribe to the board's events for the caller's lifetime. Mounted once,
 * by `useAppEvents`; a second mount would only invalidate twice.
 *
 * Invalidations are coalesced (`lib/coalesce.ts`): several repositories'
 * cards-changed in one window cost ONE refetch of the all-repositories
 * list instead of one cancelled-and-restarted refetch per event.
 */
export function useTaskCardEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };
    const stale = createKeyedCoalescer<true>((batch) => {
      const repos = [...batch.keys()].filter((k) => k !== SYSTEM_STATUS);
      notifyManager.batch(() => {
        if (repos.length > 0) {
          queryClient.invalidateQueries({
            predicate: (q) =>
              q.queryKey[0] === taskCardKeys.all[0] &&
              q.queryKey[1] === "list" &&
              repos.some((repo) =>
                concerns(q.queryKey[2] === "*" ? null : (q.queryKey[2] as string), repo),
              ),
          });
        }
        if (batch.has(SYSTEM_STATUS)) {
          queryClient.invalidateQueries({ queryKey: taskCardKeys.systemStatus() });
        }
      });
    });

    void listen<TaskCardsChangedPayload>(TASK_CARDS_CHANGED_EVENT, (event) => {
      stale.push(event.payload.repositoryId, true);
      stale.push(SYSTEM_STATUS, true);
    }).then(keep);

    // A status change also reaches the board as task-cards-changed (after
    // the backend's 300 ms coalescing, with the fresh diff), so only the
    // system counts are refreshed here; refetching the card list too
    // made every status change cost two full board loads.
    void listen<TaskStatusPayload>(TASK_STATUS_EVENT, () => {
      stale.push(SYSTEM_STATUS, true);
    }).then(keep);

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
      stale.flush();
      stale.dispose();
    };
  }, [queryClient]);
}

/** Task cards for one repository, or every repository when `null`. */
export function useTaskCards(repositoryId: string | null) {
  return useQuery({
    queryKey: taskCardKeys.list(repositoryId),
    queryFn: () => tauri.listTaskCards(repositoryId),
    // Events say when to refetch; this only bounds a missed one.
    staleTime: 60_000,
  });
}

/** Invalidate everything a created/changed/started task can show up in. */
function invalidateTask(
  queryClient: ReturnType<typeof useQueryClient>,
  workspace: Workspace,
) {
  queryClient.invalidateQueries({ queryKey: taskCardKeys.all });
  queryClient.invalidateQueries({
    queryKey: ["workspaces", "repository", workspace.repositoryId],
  });
  queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", workspace.id] });
}

/** "Save as draft" (`queue: false`) or queue a task (`queue: true`). */
export function useCreateTaskDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskDraftInput) => tauri.createTaskDraft(input),
    onSuccess: (workspace) => invalidateTask(queryClient, workspace),
  });
}

/** "Start now" for a draft or queued task. */
export function useStartQueuedTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rows, cols }: { id: string; rows?: number; cols?: number }) =>
      tauri.startQueuedTask(id, rows, cols),
    onSuccess: (started: StartedTask) => invalidateTask(queryClient, started.workspace),
  });
}

/**
 * Status bar counts: running agents, worktrees, cloud-sync state. Polled
 * every 30s and refreshed on task/board/sync events.
 */
export function useSystemStatus() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };
    const refresh = () =>
      queryClient.invalidateQueries({ queryKey: taskCardKeys.systemStatus() });
    void listen(CLOUD_SYNC_UPDATED_EVENT, refresh).then(keep);
    void listen(CLOUD_SYNC_ERROR_EVENT, refresh).then(keep);
    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: taskCardKeys.systemStatus(),
    queryFn: tauri.getSystemStatus,
    refetchInterval: 30_000,
  });
}
