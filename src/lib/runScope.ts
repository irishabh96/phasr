import type { RunningCommand } from "@/lib/types";

/**
 * Two scopes meet in a run tab, and mixing them up is how a tab opened in
 * one task ran in another:
 *
 *  - The TASK a tab belongs to (`taskId`): the task view it was opened in.
 *    `runPanel.shown` / `runPanel.intents` are keyed by it (`runKey`), so a
 *    tab only appears — and only ever starts — in that task. Outside any
 *    task (the board) there is no scope a task would ever read.
 *  - The TARGET it runs in (`runTarget`): the backend's `workspaceId`, i.e.
 *    the task's own worktree, or `null` for the repository checkout (drafts,
 *    synced tasks and in-place tasks have no worktree).
 *
 * A worktree-less draft and the board both run in the checkout (target
 * `null`), but they are different TASK scopes — so an intent created on
 * the board can never be consumed by the next draft.
 */

/** Where a task's run commands execute: its worktree, else the repo checkout (`null`). */
export function runTarget(
  task: { id: string; worktreePath: string | null } | null | undefined,
): string | null {
  return task?.worktreePath ? task.id : null;
}

/** Key for per-task run-tab state: `<runCommandId>@<taskId>` (or `@board`). */
export function runKey(runCommandId: string, taskId: string | null | undefined): string {
  return `${runCommandId}@${taskId ? `task:${taskId}` : "board"}`;
}

/**
 * Commands running in exactly `target`. The backend's `list_running_commands`
 * with `null` returns EVERY scope (each task's worktree too), so a
 * worktree-less task must not take that list as "running here".
 */
export function runningIn(
  running: readonly RunningCommand[] | null | undefined,
  target: string | null,
): RunningCommand[] {
  return (Array.isArray(running) ? running : []).filter((r) => (r.workspaceId ?? null) === target);
}

/**
 * The run tabs in this task's pane bar, in open order: ones opened in this
 * task, plus ones running in this task's own worktree (e.g. started on
 * task start). A worktree-less task's target is the shared checkout, so
 * there only the tabs opened in it count.
 */
export function runTabsForTask(
  openTabs: readonly string[],
  shown: Record<string, true>,
  running: readonly RunningCommand[] | null | undefined,
  taskId: string,
  target: string | null,
): string[] {
  const runningHere =
    target === null
      ? new Set<string>()
      : new Set(runningIn(running, target).filter((r) => r.running).map((r) => r.runCommandId));
  return openTabs.filter((id) => shown[runKey(id, taskId)] || runningHere.has(id));
}

/**
 * The run tab this task's run pane shows. `runPanel.activeTab` is global,
 * so it may name a tab from another task — then this task's newest tab,
 * or none.
 */
export function activeRunTabFor(activeTab: string | null, tabs: readonly string[]): string | null {
  if (activeTab && tabs.includes(activeTab)) return activeTab;
  return tabs[tabs.length - 1] ?? null;
}
