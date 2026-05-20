//! Tauri commands that drive the task orchestrator.
//!
//! Thin handlers: each one validates inputs and delegates to
//! `TaskOrchestrator`. Status events from the orchestrator's
//! broadcast channel are re-emitted onto Tauri's event bus on a
//! background task spawned at app start.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::orchestrator::{
    OrchestratorError, StartTaskRequest, StartedTask, TaskOrchestrator, TaskStatusEvent,
};

/// Tauri event name on which task status transitions are broadcast.
/// Kept distinct from the legacy `phasr://workspace-status` name so
/// the React side can migrate explicitly.
pub const TASK_STATUS_EVENT: &str = "phasr://task-status";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskInput {
    pub repository_id: String,
    pub agent_id: String,
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

#[tauri::command]
pub async fn start_task(
    input: StartTaskInput,
    orchestrator: State<'_, TaskOrchestrator>,
) -> Result<StartedTask, OrchestratorError> {
    let request = StartTaskRequest {
        repository_id: input.repository_id,
        agent_id: input.agent_id,
        name: input.name,
        prompt: input.prompt,
        base_branch: input.base_branch,
        rows: input.rows,
        cols: input.cols,
    };
    orchestrator.start_task(request).await
}

#[tauri::command]
pub async fn stop_task(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
) -> Result<(), OrchestratorError> {
    orchestrator.stop_task(&task_id).await
}

#[tauri::command]
pub async fn send_input_to_task(
    task_id: String,
    data: String,
    orchestrator: State<'_, TaskOrchestrator>,
) -> Result<(), OrchestratorError> {
    orchestrator.send_input(&task_id, data.as_bytes())
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
}

fn event_payload(event: &TaskStatusEvent) -> TaskStatusPayload {
    TaskStatusPayload {
        task_id: event.task_id.clone(),
        repository_id: event.repository_id.clone(),
        status: event.status.as_str().to_string(),
        exit_code: event.exit_code,
    }
}
