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
use crate::pty::{LagRecovery, PtyEvent};
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

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub task_id: String,
    /// Wall-clock epoch ms of the task terminal's most recent output
    /// (spawn time until the first byte). Compared against `Date.now()`.
    pub last_output_at: i64,
}

/// Last-output timestamps for every task with a live PTY. A task missing
/// from the list has no running terminal process at all.
#[tauri::command]
pub async fn list_task_activity(
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TaskActivity>, OrchestratorError> {
    session.require()?;
    Ok(orchestrator
        .task_activity()
        .into_iter()
        .map(|(task_id, last_output_at)| TaskActivity {
            task_id,
            last_output_at,
        })
        .collect())
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
    spawn_task_event_forwarder(sub.replay, sub.rx, sub.recovery, on_event);
    Ok(info)
}

fn spawn_task_event_forwarder(
    replay: Vec<PtyEvent>,
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    mut recovery: LagRecovery,
    channel: Channel<PtyEvent>,
) {
    tauri::async_runtime::spawn(async move {
        for event in replay {
            recovery.recover_before(&event, |missed| {
                let _ = channel.send(missed);
            });
            let _ = channel.send(event);
        }
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let is_exit = matches!(event, PtyEvent::Exit { .. });
                    // Anything the broadcast dropped is read back out of the
                    // per-task log and delivered first, so the terminal
                    // never sees a hole. Costs one integer compare when
                    // nothing was lost.
                    recovery.recover_before(&event, |missed| {
                        let _ = channel.send(missed);
                    });
                    let _ = channel.send(event);
                    if is_exit {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => recovery.note_lag(n),
                // Closed with a gap outstanding: the last bytes are still on
                // disk even though no event will ever carry them.
                Err(RecvError::Closed) => {
                    recovery.recover_tail(|missed| {
                        let _ = channel.send(missed);
                    });
                    break;
                }
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
                // A missed status event is a missed *state transition*, and
                // this broadcast carries no bytes to backfill from — so
                // re-derive the truth from the store and re-emit it, rather
                // than leaving the UI on a status that is now a lie
                // (P3, Q3 rule 2). Idempotent: the frontend applies the
                // status it is given.
                Err(RecvError::Lagged(_)) => {
                    for event in orchestrator.live_status_snapshot().await {
                        let _ = app.emit(TASK_STATUS_EVENT, event_payload(&event));
                    }
                }
                Err(RecvError::Closed) => break,
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
}

fn event_payload(event: &TaskStatusEvent) -> TaskStatusPayload {
    TaskStatusPayload {
        task_id: event.task_id.clone(),
        repository_id: event.repository_id.clone(),
        status: event.status.as_str().to_string(),
        exit_code: event.exit_code,
    }
}
