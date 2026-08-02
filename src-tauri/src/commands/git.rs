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
use crate::orchestrator::RepoLockRegistry;
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

/// Run a synchronous git operation off the async runtime. `run_git`
/// blocks the calling thread for the subprocess's full duration; doing
/// that directly on a Tokio worker starves unrelated IPC — terminal
/// input, cloud sync — during a diff/status burst on a large worktree
/// (PERFORMANCE-RETENTION-REPORT E1/A7). `spawn_blocking` moves the wait
/// onto the blocking pool. The closure owns its inputs (`move`) so no
/// borrow crosses the task boundary.
async fn blocking_git<T, F>(f: F) -> Result<T, GitCmdError>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        // A JoinError only happens if the blocking task panicked; surface
        // it as a git failure rather than silently dropping the command.
        .map_err(|e| GitCmdError::Git(GitError::CommandFailed(format!("git task failed: {e}"))))?
        .map_err(GitCmdError::Git)
}

#[tauri::command]
pub async fn git_status(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<FileChange>, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    blocking_git(move || git::status(&cwd)).await
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
    let scope = input.scope;
    let path = input.path;
    blocking_git(move || git::diff(&cwd, scope, path.as_deref())).await
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
    blocking_git(move || {
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        git::stage(&cwd, &refs)
    })
    .await
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
    blocking_git(move || {
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        git::unstage(&cwd, &refs)
    })
    .await
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
    blocking_git(move || {
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        git::discard(&cwd, &refs)
    })
    .await
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
    blocking_git(move || git::commit(&cwd, &message)).await
}

/// Result of a successful push. `pull_request_url` is a best-effort
/// "create PR/MR" link for the pushed branch (None when the remote host
/// isn't recognised or no remote is configured); the frontend surfaces
/// it as a clickable action on the "Pushed" toast.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushOutcome {
    pub branch: String,
    pub pull_request_url: Option<String>,
    pub provider: Option<String>,
}

#[tauri::command]
pub async fn git_push(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<GitPushOutcome, GitCmdError> {
    session.require()?;
    let workspace = workspaces.get(&workspace_id).await?;
    let cwd = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    let branch = workspace.branch.clone().ok_or_else(|| {
        GitCmdError::Git(GitError::CommandFailed("no branch on workspace".into()))
    })?;
    {
        let cwd = cwd.clone();
        let branch = branch.clone();
        blocking_git(move || git::push(&cwd, "origin", &branch)).await?;
    }

    // Best-effort PR link for the success toast. A missing remote, an
    // unknown host, or a failed repo lookup just yields no link — it
    // never fails the push, which already succeeded above. The two git
    // shell-outs (`get_remote_url`, `resolve_base_branch`) also run off
    // the async runtime.
    let target = match repositories.get(&workspace.repository_id).await {
        Ok(repository) => {
            let remote_hint = repository.remote_url.clone();
            let local_path = repository.local_path.clone();
            let default_branch = repository.default_branch.clone();
            let branch = branch.clone();
            blocking_git(move || {
                let remote_url = remote_hint.or_else(|| git::get_remote_url(&cwd));
                let base = git::resolve_base_branch(local_path.as_deref(), &default_branch);
                Ok(remote_url.and_then(|url| git::build_pull_request_target(&url, &base, &branch)))
            })
            .await
            .unwrap_or(None)
        }
        Err(_) => None,
    };

    Ok(GitPushOutcome {
        branch,
        pull_request_url: target.as_ref().map(|t| t.url.clone()),
        provider: target.map(|t| t.provider.to_string()),
    })
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
    blocking_git(move || git::branch_status(&cwd, target.as_deref())).await
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
    // no remote (offline use). `fetch` hits the network, so keep it off
    // the async runtime.
    blocking_git(move || {
        let output = std::process::Command::new("git")
            .args(["fetch", "--prune", "--quiet"])
            .current_dir(&cwd)
            .output()
            .map_err(GitError::Io)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitError::CommandFailed(stderr));
        }
        Ok(())
    })
    .await
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
    blocking_git(move || git::merge_into(&worktree, &source_ref, strategy)).await
}

