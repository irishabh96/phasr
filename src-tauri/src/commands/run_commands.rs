//! CRUD + PTY launch for run commands. Run-command PTYs live in
//! `TaskRuntime` alongside workspace PTYs; we use a synthesized id
//! prefix (`run:<run_command_id>`) so they don't collide with
//! workspace ids.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{AuthError, SessionState};
use crate::domain::RunCommand;
use crate::pty::{PtyEvent, TaskRuntime};
use crate::store::{RepositoryRepo, RunCommandRepo, RunCommandUpdate, StoreError};

/// Prefix every running PTY id with this so they never collide with
/// workspace UUIDs in the `TaskRuntime` map.
const RUN_PTY_PREFIX: &str = "run:";

fn pty_id(run_command_id: &str) -> String {
    format!("{RUN_PTY_PREFIX}{run_command_id}")
}

#[derive(Debug, Error)]
pub enum RunCommandError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Pty(#[from] crate::pty::handle::PtyError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("repository has no local path")]
    NoRepositoryPath,
    #[error("no running PTY for run command `{0}`")]
    NotRunning(String),
}

impl serde::Serialize for RunCommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunCommandInput {
    pub repository_id: String,
    pub name: String,
    pub command: String,
    pub shortcut: Option<String>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRunCommandInput {
    pub name: Option<String>,
    pub command: Option<String>,
    pub shortcut: Option<String>,
    pub pinned: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRunCommandInput {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub command: String,
    pub shortcut: Option<String>,
    pub pinned: bool,
    pub sort_order: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

// ── CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_run_command(
    input: CreateRunCommandInput,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunCommand, RunCommandError> {
    session.require()?;
    let mut rc = RunCommand::new(input.repository_id, input.name, input.command);
    rc.shortcut = input.shortcut;
    rc.pinned = input.pinned.unwrap_or(false);
    repo.insert(&rc).await?;
    Ok(rc)
}

#[tauri::command]
pub async fn list_run_commands(
    repository_id: String,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<RunCommand>, RunCommandError> {
    session.require()?;
    Ok(repo.list_by_repository(&repository_id).await?)
}

#[tauri::command]
pub async fn update_run_command(
    id: String,
    input: UpdateRunCommandInput,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunCommand, RunCommandError> {
    session.require()?;
    let patch = RunCommandUpdate {
        name: input.name,
        command: input.command,
        shortcut: input.shortcut.map(Some),
        pinned: input.pinned,
        sort_order: input.sort_order,
    };
    Ok(repo.update(&id, patch).await?)
}

#[tauri::command]
pub async fn delete_run_command(
    id: String,
    repo: State<'_, RunCommandRepo>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    // Kill the PTY if it's still running so the row deletion doesn't
    // leave behind an orphaned process.
    if let Some(handle) = runtime.get(&pty_id(&id)) {
        let _ = handle.kill();
        runtime.drop_task(&pty_id(&id));
    }
    repo.delete(&id).await?;
    Ok(())
}

#[tauri::command]
pub async fn upsert_run_command_from_cloud(
    input: CloudRunCommandInput,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunCommand, RunCommandError> {
    session.require()?;
    let rc = RunCommand {
        id: input.id,
        repository_id: input.repository_id,
        name: input.name,
        command: input.command,
        shortcut: input.shortcut,
        pinned: input.pinned,
        sort_order: input.sort_order,
        created_at: input.created_at,
        updated_at: input.updated_at,
    };
    Ok(repo.upsert_from_cloud(&rc).await?)
}

// ── Runtime ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_run_command(
    id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    run_commands: State<'_, RunCommandRepo>,
    repositories: State<'_, RepositoryRepo>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    let rc = run_commands.get(&id).await?;
    let key = pty_id(&id);

    // Idempotent: re-attach to an already-running PTY.
    if let Some(handle) = runtime.get(&key) {
        forward(handle.subscribe(), on_event, runtime.inner().clone(), key);
        return Ok(());
    }

    let repository = repositories.get(&rc.repository_id).await?;
    let cwd = repository
        .local_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(RunCommandError::NoRepositoryPath)?;

    let handle = runtime.spawn(
        key.clone(),
        Some(rc.command.clone()),
        None,
        cwd,
        rows.unwrap_or(24),
        cols.unwrap_or(80),
    )?;
    forward(handle.subscribe(), on_event, runtime.inner().clone(), key);
    Ok(())
}

#[tauri::command]
pub async fn stop_run_command(
    id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    let key = pty_id(&id);
    let handle = runtime
        .get(&key)
        .ok_or_else(|| RunCommandError::NotRunning(id.clone()))?;
    handle.kill()?;
    Ok(())
}

#[tauri::command]
pub async fn send_run_command_input(
    id: String,
    data: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    let handle = runtime
        .get(&pty_id(&id))
        .ok_or_else(|| RunCommandError::NotRunning(id.clone()))?;
    handle.write(data.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn resize_run_command(
    id: String,
    rows: u16,
    cols: u16,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    let handle = runtime
        .get(&pty_id(&id))
        .ok_or_else(|| RunCommandError::NotRunning(id.clone()))?;
    handle.resize(rows, cols)?;
    Ok(())
}

fn forward(
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    channel: Channel<PtyEvent>,
    runtime: Arc<TaskRuntime>,
    key: String,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let is_exit = matches!(event, PtyEvent::Exit { .. });
                    let _ = channel.send(event);
                    if is_exit {
                        runtime.drop_task(&key);
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
