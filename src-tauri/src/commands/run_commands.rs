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
use crate::pty::{LagRecovery, PtyEvent, TaskRuntime};
use crate::store::{RepositoryRepo, RunCommandRepo, RunCommandUpdate, StoreError};
use crate::sync::CloudSyncState;

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

// ── CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_run_command(
    input: CreateRunCommandInput,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<RunCommand, RunCommandError> {
    let current_session = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let mut rc = RunCommand::new(input.repository_id, input.name, input.command);
    rc.shortcut = input.shortcut;
    rc.pinned = input.pinned.unwrap_or(false);
    repo.insert_for_user(&rc, &current_session.user_id).await?;
    sync_state.request_sync();
    Ok(rc)
}

#[tauri::command]
pub async fn list_run_commands(
    repository_id: String,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<RunCommand>, RunCommandError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(repo
        .list_by_repository_for_user(&repository_id, &current.user_id)
        .await?)
}

#[tauri::command]
pub async fn update_run_command(
    id: String,
    input: UpdateRunCommandInput,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<RunCommand, RunCommandError> {
    session.require()?;
    let patch = RunCommandUpdate {
        name: input.name,
        command: input.command,
        shortcut: input.shortcut.map(Some),
        pinned: input.pinned,
        sort_order: input.sort_order,
    };
    let run_command = repo.update(&id, patch).await?;
    sync_state.request_sync();
    Ok(run_command)
}

#[tauri::command]
pub async fn delete_run_command(
    id: String,
    repo: State<'_, RunCommandRepo>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    // Kill the PTY if it's still running so the row deletion doesn't
    // leave behind an orphaned process.
    if let Some(handle) = runtime.get(&pty_id(&id)) {
        let _ = handle.kill();
        runtime.drop_task(&pty_id(&id));
    }
    repo.delete(&id).await?;
    sync_state.request_sync();
    Ok(())
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
        let (replay, rx) = handle.subscribe_with_replay();
        forward(
            replay,
            rx,
            handle.recovery(),
            on_event,
            runtime.inner().clone(),
            key,
        );
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
    let (replay, rx) = handle.subscribe_with_replay();
    forward(
        replay,
        rx,
        handle.recovery(),
        on_event,
        runtime.inner().clone(),
        key,
    );
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
    replay: Vec<PtyEvent>,
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    mut recovery: LagRecovery,
    channel: Channel<PtyEvent>,
    runtime: Arc<TaskRuntime>,
    key: String,
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
                    // per-task log and delivered first, so the terminal never
                    // sees a hole. One integer compare when nothing was lost.
                    recovery.recover_before(&event, |missed| {
                        let _ = channel.send(missed);
                    });
                    let _ = channel.send(event);
                    if is_exit {
                        runtime.drop_task(&key);
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
