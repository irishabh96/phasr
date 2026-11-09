//! CRUD + PTY launch for run commands. A run command runs per task, in
//! that task's worktree (PTY key `run:<id>@<workspaceId>`), or in the
//! repository's own checkout when no task is given (`run:<id>@repo`) —
//! see `crate::run_commands`.
//!
//! Trusted-hash guard: creating or editing a command here (or confirming
//! it) marks its exact text trusted on THIS machine. Only trusted commands
//! auto-run (`task_start` / `before_review`); one synced from elsewhere
//! waits for `confirm_run_command`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{AuthError, SessionState};
use crate::domain::{RunCommand, RunWhen};
use crate::pty::{PtyEvent, TaskRuntime};
use crate::run_commands::scripts::{self, DetectedScript};
use crate::run_commands::{pty_key, RunCommandRuntime, RunTarget, RunningCommand, TaskRunError};
use crate::store::{
    AppMetaRepo, RepositoryRepo, RunCommandRepo, RunCommandUpdate, StoreError, WorkspaceRepo,
};
use crate::sync::CloudSyncState;

use super::require_user;

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
    #[error("this task has no worktree on this machine")]
    NoWorktree,
    #[error("that run command belongs to another repository")]
    WrongRepository,
    #[error("no running PTY for run command `{0}`")]
    NotRunning(String),
    /// `attach_run_command` found nothing live under the key. The exact
    /// string is part of the contract: the run pane treats it as "show the
    /// Run button", not as a failure.
    #[error("not running")]
    NotAttached,
    #[error(transparent)]
    TaskRun(#[from] TaskRunError),
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
    #[serde(default)]
    pub run_when: Option<RunWhen>,
    #[serde(default)]
    pub detect_port: Option<bool>,
    #[serde(default)]
    pub required_for_approve: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRunCommandInput {
    pub name: Option<String>,
    pub command: Option<String>,
    pub shortcut: Option<String>,
    pub pinned: Option<bool>,
    pub sort_order: Option<i64>,
    #[serde(default)]
    pub run_when: Option<RunWhen>,
    #[serde(default)]
    pub detect_port: Option<bool>,
    #[serde(default)]
    pub required_for_approve: Option<bool>,
}

// ── CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_run_command(
    input: CreateRunCommandInput,
    repo: State<'_, RunCommandRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<RunCommand, RunCommandError> {
    let current_session = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let mut rc = RunCommand::new(input.repository_id, input.name, input.command);
    rc.shortcut = input.shortcut;
    rc.pinned = input.pinned.unwrap_or(false);
    rc.run_when = input.run_when.unwrap_or_default();
    rc.detect_port = input.detect_port.unwrap_or(false);
    rc.required_for_approve = input.required_for_approve.unwrap_or(false);
    repo.insert_for_user(&rc, &current_session.user_id).await?;
    // Typed here, by this user: trusted to auto-run on this machine.
    meta.trust_run_command(&rc).await?;
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
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<RunCommand, RunCommandError> {
    let current = require_user(&session)?;
    repo.get_for_user(&id, &current.user_id).await?;
    let edited_command = input.command.is_some();
    let patch = RunCommandUpdate {
        name: input.name,
        command: input.command,
        shortcut: input.shortcut.map(Some),
        pinned: input.pinned,
        sort_order: input.sort_order,
        run_when: input.run_when,
        detect_port: input.detect_port,
        required_for_approve: input.required_for_approve,
    };
    let run_command = repo.update(&id, patch).await?;
    // Editing the text here is confirming it. Toggling `run_when` alone is
    // NOT: that would let one click auto-run a command synced from
    // elsewhere without the user ever looking at its text.
    if edited_command {
        meta.trust_run_command(&run_command).await?;
    }
    sync_state.request_sync();
    Ok(run_command)
}

/// "Allow on this machine" for a run command synced from elsewhere: its
/// current text may now auto-run here.
#[tauri::command]
pub async fn confirm_run_command(
    id: String,
    repo: State<'_, RunCommandRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunCommand, RunCommandError> {
    let current = require_user(&session)?;
    let rc = repo.get_for_user(&id, &current.user_id).await?;
    meta.trust_run_command(&rc).await?;
    Ok(rc)
}

/// Ids of the repository's run commands whose current text is NOT trusted
/// on this machine (synced from elsewhere, never confirmed here). New
/// task's Run chip shows them disabled: "Allow on this Mac first".
#[tauri::command]
pub async fn list_untrusted_run_commands(
    repository_id: String,
    repo: State<'_, RunCommandRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<String>, RunCommandError> {
    let current = require_user(&session)?;
    let mut untrusted = Vec::new();
    for rc in repo
        .list_by_repository_for_user(&repository_id, &current.user_id)
        .await?
    {
        if !meta.is_run_command_trusted(&rc).await? {
            untrusted.push(rc.id);
        }
    }
    Ok(untrusted)
}

/// Start a run command headless in a task's worktree, alongside the task
/// (New task's Run chip). Refuses a command not trusted on this machine;
/// a no-op if it is already running there. The run pane attaches later.
#[tauri::command]
pub async fn start_run_command_for_task(
    id: String,
    workspace_id: String,
    run_commands: State<'_, RunCommandRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    meta: State<'_, AppMetaRepo>,
    runs: State<'_, RunCommandRuntime>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    let current = require_user(&session)?;
    runs.start_trusted_for_task(
        &id,
        &workspace_id,
        &current.user_id,
        &workspaces,
        &run_commands,
        &meta,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_run_command(
    id: String,
    repo: State<'_, RunCommandRepo>,
    runs: State<'_, RunCommandRuntime>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<(), RunCommandError> {
    let current = require_user(&session)?;
    // Ownership before the kill: another account's running command is
    // not ours to stop.
    repo.get_for_user(&id, &current.user_id).await?;
    // Stop it everywhere it runs (every task) so the row deletion doesn't
    // leave orphaned processes.
    runs.forget_command(&id);
    repo.delete(&id).await?;
    sync_state.request_sync();
    Ok(())
}

/// `package.json` scripts of the repository's checkout, as run-command
/// suggestions.
#[tauri::command]
pub async fn detect_package_scripts(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    repo: State<'_, RunCommandRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<DetectedScript>, RunCommandError> {
    let current = require_user(&session)?;
    let repository = repositories
        .get_for_user(&repository_id, &current.user_id)
        .await?;
    let Some(root) = repository.local_path.as_deref().map(PathBuf::from) else {
        return Ok(Vec::new());
    };
    let existing: Vec<String> = repo
        .list_by_repository_for_user(&repository_id, &current.user_id)
        .await?
        .into_iter()
        .map(|rc| rc.command)
        .collect();
    Ok(
        tokio::task::spawn_blocking(move || scripts::detect(&root, &existing))
            .await
            .unwrap_or_default(),
    )
}

// ── Runtime ─────────────────────────────────────────────────────────

/// Attach a viewer (with replay) to a run command that is ALREADY running
/// for this task (`workspaceId`) or the repository checkout (none).
/// Rejects with `"not running"` otherwise — it never spawns. The run pane
/// calls this on mount; only an explicit Run calls `start_run_command`, so
/// visiting a task (or returning after an exec command exited) can never
/// start a command by itself.
///
/// A command that exited this session is NOT rejected: its final output and
/// then an `exit` event are sent on `on_event` (already queued when this
/// resolves). Only a command never started (or deleted) here rejects, with
/// exactly "not running".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn attach_run_command(
    id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    workspace_id: Option<String>,
    run_commands: State<'_, RunCommandRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    runs: State<'_, RunCommandRuntime>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    let current = require_user(&session)?;
    // Ownership of both halves of the key before handing out its output.
    let rc = run_commands.get_for_user(&id, &current.user_id).await?;
    if let Some(workspace_id) = workspace_id.as_deref() {
        let workspace = workspaces
            .get_for_user(workspace_id, &current.user_id)
            .await?;
        if workspace.repository_id != rc.repository_id {
            return Err(RunCommandError::WrongRepository);
        }
    }
    let key = pty_key(&id, workspace_id.as_deref());
    let Some(handle) = runs.attachable(&key) else {
        // Exited this session: replay its output, then its `Exit` (the
        // pane shows the result and the Run button). Never ran: "not
        // running". Neither path spawns anything.
        let events = runs
            .exited_replay(&key)
            .ok_or(RunCommandError::NotAttached)?;
        for event in events {
            let _ = on_event.send(event);
        }
        return Ok(());
    };
    if let (Some(rows), Some(cols)) = (rows, cols) {
        // Best effort: the viewer's size, so the replay reflows correctly.
        let _ = handle.resize(rows, cols);
    }
    let (replay, rx) = handle.subscribe_with_replay();
    forward(replay, rx, on_event);
    Ok(())
}

/// Explicitly start a run command (the user pressed Run). With
/// `workspaceId` it runs in that task's worktree; without, in the
/// repository's own checkout. If it is already running this attaches to
/// the live PTY instead of starting a second copy.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_run_command(
    id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    workspace_id: Option<String>,
    run_commands: State<'_, RunCommandRepo>,
    repositories: State<'_, RepositoryRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    runs: State<'_, RunCommandRuntime>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    let current = require_user(&session)?;
    // Gates the PTY key too: stop/input/resize can only address a PTY this
    // check let start (or re-attach to).
    let rc = run_commands.get_for_user(&id, &current.user_id).await?;
    let key = pty_key(&id, workspace_id.as_deref());

    // Idempotent: re-attach to an already-running PTY (including one
    // auto-started headless for the task).
    if let Some(handle) = runs.attachable(&key) {
        let (replay, rx) = handle.subscribe_with_replay();
        forward(replay, rx, on_event);
        return Ok(());
    }

    let cwd = match workspace_id.as_deref() {
        Some(workspace_id) => {
            let workspace = workspaces
                .get_for_user(workspace_id, &current.user_id)
                .await?;
            if workspace.repository_id != rc.repository_id {
                return Err(RunCommandError::WrongRepository);
            }
            workspace
                .worktree_path
                .as_deref()
                .map(PathBuf::from)
                .filter(|p| p.exists())
                .ok_or(RunCommandError::NoWorktree)?
        }
        None => repositories
            .get_for_user(&rc.repository_id, &current.user_id)
            .await?
            .local_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or(RunCommandError::NoRepositoryPath)?,
    };

    let handle = runs.start(
        &rc,
        RunTarget {
            workspace_id,
            cwd,
            user_id: current.user_id,
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
        },
    )?;
    let (replay, rx) = handle.subscribe_with_replay();
    forward(replay, rx, on_event);
    Ok(())
}

#[tauri::command]
pub async fn stop_run_command(
    id: String,
    workspace_id: Option<String>,
    runs: State<'_, RunCommandRuntime>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    if !runs.stop(&pty_key(&id, workspace_id.as_deref()))? {
        return Err(RunCommandError::NotRunning(id));
    }
    Ok(())
}

