//! Ad-hoc shell PTYs used by the repo-page tab system. Same machinery
//! as run-commands (`commands/run_commands.rs`) but without a DB row —
//! sessions are pure in-memory, identified by a UUID returned to the
//! frontend on `start`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use thiserror::Error;
use uuid::Uuid;

use crate::auth::{AuthError, SessionState};
use crate::commands::pty_stream::{self, PtyStreamRegistry};
use crate::pty::handle::PtyHandle;
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
    on_event: Channel<InvokeResponseBody>,
    runtime: State<'_, Arc<TaskRuntime>>,
    streams: State<'_, Arc<PtyStreamRegistry>>,
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
        streams.inner().clone(),
        handle.clone(),
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
    on_event: Channel<InvokeResponseBody>,
    runtime: State<'_, Arc<TaskRuntime>>,
    streams: State<'_, Arc<PtyStreamRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), SessionTerminalError> {
    session.require()?;
    let key = pty_id(&session_id);
    let handle = runtime
        .get(&key)
        .ok_or_else(|| SessionTerminalError::NotRunning(session_id.clone()))?;
    let (replay, rx) = handle.subscribe_with_replay();
    forward(
        streams.inner().clone(),
        handle.clone(),
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

/// Local shim over the shared forwarder (`commands/pty_stream.rs`): these
/// PTYs have no workspace row behind them, so the runtime map is the only
/// thing that remembers them and it has to be cleared when the child exits.
#[allow(clippy::too_many_arguments)]
fn forward(
    streams: Arc<PtyStreamRegistry>,
    handle: Arc<PtyHandle>,
    replay: Vec<PtyEvent>,
    rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    recovery: LagRecovery,
    channel: Channel<InvokeResponseBody>,
    runtime: Arc<TaskRuntime>,
    key: String,
) {
    pty_stream::spawn(streams, handle, replay, rx, recovery, channel, move || {
        runtime.drop_task(&key)
    });
}
