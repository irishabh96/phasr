//! Commands that drive the per-task PTY runtime. These are the bridge
//! between the React UI and the `pty::TaskRuntime`.

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;

/// Tauri event name fired whenever a task row's status changes server-side
/// (PTY exit, status transitions driven by start/stop). Frontend listens
/// to this and invalidates its task queries.
pub const TASK_STATUS_EVENT: &str = "phasr://task-status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusPayload {
    pub task_id: String,
    pub workspace_id: String,
    pub status: String,
    pub exit_code: Option<i64>,
}

use crate::domain::TaskStatus;
use crate::pty::{PtyEvent, TaskRuntime};
use crate::store::{StoreError, TaskRepo, TaskUpdate, WorkspaceRepo};

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Pty(#[from] crate::pty::handle::PtyError),
    #[error("workspace has no local path; pick or clone one first")]
    NoWorkspacePath,
    #[error("no running pty for task `{0}`")]
    NotRunning(String),
    #[error("task is already finished (status: {0}); create a new task to retry")]
    AlreadyFinished(String),
}

impl serde::Serialize for RuntimeError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTaskInfo {
    pub task_id: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

/// Idempotent: if the task is already running, subscribes the channel
/// to the existing PTY broadcast; otherwise spawns a new PTY. Calling
/// this on a finished task (completed/failed/archived) errors — those
/// should display their log via `read_task_log` instead.
#[tauri::command]
pub async fn start_task(
    task_id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    app: AppHandle,
    tasks: State<'_, TaskRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    runtime: State<'_, Arc<TaskRuntime>>,
) -> Result<RunningTaskInfo, RuntimeError> {
    let task = tasks.get(&task_id).await?;

    // If already running, just subscribe.
    if let Some(handle) = runtime.get(&task_id) {
        let rx = handle.subscribe();
        spawn_event_forwarder(rx, on_event, task_id.clone(), None, None, None);
        return Ok(RunningTaskInfo {
            task_id,
            started_at: task.started_at.unwrap_or_else(Utc::now),
        });
    }

    if matches!(
        task.status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Archived
    ) {
        return Err(RuntimeError::AlreadyFinished(task.status.as_str().into()));
    }

    // Prefer the task's worktree path (created in create_task); fall
    // back to the workspace's local path for tasks created before
    // worktree support landed.
    let cwd = if let Some(worktree) = task.worktree_path.as_deref() {
        PathBuf::from(worktree)
    } else {
        let workspace = workspaces.get(&task.workspace_id).await?;
        workspace
            .local_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or(RuntimeError::NoWorkspacePath)?
    };

    let now = Utc::now();
    tasks
        .update(
            &task_id,
            TaskUpdate {
                status: Some(TaskStatus::Running),
                started_at: Some(Some(now)),
                exit_code: Some(None),
                finished_at: Some(None),
                ..Default::default()
            },
        )
        .await?;

    // Notify the frontend that this task just transitioned to running.
    let _ = app.emit(
        TASK_STATUS_EVENT,
        TaskStatusPayload {
            task_id: task_id.clone(),
            workspace_id: task.workspace_id.clone(),
            status: "running".into(),
            exit_code: None,
        },
    );

    let initial_command = if task.command.trim().is_empty() {
        None
    } else {
        Some(task.command.clone())
    };
    let initial_prompt = task.prompt.as_ref().and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let handle = runtime.spawn(
        task_id.clone(),
        initial_command,
        initial_prompt,
        cwd,
        rows.unwrap_or(24),
        cols.unwrap_or(80),
    )?;

    // Forward PTY events to the frontend Channel and watch for the Exit
    // event to update task status in the DB.
    let rx = handle.subscribe();
    spawn_event_forwarder(
        rx,
        on_event,
        task_id.clone(),
        Some(tasks.inner().clone()),
        Some(runtime.inner().clone()),
        Some(app.clone()),
    );

    Ok(RunningTaskInfo {
        task_id,
        started_at: now,
    })
}

/// Bridges a tokio broadcast Receiver to a Tauri Channel. When this is the
/// primary subscriber (i.e. created `start_task` was the spawn path), it
/// also updates the task row to completed/failed and drops the runtime
/// entry on exit. Secondary subscribers (e.g. a second tab attaching to a
/// running task) pass `task_repo`/`runtime` as `None` and just forward.
fn spawn_event_forwarder(
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    channel: Channel<PtyEvent>,
    task_id: String,
    task_repo: Option<TaskRepo>,
    runtime: Option<Arc<TaskRuntime>>,
    app: Option<AppHandle>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let is_exit = matches!(event, PtyEvent::Exit { .. });
                    let exit_code = if let PtyEvent::Exit { exit_code, .. } = &event {
                        *exit_code
                    } else {
                        None
                    };
                    let _ = channel.send(event);

                    if is_exit {
                        if let (Some(repo), Some(rt)) = (task_repo.as_ref(), runtime.as_ref()) {
                            let next_status = if exit_code == Some(0) {
                                TaskStatus::Completed
                            } else {
                                TaskStatus::Failed
                            };
                            let updated = repo
                                .update(
                                    &task_id,
                                    TaskUpdate {
                                        status: Some(next_status),
                                        exit_code: Some(exit_code),
                                        finished_at: Some(Some(Utc::now())),
                                        ..Default::default()
                                    },
                                )
                                .await
                                .ok();
                            rt.drop_task(&task_id);

                            if let (Some(app), Some(task)) = (app.as_ref(), updated) {
                                let _ = app.emit(
                                    TASK_STATUS_EVENT,
                                    TaskStatusPayload {
                                        task_id: task_id.clone(),
                                        workspace_id: task.workspace_id,
                                        status: next_status.as_str().into(),
                                        exit_code,
                                    },
                                );
                            }
                        }
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Reads the log file for a task (UTF-8, lossy). Used to display history
/// for completed/failed/stopped tasks without re-spawning a PTY.
#[tauri::command]
pub async fn read_task_log(
    task_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
) -> Result<String, RuntimeError> {
    let path = runtime.log_dir.join(format!("{task_id}.log"));
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(RuntimeError::Pty(err.into())),
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn send_task_input(
    task_id: String,
    data: String,
    runtime: State<'_, Arc<TaskRuntime>>,
) -> Result<(), RuntimeError> {
    let handle = runtime
        .get(&task_id)
        .ok_or_else(|| RuntimeError::NotRunning(task_id.clone()))?;
    handle.write(data.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn resize_task(
    task_id: String,
    rows: u16,
    cols: u16,
    runtime: State<'_, Arc<TaskRuntime>>,
) -> Result<(), RuntimeError> {
    let handle = runtime
        .get(&task_id)
        .ok_or_else(|| RuntimeError::NotRunning(task_id.clone()))?;
    handle.resize(rows, cols)?;
    Ok(())
}

#[tauri::command]
pub async fn interrupt_task(
    task_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
) -> Result<(), RuntimeError> {
    let handle = runtime
        .get(&task_id)
        .ok_or_else(|| RuntimeError::NotRunning(task_id.clone()))?;
    handle.interrupt()?;
    Ok(())
}

#[tauri::command]
pub async fn stop_task(
    task_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
) -> Result<(), RuntimeError> {
    let handle = runtime
        .get(&task_id)
        .ok_or_else(|| RuntimeError::NotRunning(task_id.clone()))?;
    handle.kill()?;
    Ok(())
}
