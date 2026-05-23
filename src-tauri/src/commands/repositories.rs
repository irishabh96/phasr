use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::Repository;
use crate::git::{self, GitError};
use crate::orchestrator::TaskOrchestrator;
use crate::pty::TaskRuntime;
use crate::store::{RepositoryRepo, RepositoryUpdate, StoreError, WorkspaceRepo};

#[derive(Debug)]
pub enum RepositoryCmdError {
    Store(StoreError),
    Git(GitError),
    Auth(AuthError),
    NoLocalPath,
}

impl From<StoreError> for RepositoryCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<GitError> for RepositoryCmdError {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}

impl From<AuthError> for RepositoryCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for RepositoryCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::NoLocalPath => write!(f, "repository has no local path on this machine"),
        }
    }
}

impl serde::Serialize for RepositoryCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepositoryInput {
    pub name: String,
    pub local_path: Option<String>,
    pub remote_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRepositoryInput {
    pub name: Option<String>,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    pub default_branch: Option<String>,
}

#[tauri::command]
pub async fn create_repository(
    input: CreateRepositoryInput,
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Repository, RepositoryCmdError> {
    session.require()?;
    // Idempotent: same canonical path returns the existing row.
    if let Some(input_path) = input.local_path.as_deref() {
        let candidate = std::fs::canonicalize(input_path)
            .ok()
            .unwrap_or_else(|| std::path::PathBuf::from(input_path));
        for existing in repo.list().await? {
            if let Some(existing_path) = existing.local_path.as_deref() {
                let resolved = std::fs::canonicalize(existing_path)
                    .ok()
                    .unwrap_or_else(|| std::path::PathBuf::from(existing_path));
                if resolved == candidate {
                    return Ok(existing);
                }
            }
        }
    }

    // Auto-detect the origin URL from the local repo if the caller
    // didn't provide one.
    let resolved_remote_url = input.remote_url.or_else(|| {
        input
            .local_path
            .as_deref()
            .and_then(|p| crate::git::get_remote_url(std::path::Path::new(p)))
    });

    let mut repository = Repository::new(input.name, input.local_path, resolved_remote_url);

    // Replace the hardcoded "main" with whatever the local repo
    // actually uses (master, develop, …) so merge/worktree commands
    // don't fail with `pathspec 'main' did not match`.
    if let Some(local_path) = repository.local_path.as_deref() {
        if let Some(detected) = crate::git::get_default_branch(std::path::Path::new(local_path)) {
            repository.default_branch = detected;
        }
    }

    repo.insert(&repository).await?;
    Ok(repository)
}

#[tauri::command]
pub async fn list_repositories(
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Repository>, RepositoryCmdError> {
    session.require()?;
    Ok(repo.list().await?)
}

#[tauri::command]
pub async fn get_repository(
    id: String,
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Repository, RepositoryCmdError> {
    session.require()?;
    Ok(repo.get(&id).await?)
}

#[tauri::command]
pub async fn update_repository(
    id: String,
    input: UpdateRepositoryInput,
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Repository, RepositoryCmdError> {
    session.require()?;
    let patch = RepositoryUpdate {
        name: input.name,
        remote_url: input.remote_url.map(Some),
        local_path: input.local_path.map(Some),
        default_branch: input.default_branch,
    };
    Ok(repo.update(&id, patch).await?)
}

#[tauri::command]
pub async fn delete_repository(
    id: String,
    repo: State<'_, RepositoryRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    orchestrator: State<'_, TaskOrchestrator>,
    runtime: State<'_, Arc<TaskRuntime>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RepositoryCmdError> {
    session.require()?;

    // Need the repo's localPath for `git worktree remove` later.
    // Tolerate NotFound so a double-delete doesn't error.
    let repository = repo.get(&id).await.ok();
    let repo_local_path = repository.as_ref().and_then(|r| r.local_path.clone());

    // 1. Stop running tasks and force-kill any still-live PTYs.
    //    Workspaces are listed BEFORE the soft-delete + child wipe so
    //    we still have their ids + worktree paths.
    let owned_workspaces = workspaces.list_by_repository(&id).await?;
    for ws in &owned_workspaces {
        // Silently ignore NotRunning. The task may already have exited.
        let _ = orchestrator.stop_task(&ws.id).await;
        if let Some(handle) = runtime.get(&ws.id) {
            let _ = handle.kill();
        }
    }

    // 2. Remove worktree directories. `git::remove_worktree` runs
    //    `git worktree remove --force` against the parent .git. If the
    //    parent local_path is unknown OR the command fails (the user
    //    deleted the parent repo out from under us, etc.), fall back
    //    to plain `rm -rf` on the worktree path so the dir doesn't
    //    linger on disk.
    for ws in &owned_workspaces {
        let Some(path) = ws.worktree_path.as_deref() else {
            continue;
        };
        let worktree_path = std::path::Path::new(path);
        if !worktree_path.exists() {
            continue;
        }
        let cleaned = repo_local_path
            .as_deref()
            .map(|parent| git::remove_worktree(std::path::Path::new(parent), worktree_path).is_ok())
            .unwrap_or(false);
        if !cleaned {
            let _ = std::fs::remove_dir_all(worktree_path);
        }
    }

    // 3. Soft-delete the parent + hard-delete children in one tx
    //    (handled inside RepositoryRepo::delete).
    repo.delete(&id).await?;
    Ok(())
}

/// IDs of repositories soft-deleted locally but not yet pushed to
/// cloud. The bootstrap step in `useCloudSync` reads this before
/// pulling so any pending deletions land remotely first.
#[tauri::command]
pub async fn list_soft_deleted_repositories(
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<String>, RepositoryCmdError> {
    session.require()?;
    Ok(repo.list_dirty_soft_deletes().await?)
}

/// Clear `dirty` on a repository row once its cloud-side delete has
/// confirmed.
#[tauri::command]
pub async fn mark_repository_synced(
    id: String,
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), RepositoryCmdError> {
    session.require()?;
    repo.mark_synced(&id).await?;
    Ok(())
}

/// `true` when this id is soft-deleted locally. The cloud-sync pull
/// uses this to skip resurrection of locally-tombstoned repositories.
#[tauri::command]
pub async fn repository_is_soft_deleted(
    id: String,
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<bool, RepositoryCmdError> {
    session.require()?;
    Ok(repo.exists_soft_deleted(&id).await?)
}

/// Initialize the repository's local folder as a git repo (mockup 4
/// recovery flow). Runs `git init -b main` plus an empty initial
/// commit so HEAD exists, then refreshes `default_branch` on the
/// stored row.
#[tauri::command]
pub async fn git_init_repository(
    id: String,
    repo: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Repository, RepositoryCmdError> {
    session.require()?;
    let repository = repo.get(&id).await?;
    let local_path = repository
        .local_path
        .as_deref()
        .ok_or(RepositoryCmdError::NoLocalPath)?;
    git::init_repo(std::path::Path::new(local_path))?;

    let detected = git::get_default_branch(std::path::Path::new(local_path));
    let patch = RepositoryUpdate {
        default_branch: detected,
        ..Default::default()
    };
    Ok(repo.update(&id, patch).await?)
}

/// Clone `url` into `destination_path`. Used by the new-project wizard
/// for the "Clone URL" flow. The destination must not exist or must be
/// empty — we never overwrite a user folder.
///
/// This does NOT create a repository row in the store; the frontend
/// follows up with `create_repository` once the clone succeeds, so the
/// row gets the auto-detected `remote_url` and `default_branch`.
#[tauri::command]
pub async fn git_clone_repository(
    url: String,
    destination_path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, RepositoryCmdError> {
    session.require()?;
    let dest = std::path::Path::new(&destination_path);
    git::clone_repo(&url, dest)?;
    Ok(destination_path)
}

/// Clone a template repo into `destination_path`, drop its history, and
/// re-init git so the user owns commit 0. Same destination contract as
/// `git_clone_repository`. The frontend follows up with
/// `create_repository` to register the row.
#[tauri::command]
pub async fn git_init_from_template(
    template_git_url: String,
    destination_path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, RepositoryCmdError> {
    session.require()?;
    let dest = std::path::Path::new(&destination_path);
    git::init_from_template(&template_git_url, dest)?;
    Ok(destination_path)
}

/// `mkdir -p <destination_path>` + `git init` + seed an initial commit
/// so the new repo has a HEAD. Used by the NewProjectPane "Empty" tile.
/// The frontend follows up with `create_repository` to register the row.
#[tauri::command]
pub async fn git_init_empty_repository(
    destination_path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, RepositoryCmdError> {
    session.require()?;
    let dest = std::path::Path::new(&destination_path);
    std::fs::create_dir_all(dest)
        .map_err(|e| RepositoryCmdError::Git(crate::git::GitError::Io(e)))?;
    git::init_repo(dest)?;
    Ok(destination_path)
}

/// List files inside a repository for the file-search modal. Honors
/// `.gitignore` when the path is a git repo; falls back to a manual
/// walk that skips heavy folders otherwise.
#[tauri::command]
pub async fn list_repo_files(
    path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<String>, RepositoryCmdError> {
    session.require()?;
    Ok(git::list_files(std::path::Path::new(&path))?)
}

/// Sorted list of local branch names in the repo. Used by the
/// CreateFirstWorkspacePane base-branch dropdown.
#[tauri::command]
pub async fn list_local_branches(
    path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<String>, RepositoryCmdError> {
    session.require()?;
    Ok(git::list_local_branches(std::path::Path::new(&path))?)
}
