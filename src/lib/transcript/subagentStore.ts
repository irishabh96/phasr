import { create } from "zustand";

/**
 * Per-task state of the Running strip and the subagent panel, keyed by
 * task id (not persisted: a reload starts clean).
 *
 *  - `selectedSubagent[taskId]`: the subagent call (its tool_use id) the
 *    inspector column shows instead of the task's inspector. Kept per task,
 *    so switching tasks and back shows it again.
 *  - `pinned[taskId]`: strip chips that stay after they finish.
 *  - `dismissed[taskId]`: finished chips the user closed; they don't come
 *    back.
 */
export interface SubagentState {
  selectedSubagent: Readonly<Record<string, string>>;
  pinned: Readonly<Record<string, readonly string[]>>;
  dismissed: Readonly<Record<string, readonly string[]>>;
  /** Bumped by every `selectSubagent`, so a repeat open still counts (it expands a collapsed inspector). */
  openSeq: number;
  /** Show this subagent in the task's inspector column. */
  selectSubagent: (taskId: string, toolUseId: string) => void;
  /**
   * Back to the task's inspector. With `toolUseId`, only if that subagent
   * is still the one shown (a late "it's gone" mustn't close a newer one).
   */
  clearSubagent: (taskId: string, toolUseId?: string) => void;
  togglePin: (taskId: string, chipId: string) => void;
  /** Close a finished chip: unpinned, and it stays gone. */
  dismissChip: (taskId: string, chipId: string) => void;
  /** The task is gone: drop everything kept for it. */
  forgetTask: (taskId: string) => void;
}

const EMPTY: readonly string[] = [];

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

export const useSubagentStore = create<SubagentState>((set) => ({
  selectedSubagent: {},
  pinned: {},
  dismissed: {},
  openSeq: 0,
  selectSubagent: (taskId, toolUseId) =>
    set((s) => ({
      openSeq: s.openSeq + 1,
      selectedSubagent:
        s.selectedSubagent[taskId] === toolUseId ? s.selectedSubagent : { ...s.selectedSubagent, [taskId]: toolUseId },
    })),
  clearSubagent: (taskId, toolUseId) =>
    set((s) => {
      const current = s.selectedSubagent[taskId];
      if (current === undefined || (toolUseId !== undefined && current !== toolUseId)) return s;
      return { selectedSubagent: without(s.selectedSubagent, taskId) };
    }),
  togglePin: (taskId, chipId) =>
    set((s) => {
      const list = s.pinned[taskId] ?? EMPTY;
      const next = list.includes(chipId) ? list.filter((id) => id !== chipId) : [...list, chipId];
      return { pinned: { ...s.pinned, [taskId]: next } };
    }),
  dismissChip: (taskId, chipId) =>
    set((s) => {
      const pinned = s.pinned[taskId] ?? EMPTY;
      const dismissed = s.dismissed[taskId] ?? EMPTY;
      return {
        pinned: pinned.includes(chipId) ? { ...s.pinned, [taskId]: pinned.filter((id) => id !== chipId) } : s.pinned,
        dismissed: dismissed.includes(chipId) ? s.dismissed : { ...s.dismissed, [taskId]: [...dismissed, chipId] },
      };
    }),
  forgetTask: (taskId) =>
    set((s) => ({
      selectedSubagent: without(s.selectedSubagent, taskId),
      pinned: without(s.pinned, taskId),
      dismissed: without(s.dismissed, taskId),
    })),
}));

/** The subagent shown in a task's inspector column, if any. */
export function useSelectedSubagent(taskId: string): string | null {
  return useSubagentStore((s) => s.selectedSubagent[taskId] ?? null);
}

/** A stable empty list for selectors (`?? EMPTY_IDS`). */
export const EMPTY_IDS = EMPTY;
