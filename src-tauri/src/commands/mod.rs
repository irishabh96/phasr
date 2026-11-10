//! Tauri command surface. Each handler is a thin wrapper around a
//! repository call.

pub mod agent_signals;
pub mod agents;
pub mod api_keys;
pub mod attachments;
pub mod board;
pub mod events;
pub mod files;
pub mod git;
pub mod notes;
pub mod notifications;
pub mod orchestrator;
pub mod repositories;
pub mod repository_config;
pub mod review;
pub mod run_commands;
pub mod session_terminal;
pub mod settings;
pub mod workspaces;

use crate::auth::{AuthError, Session, SessionState};

/// The auth gate for any command that touches user-owned rows: signed in,
/// AND the session identifies a user whose id scopes the `_for_user`
/// lookups that follow. Use instead of a bare `session.require()?` whenever
/// the command reads or mutates a syncable row by id — a bare gate proves
/// *someone* is signed in, not that the row is theirs.
pub fn require_user(session: &SessionState) -> Result<Session, AuthError> {
    session.require()?.ok_or(AuthError::NotSignedIn)
}
