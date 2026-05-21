//! Git command surface. All operations run inside a workspace's
//! worktree (resolved from `workspace.worktree_path`).

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::git::{self, BranchStatus, CommitOutput, DiffScope, FileChange, GitError};
use crate::store::{StoreError, WorkspaceRepo};

#[derive(Debug)]
pub enum GitCmdError {
    Store(StoreError),
    Git(GitError),
    Auth(AuthError),
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

impl From<AuthError> for GitCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for GitCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::NoWorktree => write!(f, "workspace has no worktree yet"),
        }
    }
}

impl serde::Serialize for GitCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

async fn workspace_cwd(
    repo: &WorkspaceRepo,
    workspace_id: &str,
) -> Result<PathBuf, GitCmdError> {
    let workspace = repo.get(workspace_id).await?;
    workspace
        .worktree_path
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)
}

#[tauri::command]
pub async fn git_status(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<FileChange>, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::status(&cwd)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffInput {
    pub workspace_id: String,
    pub scope: DiffScope,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn git_diff(
    input: DiffInput,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &input.workspace_id).await?;
    Ok(git::diff(&cwd, input.scope, input.path.as_deref())?)
}

#[tauri::command]
pub async fn git_stage(
    workspace_id: String,
    paths: Vec<String>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git::stage(&cwd, &refs)?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(
    workspace_id: String,
    paths: Vec<String>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git::unstage(&cwd, &refs)?;
    Ok(())
}

#[tauri::command]
pub async fn git_discard(
    workspace_id: String,
    paths: Vec<String>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git::discard(&cwd, &refs)?;
    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    workspace_id: String,
    message: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<CommitOutput, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::commit(&cwd, &message)?)
}

#[tauri::command]
pub async fn git_push(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;
    let cwd = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    let branch = workspace.branch.ok_or_else(|| {
        GitCmdError::Git(GitError::CommandFailed("no branch on workspace".into()))
    })?;
    git::push(&cwd, "origin", &branch)?;
    Ok(())
}

#[tauri::command]
pub async fn git_branch_status(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<BranchStatus, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::branch_status(&cwd)?)
}
