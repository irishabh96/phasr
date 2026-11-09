//! Git command surface. All operations run inside a workspace's
//! worktree (resolved from `workspace.worktree_path`).

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::{TaskOutcome, Workspace, WorkspaceKind};
use crate::git::{
    self, BranchStatus, Commit, CommitFileChange, CommitOutput, ConflictSide, DiffScope,
    FileChange, GitError, InProgress, LogOptions, MergeOutcome, MergeStrategy,
};
use crate::orchestrator::TaskBoard;
use crate::review::cleanup::MergeCleanup;
use crate::review::{CloseOutFlags, ReviewError, ReviewService};
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};

use super::require_user;

#[derive(Debug)]
pub enum GitCmdError {
    Store(StoreError),
    Git(GitError),
    Auth(AuthError),
    Review(ReviewError),
    NoWorktree,
}

impl From<ReviewError> for GitCmdError {
    fn from(e: ReviewError) -> Self {
        match e {
            ReviewError::Store(e) => Self::Store(e),
            ReviewError::Git(e) => Self::Git(e),
            other => Self::Review(other),
        }
    }
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
            Self::Review(e) => write!(f, "{e}"),
            Self::NoWorktree => write!(f, "workspace has no worktree yet"),
        }
    }
}

impl serde::Serialize for GitCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The workspace, if it belongs to `user_id`. Another account's workspace
/// is indistinguishable from a missing one (`not found`), so a second local
/// account can neither run git in it nor learn that it exists.
async fn owned_workspace(
    repo: &WorkspaceRepo,
    workspace_id: &str,
    user_id: &str,
) -> Result<Workspace, GitCmdError> {
    Ok(repo.get_for_user(workspace_id, user_id).await?)
}

