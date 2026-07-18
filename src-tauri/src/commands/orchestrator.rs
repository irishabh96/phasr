//! Tauri commands that drive the task orchestrator.
//!
//! Thin handlers: each one validates inputs and delegates to
//! `TaskOrchestrator`. Status events from the orchestrator's
//! broadcast channel are re-emitted onto Tauri's event bus on a
//! background task spawned at app start.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{AuthError, SessionState};
use crate::domain::Agent;
use crate::orchestrator::{
    OrchestratorError, StartTaskRequest, StartedTask, TaskOrchestrator, TaskStatusEvent,
};
use crate::pty::PtyEvent;
use crate::sync::CloudSyncState;

/// Tauri event name on which task status transitions are broadcast.
pub const TASK_STATUS_EVENT: &str = "phasr://task-status";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskInput {
    pub repository_id: String,
    pub agent: Agent,
    pub name: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub cols: Option<u16>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTaskInfo {
    pub task_id: String,
    pub started_at: DateTime<Utc>,
}

#[tauri::command]
pub async fn start_task(
    input: StartTaskInput,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<StartedTask, OrchestratorError> {
    let current_session = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let request = StartTaskRequest {
        repository_id: input.repository_id,
        user_id: Some(current_session.user_id),
        agent: input.agent,
        command: input.agent.command().to_string(),
        name: input.name,
        prompt: input.prompt,
        base_branch: input.base_branch,
        rows: input.rows,
        cols: input.cols,
    };
    let started = orchestrator.start_task(request).await?;
    sync_state.request_sync();
    Ok(started)
}

#[tauri::command]
pub async fn stop_task(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    session.require()?;
    orchestrator.stop_task(&task_id).await
}

#[tauri::command]
pub async fn open_task_terminal(
    task_id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunningTaskInfo, OrchestratorError> {
    session.require()?;
    let sub = orchestrator
        .open_terminal(&task_id, rows.unwrap_or(24), cols.unwrap_or(80))
        .await?;
    let info = RunningTaskInfo {
        task_id: sub.task_id.clone(),
        started_at: sub.started_at,
    };
    spawn_task_event_forwarder(sub.replay, sub.rx, on_event);
    Ok(info)
}

fn spawn_task_event_forwarder(
    replay: Vec<PtyEvent>,
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    channel: Channel<PtyEvent>,
) {
    tauri::async_runtime::spawn(async move {
        for event in replay {
            let _ = channel.send(event);
        }
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let is_exit = matches!(event, PtyEvent::Exit { .. });
                    let _ = channel.send(event);
                    if is_exit {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[tauri::command]
pub async fn send_input_to_task(
    task_id: String,
    data: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    session.require()?;
    orchestrator.send_input(&task_id, data.as_bytes())
}

#[tauri::command]
pub async fn read_task_log(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, OrchestratorError> {
    session.require()?;
    orchestrator.read_task_log(&task_id).await
}

#[tauri::command]
pub async fn resize_task(
    task_id: String,
    rows: u16,
    cols: u16,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    session.require()?;
    orchestrator.resize_task(&task_id, rows, cols)
}

#[tauri::command]
pub async fn interrupt_task(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    session.require()?;
    orchestrator.interrupt_task(&task_id)
}

/// Subscribe to the orchestrator's status broadcast and re-emit each
/// event onto the Tauri event bus. Call once at app startup.
pub fn spawn_status_bridge(orchestrator: Arc<TaskOrchestrator>, app: AppHandle) {
    let mut rx = orchestrator.subscribe_status();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let _ = app.emit(TASK_STATUS_EVENT, event_payload(&event));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStatusPayload {
    task_id: String,
    repository_id: String,
    status: String,
    exit_code: Option<i64>,
    /// Honest status (E0). Wire values: `"working" | "idle" | "wedged"`
    /// (liveness poller) or `"done" | "failed"` (exit-watcher); `null` on
    /// plain lifecycle transitions. Serialized as a plain string to match
    /// `status` above and the frontend `DerivedAgentState` union.
    derived_state: Option<String>,
    /// ISO-8601 UTC timestamp of the agent's last output; the frontend
    /// counts "Ns ago" upward from it locally between events.
    last_activity_at: Option<String>,
}

fn event_payload(event: &TaskStatusEvent) -> TaskStatusPayload {
    TaskStatusPayload {
        task_id: event.task_id.clone(),
        repository_id: event.repository_id.clone(),
        status: event.status.as_str().to_string(),
        exit_code: event.exit_code,
        derived_state: event.derived_state.map(|d| d.as_str().to_string()),
        last_activity_at: event.last_activity_at.map(|dt| dt.to_rfc3339()),
    }
}
