//! The one bridge from phasr's Tauri-agnostic runtime services onto the
//! Tauri event bus. Each service exposes a `tokio::broadcast`; this module
//! subscribes once at startup and re-emits. Event names here must match
//! `src/lib/events.ts`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;

use crate::agent_signals::{AgentSignalEvent, AgentSignals};
use crate::checks::{CheckEvent, CheckService};
use crate::domain::usage::TaskUsage;
use crate::notifications::NotificationService;
use crate::run_commands::RunCommandRuntime;
use crate::orchestrator::board::BoardEvent;
use crate::orchestrator::{TaskBoard, TaskOrchestrator, TaskStatusEvent};
use crate::sync::CloudSyncState;

/// Task lifecycle transitions (pending → running → completed/failed/…).
pub const TASK_STATUS_EVENT: &str = "phasr://task-status";
/// A task's agent state changed (working / idle / needs-you / exited).
/// Payload: `TaskAgentState`.
pub const TASK_AGENT_STATE_EVENT: &str = "phasr://task-agent-state";
/// A task's token usage changed. At most one per task per 5s (the
/// `AgentSignals` usage poller's cadence). Payload: `TaskUsagePayload`.
pub const TASK_USAGE_EVENT: &str = "phasr://task-usage";
/// Cards in a repository may have changed lane or content — refetch
/// `list_task_cards`. Coalesced (≤ 1 per repository per 300ms) and carries
/// no card data on purpose: cheap to emit on every status / agent-state /
/// diff change. Payload: `TaskCardsChangedPayload`.
pub const TASK_CARDS_CHANGED_EVENT: &str = "phasr://task-cards-changed";
/// A check run was queued, started or settled. Payload: `CheckRun`.
pub const CHECK_RUN_EVENT: &str = "phasr://check-run";
/// New output from a running check, batched ≤ 1 per run per 250ms.
/// Payload: `CheckOutputPayload`.
pub const CHECK_OUTPUT_EVENT: &str = "phasr://check-output";
/// A run command started, found its port, or exited. Payload:
/// `RunningCommand`.
pub const RUN_COMMAND_STATE_EVENT: &str = "phasr://run-command-state";
/// An inbox entry was recorded. Payload: `AppNotification`. Whether it
/// becomes a banner/sound is decided in the frontend
/// (`notificationPolicy.ts`).
pub const NOTIFICATION_CREATED_EVENT: &str = "phasr://notification-created";

/// Drain `rx` on the async runtime, handing each event to `forward`.
/// A lagging receiver skips what it missed rather than stopping: every
/// payload here is a full snapshot, so the next one corrects the UI.
fn spawn_forwarder<T, F>(mut rx: broadcast::Receiver<T>, mut forward: F)
where
    T: Clone + Send + 'static,
    F: FnMut(T) + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => forward(event),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Re-emit the orchestrator's status broadcast. Call once at startup.
pub fn spawn_status_bridge(orchestrator: Arc<TaskOrchestrator>, app: AppHandle) {
    spawn_forwarder(orchestrator.subscribe_status(), move |event| {
        let _ = app.emit(TASK_STATUS_EVENT, status_payload(&event));
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStatusPayload {
    task_id: String,
    repository_id: String,
    status: String,
    exit_code: Option<i64>,
}

fn status_payload(event: &TaskStatusEvent) -> TaskStatusPayload {
    TaskStatusPayload {
        task_id: event.task_id.clone(),
        repository_id: event.repository_id.clone(),
        status: event.status.as_str().to_string(),
        exit_code: event.exit_code,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsagePayload {
    pub task_id: String,
    pub usage: TaskUsage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCardsChangedPayload {
    pub repository_id: String,
    /// The cards that changed, when the backend knows exactly; absent =
    /// any card in the repository. Additive: a listener that ignores it
    /// refetches the repository as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_ids: Option<Vec<String>>,
}

/// Re-emit the board's coalesced change notifications. Call once at
/// startup.
pub fn spawn_board_bridge(board: &TaskBoard, app: AppHandle) {
    spawn_forwarder(board.subscribe(), move |event| match event {
        BoardEvent::CardsChanged {
            repository_id,
            task_ids,
        } => {
            let _ = app.emit(
                TASK_CARDS_CHANGED_EVENT,
                TaskCardsChangedPayload {
                    repository_id,
                    task_ids,
                },
            );
        }
    });
}

/// Re-emit agent state + usage, and push a synced `last_turn_ended_at`
/// as soon as it's written. Call once at startup.
pub fn spawn_agent_signal_bridge(signals: &AgentSignals, app: AppHandle) {
    spawn_forwarder(signals.subscribe(), move |event| match event {
        AgentSignalEvent::State(state) => {
            let _ = app.emit(TASK_AGENT_STATE_EVENT, state);
        }
        AgentSignalEvent::Usage { task_id, usage } => {
            let _ = app.emit(TASK_USAGE_EVENT, TaskUsagePayload { task_id, usage });
        }
        AgentSignalEvent::TurnEnded => {
            if let Some(sync) = app.try_state::<Arc<CloudSyncState>>() {
                sync.request_sync();
            }
        }
        // The board consumes it (diff cache) and emits its own event.
        AgentSignalEvent::ToolFinished { .. } => {}
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutputPayload {
    pub check_run_id: String,
    pub workspace_id: String,
    pub chunk: String,
}

/// Re-emit check runs + their (already throttled) output. Call once.
pub fn spawn_check_bridge(checks: &CheckService, app: AppHandle) {
    spawn_forwarder(checks.subscribe(), move |event| match event {
        CheckEvent::Run(run) => {
            let _ = app.emit(CHECK_RUN_EVENT, run);
        }
        CheckEvent::Output {
            check_run_id,
            workspace_id,
            chunk,
        } => {
            let _ = app.emit(
                CHECK_OUTPUT_EVENT,
                CheckOutputPayload {
                    check_run_id,
                    workspace_id,
                    chunk,
                },
            );
        }
    });
}

/// Re-emit run-command state changes. Call once.
pub fn spawn_run_command_bridge(runs: &RunCommandRuntime, app: AppHandle) {
    spawn_forwarder(runs.subscribe(), move |event| {
        let _ = app.emit(RUN_COMMAND_STATE_EVENT, event.state);
    });
}

/// Re-emit new inbox entries. Call once.
pub fn spawn_notification_bridge(notifications: &NotificationService, app: AppHandle) {
    spawn_forwarder(notifications.subscribe(), move |n| {
        let _ = app.emit(NOTIFICATION_CREATED_EVENT, n);
    });
}
