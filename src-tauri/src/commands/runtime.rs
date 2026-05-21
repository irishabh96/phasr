//! Commands that drive the per-workspace PTY runtime.

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{AuthError, SessionState};
use crate::domain::WorkspaceStatus;
use crate::pty::{PtyEvent, TaskRuntime};
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo, WorkspaceUpdate};

/// Tauri event name fired whenever a workspace row's status changes
/// server-side (PTY exit, status transitions driven by start/stop).
pub const WORKSPACE_STATUS_EVENT: &str = "phasr://workspace-status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusPayload {
    pub workspace_id: String,
    pub repository_id: String,
    pub status: String,
    pub exit_code: Option<i64>,
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Pty(#[from] crate::pty::handle::PtyError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("repository has no local path; pick or clone one first")]
    NoRepositoryPath,
    #[error("no running pty for workspace `{0}`")]
    NotRunning(String),
    #[error("workspace is already finished (status: {0}); create a new one to retry")]
    AlreadyFinished(String),
}

impl serde::Serialize for RuntimeError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningWorkspaceInfo {
    pub workspace_id: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

/// Idempotent: if the workspace is already running, subscribes the
/// channel to the existing PTY broadcast; otherwise spawns a new PTY.
#[tauri::command]
pub async fn start_workspace(
    workspace_id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    app: AppHandle,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunningWorkspaceInfo, RuntimeError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;

    if let Some(handle) = runtime.get(&workspace_id) {
        let rx = handle.subscribe();
        spawn_event_forwarder(rx, on_event, workspace_id.clone(), None, None, None);
        return Ok(RunningWorkspaceInfo {
            workspace_id,
            started_at: workspace.started_at.unwrap_or_else(Utc::now),
        });
    }

    if matches!(
        workspace.status,
        WorkspaceStatus::Completed | WorkspaceStatus::Failed | WorkspaceStatus::Archived
    ) {
        return Err(RuntimeError::AlreadyFinished(
            workspace.status.as_str().into(),
        ));
    }

    let cwd = if let Some(worktree) = workspace.worktree_path.as_deref() {
        PathBuf::from(worktree)
    } else {
        let repository = repositories.get(&workspace.repository_id).await?;
        repository
            .local_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or(RuntimeError::NoRepositoryPath)?
    };

    let now = Utc::now();
    workspaces
        .update(
            &workspace_id,
            WorkspaceUpdate {
                status: Some(WorkspaceStatus::Running),
                started_at: Some(Some(now)),
                exit_code: Some(None),
                finished_at: Some(None),
                ..Default::default()
            },
        )
        .await?;

    let _ = app.emit(
        WORKSPACE_STATUS_EVENT,
        WorkspaceStatusPayload {
            workspace_id: workspace_id.clone(),
            repository_id: workspace.repository_id.clone(),
            status: "running".into(),
            exit_code: None,
        },
    );

    let initial_command = if workspace.command.trim().is_empty() {
        None
    } else {
        Some(workspace.command.clone())
    };
    let initial_prompt = workspace.prompt.as_ref().and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let handle = runtime.spawn(
        workspace_id.clone(),
        initial_command,
        initial_prompt,
        cwd,
        rows.unwrap_or(24),
        cols.unwrap_or(80),
    )?;

    let rx = handle.subscribe();
    spawn_event_forwarder(
        rx,
        on_event,
        workspace_id.clone(),
        Some(workspaces.inner().clone()),
        Some(runtime.inner().clone()),
        Some(app.clone()),
    );

    Ok(RunningWorkspaceInfo {
        workspace_id,
        started_at: now,
    })
}

fn spawn_event_forwarder(
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    channel: Channel<PtyEvent>,
    workspace_id: String,
    workspace_repo: Option<WorkspaceRepo>,
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
                        if let (Some(repo), Some(rt)) = (workspace_repo.as_ref(), runtime.as_ref())
                        {
                            let next_status = if exit_code == Some(0) {
                                WorkspaceStatus::Completed
                            } else {
                                WorkspaceStatus::Failed
                            };
                            let updated = repo
                                .update(
                                    &workspace_id,
                                    WorkspaceUpdate {
                                        status: Some(next_status),
                                        exit_code: Some(exit_code),
                                        finished_at: Some(Some(Utc::now())),
                                        ..Default::default()
                                    },
                                )
                                .await
                                .ok();
                            rt.drop_task(&workspace_id);

                            if let (Some(app), Some(workspace)) = (app.as_ref(), updated) {
                                let _ = app.emit(
                                    WORKSPACE_STATUS_EVENT,
                                    WorkspaceStatusPayload {
                                        workspace_id: workspace_id.clone(),
                                        repository_id: workspace.repository_id,
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

#[tauri::command]
pub async fn read_workspace_log(
    workspace_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, RuntimeError> {
    session.require()?;
    let path = runtime.log_dir.join(format!("{workspace_id}.log"));
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(RuntimeError::Pty(err.into())),
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn send_workspace_input(
    workspace_id: String,
    data: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RuntimeError> {
    session.require()?;
    let handle = runtime
        .get(&workspace_id)
        .ok_or_else(|| RuntimeError::NotRunning(workspace_id.clone()))?;
    handle.write(data.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn resize_workspace(
    workspace_id: String,
    rows: u16,
    cols: u16,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RuntimeError> {
    session.require()?;
    let handle = runtime
        .get(&workspace_id)
        .ok_or_else(|| RuntimeError::NotRunning(workspace_id.clone()))?;
    handle.resize(rows, cols)?;
    Ok(())
}

#[tauri::command]
pub async fn interrupt_workspace(
    workspace_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RuntimeError> {
    session.require()?;
    let handle = runtime
        .get(&workspace_id)
        .ok_or_else(|| RuntimeError::NotRunning(workspace_id.clone()))?;
    handle.interrupt()?;
    Ok(())
}

#[tauri::command]
pub async fn stop_workspace(
    workspace_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RuntimeError> {
    session.require()?;
    let handle = runtime
        .get(&workspace_id)
        .ok_or_else(|| RuntimeError::NotRunning(workspace_id.clone()))?;
    handle.kill()?;
    Ok(())
}
