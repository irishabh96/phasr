use tauri::State;

use crate::domain::Agent;
use crate::store::{AgentRepo, SettingsRepo, StoreError};

/// Returns the merged agent list:
///   1. Hardcoded seeds (Claude, Codex, …) — stable IDs across machines.
///   2. The user's custom agents from the `agents` table.
/// Per-row `is_enabled` is overlaid from `user_settings.disabled_agent_ids`.
#[tauri::command]
pub async fn list_agents(
    agents: State<'_, AgentRepo>,
    settings: State<'_, SettingsRepo>,
) -> Result<Vec<Agent>, StoreError> {
    let mut seeded = Agent::seeded();
    let custom = agents.list_custom().await?;

    let user_settings = settings.get_or_init().await?;
    let disabled: Vec<String> =
        serde_json::from_str(&user_settings.disabled_agent_ids).unwrap_or_default();

    for agent in seeded.iter_mut().chain(custom.iter().cloned().collect::<Vec<_>>().iter_mut()) {
        agent.is_enabled = !disabled.contains(&agent.id);
    }

    // Combine seeded + custom; the loop above mutated `seeded` but we
    // also need the custom list reflected. Recompute the final list.
    let mut out = Agent::seeded();
    for a in out.iter_mut() {
        a.is_enabled = !disabled.contains(&a.id);
    }
    let mut customs = custom;
    for a in customs.iter_mut() {
        a.is_enabled = !disabled.contains(&a.id);
    }
    out.extend(customs);
    Ok(out)
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
