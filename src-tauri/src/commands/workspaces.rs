use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::auth::{AuthError, SessionState};
use crate::domain::{Agent, PermissionMode, Workspace, WorkspaceStatus};
use crate::fswatch::WorktreeWatchRegistry;
use crate::git;
use crate::orchestrator::{
    launch, OrchestratorError, RepoLockRegistry, TaskOrchestrator, TaskSetup,
};
use crate::store::{
    AppMetaRepo, RepositoryConfigRepo, RepositoryRepo, SettingsRepo, StoreError, WorkspaceRepo,
    WorkspaceUpdate,
};
use crate::sync::CloudSyncState;

use super::require_user;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub repository_id: String,
    pub name: String,
    pub prompt: Option<String>,
    pub agent: Option<Agent>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub agent: Option<Agent>,
    pub command: Option<String>,
    pub status: Option<WorkspaceStatus>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
    /// Stored now, takes effect the next time the task starts/resumes: the
    /// launch command is re-rendered with the new flags, but an agent
    /// that's already running keeps the ones it launched with.
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub notify_on_attention: Option<bool>,
}

#[derive(Debug)]
pub enum WorkspaceCmdError {
    Store(StoreError),
    Git(git::GitError),
    Auth(AuthError),
    Launch(OrchestratorError),
}

impl From<OrchestratorError> for WorkspaceCmdError {
    fn from(e: OrchestratorError) -> Self {
        Self::Launch(e)
    }
}

impl From<StoreError> for WorkspaceCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<git::GitError> for WorkspaceCmdError {
    fn from(e: git::GitError) -> Self {
        Self::Git(e)
    }
}

impl From<AuthError> for WorkspaceCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for WorkspaceCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Launch(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for WorkspaceCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Start watching the active workspace's worktree for fs changes.
/// The frontend calls this when a user opens the workspace view and
/// pairs it with `unwatch_workspace` on unmount, so we only ever
/// hold one OS-level watcher at a time.
#[tauri::command]
pub async fn watch_workspace(
    id: String,
    workspaces: State<'_, WorkspaceRepo>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), WorkspaceCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&id, &current.user_id).await?;
    if let Some(path) = workspace.worktree_path {
        watchers.start(id, PathBuf::from(path));
    }
    Ok(())
}

#[tauri::command]
pub fn unwatch_workspace(
    id: String,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), WorkspaceCmdError> {
    session.require()?;
    watchers.stop(&id);
    Ok(())
}

#[tauri::command]
pub async fn create_workspace(
    input: CreateWorkspaceInput,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    settings: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    repository_configs: State<'_, RepositoryConfigRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    let current_session = require_user(&session)?;
    let repository = repositories
        .get_for_user(&input.repository_id, &current_session.user_id)
        .await?;
    // Same branch template / worktree base / default base as start_task.
    let setup = TaskSetup {
        config: repository_configs.get(&repository.id).await?,
        settings: crate::settings_trust::usable(&meta, settings.get_or_default().await?).await,
    };

    // The launch command is the selected agent's (default Claude) template
    // in the user's default permission mode — the same resolution
    // start_task uses, so this path can't quietly launch skip-all.
    let agent = input.agent.unwrap_or_else(Agent::default);
    let (mode, command) =
        launch::resolve_launch(agent, None, &crate::settings_trust::launch_settings(&settings, &meta).await?)?;
    let mut workspace = Workspace::new(
        input.repository_id.clone(),
        input.name,
        launch::interpolate_for_task(&command, input.prompt.as_deref()),
    );
    workspace.prompt = input.prompt;
    workspace.agent = Some(agent);
    workspace.permission_mode = Some(mode);

    if let Some(repo_path_str) = repository.local_path.as_deref() {
        let repo_path = PathBuf::from(repo_path_str);
        if repo_path.exists() && repo_path.join(".git").exists() {
            let base = setup.base_branch(None, &repository.default_branch);
            let worktree_path = setup.worktree_base().join(&workspace.id);
            // F6: `git worktree add` writes `.git/worktrees/` and refs in the
            // SHARED repo; serialize against every other worktree-add,
            // merge-to-main, and branch-delete on this repo via the shared
            // per-repo lock so a concurrent create/start/delete can't corrupt
            // `index.lock`/refs.
            let lock = repo_locks.for_repository(&input.repository_id);
            let _guard = lock.lock().await;
            let branch =
                setup.branch_for(&repo_path, &workspace.name, &workspace.id, workspace.agent);
            git::create_worktree(&repo_path, &worktree_path, &branch, &base)?;
            workspace.branch = Some(branch);
            workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());
            // The board measures the task's diff against this.
            workspace.base_branch = Some(base);
        }
    }

    workspaces
        .insert_for_user(&workspace, &current_session.user_id)
        .await?;
    // Created here: its mode is this machine's choice (see
    // `launch::effective_mode`).
    launch::trust_task_mode(&meta, &workspace.id, mode).await?;
    sync_state.request_sync();
    Ok(workspace)
}

