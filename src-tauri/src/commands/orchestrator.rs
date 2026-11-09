//! Tauri commands that drive the task orchestrator.
//!
//! Thin handlers: each one validates inputs and delegates to
//! `TaskOrchestrator`. Status events from the orchestrator's
//! broadcast channel are re-emitted onto Tauri's event bus by
//! `commands::events`.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::SessionState;
use crate::domain::{Agent, PermissionMode};
use crate::orchestrator::{
    launch, OrchestratorError, RunIn, StartTaskRequest, StartedTask, TaskOrchestrator,
};
use crate::pty::PtyEvent;
use crate::store::SettingsRepo;
use crate::sync::CloudSyncState;

use super::require_user;

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
    /// `None` → the user's `defaultPermissionMode` (clamped to what the
    /// agent supports). An explicit mode the agent can't express is an
    /// error, never silently swapped.
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// `None` → true.
    #[serde(default)]
    pub notify_on_attention: Option<bool>,
    /// `None` → a new worktree.
    #[serde(default)]
    pub run_in: Option<RunIn>,
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
    settings: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<StartedTask, OrchestratorError> {
    let current_session = require_user(&session)?;
    let user_settings = settings.get_or_init().await?;
    let (mode, command) =
        launch::resolve_launch(input.agent, input.permission_mode, &user_settings)?;
    let request = StartTaskRequest {
        repository_id: input.repository_id,
        user_id: Some(current_session.user_id),
        agent: input.agent,
        command,
        name: input.name,
        prompt: input.prompt,
        base_branch: input.base_branch,
        rows: input.rows,
        cols: input.cols,
        permission_mode: Some(mode),
        notify_on_attention: input.notify_on_attention.unwrap_or(true),
        run_in: input.run_in.unwrap_or_default(),
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
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
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
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
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
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.send_input(&task_id, data.as_bytes())
}

/// Send one composed message to the task's agent (paste-framed when the
/// agent asked for bracketed paste), pressing Enter if `submit`.
#[tauri::command]
pub async fn send_message_to_task(
    task_id: String,
    text: String,
    submit: bool,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.send_message(&task_id, &text, submit).await
}

#[tauri::command]
pub async fn read_task_log(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
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
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.resize_task(&task_id, rows, cols)
}

#[tauri::command]
pub async fn interrupt_task(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.interrupt_task(&task_id)
}
