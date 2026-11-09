/**
 * Stable substring of the backend's `OrchestratorError::NotStarted`
 * ("this task hasn't been started on this Mac yet"). `open_task_terminal`
 * returns it for a draft/queued task synced from a newer phasr build — a
 * `pending` row with no branch — which this build refuses to launch (it
 * has no worktree, so the agent would otherwise start in the repository's
 * own checkout). Keep in sync with `src-tauri/src/orchestrator/error.rs`.
 */
export const NOT_STARTED_MARKER = "hasn't been started on this Mac";

/** True when an `openTaskTerminal` rejection is the calm "not started" refusal. */
export function isNotStartedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(NOT_STARTED_MARKER);
}