async fn workspace_cwd(
    repo: &WorkspaceRepo,
    workspace_id: &str,
    user_id: &str,
) -> Result<PathBuf, GitCmdError> {
    owned_workspace(repo, workspace_id, user_id)
        .await?
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, GitCmdError> {
    let current = require_user(&session)?;
    if matches!(input.scope, DiffScope::Base) {
        // Everything the task changed since it forked from its base:
        // committed + uncommitted + untracked (the review diff).
        let workspace = owned_workspace(&workspaces, &input.workspace_id, &current.user_id).await?;
        let cwd = workspace
            .worktree_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or(GitCmdError::NoWorktree)?;
        let base = match workspace.base_branch.clone() {
            Some(base) => base,
            None => {
                let repository = repositories
                    .get_for_user(&workspace.repository_id, &current.user_id)
                    .await?;
                git::resolve_base_branch(repository.local_path.as_deref(), &repository.default_branch)
            }
        };
        let path = input.path;
        return blocking_git(move || git::diff_vs_base(&cwd, &base, path.as_deref())).await;
    }
    let cwd = workspace_cwd(&workspaces, &input.workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let workspace = owned_workspace(&workspaces, &workspace_id, &current.user_id).await?;
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
    let target = match repositories
        .get_for_user(&workspace.repository_id, &current.user_id)
        .await
    {
        Ok(repository) => {
            let remote_hint = repository.remote_url.clone();
            // The PR targets the TASK's base (what Approve opens it
            // against), not the repository default.
            let base = ReviewService::base_branch(&workspace, &repository).await;
            let branch = branch.clone();
            blocking_git(move || {
                let remote_url = remote_hint.or_else(|| git::get_remote_url(&cwd));
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
    let current = require_user(&session)?;
    let workspace = owned_workspace(&workspaces, &workspace_id, &current.user_id).await?;
    let cwd = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    // The task's merge target — its base, the branch "Merge locally" merges
    // into and Sync merges from — so the BranchStatus carries ahead/behind
    // vs that (and names it in `baseBranch`) besides vs upstream. The
    // SyncButton and Merge gates use the target-relative counts; BranchChip
    // shows upstream-relative ones.
    let target = match repositories
        .get_for_user(&workspace.repository_id, &current.user_id)
        .await
    {
        Ok(repository) => Some(ReviewService::base_branch(&workspace, &repository).await),
        Err(_) => workspace.base_branch.clone(),
    }
    .filter(|base| git::ensure_branch_name(base).is_ok());
    blocking_git(move || git::branch_status(&cwd, target.as_deref())).await
}

#[tauri::command]
pub async fn git_fetch(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let workspace = owned_workspace(&workspaces, &workspace_id, &current.user_id).await?;
    let worktree = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    let repository = repositories
        .get_for_user(&workspace.repository_id, &current.user_id)
        .await?;
    // Sync from the TASK's base (what it was cut from and merges back
    // into), not the repository default. Its remote-tracking ref when there
    // is one (the caller usually fetches first via git_fetch); else the
    // local branch, so offline users and never-pushed bases still sync.
    let base = ReviewService::base_branch(&workspace, &repository).await;
    git::ensure_branch_name(&base)?;
    blocking_git(move || {
        let source_ref = if git::ref_exists(&worktree, &format!("refs/remotes/origin/{base}")) {
            format!("origin/{base}")
        } else {
            base
        };
        git::merge_into(&worktree, &source_ref, strategy)
    })
    .await
}

/// "Merge locally": the task's branch into its base in the repository's
/// main checkout. Gated like Approve — `overrideChecks` / `commitDirty`
/// answer the "required checks not passing: …" / "worktree has
/// uncommitted changes" refusals and may be sent together.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_merge_to_main(
    workspace_id: String,
    strategy: MergeStrategy,
    override_checks: Option<bool>,
    commit_dirty: Option<bool>,
    workspaces: State<'_, WorkspaceRepo>,
    review: State<'_, ReviewService>,
    board: State<'_, TaskBoard>,
    cleanup: State<'_, MergeCleanup>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<crate::sync::CloudSyncState>>,
) -> Result<MergeOutcome, GitCmdError> {
    let current = require_user(&session)?;
    let workspace = owned_workspace(&workspaces, &workspace_id, &current.user_id).await?;
    // THE local-merge path (the former `merge_task_locally` duplicated it
    // and disagreed on the target): merges into the TASK's base branch —
    // the one it was cut from — under the per-repo lock (F6: it checks the
    // target out in the SHARED main checkout), refuses while an in-place
    // agent works in that checkout, and records the `merged` outcome
    // against that same branch. A merge completed after resolving
    // conflicts is recorded by `git_continue_merge`.
    let outcome = review
        .merge_locally(
            &workspace,
            &current.user_id,
            strategy,
            None,
            CloseOutFlags {
                override_checks: override_checks.unwrap_or(false),
                commit_dirty: commit_dirty.unwrap_or(false),
            },
        )
        .await?;
    if matches!(outcome, MergeOutcome::Clean { .. }) && workspace.workspace_kind == WorkspaceKind::Agent {
        if workspace.outcome != Some(TaskOutcome::Merged) {
            if let Ok(merged) = workspaces.get_for_user(&workspace.id, &current.user_id).await {
                cleanup.on_merged(&merged, &current.user_id).await;
            }
        }
        board.notify_changed(&workspace.repository_id);
        sync_state.request_sync();
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn git_merge_in_progress(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<InProgress, GitCmdError> {
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
    blocking_git(move || git::merge_in_progress(&cwd)).await
}

#[tauri::command]
pub async fn git_abort_merge(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
    blocking_git(move || git::merge_abort(&cwd)).await
}

#[tauri::command]
pub async fn git_continue_merge(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    review: State<'_, crate::review::ReviewService>,
    cleanup: State<'_, MergeCleanup>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<crate::sync::CloudSyncState>>,
) -> Result<MergeOutcome, GitCmdError> {
    let current = require_user(&session)?;
    let workspace = owned_workspace(&workspaces, &workspace_id, &current.user_id).await?;
    let cwd = workspace
        .worktree_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or(GitCmdError::NoWorktree)?;
    // Read what's being merged (MERGE_HEAD) and into what BEFORE finishing:
    // the commit consumes MERGE_HEAD. A merge-to-main that stopped on
    // conflicts is finished here, in the main checkout — and must still
    // land the task in Done (M7 left this gap).
    let (outcome, merged, target) = blocking_git(move || {
        let merged = git::merge_head_branches(&cwd)?;
        let target = git::current_branch(&cwd)?;
        Ok((git::merge_continue(&cwd)?, merged, target))
    })
    .await?;
    if matches!(outcome, MergeOutcome::Clean { .. }) && !merged.is_empty() {
        match review
            .record_continued_merge(&workspace, &current.user_id, &merged, target.as_deref())
            .await
        {
            Ok(done) if !done.is_empty() => {
                for merged in &done {
                    cleanup.on_merged(merged, &current.user_id).await;
                }
                board.notify_changed(&workspace.repository_id);
                sync_state.request_sync();
            }
            Ok(_) => {}
            Err(err) => eprintln!("failed to record merge outcome after continue: {err}"),
        }
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn git_resolve_conflict(
    workspace_id: String,
    path: String,
    side: ConflictSide,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), GitCmdError> {
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let workspace = owned_workspace(&workspaces, &workspace_id, &current.user_id).await?;
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
            .get_for_user(&workspace.repository_id, &current.user_id)
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
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
    let current = require_user(&session)?;
    let cwd = workspace_cwd(&workspaces, &workspace_id, &current.user_id).await?;
    blocking_git(move || git::diff_for_commit(&cwd, &sha, path.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::init_pool;

    async fn seed_user(pool: &crate::store::Db, id: &str) {
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .bind(id)
        .bind(id)
        .bind(format!("{id}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    /// Every `git_*` command resolves its cwd through `workspace_cwd`; a
    /// second local account handing in the first account's workspace id
    /// must get the same `not found` as a bogus id — never a worktree path.
    #[tokio::test]
    async fn git_commands_cannot_reach_another_users_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;
        let repositories = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());

        let repo = Repository::new("r".into(), None, None);
        repositories.insert_for_user(&repo, "user-a").await.unwrap();
        let mut ws = Workspace::new(repo.id.clone(), "a-task".into(), "c".into());
        ws.worktree_path = Some("/tmp/phasr-owned-by-a".into());
        workspaces.insert_for_user(&ws, "user-a").await.unwrap();

        assert_eq!(
            workspace_cwd(&workspaces, &ws.id, "user-a").await.unwrap(),
            PathBuf::from("/tmp/phasr-owned-by-a")
        );
        let err = workspace_cwd(&workspaces, &ws.id, "user-b")
            .await
            .expect_err("user-b must not resolve user-a's worktree");
        assert!(matches!(err, GitCmdError::Store(StoreError::NotFound)));
        // The serialized error the frontend sees is the plain string.
        assert_eq!(serde_json::to_string(&err).unwrap(), "\"not found\"");

        assert!(matches!(
            owned_workspace(&workspaces, &ws.id, "user-b").await,
            Err(GitCmdError::Store(StoreError::NotFound))
        ));
    }
}
