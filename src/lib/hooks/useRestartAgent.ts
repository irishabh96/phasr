import { getCurrentWindow } from "@tauri-apps/api/window";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { tauri } from "@/lib/tauri";

/**
 * Recovery affordance for Wedged / Failed / Interrupted agents (Step 0 —
 * S0.2-T2). Returns a click handler that:
 *
 *   1. Best-effort `stop_task` — releases a stuck/live PTY (SIGINT, then the
 *      backend's own SIGKILL escalation). A stopped/interrupted row has no live
 *      process, so this rejects harmlessly (`TaskNotRunning`) and is caught.
 *   2. Focuses + navigates to the workspace. The main Terminal then resumes a
 *      non-terminal row in its original worktree/branch on mount
 *      (`open_terminal`, `service.rs`) and surfaces its own Restart overlay for
 *      a finished one — so no Wedged/Failed surface is a dead end (DDR-002).
 *
 * We deliberately do NOT `open_task_terminal` here: the backend's `stop_task`
 * arms a 3 s SIGKILL escalation that would race an immediate re-spawn. Letting
 * the visible Terminal own the resume keeps a single owner of the PTY channel.
 */
export function useRestartAgent(workspaceId: string, repositoryId: string) {
  const navigate = useNavigate();

  return useCallback(async () => {
    try {
      await tauri.stopTask(workspaceId);
    } catch {
      // No live process (already stopped/failed/interrupted) — nothing to stop.
    }
    try {
      const win = getCurrentWindow();
      await win.unminimize();
      await win.setFocus();
    } catch {
      // Focus is best-effort; navigation below still happens.
    }
    void navigate({
      to: "/repositories/$repositoryId/workspaces/$workspaceId",
      params: { repositoryId, workspaceId },
    });
  }, [navigate, workspaceId, repositoryId]);
}
