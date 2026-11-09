import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  CLOUD_SYNC_ERROR_EVENT,
  CLOUD_SYNC_UPDATED_EVENT,
  TASK_AGENT_STATE_EVENT,
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
 * the status bar's system counts.
 *
 * Freshness without polling:
 * - `phasr://task-cards-changed` (coalesced by the backend whenever a lane
 *   may have moved — status, agent state, diff) and `phasr://task-status`
 *   refetch the affected cards.
 * - `phasr://task-agent-state` patches the matching card's `agentState` in
 *   place, so the running card's activity line stays live without a
 *   refetch per tool call. (Lane changes it causes arrive as
 *   cards-changed.)
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
  if (!cards) return cards;
  const i = cards.findIndex((c) => c.workspace.id === state.taskId);
  const card = cards[i];
  if (!card) return cards;
  const copy = cards.slice();
  copy[i] = { ...card, agentState: state };
  return copy;
}

/** Whether a change in `repositoryId` concerns the list for `listRepo`. */
function concerns(listRepo: string | null, repositoryId: string): boolean {
  return listRepo === null || listRepo === repositoryId;
}

/**
 * Subscribe to the board's events for the caller's lifetime. Mounting it
 * more than once is harmless: every handler is an idempotent
 * invalidate/patch.
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
    const invalidateRepo = (repositoryId: string) => {
      queryClient.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === taskCardKeys.all[0] &&
          q.queryKey[1] === "list" &&
          concerns(q.queryKey[2] === "*" ? null : (q.queryKey[2] as string), repositoryId),
      });
    };

    void listen<TaskCardsChangedPayload>(TASK_CARDS_CHANGED_EVENT, (event) => {
      invalidateRepo(event.payload.repositoryId);
      queryClient.invalidateQueries({ queryKey: taskCardKeys.systemStatus() });
    }).then(keep);

    void listen<TaskStatusPayload>(TASK_STATUS_EVENT, (event) => {
      invalidateRepo(event.payload.repositoryId);
      queryClient.invalidateQueries({ queryKey: taskCardKeys.systemStatus() });
    }).then(keep);

    void listen<TaskAgentState>(TASK_AGENT_STATE_EVENT, (event) => {
      const state = event.payload;
      for (const repo of [state.repositoryId, null]) {
        queryClient.setQueryData<TaskCard[]>(taskCardKeys.list(repo), (prev) =>
          patchCardAgentState(prev, state),
        );
      }
    }).then(keep);

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
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