#[tauri::command]
pub async fn list_workspaces(
    repository_id: String,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Workspace>, WorkspaceCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(repo
        .list_by_repository_for_user(&repository_id, &current.user_id)
        .await?)
}

#[tauri::command]
pub async fn get_workspace(
    id: String,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(repo.get_for_user(&id, &current.user_id).await?)
}

#[tauri::command]
pub async fn update_workspace(
    id: String,
    input: UpdateWorkspaceInput,
    repo: State<'_, WorkspaceRepo>,
    settings: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    let current = require_user(&session)?;
    // Ownership first: `update` itself is keyed by id alone.
    let existing = repo.get_for_user(&id, &current.user_id).await?;

    // Switching agent or permission mode re-renders the stored launch
    // command (which is what a resume runs), unless the caller explicitly
    // provided one. A workspace with no agent (a plain local workspace)
    // just records the mode.
    let mut command = input.command;
    let mut permission_mode = input.permission_mode.map(Some);
    let relaunch_agent = input.agent.or(existing.agent);
    if command.is_none() && (input.agent.is_some() || input.permission_mode.is_some()) {
        if let Some(agent) = relaunch_agent {
            let (mode, template) = launch::relaunch(
                agent,
                input.permission_mode,
                existing.permission_mode,
                &crate::settings_trust::launch_settings(&settings, &meta).await?,
            )?;
            let prompt = input.prompt.as_deref().or(existing.prompt.as_deref());
            command = Some(launch::interpolate_for_task(&template, prompt));
            permission_mode = mode.map(Some);
        }
    }

    let patch = WorkspaceUpdate {
        name: input.name,
        prompt: input.prompt.map(Some),
        agent: input.agent.map(Some),
        command,
        status: input.status,
        branch: input.branch.map(Some),
        worktree_path: input.worktree_path.map(Some),
        exit_code: input.exit_code.map(Some),
        permission_mode,
        notify_on_attention: input.notify_on_attention,
        ..Default::default()
    };
    let workspace = repo.update(&id, patch).await?;
    // A mode explicitly picked here is this machine's choice.
    if let (Some(_), Some(mode)) = (input.permission_mode, workspace.permission_mode) {
        launch::trust_task_mode(&meta, &workspace.id, mode).await?;
    }
    sync_state.request_sync();
    Ok(workspace)
}

