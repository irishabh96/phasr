//! Board commands (M7): task cards in derived lanes, drafts, the queue,
//! and the status bar's system counts. Thin wrappers over `TaskBoard`,
//! `TaskOrchestrator` and `QueueScheduler`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::auth::SessionState;
use crate::domain::{Agent, PermissionMode, Workspace};
use crate::orchestrator::{
    launch, OrchestratorError, QueueScheduler, StartedTask, TaskBoard, TaskCard,
    TaskOrchestrator, TaskRow, TaskRowPatch,
};
use crate::store::{AppMetaRepo, SettingsRepo, WorkspaceRepo};
use crate::sync::{CloudSyncState, SyncPhase};

use super::require_user;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskDraftInput {
    pub repository_id: String,
    pub name: String,
    #[serde(default)]
    pub prompt: Option<String>,
    pub agent: Agent,
    /// `None` → the user's default mode (clamped to the agent), as for
    /// `start_task`.
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// `None` → the repository's default branch at launch time.
    #[serde(default)]
    pub base_branch: Option<String>,
    /// `true` → straight into the queue; `false` → a draft.
    #[serde(default)]
    pub queue: bool,
    /// Task id to wait for (queued tasks start once it reaches review).
    #[serde(default)]
    pub depends_on: Option<String>,
    /// `None` → true.
    #[serde(default)]
    pub notify_on_attention: Option<bool>,
}

/// Absent field = unchanged; for `prompt` / `baseBranch` / `dependsOn`, an
/// explicit `null` clears it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskDraftInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub prompt: Option<Option<String>>,
    #[serde(default)]
    pub agent: Option<Agent>,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, deserialize_with = "present")]
    pub base_branch: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub depends_on: Option<Option<String>>,
    #[serde(default)]
    pub notify_on_attention: Option<bool>,
}

/// "Field absent" (`None`, via `serde(default)`) vs "present, null"
/// (`Some(None)`).
pub(crate) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    /// Agents running in task PTYs (not run commands / plain shells).
    pub agents_running: usize,
    /// The user's task worktrees present on this machine.
    pub worktrees: usize,
    pub sync: SyncPhase,
}

