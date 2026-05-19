use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::domain::{Workspace, WorkspaceStatus};
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
    pub preset_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub preset_id: Option<String>,
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

impl std::fmt::Display for WorkspaceCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for WorkspaceCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn worktree_base_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".phasr").join("worktrees")
}

fn short_id(id: &str) -> &str {
    id.split('-').next().unwrap_or(id)
}

#[tauri::command]
pub async fn create_workspace(
    input: CreateWorkspaceInput,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
) -> Result<Workspace, WorkspaceCmdError> {
    let repository = repositories.get(&input.repository_id).await?;

    let mut workspace = Workspace::new(input.repository_id.clone(), input.name, input.command);
    workspace.prompt = input.prompt;
    workspace.preset_id = input.preset_id;

    if let Some(repo_path_str) = repository.local_path.as_deref() {
        let repo_path = PathBuf::from(repo_path_str);
        if repo_path.exists() && repo_path.join(".git").exists() {
            let branch = format!("phasr/{}", short_id(&workspace.id));
            let worktree_path = worktree_base_path().join(&workspace.id);
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
) -> Result<Vec<Workspace>, WorkspaceCmdError> {
    Ok(repo.list_by_repository(&repository_id).await?)
}

#[tauri::command]
pub async fn get_workspace(
    id: String,
    repo: State<'_, WorkspaceRepo>,
) -> Result<Workspace, WorkspaceCmdError> {
    Ok(repo.get(&id).await?)
}

#[tauri::command]
pub async fn update_workspace(
    id: String,
    input: UpdateWorkspaceInput,
    repo: State<'_, WorkspaceRepo>,
) -> Result<Workspace, WorkspaceCmdError> {
    let patch = WorkspaceUpdate {
        name: input.name,
        prompt: input.prompt.map(Some),
        preset_id: input.preset_id.map(Some),
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
pub async fn delete_workspace(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
) -> Result<(), WorkspaceCmdError> {
    let workspace = repo.get(&id).await.ok();

    if let Some(workspace) = workspace.as_ref() {
        if let Some(runtime) = app.try_state::<Arc<TaskRuntime>>() {
            if let Some(handle) = runtime.get(&workspace.id) {
                let _ = handle.kill();
                runtime.drop_task(&workspace.id);
            }
        }
        if let Some(worktree_path) = workspace.worktree_path.as_deref() {
            if let Ok(repository) = repositories.get(&workspace.repository_id).await {
                if let Some(repo_path) = repository.local_path.as_deref() {
                    let _ = git::remove_worktree(
                        &PathBuf::from(repo_path),
                        &PathBuf::from(worktree_path),
                    );
                }
            }
        }
    }

    Ok(repo.delete(&id).await?)
}
