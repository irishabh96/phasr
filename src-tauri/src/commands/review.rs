//! Review commands (M8): the task's diff vs its base, checks, diff
//! comments sent to the agent, and closing the task out (PR / merge /
//! discard). Thin wrappers over `CheckService`, `ReviewService`, the
//! comment store and the orchestrator.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::agent_signals::AgentSignals;
use crate::auth::{AuthError, SessionState};
use crate::checks::{CheckError, CheckService};
use crate::domain::{
    review::format_review_comments, CheckRun, CheckSummary, CommentSide, CommentStatus, ReviewComment, Workspace,
};
use crate::fswatch::WorktreeWatchRegistry;
use crate::git::{self, FileChange, GitError};
use crate::orchestrator::{OrchestratorError, TaskBoard, TaskOrchestrator};
use crate::domain::PrMode;
use crate::review::cleanup::MergeCleanup;
use crate::review::{ApproveInput, PullRequestOutcome, ReviewError, ReviewService};
use crate::run_commands::RunCommandRuntime;
use crate::store::{
    RepositoryConfigRepo, RepositoryRepo, ReviewCommentRepo, ReviewCommentUpdate, StoreError,
    WorkspaceRepo,
};
use crate::sync::CloudSyncState;

use super::require_user;

#[derive(Debug)]
pub enum ReviewCmdError {
    Store(StoreError),
    Git(GitError),
    Auth(AuthError),
    Checks(CheckError),
    Review(ReviewError),
    /// The agent's PTY isn't running, so there's nothing to send to.
    AgentNotRunning,
    NothingToSend,
    NoWorktree,
}

impl From<StoreError> for ReviewCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}
impl From<GitError> for ReviewCmdError {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}
impl From<AuthError> for ReviewCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}
impl From<CheckError> for ReviewCmdError {
    fn from(e: CheckError) -> Self {
        Self::Checks(e)
    }
}
impl From<ReviewError> for ReviewCmdError {
    fn from(e: ReviewError) -> Self {
        Self::Review(e)
    }
}
impl From<OrchestratorError> for ReviewCmdError {
    fn from(e: OrchestratorError) -> Self {
        match e {
            OrchestratorError::TaskNotRunning(_)
            | OrchestratorError::Pty(crate::pty::handle::PtyError::AgentNotRunning) => Self::AgentNotRunning,
            OrchestratorError::Store(e) => Self::Store(e),
            other => Self::Review(ReviewError::Other(other.to_string())),
        }
    }
}

impl std::fmt::Display for ReviewCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Checks(e) => write!(f, "{e}"),
            Self::Review(e) => write!(f, "{e}"),
            // The frontend matches this exact string.
            Self::AgentNotRunning => write!(f, "agent not running"),
            Self::NothingToSend => write!(f, "no pending comments to send"),
            Self::NoWorktree => write!(f, "workspace has no worktree yet"),
        }
    }
}

impl serde::Serialize for ReviewCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Run a blocking git op off the async runtime.
async fn blocking_git<T, F>(f: F) -> Result<T, ReviewCmdError>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ReviewCmdError::Git(GitError::CommandFailed(format!("git task failed: {e}"))))?
        .map_err(ReviewCmdError::Git)
}

/// The task's base branch: recorded at launch, else the repository's
/// default (pre-M7 rows).
async fn base_branch_of(
    workspace: &Workspace,
    repositories: &RepositoryRepo,
    user_id: &str,
) -> Result<String, ReviewCmdError> {
    if let Some(base) = workspace.base_branch.clone() {
        return Ok(base);
    }
    let repository = repositories.get_for_user(&workspace.repository_id, user_id).await?;
    Ok(ReviewService::base_branch(workspace, &repository).await)
}

fn worktree_of(workspace: &Workspace) -> Result<PathBuf, ReviewCmdError> {
    workspace
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or(ReviewCmdError::NoWorktree)
}

// ── diff vs base ─────────────────────────────────────────────────────

/// Every file the task changed vs the merge-base with its base branch,
/// committed work included (see `git::review_files` for field meanings).
#[tauri::command]
pub async fn git_review_files(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<FileChange>, ReviewCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    let cwd = worktree_of(&workspace)?;
    let base = base_branch_of(&workspace, &repositories, &current.user_id).await?;
    blocking_git(move || git::review_files(&cwd, &base)).await
}

// ── checks ───────────────────────────────────────────────────────────

/// Run checks now: `runCommandIds`, or every check (required or
/// `before_review`) when omitted. Returns the queued (or already active)
/// runs; progress arrives as `phasr://check-run` / `phasr://check-output`.
#[tauri::command]
pub async fn run_checks(
    workspace_id: String,
    run_command_ids: Option<Vec<String>>,
    workspaces: State<'_, WorkspaceRepo>,
    checks: State<'_, CheckService>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<CheckRun>, ReviewCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    Ok(checks
        .run(&workspace, &current.user_id, run_command_ids.as_deref())
        .await?)
}

