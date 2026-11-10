/**
 * Tauri event names emitted by the backend. Must match the constants in
 * `src-tauri/src/commands/events.rs` (the single bridge from the Rust
 * runtime services onto the event bus).
 */

/** Task lifecycle transitions. Payload: `TaskStatusPayload`. */
export const TASK_STATUS_EVENT = "phasr://task-status";

/**
 * A task's agent state changed (working / idle / needs-you / exited).
 * Payload: `TaskAgentState` — a full snapshot for that task.
 */
export const TASK_AGENT_STATE_EVENT = "phasr://task-agent-state";

/** A task's token usage changed (≤ 1 per task per 5s). Payload: `TaskUsagePayload`. */
export const TASK_USAGE_EVENT = "phasr://task-usage";

/**
 * Board cards in a repository may have changed lane or content (status,
 * agent state, diff). Coalesced (≤ 1 per repository per 300ms) and carries
 * no card data — refetch `list_task_cards`. Payload: `TaskCardsChangedPayload`.
 */
export const TASK_CARDS_CHANGED_EVENT = "phasr://task-cards-changed";

/** A check run was queued, started or settled. Payload: `CheckRun` (the full row). */
export const CHECK_RUN_EVENT = "phasr://check-run";

/**
 * New output from a running check, batched ≤ 1 per run per 250ms.
 * Payload: `CheckOutputPayload`. Lossy under load — `get_check_output`
 * has the full log.
 */
export const CHECK_OUTPUT_EVENT = "phasr://check-output";

/** A run command started, confirmed its port, or exited. Payload: `RunningCommand`. */
export const RUN_COMMAND_STATE_EVENT = "phasr://run-command-state";

/**
 * An inbox entry was recorded. Payload: `AppNotification`. Whether it also
 * becomes a banner / sound is `notificationPolicy.ts::shouldDeliver`.
 */
export const NOTIFICATION_CREATED_EVENT = "phasr://notification-created";

/**
 * A needs-you notification's body was clicked (macOS, `notify_attention`).
 * The backend already brought the window forward; open the task on its
 * agent pane. Payload: `AttentionActivatedPayload`.
 */
export const ATTENTION_ACTIVATED_EVENT = "phasr://attention-activated";

/**
 * Files changed in a watched worktree (debounced; `.git`, `node_modules`,
 * `target`, `dist` filtered). Emitted by `src-tauri/src/fswatch.rs` while a
 * workspace is watched (`watch_workspace`). Payload:
 * `{ workspaceId: string; paths: string[] }` — empty `paths` = unknown.
 */
export const WORKTREE_CHANGED_EVENT = "worktree-changed";

/**
 * A cloud-sync cycle finished / failed. Emitted by the sync worker
 * (`src-tauri/src/sync/mod.rs`), not `commands/events.rs`. Payloads: none /
 * the error string.
 */
export const CLOUD_SYNC_UPDATED_EVENT = "cloud-sync-updated";
export const CLOUD_SYNC_ERROR_EVENT = "cloud-sync-error";
