import { useCallback, useSyncExternalStore } from "react";
import type { TaskAgentState } from "@/lib/types";

/**
 * The composer's queue in transcript view (spec §3): a message sent while
 * a turn runs waits, shown as "Queued", and goes when the turn ends.
 *
 * One slot, not a list: a second message sent while one waits joins it,
 * so the agent gets everything you said as one message rather than one
 * turn per fragment.
 */
export type QueuedMessage = string | null;

type AgentStateKind = TaskAgentState["state"];

/** Whether a message sent now must wait for the turn to end. */
export function mustQueue(state: AgentStateKind | null | undefined): boolean {
  return state === "working";
}

/** Add `message` to the slot. */
export function enqueue(queued: QueuedMessage, message: string): string {
  return queued ? `${queued}\n\n${message}` : message;
}

/**
 * Whether the queued message goes now: the turn is over (idle, exited or
 * untracked) and the agent isn't waiting on an approval, where text would
 * be refused (`awaiting answer`) — it goes once that's answered and the
 * turn after it ends.
 */
export function shouldFlush(queued: QueuedMessage, state: AgentStateKind | null | undefined, sending: boolean): boolean {
  if (!queued || sending) return false;
  return state !== "working" && state !== "needs-you";
}

/**
 * The slot per task, outside React: the session view remounts on every
 * task switch, and a message you queued (and saw leave the input) must
 * not vanish because you looked at another task meanwhile. It goes once
 * this task's composer is back on screen and the turn has ended.
 */
const slots = new Map<string, string>();
const listeners = new Set<() => void>();

export const queuedMessages = {
  get: (taskId: string): QueuedMessage => slots.get(taskId) ?? null,
  set(taskId: string, value: QueuedMessage) {
    if ((slots.get(taskId) ?? null) === value) return;
    if (value) slots.set(taskId, value);
    else slots.delete(taskId);
    for (const l of listeners) l();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useQueuedMessage(taskId: string): [QueuedMessage, (next: QueuedMessage) => void] {
  const value = useSyncExternalStore(queuedMessages.subscribe, () => queuedMessages.get(taskId));
  const set = useCallback((next: QueuedMessage) => queuedMessages.set(taskId, next), [taskId]);
  return [value, set];
}
