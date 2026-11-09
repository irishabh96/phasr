use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::detect::{AgentDetection, DetectionCache, EnvironmentCheck};
use crate::domain::{Agent, PermissionMode};
use crate::orchestrator::{launch, OrchestratorError};
use crate::store::{SettingsRepo, StoreError};

/// One built-in agent as exposed to the frontend.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOption {
    pub agent: Agent,
    pub label: &'static str,
    /// What a new task with this agent runs by default: the effective
    /// template rendered for the user's default permission mode (clamped
    /// to what the agent supports).
    pub command: String,
    pub is_default: bool,
    /// Built-in template, with the `{{permissions}}` placeholder.
    pub default_template: &'static str,
    /// The template actually used: the user's override, else the default.
    pub template: String,
    /// Modes this agent can express, strictest first.
    pub permission_modes: Vec<PermissionMode>,
    pub supports_hooks: bool,
    pub usage_supported: bool,
}

#[derive(Debug)]
pub enum AgentsCmdError {
    Auth(AuthError),
    Store(StoreError),
    Launch(OrchestratorError),
}

impl From<AuthError> for AgentsCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<StoreError> for AgentsCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<OrchestratorError> for AgentsCmdError {
    fn from(e: OrchestratorError) -> Self {
        Self::Launch(e)
    }
}

impl std::fmt::Display for AgentsCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auth(e) => write!(f, "{e}"),
            Self::Store(e) => write!(f, "{e}"),
            Self::Launch(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for AgentsCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The fixed set of built-in agents with their launch configuration.
/// Agents aren't stored; their templates are (`user_settings.agent_commands`).
#[tauri::command]
pub async fn list_agents(
    settings: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<AgentOption>, AgentsCmdError> {
    session.require()?;
    let settings = settings.get_or_init().await?;
    Agent::ALL
        .into_iter()
        .map(|agent| {
            let (_, command) = launch::resolve_launch(agent, None, &settings)?;
            Ok(AgentOption {
                agent,
                label: agent.label(),
                command,
                is_default: agent == Agent::default(),
                default_template: agent.default_template(),
                template: settings
                    .agent_command_override(agent)
                    .unwrap_or_else(|| agent.default_template())
                    .to_string(),
                permission_modes: agent.permission_modes(),
                supports_hooks: agent.supports_hooks(),
                usage_supported: agent.usage_supported(),
            })
        })
        .collect()
}

/// Which agent CLIs are installed, with versions. Cached for the app's
/// lifetime; `force` re-probes (the "Re-detect" button).
#[tauri::command]
pub async fn detect_agents(
    force: bool,
    cache: State<'_, Arc<DetectionCache>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<AgentDetection>, AgentsCmdError> {
    session.require()?;
    Ok(cache.agents(force).await)
}

/// git / gh (+ auth) / shell, for the first-run environment panel.
#[tauri::command]
pub async fn check_environment(
    force: bool,
    cache: State<'_, Arc<DetectionCache>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<EnvironmentCheck, AgentsCmdError> {
    session.require()?;
    Ok(cache.environment(force).await)
}

/// The exact command a task would launch with — the New task plan preview
/// and the template editor's live preview.
#[tauri::command]
pub async fn preview_agent_command(
    agent: Agent,
    mode: PermissionMode,
    settings: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, AgentsCmdError> {
    session.require()?;
    let settings = settings.get_or_init().await?;
    Ok(launch::resolve_command(agent, mode, &settings)?)
}
