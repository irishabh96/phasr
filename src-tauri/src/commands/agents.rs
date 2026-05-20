use serde::Deserialize;
use tauri::State;

use crate::domain::Agent;
use crate::store::{AgentRepo, SettingsRepo, StoreError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    pub name: String,
    pub command: String,
}

/// Returns the merged agent list:
///   1. Seeded rows present in the local `agents` table (re-inserted
///      on boot with deterministic UUIDs).
///   2. The user's custom agents.
/// `is_enabled` is overlaid from `user_settings.disabled_agent_ids`.
#[tauri::command]
pub async fn list_agents(
    agents: State<'_, AgentRepo>,
    settings: State<'_, SettingsRepo>,
) -> Result<Vec<Agent>, StoreError> {
    // Seeds are read straight from the DB so command edits land
    // immediately; custom agents come from the same table.
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
) -> Result<(), StoreError> {
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
) -> Result<(), StoreError> {
    repo.set_command(&id, &command).await
}

#[tauri::command]
pub async fn set_agent_default(
    id: String,
    repo: State<'_, AgentRepo>,
) -> Result<(), StoreError> {
    repo.set_default(&id).await
}

#[tauri::command]
pub async fn create_custom_agent(
    input: CreateAgentInput,
    repo: State<'_, AgentRepo>,
) -> Result<Agent, StoreError> {
    let agent = Agent::new_custom(input.name, input.command);
    repo.insert(&agent).await?;
    Ok(agent)
}

#[tauri::command]
pub async fn delete_agent(
    id: String,
    repo: State<'_, AgentRepo>,
) -> Result<(), StoreError> {
    repo.delete(&id).await
}
