//! Git command surface. All operations run inside a workspace's
//! worktree (resolved from `workspace.worktree_path`).

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::git::{
    self, BranchStatus, Commit, CommitFileChange, CommitOutput, ConflictSide, DiffScope,
    FileChange, GitError, InProgress, LogOptions, MergeOutcome, MergeStrategy,
};
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};

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

async fn workspace_cwd(repo: &WorkspaceRepo, workspace_id: &str) -> Result<PathBuf, GitCmdError> {
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
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<BranchStatus, GitCmdError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;
    let cwd = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    // Look up the repo's merge target so the BranchStatus carries
    // ahead/behind vs `<target>` in addition to vs upstream. The
    // SyncButton and MergeToMain gates use the target-relative counts;
    // BranchChip continues to show upstream-relative counts.
    let target = repositories
        .get(&workspace.repository_id)
        .await
        .ok()
        .map(|r| r.default_branch);
    Ok(git::branch_status(&cwd, target.as_deref())?)
}

#[tauri::command]
pub async fn git_fetch(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    // `--prune` so stale tracking refs disappear; non-fatal if there's
    // no remote (offline use).
    let output = std::process::Command::new("git")
        .args(["fetch", "--prune", "--quiet"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| GitCmdError::Git(GitError::Io(e)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitCmdError::Git(GitError::CommandFailed(stderr)));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_sync_with_main(
    workspace_id: String,
    strategy: MergeStrategy,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<MergeOutcome, GitCmdError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;
    let worktree = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    let repository = repositories.get(&workspace.repository_id).await?;
    // Use the local repo's tracking ref so offline users can still
    // sync (no network round-trip needed when fetch fails). When a
    // remote exists, the caller usually fetches first via git_fetch.
    let has_remote = repository.remote_url.is_some();
    let source_ref = if has_remote {
        format!("origin/{}", repository.default_branch)
    } else {
        repository.default_branch.clone()
    };
    Ok(git::merge_into(&worktree, &source_ref, strategy)?)
}

#[tauri::command]
pub async fn git_merge_to_main(
    workspace_id: String,
    strategy: MergeStrategy,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<MergeOutcome, GitCmdError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;
    let branch = workspace.branch.clone().ok_or_else(|| {
        GitCmdError::Git(GitError::CommandFailed("workspace has no branch".into()))
    })?;
    let repository = repositories.get(&workspace.repository_id).await?;
    let main_repo = repository
        .local_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| {
            GitCmdError::Git(GitError::CommandFailed(
                "repository has no local path".into(),
            ))
        })?;
    Ok(git::merge_to(
        &main_repo,
        &repository.default_branch,
        &branch,
        strategy,
    )?)
}

#[tauri::command]
pub async fn git_merge_in_progress(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<InProgress, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::merge_in_progress(&cwd)?)
}

#[tauri::command]
pub async fn git_abort_merge(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    git::merge_abort(&cwd)?;
    Ok(())
}

#[tauri::command]
pub async fn git_continue_merge(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<MergeOutcome, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::merge_continue(&cwd)?)
}

#[tauri::command]
pub async fn git_resolve_conflict(
    workspace_id: String,
    path: String,
    side: ConflictSide,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    git::merge_set_resolution(&cwd, &path, side)?;
    Ok(())
}

#[tauri::command]
pub async fn git_log(
    workspace_id: String,
    opts: LogOptions,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Commit>, GitCmdError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;
    let cwd = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    // Caller may have provided default_branch directly, but most
    // React calls won't — resolve it from the repo row here so the
    // hook signature stays branch-only=bool + grep/page only.
    let mut opts = opts;
    if opts.branch_only && opts.default_branch.is_none() {
        opts.default_branch = repositories
            .get(&workspace.repository_id)
            .await
            .ok()
            .map(|r| r.default_branch);
    }
    Ok(git::git_log_query(&cwd, &opts)?)
}

#[tauri::command]
pub async fn git_commit_files(
    workspace_id: String,
    sha: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<CommitFileChange>, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::commit_files(&cwd, &sha)?)
}

#[tauri::command]
pub async fn git_commit_diff(
    workspace_id: String,
    sha: String,
    path: Option<String>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    Ok(git::diff_for_commit(&cwd, &sha, path.as_deref())?)
}
