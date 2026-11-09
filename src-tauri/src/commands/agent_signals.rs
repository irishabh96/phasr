//! Agent-signal commands: needs-you state, in-app approvals, token usage,
//! the agent's last message and the files it edited. Thin wrappers over
//! `AgentSignals` / `TaskOrchestrator`; events live in `commands::events`.

use std::sync::Arc;

use tauri::State;

use crate::agent_signals::{
    AgentFileEdit, AgentSignalError, AgentSignals, AgentSummary, AttentionResponse,
    TaskAgentState,
};
use crate::auth::{AuthError, SessionState};
use crate::domain::usage::TaskUsage;
use crate::orchestrator::{OrchestratorError, TaskOrchestrator};
use crate::store::{StoreError, WorkspaceRepo};

use super::require_user;

#[derive(Debug)]
pub enum AgentSignalsCmdError {
    Auth(AuthError),
    Store(StoreError),
    Orchestrator(OrchestratorError),
    Signals(AgentSignalError),
}

impl From<AuthError> for AgentSignalsCmdError {
    fn from(err: AuthError) -> Self {
        Self::Auth(err)
    }
}

impl From<StoreError> for AgentSignalsCmdError {
    fn from(err: StoreError) -> Self {
        Self::Store(err)
    }
}

impl From<OrchestratorError> for AgentSignalsCmdError {
    fn from(err: OrchestratorError) -> Self {
        Self::Orchestrator(err)
    }
}

impl From<AgentSignalError> for AgentSignalsCmdError {
    fn from(err: AgentSignalError) -> Self {
        Self::Signals(err)
    }
}

impl std::fmt::Display for AgentSignalsCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auth(err) => write!(f, "{err}"),
            Self::Store(err) => write!(f, "{err}"),
            Self::Orchestrator(err) => write!(f, "{err}"),
            Self::Signals(err) => write!(f, "{err}"),
        }
    }
}

impl serde::Serialize for AgentSignalsCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Snapshot of every tracked task's agent state that belongs to the
/// signed-in user. Tasks phasr hasn't launched since startup are absent;
/// `phasr://task-agent-state` patches the snapshot afterwards.
#[tauri::command]
pub async fn list_agent_states(
    signals: State<'_, AgentSignals>,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TaskAgentState>, AgentSignalsCmdError> {
    let current = require_user(&session)?;
    let mut owned = Vec::new();
    for state in signals.states() {
        if orchestrator
            .assert_owner(&state.task_id, &current.user_id)
            .await
            .is_ok()
        {
            owned.push(state);
        }
    }
    Ok(owned)
}

/// Answer the agent's approval dialog. Rejects with `"stale attention"`
/// when `attention_id` isn't the dialog currently up (nothing is typed).
#[tauri::command]
pub async fn respond_to_attention(
    task_id: String,
    attention_id: String,
    response: AttentionResponse,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), AgentSignalsCmdError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    Ok(orchestrator
        .respond_to_attention(&task_id, &attention_id, response)
        .await?)
}

/// Token/cost totals for a task (`null` for agents without readable
/// transcripts, or before the first turn).
#[tauri::command]
pub async fn get_task_usage(
    task_id: String,
    signals: State<'_, AgentSignals>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Option<TaskUsage>, AgentSignalsCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&task_id, &current.user_id).await?;
    Ok(signals.usage_for(&workspace).await)
}

/// The agent's last assistant message.
#[tauri::command]
pub async fn get_agent_summary(
    task_id: String,
    signals: State<'_, AgentSignals>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Option<AgentSummary>, AgentSignalsCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&task_id, &current.user_id).await?;
    Ok(signals.summary_for(&workspace).await)
}

/// Files the agent edited (latest edit per path, newest first).
#[tauri::command]
pub async fn list_agent_file_edits(
    task_id: String,
    signals: State<'_, AgentSignals>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<AgentFileEdit>, AgentSignalsCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&task_id, &current.user_id).await?;
    Ok(signals.file_edits_for(&workspace).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_as_plain_strings() {
        let err = AgentSignalsCmdError::from(AgentSignalError::StaleAttention);
        assert_eq!(serde_json::to_value(&err).unwrap(), "stale attention");
        let err = AgentSignalsCmdError::from(OrchestratorError::from(
            AgentSignalError::StaleAttention,
        ));
        assert_eq!(serde_json::to_value(&err).unwrap(), "stale attention");
        let err = AgentSignalsCmdError::from(StoreError::NotFound);
        assert_eq!(serde_json::to_value(&err).unwrap(), "not found");
    }
}