#[tauri::command]
pub async fn git_merge_to_main(
    workspace_id: String,
    strategy: MergeStrategy,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
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
    let default_branch = repository.default_branch.clone();

    // F6: merge-to-main checks out the target branch directly in the
    // SHARED main repo `.git`, touching the same `.git/index`/refs that
    // every worktree-add and branch-delete on this repo touches. Serialize
    // against them via the shared per-repo lock so a concurrent
    // create/start/delete can't corrupt `index.lock`/refs mid-merge. The
    // guard is held across the `spawn_blocking` await (tokio Mutex).
    let lock = repo_locks.for_repository(&workspace.repository_id);
    let _guard = lock.lock().await;
    blocking_git(move || git::merge_to(&main_repo, &default_branch, &branch, strategy)).await
}

#[tauri::command]
pub async fn git_merge_in_progress(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<InProgress, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    blocking_git(move || git::merge_in_progress(&cwd)).await
}

/// The repository's MAIN checkout path (where Ship merges land). The
/// workspace-scoped twins above operate on worktrees; a conflicted Ship lives
/// in the main checkout, which no workspace id reaches — hence this repo-scoped
/// trio (`ship_epic` recovery).
async fn repo_main_path(
    repositories: &RepositoryRepo,
    repository_id: &str,
) -> Result<PathBuf, GitCmdError> {
    let repository = repositories.get(repository_id).await?;
    repository
        .local_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| {
            GitCmdError::Git(GitError::CommandFailed(
                "repository has no local path".into(),
            ))
        })
}

#[tauri::command]
pub async fn git_repo_merge_in_progress(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<InProgress, GitCmdError> {
    session.require()?;
    let cwd = repo_main_path(&repositories, &repository_id).await?;
    blocking_git(move || git::merge_in_progress(&cwd)).await
}

/// Abort a merge stopped mid-flight in the repository's MAIN checkout — the
/// one-click recovery from a conflicted Ship (restores a clean default-branch
/// checkout; the integration branch is untouched, so Ship can be retried).
/// Mutates the shared checkout → serialized on the per-repo lock like every
/// other main-checkout mutation (F6).
#[tauri::command]
pub async fn git_repo_abort_merge(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = repo_main_path(&repositories, &repository_id).await?;
    let lock = repo_locks.for_repository(&repository_id);
    let _guard = lock.lock().await;
    blocking_git(move || git::merge_abort(&cwd)).await
}

/// Push the repository's DEFAULT branch from the MAIN checkout — the explicit
/// post-Ship action (Ship itself is local-merge-only by decision). No PR link:
/// this pushes the base branch itself.
#[tauri::command]
pub async fn git_push_default_branch(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<GitPushOutcome, GitCmdError> {
    session.require()?;
    let repository = repositories.get(&repository_id).await?;
    if repository.remote_url.is_none() {
        return Err(GitCmdError::Git(GitError::CommandFailed(
            "repository has no `origin` remote configured".into(),
        )));
    }
    let cwd = repository
        .local_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| {
            GitCmdError::Git(GitError::CommandFailed(
                "repository has no local path".into(),
            ))
        })?;
    let branch = repository.default_branch.clone();
    {
        let branch = branch.clone();
        blocking_git(move || git::push(&cwd, "origin", &branch)).await?;
    }
    Ok(GitPushOutcome {
        branch,
        pull_request_url: None,
        provider: None,
    })
}

#[tauri::command]
pub async fn git_abort_merge(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    blocking_git(move || git::merge_abort(&cwd)).await
}

#[tauri::command]
pub async fn git_continue_merge(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<MergeOutcome, GitCmdError> {
    session.require()?;
    let cwd = workspace_cwd(&workspaces, &workspace_id).await?;
    blocking_git(move || git::merge_continue(&cwd)).await
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
    blocking_git(move || git::merge_set_resolution(&cwd, &path, side)).await
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
    blocking_git(move || git::git_log_query(&cwd, &opts)).await
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
    blocking_git(move || git::commit_files(&cwd, &sha)).await
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
    blocking_git(move || git::diff_for_commit(&cwd, &sha, path.as_deref())).await
}
