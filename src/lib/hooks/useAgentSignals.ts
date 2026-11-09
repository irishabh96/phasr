import { listen } from "@tauri-apps/api/event";
import {
  notifyManager,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { createKeyedCoalescer } from "@/lib/coalesce";
import { TASK_AGENT_STATE_EVENT, TASK_USAGE_EVENT } from "@/lib/events";
import { applyAgentStatesToCards } from "@/lib/hooks/useTaskCards";
import { tauri } from "@/lib/tauri";
import type {
  AttentionResponse,
  TaskAgentState,
  TaskUsage,
  TaskUsagePayload,
} from "@/lib/types";

/**
 * Agent signals (M6): per-task working / idle / needs-you / exited state,
 * in-app approvals, token usage and the agent's last message.
 *
 * One snapshot query (`list_agent_states`) is patched in place by
 * `phasr://task-agent-state` events, so every consumer shares one cache
 * entry and none of them poll. Each event carries the task's full state, so
 * patching is a replace-by-taskId.
 */

export const agentSignalKeys = {
  all: ["agent-signals"] as const,
  states: () => [...agentSignalKeys.all, "states"] as const,
  usage: (taskId: string) => [...agentSignalKeys.all, "usage", taskId] as const,
  summary: (taskId: string) => [...agentSignalKeys.all, "summary", taskId] as const,
  fileEdits: (taskId: string) => [...agentSignalKeys.all, "file-edits", taskId] as const,
};

/** Replace (or add) one task's state in the snapshot. Pure; exported for tests. */
export function upsertAgentState(
  prev: TaskAgentState[] | undefined,
  next: TaskAgentState,
): TaskAgentState[] {
  return upsertAgentStates(prev, [next]);
}

/**
 * Replace (or add) several tasks' states in ONE new snapshot — the form a
 * coalesced flush applies. Entries for other tasks keep their identity,
 * which is what lets `useTaskAgentState(B)` ignore an update to task A.
 */
export function upsertAgentStates(
  prev: TaskAgentState[] | undefined,
  next: Iterable<TaskAgentState>,
): TaskAgentState[] {
  const list = prev ?? [];
  let copy: TaskAgentState[] | null = null;
  for (const state of next) {
    copy ??= list.slice();
    const i = copy.findIndex((s) => s.taskId === state.taskId);
    if (i === -1) copy.push(state);
    else copy[i] = state;
  }
  return copy ?? list;
}

/** A finished turn: the summary, the edits and the workspace row are stale. */
function endsTurn(state: TaskAgentState): boolean {
  return state.state === "idle" && !!state.lastTurnEndedAt;
}

/**
 * Apply one coalesced batch of agent states to every cache that mirrors
 * them (the snapshot, and each task-card list's `agentState`) inside one
 * `notifyManager.batch`, so subscribers hear about the whole batch once.
 * Exported for tests.
 */
export function applyAgentStateBatch(
  queryClient: QueryClient,
  states: TaskAgentState[],
  turnEnded: Iterable<string> = [],
): void {
  if (states.length === 0) return;
  notifyManager.batch(() => {
    queryClient.setQueryData<TaskAgentState[]>(agentSignalKeys.states(), (prev) =>
      upsertAgentStates(prev, states),
    );
    applyAgentStatesToCards(queryClient, states);
    // A finished turn means a fresh summary (and the synced turn-end on
    // the workspace row).
    for (const taskId of turnEnded) {
      queryClient.invalidateQueries({ queryKey: agentSignalKeys.summary(taskId) });
      queryClient.invalidateQueries({ queryKey: agentSignalKeys.fileEdits(taskId) });
      queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", taskId] });
    }
  });
}

/**
 * Subscribe to agent-state + usage events for the lifetime of the caller.
 * Mounted ONCE, by `useAppEvents`. It also keeps the task cards' copy of
 * the agent state current, so the board's row and the snapshot can never
 * disagree for a frame.
 *
 * Coalesced to ≤ 30 Hz (`lib/coalesce.ts`, last state per task wins): a
 * tool-heavy turn emits a state per tool call, and each one used to be its
 * own cache write, i.e. its own render of the sidebar, the board and the
 * inspector.
 */
export function useAgentSignalEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };

    // Tracked beside the coalescer, not inside it: a batch keeps only the
    // LAST state per task, and a turn that ended mid-burst (idle, then
    // working again) must still refresh the summary it produced.
    const turnEnded = new Set<string>();
    const states = createKeyedCoalescer<TaskAgentState>((batch) => {
      const ended = [...turnEnded];
      turnEnded.clear();
      applyAgentStateBatch(queryClient, [...batch.values()], ended);
    });
    const usage = createKeyedCoalescer<TaskUsagePayload>((batch) => {
      notifyManager.batch(() => {
        for (const { taskId, usage: u } of batch.values()) {
          queryClient.setQueryData<TaskUsage | null>(agentSignalKeys.usage(taskId), u);
        }
      });
    });

    void listen<TaskAgentState>(TASK_AGENT_STATE_EVENT, (event) => {
      const state = event.payload;
      if (endsTurn(state)) turnEnded.add(state.taskId);
      states.push(state.taskId, state);
    }).then(keep);

    void listen<TaskUsagePayload>(TASK_USAGE_EVENT, (event) => {
      usage.push(event.payload.taskId, event.payload);
    }).then(keep);

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
      // What already arrived is still true: apply it rather than drop it.
      states.flush();
      usage.flush();
      states.dispose();
      usage.dispose();
    };
  }, [queryClient]);
}

/** Every tracked task's agent state, kept live by events. */
export function useAgentStates() {
  return useQuery({
    queryKey: agentSignalKeys.states(),
    queryFn: tauri.listAgentStates,
    // Events keep it current; a refetch only matters after a remount.
    staleTime: Infinity,
  });
}

/**
 * One task's agent state, or `null` when phasr isn't tracking it.
 *
 * Narrow on purpose: through `select`, a consumer re-renders only when
 * THIS task's entry changes (the snapshot keeps every other task's entry
 * by identity), not on every event for every task.
 */
export function useTaskAgentState(taskId: string | null | undefined): TaskAgentState | null {
  const select = useCallback(
    (list: TaskAgentState[]) =>
      taskId ? (list.find((s) => s.taskId === taskId) ?? null) : null,
    [taskId],
  );
  const { data } = useQuery({
    queryKey: agentSignalKeys.states(),
    queryFn: tauri.listAgentStates,
    staleTime: Infinity,
    select,
  });
  return data ?? null;
}

/**
 * Answer an approval card. On "stale attention" the card is already gone or
 * replaced: the snapshot is refetched so the UI shows the current dialog.
 */
export function useRespondToAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      attentionId,
      response,
    }: {
      taskId: string;
      attentionId: string;
      response: AttentionResponse;
    }) => tauri.respondToAttention(taskId, attentionId, response),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: agentSignalKeys.states() });
    },
  });
}

/** Token/cost totals; `null` for agents without usage (hide the row). */
export function useTaskUsage(taskId: string | null | undefined) {
  return useQuery({
    queryKey: agentSignalKeys.usage(taskId ?? ""),
    queryFn: () => tauri.getTaskUsage(taskId ?? ""),
    enabled: !!taskId,
    // Updates arrive via `phasr://task-usage`.
    staleTime: Infinity,
  });
}

/** The agent's last assistant message; refreshed when a turn ends. */
export function useAgentSummary(taskId: string | null | undefined) {
  return useQuery({
    queryKey: agentSignalKeys.summary(taskId ?? ""),
    queryFn: () => tauri.getAgentSummary(taskId ?? ""),
    enabled: !!taskId,
  });
}
