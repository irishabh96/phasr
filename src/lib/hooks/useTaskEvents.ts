import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { TaskStatusPayload } from "@/lib/types";

/**
 * Listens for `phasr://task-status` events emitted by the new task
 * orchestrator (see `src-tauri/src/commands/orchestrator.rs::spawn_status_bridge`).
 *
 * Each transition (pending → running → completed/failed/stopped) lands here.
 * We invalidate the affected workspace row + its repository's list so any
 * mounted UI reflects the new state without polling.
 *
 * Note: per the project memory in
 * `~/.claude/projects/-Users-rishabh-code-phasr/memory/project_pty_exit_for_interactive_agents.md`,
 * interactive agents (Claude / Codex / Cursor) sit in a REPL and never
 * trigger a real PTY exit — so `completed` / `failed` events here only
 * fire on actual process death (a crash, the user typing `exit`, or a
 * stop). Don't build "agent finished a turn" semantics off this signal.
 */
export function useTaskEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<TaskStatusPayload>("phasr://task-status", (event) => {
      const { taskId, repositoryId } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", taskId] });
      queryClient.invalidateQueries({
        queryKey: ["workspaces", "repository", repositoryId],
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
}
