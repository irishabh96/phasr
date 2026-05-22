use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::Agent;
use crate::store::{AgentRepo, SettingsRepo, StoreError};

/// Wraps `StoreError` so we can carry an auth-rejection variant on the
/// command surface without churning every other call site that handles
/// store errors. The `Display` impl flattens both variants to a string,
/// matching the existing `serialize_str(&self.to_string())` envelope, so
/// the frontend's error handling does not need to change.
#[derive(Debug)]
pub enum AgentCmdError {
    Store(StoreError),
    Auth(AuthError),
}

impl From<StoreError> for AgentCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for AgentCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for AgentCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for AgentCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Returns built-in agents from the local `agents` table. Rows are
/// re-inserted on boot with deterministic UUIDs so command edits and
/// default state can persist locally.
/// `is_enabled` is overlaid from `user_settings.disabled_agent_ids`.
#[tauri::command]
pub async fn list_agents(
    agents: State<'_, AgentRepo>,
    settings: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Agent>, AgentCmdError> {
    session.require()?;
    // Seeds are read straight from the DB so command edits land immediately.
    let mut all = agents.list_all().await?;

    let user_settings = settings.get_or_init().await?;
    let disabled: Vec<String> =
        serde_json::from_str(&user_settings.disabled_agent_ids).unwrap_or_default();
    for agent in all.iter_mut() {
        agent.is_enabled = !disabled.contains(&agent.id);
    }
    Ok(all)
}

#[tauri::command]
pub async fn set_agent_enabled(
    id: String,
    enabled: bool,
    settings: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), AgentCmdError> {
    session.require()?;
    let mut current = settings.get_or_init().await?;
    let mut disabled: Vec<String> =
        serde_json::from_str(&current.disabled_agent_ids).unwrap_or_default();

    if enabled {
        disabled.retain(|x| x != &id);
    } else if !disabled.contains(&id) {
        disabled.push(id);
    }

    current.disabled_agent_ids = serde_json::to_string(&disabled).unwrap_or_else(|_| "[]".into());
    settings.update(&current).await?;
    Ok(())
}

#[tauri::command]
pub async fn set_agent_command(
    id: String,
    command: String,
    repo: State<'_, AgentRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), AgentCmdError> {
    session.require()?;
    repo.set_command(&id, &command).await?;
    Ok(())
}

#[tauri::command]
pub async fn set_agent_default(
    id: String,
    repo: State<'_, AgentRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), AgentCmdError> {
    session.require()?;
    repo.set_default(&id).await?;
    Ok(())
}