/// Every task card for the signed-in user — one repository, or all of them
/// when `repository_id` is null. `phasr://task-cards-changed` says when to
/// refetch.
#[tauri::command]
pub async fn list_task_cards(
    repository_id: Option<String>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TaskCard>, OrchestratorError> {
    let current = require_user(&session)?;
    Ok(board
        .cards(Some(&current.user_id), repository_id.as_deref())
        .await?)
}

/// Save a task without starting it: a draft, or (`queue: true`) a queued
/// task the scheduler starts once its dependency is satisfied.
#[tauri::command]
pub async fn create_task_draft(
    input: CreateTaskDraftInput,
    orchestrator: State<'_, TaskOrchestrator>,
    scheduler: State<'_, QueueScheduler>,
    settings: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, OrchestratorError> {
    let current = require_user(&session)?;
    let (mode, command) = launch::resolve_launch(
        input.agent,
        input.permission_mode,
        &crate::settings_trust::launch_settings(&settings, &meta).await?,
    )?;
    let created = orchestrator
        .create_row(
            TaskRow {
                repository_id: input.repository_id,
                agent: input.agent,
                command,
                name: input.name,
                prompt: input.prompt,
                base_branch: input.base_branch,
                permission_mode: Some(mode),
                notify_on_attention: input.notify_on_attention.unwrap_or(true),
                queued: input.queue,
                depends_on: input.depends_on,
            },
            Some(&current.user_id),
        )
        .await?;
    if created.is_queued() {
        scheduler.kick();
    }
    sync_state.request_sync();
    Ok(created)
}

/// Edit a draft / queued task. Rejected once it has started.
#[tauri::command]
pub async fn update_task_draft(
    id: String,
    input: UpdateTaskDraftInput,
    orchestrator: State<'_, TaskOrchestrator>,
    workspaces: State<'_, WorkspaceRepo>,
    scheduler: State<'_, QueueScheduler>,
    settings: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, OrchestratorError> {
    let current = require_user(&session)?;
    let existing = workspaces.get_for_user(&id, &current.user_id).await?;
    // The launch command follows the (possibly new) agent and mode; the
    // stored mode carries over, clamped to a new agent, unless one is given.
    let relaunch = match (input.agent, input.permission_mode) {
        (None, None) => None,
        (agent, requested) => {
            let agent = agent.or(existing.agent).unwrap_or_else(Agent::default);
            Some(launch::relaunch(
                agent,
                requested,
                existing.permission_mode,
                &crate::settings_trust::launch_settings(&settings, &meta).await?,
            )?)
        }
    };
    // A prompt change re-fills `{{prompt}}`: re-resolve from the template.
    let relaunch = match (relaunch, &input.prompt) {
        (None, Some(_)) => {
            let agent = existing.agent.unwrap_or_else(Agent::default);
            Some(launch::relaunch(
                agent,
                None,
                existing.permission_mode,
                &crate::settings_trust::launch_settings(&settings, &meta).await?,
            )?)
        }
        (relaunch, _) => relaunch,
    };
    let (permission_mode, command) = match relaunch {
        Some((mode, command)) => (mode, Some(command)),
        None => (None, None),
    };
    let updated = orchestrator
        .update_unlaunched(
            &id,
            Some(&current.user_id),
            TaskRowPatch {
                name: input.name,
                prompt: input.prompt,
                agent: input.agent,
                command,
                permission_mode,
                notify_on_attention: input.notify_on_attention,
                base_branch: input.base_branch,
                queued: None,
                depends_on: input.depends_on,
            },
        )
        .await?;
    if updated.is_queued() {
        // A changed dependency may already be satisfied.
        scheduler.kick();
    }
    sync_state.request_sync();
    Ok(updated)
}

/// Move a not-yet-started task into (`true`) or out of (`false`) the queue.
#[tauri::command]
pub async fn set_task_queued(
    id: String,
    queued: bool,
    orchestrator: State<'_, TaskOrchestrator>,
    scheduler: State<'_, QueueScheduler>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, OrchestratorError> {
    let current = require_user(&session)?;
    let updated = orchestrator
        .update_unlaunched(
            &id,
            Some(&current.user_id),
            TaskRowPatch {
                queued: Some(queued),
                ..Default::default()
            },
        )
        .await?;
    if queued {
        scheduler.kick();
    }
    sync_state.request_sync();
    Ok(updated)
}

/// "Start now" for a draft or queued task, whatever it waits on. A task
/// that already started is returned as is (never started twice).
#[tauri::command]
pub async fn start_queued_task(
    id: String,
    rows: Option<u16>,
    cols: Option<u16>,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<StartedTask, OrchestratorError> {
    let current = require_user(&session)?;
    let started = orchestrator
        .launch(&id, Some(&current.user_id), rows, cols)
        .await?;
    sync_state.request_sync();
    Ok(started)
}

/// The status bar: running agents, worktrees on disk, cloud-sync state.
#[tauri::command]
pub async fn get_system_status(
    board: State<'_, TaskBoard>,
    orchestrator: State<'_, TaskOrchestrator>,
    sync_state: State<'_, Arc<CloudSyncState>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<SystemStatus, OrchestratorError> {
    let current = require_user(&session)?;
    let (agents_running, worktrees) = board
        .system_counts(Some(&current.user_id), &orchestrator.running_task_ids())
        .await?;
    Ok(SystemStatus {
        agents_running,
        worktrees,
        sync: sync_state.phase(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_input_tells_absent_from_null() {
        let input: UpdateTaskDraftInput =
            serde_json::from_value(serde_json::json!({"name": "n", "dependsOn": null})).unwrap();
        assert_eq!(input.name.as_deref(), Some("n"));
        assert_eq!(input.depends_on, Some(None));
        assert_eq!(input.prompt, None);
        assert_eq!(input.base_branch, None);
        let input: UpdateTaskDraftInput =
            serde_json::from_value(serde_json::json!({"baseBranch": "dev", "prompt": "p"})).unwrap();
        assert_eq!(input.base_branch, Some(Some("dev".into())));
        assert_eq!(input.prompt, Some(Some("p".into())));
    }

    #[test]
    fn create_input_defaults_to_a_draft() {
        let input: CreateTaskDraftInput = serde_json::from_value(serde_json::json!({
            "repositoryId": "r", "name": "n", "agent": "claude"
        }))
        .unwrap();
        assert!(!input.queue);
        assert_eq!(input.depends_on, None);
        assert_eq!(input.permission_mode, None);
    }

    #[test]
    fn system_status_wire_shape() {
        let status = SystemStatus {
            agents_running: 2,
            worktrees: 5,
            sync: SyncPhase::Syncing,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"agentsRunning": 2, "worktrees": 5, "sync": "syncing"})
        );
    }
}
