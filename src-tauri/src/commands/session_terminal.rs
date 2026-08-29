//! Ad-hoc shell PTYs used by the repo-page tab system. Same machinery
//! as run-commands (`commands/run_commands.rs`) but without a DB row —
//! sessions are pure in-memory, identified by a UUID returned to the
//! frontend on `start`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::auth::{AuthError, SessionState};
use crate::pty::{LagRecovery, PtyEvent, TaskRuntime};

/// Distinct from `run:` and bare workspace UUIDs so the keys never collide.
const SESSION_PTY_PREFIX: &str = "session:";

fn pty_id(session_id: &str) -> String {
    format!("{SESSION_PTY_PREFIX}{session_id}")
}

#[derive(Debug, Error)]
pub enum SessionTerminalError {
    #[error(transparent)]
    Pty(#[from] crate::pty::handle::PtyError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("no running session for id `{0}`")]
    NotRunning(String),
}

impl serde::Serialize for SessionTerminalError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub async fn start_session_terminal(
    cwd: String,
    initial_command: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    on_event: Channel<PtyEvent>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, SessionTerminalError> {
    session.require()?;
    let session_id = Uuid::new_v4().to_string();
    let key = pty_id(&session_id);

    let handle = runtime.spawn(
        key.clone(),
        initial_command,
        None,
        PathBuf::from(cwd),
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
    Ok(session_id)
}

#[tauri::command]
pub async fn attach_session_terminal(
    session_id: String,
    on_event: Channel<PtyEvent>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), SessionTerminalError> {
    session.require()?;
    let key = pty_id(&session_id);
    let handle = runtime
        .get(&key)
        .ok_or_else(|| SessionTerminalError::NotRunning(session_id.clone()))?;
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
pub async fn send_session_input(
    session_id: String,
    data: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), SessionTerminalError> {
    session.require()?;
    let handle = runtime
        .get(&pty_id(&session_id))
        .ok_or_else(|| SessionTerminalError::NotRunning(session_id.clone()))?;
    handle.write(data.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn resize_session(
    session_id: String,
    rows: u16,
    cols: u16,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), SessionTerminalError> {
    session.require()?;
    let handle = runtime
        .get(&pty_id(&session_id))
        .ok_or_else(|| SessionTerminalError::NotRunning(session_id.clone()))?;
    handle.resize(rows, cols)?;
    Ok(())
}

#[tauri::command]
pub async fn stop_session_terminal(
    session_id: String,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), SessionTerminalError> {
    session.require()?;
    let key = pty_id(&session_id);
    if let Some(handle) = runtime.get(&key) {
        let _ = handle.kill();
        runtime.drop_task(&key);
    }
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
