use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::domain::{Task, TaskStatus};
use crate::git;
use crate::pty::TaskRuntime;
use crate::store::{StoreError, TaskRepo, TaskUpdate, WorkspaceRepo};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub workspace_id: String,
    pub name: String,
    pub command: String,
    pub prompt: Option<String>,
    pub preset_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub preset_id: Option<String>,
    pub command: Option<String>,
    pub status: Option<TaskStatus>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
}

#[derive(Debug)]
pub enum TaskCmdError {
    Store(StoreError),
    Git(git::GitError),
    InvalidPath(String),
}

impl From<StoreError> for TaskCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<git::GitError> for TaskCmdError {
    fn from(e: git::GitError) -> Self {
        Self::Git(e)
    }
}

impl std::fmt::Display for TaskCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::InvalidPath(p) => write!(f, "invalid path: {p}"),
        }
    }
}

impl serde::Serialize for TaskCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn worktree_base_path() -> PathBuf {
    // Expand `~/.phasr/worktrees`. The Settings UI lets users override
    // this per workspace later (workspace_config.worktree_base_path).
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".phasr").join("worktrees")
}

fn short_id(task_id: &str) -> &str {
    task_id.split('-').next().unwrap_or(task_id)
}

#[tauri::command]
pub async fn create_task(
    input: CreateTaskInput,
    tasks: State<'_, TaskRepo>,
    workspaces: State<'_, WorkspaceRepo>,
) -> Result<Task, TaskCmdError> {
    let workspace = workspaces.get(&input.workspace_id).await?;

    let mut task = Task::new(input.workspace_id.clone(), input.name, input.command);
    task.prompt = input.prompt;
    task.preset_id = input.preset_id;

    // If the workspace has a local path, attempt to create the worktree
    // now so the task is ready to run. Workspaces without a local clone
    // (e.g. cloud-only on this machine) skip this — start_task will
    // error with NoWorkspacePath later.
    if let Some(repo_path_str) = workspace.local_path.as_deref() {
        let repo_path = PathBuf::from(repo_path_str);
        if repo_path.exists() && repo_path.join(".git").exists() {
            let branch = format!("phasr/{}", short_id(&task.id));
            let worktree_path = worktree_base_path().join(&task.id);
            git::create_worktree(&repo_path, &worktree_path, &branch, &workspace.default_branch)?;
            task.branch = Some(branch);
            task.worktree_path = Some(worktree_path.to_string_lossy().into_owned());
        }
    }

    tasks.insert(&task).await?;
    Ok(task)
}

#[tauri::command]
pub async fn list_tasks(
    workspace_id: String,
    repo: State<'_, TaskRepo>,
) -> Result<Vec<Task>, TaskCmdError> {
    Ok(repo.list_by_workspace(&workspace_id).await?)
}

#[tauri::command]
pub async fn get_task(id: String, repo: State<'_, TaskRepo>) -> Result<Task, TaskCmdError> {
    Ok(repo.get(&id).await?)
}

#[tauri::command]
pub async fn update_task(
    id: String,
    input: UpdateTaskInput,
    repo: State<'_, TaskRepo>,
) -> Result<Task, TaskCmdError> {
    let patch = TaskUpdate {
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
pub async fn delete_task(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, TaskRepo>,
    workspaces: State<'_, WorkspaceRepo>,
) -> Result<(), TaskCmdError> {
    // Snapshot the task first so we can clean up its worktree after
    // the row is gone. We intentionally swallow PTY/worktree errors —
    // the DB delete is the source of truth; orphaned files are
    // garbage-collected later.
    let task = repo.get(&id).await.ok();

    if let Some(task) = task.as_ref() {
        // Stop any live PTY for this task.
        if let Some(runtime) = app.try_state::<Arc<TaskRuntime>>() {
            if let Some(handle) = runtime.get(&task.id) {
                let _ = handle.kill();
                runtime.drop_task(&task.id);
            }
        }
        // Remove the worktree (best effort).
        if let Some(worktree_path) = task.worktree_path.as_deref() {
            if let Ok(workspace) = workspaces.get(&task.workspace_id).await {
                if let Some(repo_path) = workspace.local_path.as_deref() {
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
