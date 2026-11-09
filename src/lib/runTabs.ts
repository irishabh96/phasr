import { runKey } from "@/lib/store";
import type { RunningCommand } from "@/lib/types";

/**
 * Which open run tabs belong to this task's pane bar: ones the user opened
 * here, or ones that are running here (e.g. started on task start). A tab
 * opened in task A no longer shows — and mounts, and runs — in task B.
 */
export function runTabsForTask(
  openTabs: readonly string[],
  shown: Record<string, true>,
  running: RunningCommand[] | null | undefined,
  scope: string | null,
): string[] {
  const runningHere = new Set(
    (Array.isArray(running) ? running : []).filter((r) => r.running).map((r) => r.runCommandId),
  );
  return openTabs.filter((id) => shown[runKey(id, scope)] || runningHere.has(id));
}
