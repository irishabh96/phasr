use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::auth::{AuthError, SessionState};
use crate::domain::{Workspace, WorkspaceStatus};
use crate::fswatch::WorktreeWatchRegistry;
use crate::git;
use crate::pty::TaskRuntime;
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo, WorkspaceUpdate};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub repository_id: String,
    pub name: String,
    pub command: String,
    pub prompt: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub agent_id: Option<String>,
    pub command: Option<String>,
    pub status: Option<WorkspaceStatus>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
}

#[derive(Debug)]
pub enum WorkspaceCmdError {
    Store(StoreError),
    Git(git::GitError),
    Auth(AuthError),
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
    session.require()?;
    let workspace = workspaces.get(&id).await?;
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
    session: State<'_, Arc<SessionState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    session.require()?;
    let repository = repositories.get(&input.repository_id).await?;

    let mut workspace = Workspace::new(input.repository_id.clone(), input.name, input.command);
    workspace.prompt = input.prompt;
    workspace.agent_id = input.agent_id;

    if let Some(repo_path_str) = repository.local_path.as_deref() {
        let repo_path = PathBuf::from(repo_path_str);
        if repo_path.exists() && repo_path.join(".git").exists() {
            let branch = format!("phasr/{}", git::short_id(&workspace.id));
            let worktree_path = git::default_worktree_base_path().join(&workspace.id);
            git::create_worktree(
                &repo_path,
                &worktree_path,
                &branch,
                &repository.default_branch,
            )?;
            workspace.branch = Some(branch);
            workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());
        }
    }

    workspaces.insert(&workspace).await?;
    Ok(workspace)
}

#[tauri::command]
pub async fn list_workspaces(
    repository_id: String,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Workspace>, WorkspaceCmdError> {
    session.require()?;
    Ok(repo.list_by_repository(&repository_id).await?)
}

#[tauri::command]
pub async fn get_workspace(
    id: String,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    session.require()?;
    Ok(repo.get(&id).await?)
}

#[tauri::command]
pub async fn update_workspace(
    id: String,
    input: UpdateWorkspaceInput,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    session.require()?;
    let patch = WorkspaceUpdate {
        name: input.name,
        prompt: input.prompt.map(Some),
        agent_id: input.agent_id.map(Some),
        command: input.command,
        status: input.status,
        branch: input.branch.map(Some),
        worktree_path: input.worktree_path.map(Some),
        exit_code: input.exit_code.map(Some),
        ..Default::default()
    };
    Ok(repo.update(&id, patch).await?)
}

#[tauri::command]
pub async fn archive_workspace(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<crate::domain::Workspace, WorkspaceCmdError> {
    session.require()?;
    // Stop the PTY if it's running so the status flip doesn't race
    // against a still-alive shell.
    if let Some(runtime) = app.try_state::<Arc<TaskRuntime>>() {
        if let Some(handle) = runtime.get(&id) {
            let _ = handle.kill();
            runtime.drop_task(&id);
        }
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
    Ok(repo.update(&id, patch).await?)
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
    session.require()?;
    let workspace = workspaces.get(&id).await?;
    let branch = workspace.branch.clone().ok_or_else(|| {
        WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(
            "workspace has no branch yet".into(),
        ))
    })?;

    let repository = repositories.get(&workspace.repository_id).await?;
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

    // Use the configured default branch when it actually exists, else
    // fall back to whatever git reports — keeps existing rows that
    // were created with `default_branch = "main"` working on
    // master-style repos.
    let local_path = repository.local_path.as_deref();
    let configured_exists = local_path.is_some_and(|p| {
        crate::git::get_default_branch(std::path::Path::new(p))
            .is_some_and(|d| d == repository.default_branch)
    });
    let base_branch = if configured_exists {
        repository.default_branch.clone()
    } else if let Some(detected) =
        local_path.and_then(|p| crate::git::get_default_branch(std::path::Path::new(p)))
    {
        detected
    } else {
        repository.default_branch.clone()
    };

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
    session.require()?;
    let workspace = workspaces.get(&id).await?;
    let Some(branch) = workspace.branch.as_deref() else {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    };
    let repository = repositories.get(&workspace.repository_id).await?;
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
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), WorkspaceCmdError> {
    session.require()?;
    watchers.stop(&id);
    let workspace = repo.get(&id).await.ok();

    if let Some(workspace) = workspace.as_ref() {
        if let Some(runtime) = app.try_state::<Arc<TaskRuntime>>() {
            if let Some(handle) = runtime.get(&workspace.id) {
                let _ = handle.kill();
                runtime.drop_task(&workspace.id);
            }
        }
        if let Ok(repository) = repositories.get(&workspace.repository_id).await {
            if let Some(repo_path) = repository.local_path.as_deref() {
                let repo_path = PathBuf::from(repo_path);
                if let Some(worktree_path) = workspace.worktree_path.as_deref() {
                    let _ = git::remove_worktree(&repo_path, &PathBuf::from(worktree_path));
                }
                if let Some(branch) = workspace.branch.as_deref() {
                    let _ = git::branch_delete(&repo_path, branch);
                }
            }
        }
    }

    Ok(repo.delete(&id).await?)
}
