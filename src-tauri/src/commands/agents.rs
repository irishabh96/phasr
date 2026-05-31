use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::Agent;

/// One built-in agent as exposed to the frontend: the enum value, a
/// display label, and the hardcoded launch command.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOption {
    pub agent: &'static str,
    pub label: &'static str,
    pub command: &'static str,
    pub is_default: bool,
}

/// Returns the fixed set of built-in agents for the "New workspace"
/// form. Agents are no longer stored in the database or customizable —
/// each variant carries a hardcoded command (see `domain::agent::Agent`).
#[tauri::command]
pub async fn list_agents(
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<AgentOption>, AuthError> {
    session.require()?;
    Ok(Agent::ALL
        .into_iter()
        .map(|agent| AgentOption {
            agent: agent.as_str(),
            label: agent.label(),
            command: agent.command(),
            is_default: agent == Agent::default(),
        })
        .collect())
}
