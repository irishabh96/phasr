import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { TASK_AGENT_STATE_EVENT, TASK_USAGE_EVENT } from "@/lib/events";
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
  const list = prev ?? [];
  const i = list.findIndex((s) => s.taskId === next.taskId);
  if (i === -1) return [...list, next];
  const copy = list.slice();
  copy[i] = next;
  return copy;
}

/**
 * Subscribe to agent-state + usage events for the lifetime of the caller.
 * Mounted by `useAgentStates`; mounting it more than once is harmless
 * (each listener applies the same idempotent patch).
 */
function useAgentSignalEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };

    void listen<TaskAgentState>(TASK_AGENT_STATE_EVENT, (event) => {
      const state = event.payload;
      queryClient.setQueryData<TaskAgentState[]>(agentSignalKeys.states(), (prev) =>
        upsertAgentState(prev, state),
      );
      // A finished turn means a fresh summary (and the synced turn-end on
      // the workspace row).
      if (state.state === "idle" && state.lastTurnEndedAt) {
        queryClient.invalidateQueries({ queryKey: agentSignalKeys.summary(state.taskId) });
        queryClient.invalidateQueries({ queryKey: agentSignalKeys.fileEdits(state.taskId) });
        queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", state.taskId] });
      }
    }).then(keep);

    void listen<TaskUsagePayload>(TASK_USAGE_EVENT, (event) => {
      queryClient.setQueryData<TaskUsage | null>(
        agentSignalKeys.usage(event.payload.taskId),
        event.payload.usage,
      );
    }).then(keep);

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, [queryClient]);
}

/** Every tracked task's agent state, kept live by events. */
export function useAgentStates() {
  useAgentSignalEvents();
  return useQuery({
    queryKey: agentSignalKeys.states(),
    queryFn: tauri.listAgentStates,
    // Events keep it current; a refetch only matters after a remount.
    staleTime: Infinity,
  });
}

/** One task's agent state, or `null` when phasr isn't tracking it. */
export function useTaskAgentState(taskId: string | null | undefined): TaskAgentState | null {
  const { data } = useAgentStates();
  return useMemo(
    () => (taskId ? (data?.find((s) => s.taskId === taskId) ?? null) : null),
    [data, taskId],
  );
}

/** How many tasks are waiting on the user. */
export function useNeedsYouCount(): number {
  const { data } = useAgentStates();
  return useMemo(() => data?.filter((s) => s.state === "needs-you").length ?? 0, [data]);
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
  useAgentSignalEvents();
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
  useAgentSignalEvents();
  return useQuery({
    queryKey: agentSignalKeys.summary(taskId ?? ""),
    queryFn: () => tauri.getAgentSummary(taskId ?? ""),
    enabled: !!taskId,
  });
}

/** Files the agent edited (M9 editor); refreshed when a turn ends. */
export function useAgentFileEdits(taskId: string | null | undefined) {
  useAgentSignalEvents();
  return useQuery({
    queryKey: agentSignalKeys.fileEdits(taskId ?? ""),
    queryFn: () => tauri.listAgentFileEdits(taskId ?? ""),
    enabled: !!taskId,
  });
}