#[tauri::command]
pub async fn send_run_command_input(
    id: String,
    data: String,
    workspace_id: Option<String>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    let handle = runtime
        .get(&pty_key(&id, workspace_id.as_deref()))
        .ok_or_else(|| RunCommandError::NotRunning(id.clone()))?;
    handle.write(data.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn resize_run_command(
    id: String,
    rows: u16,
    cols: u16,
    workspace_id: Option<String>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RunCommandError> {
    session.require()?;
    let handle = runtime
        .get(&pty_key(&id, workspace_id.as_deref()))
        .ok_or_else(|| RunCommandError::NotRunning(id.clone()))?;
    handle.resize(rows, cols)?;
    Ok(())
}

/// The user's run commands that are running (or exited this session) —
/// for one task, or all when `workspaceId` is omitted.
#[tauri::command]
pub async fn list_running_commands(
    workspace_id: Option<String>,
    runs: State<'_, RunCommandRuntime>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<RunningCommand>, RunCommandError> {
    let current = require_user(&session)?;
    Ok(runs.list(&current.user_id, workspace_id.as_deref()))
}

/// Pipe a PTY's replay + live events into the frontend channel. The PTY's
/// exit is handled (unregistered) by the runtime's own monitor, so a
/// closed channel or a second viewer never affects it.
fn forward(
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
                    if channel.send(event).is_err() || is_exit {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
