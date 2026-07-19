import { useSyncExternalStore } from "react";
import type { AgentLiveness } from "@/lib/deriveAgentState";

/**
 * A tiny module-level store of the latest liveness snapshot per task, fed by
 * the `phasr://task-status` stream (`useTaskEvents`) and read by the sidebar
 * indicator + header badge. Mirrors the `toast.ts` `useSyncExternalStore`
 * pattern — deliberately outside React Query, because liveness is a
 * high-frequency, ephemeral signal, not a persisted row (Step 0 — S0.1).
 *
 * Only running-liveness transitions (`working | idle | wedged`) are stored
 * here; terminal `done | failed` states live on the persisted row's
 * `status`/`exitCode` and are derived from there, not from this store.
 */

let livenessByTask: Record<string, AgentLiveness> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record the latest liveness for a task. No-ops (no re-render) when the
 * snapshot is unchanged, so a repeat event can never thrash subscribers.
 */
export function setAgentLiveness(taskId: string, next: AgentLiveness) {
  const prev = livenessByTask[taskId];
  if (
    prev &&
    prev.derivedState === next.derivedState &&
    prev.lastActivityAt === next.lastActivityAt
  ) {
    return;
  }
  // Reassign the top-level map (new reference) but keep unchanged per-task
  // objects by reference so their `useSyncExternalStore` snapshots stay stable.
  livenessByTask = { ...livenessByTask, [taskId]: next };
  emit();
}

/** Drop a task's liveness (e.g. once it leaves `running`). */
export function clearAgentLiveness(taskId: string) {
  if (!(taskId in livenessByTask)) return;
  const { [taskId]: _removed, ...rest } = livenessByTask;
  livenessByTask = rest;
  emit();
}

export function getAgentLiveness(taskId: string): AgentLiveness | undefined {
  return livenessByTask[taskId];
}

/** Test-only reset so specs don't leak liveness between cases. */
export function __resetAgentLiveness() {
  livenessByTask = {};
  emit();
}

/** Subscribe a component to a single task's liveness snapshot. */
export function useAgentLiveness(
  taskId: string | null | undefined,
): AgentLiveness | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (taskId ? livenessByTask[taskId] : undefined),
    () => (taskId ? livenessByTask[taskId] : undefined),
  );
}

/**
 * Subscribe to the WHOLE liveness map at once. Used by the task board, which
 * derives every subtask card's state in one place (no per-card hook in a
 * variable-length loop). The map reference is stable across no-op events
 * (`setAgentLiveness`/`clearAgentLiveness` only reassign on a real change), so
 * this is a safe `useSyncExternalStore` snapshot.
 */
export function useAllAgentLiveness(): Record<string, AgentLiveness> {
  return useSyncExternalStore(
    subscribe,
    () => livenessByTask,
    () => livenessByTask,
  );
}