/// Cancel the task's queued/running checks. Returns how many were signalled.
#[tauri::command]
pub async fn cancel_checks(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    checks: State<'_, CheckService>,
    session: State<'_, Arc<SessionState>>,
) -> Result<usize, ReviewCmdError> {
    let current = require_user(&session)?;
    workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    Ok(checks.cancel(&workspace_id))
}

#[tauri::command]
pub async fn list_check_runs(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    checks: State<'_, CheckService>,
    session: State<'_, Arc<SessionState>>,
) -> Result<CheckSummary, ReviewCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    Ok(checks.summary(&workspace, &current.user_id).await?)
}

/// A check run's full output (the end of its log, capped at 4 MiB).
#[tauri::command]
pub async fn get_check_output(
    check_run_id: String,
    checks: State<'_, CheckService>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, ReviewCmdError> {
    let current = require_user(&session)?;
    let run = checks.get_run_for_user(&check_run_id, &current.user_id).await?;
    Ok(checks.output(&run).await)
}

// ── comments ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_review_comments(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    comments: State<'_, ReviewCommentRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<ReviewComment>, ReviewCmdError> {
    let current = require_user(&session)?;
    workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    Ok(comments
        .list_for_workspace_for_user(&workspace_id, &current.user_id)
        .await?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReviewCommentInput {
    pub workspace_id: String,
    pub path: String,
    pub line: i64,
    #[serde(default)]
    pub side: Option<CommentSide>,
    #[serde(default)]
    pub anchor_text: Option<String>,
    pub body: String,
}

#[tauri::command]
pub async fn create_review_comment(
    input: CreateReviewCommentInput,
    workspaces: State<'_, WorkspaceRepo>,
    comments: State<'_, ReviewCommentRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<ReviewComment, ReviewCmdError> {
    let current = require_user(&session)?;
    workspaces.get_for_user(&input.workspace_id, &current.user_id).await?;
    let mut comment = ReviewComment::new(
        input.workspace_id,
        input.path,
        input.line,
        input.side.unwrap_or_default(),
        input.body,
    );
    comment.anchor_text = input.anchor_text;
    comments.insert_for_user(&comment, &current.user_id).await?;
    Ok(comment)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReviewCommentInput {
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: Option<CommentStatus>,
}

#[tauri::command]
pub async fn update_review_comment(
    id: String,
    input: UpdateReviewCommentInput,
    comments: State<'_, ReviewCommentRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<ReviewComment, ReviewCmdError> {
    let current = require_user(&session)?;
    Ok(comments
        .update_for_user(
            &id,
            &current.user_id,
            ReviewCommentUpdate {
                body: input.body,
                status: input.status,
            },
        )
        .await?)
}

#[tauri::command]
pub async fn delete_review_comment(
    id: String,
    comments: State<'_, ReviewCommentRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), ReviewCmdError> {
    let current = require_user(&session)?;
    Ok(comments.delete_for_user(&id, &current.user_id).await?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendCommentsOutcome {
    /// How many comments went to the agent.
    pub sent: usize,
}

/// Format `intro` + the task's pending comments and deliver them to its
/// agent as ONE message (bracketed-paste aware, submitted), then mark them
/// sent. Nothing is marked if the agent isn't running.
async fn send_to_agent(
    workspace_id: &str,
    user_id: &str,
    intro: Option<&str>,
    require_comments: bool,
    workspaces: &WorkspaceRepo,
    comments: &ReviewCommentRepo,
    orchestrator: &TaskOrchestrator,
) -> Result<SendCommentsOutcome, ReviewCmdError> {
    workspaces.get_for_user(workspace_id, user_id).await?;
    let pending: Vec<ReviewComment> = comments
        .list_for_workspace_for_user(workspace_id, user_id)
        .await?
        .into_iter()
        .filter(|c| c.status == CommentStatus::Pending)
        .collect();
    let has_intro = intro.is_some_and(|s| !s.trim().is_empty());
    if pending.is_empty() && (require_comments || !has_intro) {
        return Err(ReviewCmdError::NothingToSend);
    }
    let message = format_review_comments(intro, &pending);
    orchestrator.send_message(workspace_id, &message, true).await?;
    let ids: Vec<String> = pending.iter().map(|c| c.id.clone()).collect();
    comments.mark_sent(&ids, user_id).await?;
    Ok(SendCommentsOutcome { sent: ids.len() })
}

const SEND_INTRO: &str = "Please address these review comments on your changes:";
const REQUEST_CHANGES_INTRO: &str = "I reviewed your changes. Please make the following changes:";

/// "Send all comments to {agent}". `message` (optional) leads the list.
#[tauri::command]
pub async fn send_review_comments(
    workspace_id: String,
    message: Option<String>,
    workspaces: State<'_, WorkspaceRepo>,
    comments: State<'_, ReviewCommentRepo>,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<SendCommentsOutcome, ReviewCmdError> {
    let current = require_user(&session)?;
    let intro = message.as_deref().filter(|m| !m.trim().is_empty()).unwrap_or(SEND_INTRO);
    send_to_agent(&workspace_id, &current.user_id, Some(intro), true, &workspaces, &comments, &orchestrator).await
}

/// "Request changes": the same delivery, but a message alone (no line
/// comments) is enough.
#[tauri::command]
pub async fn request_changes(
    workspace_id: String,
    message: Option<String>,
    workspaces: State<'_, WorkspaceRepo>,
    comments: State<'_, ReviewCommentRepo>,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<SendCommentsOutcome, ReviewCmdError> {
    let current = require_user(&session)?;
    let custom = message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    // A lead-in only makes sense in front of a list; a bare message is sent
    // as written.
    let intro = custom.unwrap_or(REQUEST_CHANGES_INTRO);
    send_to_agent(&workspace_id, &current.user_id, Some(intro), custom.is_none(), &workspaces, &comments, &orchestrator)
        .await
}

// ── closing out ──────────────────────────────────────────────────────

/// Gate on required checks (unless `overrideChecks`) → push → `gh pr
/// create` (or the compare URL when `gh` isn't usable) → record the PR.
#[tauri::command]
pub async fn approve_and_create_pr(
    workspace_id: String,
    input: Option<ApproveInput>,
    workspaces: State<'_, WorkspaceRepo>,
    review: State<'_, ReviewService>,
    configs: State<'_, RepositoryConfigRepo>,
    board: State<'_, TaskBoard>,
    app: tauri::AppHandle,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<PullRequestOutcome, ReviewCmdError> {
    let current = require_user(&session)?;
    let workspace = workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    // No explicit choice → the repository's PR mode (Settings → Branch rules).
    let mut input = input.unwrap_or_default();
    if input.draft.is_none() {
        input.draft = Some(configs.get(&workspace.repository_id).await?.pr_mode == PrMode::Draft);
    }
    let summary = match app.try_state::<AgentSignals>() {
        Some(signals) => signals.summary_for(&workspace).await.map(|s| s.text),
        None => None,
    };
    let outcome = review
        .approve_and_create_pr(&workspace, &current.user_id, input, summary)
        .await?;
    if outcome.via_gh {
        board.notify_changed(&workspace.repository_id);
        sync_state.request_sync();
    }
    Ok(outcome)
}

/// Re-read open PRs (all repositories, or one) and record merged/closed
/// outcomes. Called on window focus; also runs every 5 minutes.
#[tauri::command]
pub async fn refresh_pr_states(
    repository_id: Option<String>,
    review: State<'_, ReviewService>,
    cleanup: State<'_, MergeCleanup>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Vec<Workspace>, ReviewCmdError> {
    let current = require_user(&session)?;
    let refresh = review
        .refresh_pr_states_detailed(&current.user_id, repository_id.as_deref())
        .await?;
    for merged in &refresh.newly_merged {
        cleanup.on_merged(merged, &current.user_id).await;
    }
    let changed = refresh.changed;
    for w in &changed {
        board.notify_changed(&w.repository_id);
    }
    if !changed.is_empty() {
        sync_state.request_sync();
    }
    Ok(changed)
}

/// "Discard worktree": stop everything running for the task, remove its
/// worktree and branch, and close it. The row and its notes are kept.
#[tauri::command]
pub async fn discard_workspace(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    review: State<'_, ReviewService>,
    checks: State<'_, CheckService>,
    runs: State<'_, RunCommandRuntime>,
    orchestrator: State<'_, TaskOrchestrator>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, ReviewCmdError> {
    let current = require_user(&session)?;
    // Ownership — and discardability — before any side effect: refusing the
    // repository's own checkout AFTER stopping its agent, run commands and
    // checks would still have killed them.
    let workspace = workspaces.get_for_user(&workspace_id, &current.user_id).await?;
    ReviewService::ensure_discardable(&workspace)?;
    watchers.stop(&workspace_id);
    // Row → stopped BEFORE the kill (see `quiesce_task`), so the exit isn't
    // reported as an agent failure.
    orchestrator.quiesce_task(&workspace_id).await;
    runs.stop_for_workspace(&workspace_id);
    // Checks run IN the worktree about to be removed: let them die first.
    checks
        .cancel_and_wait(&workspace_id, std::time::Duration::from_secs(5))
        .await;
    let closed = review.discard(&workspace, &current.user_id).await?;
    if let Some(path) = workspace.worktree_path.as_deref() {
        checks.forget_worktree(std::path::Path::new(path));
    }
    board.notify_changed(&closed.repository_id);
    sync_state.request_sync();
    Ok(closed)
}