#[tauri::command]
pub async fn archive_workspace(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<crate::domain::Workspace, WorkspaceCmdError> {
    let current = require_user(&session)?;
    // Ownership before ANY side effect — quiescing another account's agent
    // would be damage even if the update below then failed.
    repo.get_for_user(&id, &current.user_id).await?;
    // Stop the PTY if it's running so the status flip doesn't race
    // against a still-alive shell. Via `quiesce_task`, which marks the
    // row stopped BEFORE the kill — killing first makes the exit watcher
    // report the archive as an agent failure.
    if let Some(orchestrator) = app.try_state::<TaskOrchestrator>() {
        orchestrator.quiesce_task(&id).await;
    }
    if let Some(runs) = app.try_state::<crate::run_commands::RunCommandRuntime>() {
        runs.stop_for_workspace(&id);
    }
    // Archived workspaces no longer need the watcher (the UI won't
    // be showing live git_status for them).
    watchers.stop(&id);

    let now = chrono::Utc::now();
    let patch = WorkspaceUpdate {
        status: Some(WorkspaceStatus::Archived),
        archived_at: Some(Some(now)),
        ..Default::default()
    };
    let workspace = repo.update(&id, patch).await?;
    sync_state.request_sync();
    Ok(workspace)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPullRequestOutcome {
    pub url: String,
    pub provider: String,
    pub head_branch: String,
    pub base_branch: String,
}

/// Pushes the workspace's branch to `origin`, then builds the
/// provider-specific "create PR/MR" URL. The frontend opens the URL
/// in the user's default browser via tauri-plugin-opener.
#[tauri::command]
pub async fn open_pull_request(
    id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<OpenPullRequestOutcome, WorkspaceCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&id, &current.user_id).await?;
    let branch = workspace.branch.clone().ok_or_else(|| {
        WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(
            "workspace has no branch yet".into(),
        ))
    })?;

    let repository = repositories
        .get_for_user(&workspace.repository_id, &current.user_id)
        .await?;
    let remote_url = repository.remote_url.clone().ok_or_else(|| {
        WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(
            "repository has no `origin` remote configured".into(),
        ))
    })?;

    // Push from the worktree (where the branch is checked out). Setting
    // upstream so the user can `git push` afterwards without flags.
    let cwd = workspace
        .worktree_path
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(repository.local_path.clone().unwrap_or_default())
        });
    crate::git::push(&cwd, "origin", &branch)?;

    let base_branch = crate::git::resolve_base_branch(
        repository.local_path.as_deref(),
        &repository.default_branch,
    );

    let target = crate::git::build_pull_request_target(&remote_url, &base_branch, &branch)
        .ok_or_else(|| {
            WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(format!(
                "couldn't derive a pull-request URL from remote `{remote_url}`"
            )))
        })?;
    Ok(OpenPullRequestOutcome {
        url: target.url,
        provider: target.provider.into(),
        head_branch: branch,
        base_branch,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeleteCheck {
    pub has_unpushed_commits: bool,
}

/// Pre-flight check so the UI can show a stronger confirmation when
/// the workspace has unmerged work. The actual delete still happens
/// via `delete_workspace`.
#[tauri::command]
pub async fn check_workspace_delete(
    id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WorkspaceDeleteCheck, WorkspaceCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&id, &current.user_id).await?;
    if workspace.workspace_kind.is_local() {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    }
    let Some(branch) = workspace.branch.as_deref() else {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    };
    let repository = repositories
        .get_for_user(&workspace.repository_id, &current.user_id)
        .await?;
    let Some(repo_path) = repository.local_path.as_deref() else {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    };
    let has =
        crate::git::has_unpushed_commits(std::path::Path::new(repo_path), branch).unwrap_or(false);
    Ok(WorkspaceDeleteCheck {
        has_unpushed_commits: has,
    })
}

#[tauri::command]
pub async fn delete_workspace(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<(), WorkspaceCmdError> {
    let current = require_user(&session)?;
    // Scoped lookup up front, propagated: another account's id (or one
    // already deleted) is `not found` before anything is stopped or
    // removed. A missing row used to fall through to `repo.delete`, which
    // returned the same `not found`, so callers see no change.
    let workspace = repo.get_for_user(&id, &current.user_id).await?;
    watchers.stop(&id);

    // Marks the row stopped before killing — otherwise the exit
    // watcher sees a still-`running` row exit non-zero and fires an
    // "agent failed" notification for the workspace being deleted.
    if let Some(orchestrator) = app.try_state::<TaskOrchestrator>() {
        orchestrator.quiesce_task(&workspace.id).await;
    }
    // Its dev servers and checks run in the worktree about to go away.
    if let Some(runs) = app.try_state::<crate::run_commands::RunCommandRuntime>() {
        runs.stop_for_workspace(&workspace.id);
    }
    if let Some(checks) = app.try_state::<crate::checks::CheckService>() {
        checks.cancel(&workspace.id);
    }
    if workspace.workspace_kind.is_local() {
        return Ok(repo.delete(&id).await?);
    }
    if let Ok(repository) = repositories
        .get_for_user(&workspace.repository_id, &current.user_id)
        .await
    {
        if let Some(repo_path) = repository.local_path.as_deref() {
            let repo_path = PathBuf::from(repo_path);
            // F6: worktree-remove + branch-delete both mutate the shared
            // repo's `.git/worktrees`/refs; hold the per-repo lock across
            // both so they can't race a concurrent worktree-add or merge.
            let lock = repo_locks.for_repository(&workspace.repository_id);
            let _guard = lock.lock().await;
            if let Some(worktree_path) = workspace.worktree_path.as_deref() {
                let _ = git::remove_worktree(&repo_path, &PathBuf::from(worktree_path));
            }
            if let Some(branch) = workspace.branch.as_deref() {
                let _ = git::branch_delete(&repo_path, branch);
            }
        }
    }

    repo.delete(&id).await?;
    sync_state.request_sync();
    Ok(())
}
