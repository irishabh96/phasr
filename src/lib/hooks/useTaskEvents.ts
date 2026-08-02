import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { clearAgentLiveness, setAgentLiveness } from "@/lib/agentLiveness";
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
      const { taskId, repositoryId, status, derivedState, lastActivityAt, busy } =
        event.payload;

      // Honest-status liveness (Step 0 — S0.1): feed the module store the
      // running-liveness transitions (working/idle/wedged) so the sidebar +
      // header can render the derived state without polling. The exit-watcher's
      // terminal `done`/`failed` (and any exit to stopped/archived) drops the
      // task from the live set — its state is then derived from the persisted
      // row's status/exitCode instead.
      if (
        derivedState === "working" ||
        derivedState === "idle" ||
        derivedState === "wedged"
      ) {
        setAgentLiveness(taskId, {
          derivedState,
          lastActivityAt,
          busy: busy ?? false,
        });
      } else if (status !== "running" && status !== "pending") {
        clearAgentLiveness(taskId);
      }

      queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", taskId] });
      queryClient.invalidateQueries({
        queryKey: ["workspaces", "repository", repositoryId],
      });
      // Keep the cross-repo Worklist honest on terminal transitions (a finished
      // agent's row comes from the persisted board/looseAgent snapshot, which
      // the liveness store can't refresh). Reuses THIS listener — no new
      // subscription (spec §F1). Between refetches, `useAllAgentLiveness`
      // re-buckets the live rows in place.
      queryClient.invalidateQueries({ queryKey: ["worklist"] });
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
