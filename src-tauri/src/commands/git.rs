//! Git command surface. All operations run inside the task's worktree
//! (resolved from `task.worktree_path`). Tasks without a worktree path
//! yet (e.g. workspace had no local path at create time) return an
//! error.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::State;

use crate::git::{self, CommitOutput, DiffScope, FileChange, GitError};
use crate::store::{StoreError, TaskRepo};

#[derive(Debug)]
pub enum GitCmdError {
    Store(StoreError),
    Git(GitError),
    NoWorktree,
}

impl From<StoreError> for GitCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<GitError> for GitCmdError {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}

impl std::fmt::Display for GitCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::NoWorktree => write!(f, "task has no worktree yet"),
        }
    }
}

impl serde::Serialize for GitCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

async fn task_cwd(repo: &TaskRepo, task_id: &str) -> Result<PathBuf, GitCmdError> {
    let task = repo.get(task_id).await?;
    task.worktree_path
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)
}

#[tauri::command]
pub async fn git_status(
    task_id: String,
    tasks: State<'_, TaskRepo>,
) -> Result<Vec<FileChange>, GitCmdError> {
    let cwd = task_cwd(&tasks, &task_id).await?;
    Ok(git::status(&cwd)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffInput {
    pub task_id: String,
    pub scope: DiffScope,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn git_diff(
    input: DiffInput,
    tasks: State<'_, TaskRepo>,
) -> Result<String, GitCmdError> {
    let cwd = task_cwd(&tasks, &input.task_id).await?;
    Ok(git::diff(&cwd, input.scope, input.path.as_deref())?)
}

#[tauri::command]
pub async fn git_stage(
    task_id: String,
    paths: Vec<String>,
    tasks: State<'_, TaskRepo>,
) -> Result<(), GitCmdError> {
    let cwd = task_cwd(&tasks, &task_id).await?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git::stage(&cwd, &refs)?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(
    task_id: String,
    paths: Vec<String>,
    tasks: State<'_, TaskRepo>,
) -> Result<(), GitCmdError> {
    let cwd = task_cwd(&tasks, &task_id).await?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git::unstage(&cwd, &refs)?;
    Ok(())
}

#[tauri::command]
pub async fn git_discard(
    task_id: String,
    paths: Vec<String>,
    tasks: State<'_, TaskRepo>,
) -> Result<(), GitCmdError> {
    let cwd = task_cwd(&tasks, &task_id).await?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git::discard(&cwd, &refs)?;
    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    task_id: String,
    message: String,
    tasks: State<'_, TaskRepo>,
) -> Result<CommitOutput, GitCmdError> {
    let cwd = task_cwd(&tasks, &task_id).await?;
    Ok(git::commit(&cwd, &message)?)
}

#[tauri::command]
pub async fn git_push(
    task_id: String,
    tasks: State<'_, TaskRepo>,
) -> Result<(), GitCmdError> {
    let task = tasks.get(&task_id).await?;
    let cwd = task
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    let branch = task
        .branch
        .ok_or_else(|| GitCmdError::Git(GitError::CommandFailed("no branch on task".into())))?;
    git::push(&cwd, "origin", &branch)?;
    Ok(())
}
