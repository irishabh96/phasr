//! Closing out a task: approve → push → pull request (via `gh`, or the
//! browser compare URL), merge locally, or discard — and recording how it
//! ended (`outcome`, `pr_*`) so the Board files it under Done.
//!
//! Tauri-agnostic; `commands::review` wraps it.

pub mod cleanup;
pub mod gh;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::checks::{CheckError, CheckService};
use crate::domain::{CheckRun, CheckStatus, Repository, TaskOutcome, Workspace, WorkspaceKind};
use crate::git::{self, GitError, MergeOutcome, MergeStrategy};
use crate::orchestrator::RepoLockRegistry;
use crate::pty::TaskRuntime;
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};

#[derive(Debug, Error)]
pub enum ReviewError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Checks(#[from] CheckError),
    #[error(transparent)]
    Gh(#[from] gh::GhError),
    /// The frontend matches the prefix to offer "Approve anyway".
    #[error("required checks not passing: {}", .0.join(", "))]
    ChecksNotPassing(Vec<String>),
    #[error("this task has no branch yet")]
    NoBranch,
    #[error("this task has no worktree on this machine")]
    NoWorktree,
    #[error("repository has no local path on this machine")]
    NoRepositoryPath,
    #[error("repository has no `origin` remote configured")]
    NoRemote,
    #[error("couldn't derive a pull-request URL from remote `{0}`")]
    UnknownHost(String),
    /// Approve pushes the BRANCH; uncommitted work would be left out of the
    /// PR while checks/review (which include the worktree) vouched for it.
    /// The frontend matches this exact string to offer "Commit & push".
    #[error("worktree has uncommitted changes")]
    DirtyWorktree,
    /// The worktree's HEAD isn't the task's branch (the agent switched):
    /// committing there and pushing / merging the recorded branch would
    /// close out something other than what was checked and reviewed.
    #[error("the task's worktree is on `{actual}`, not its branch `{expected}` — switch back to `{expected}` first")]
    BranchMismatch { expected: String, actual: String },
    /// Merging checks the target branch out in the repository's own
    /// checkout — the very directory an in-place agent is working in.
    #[error("an in-place agent is running in this repository's checkout; stop it before merging locally")]
    InPlaceAgentRunning,
    #[error("the repository's own checkout can't be discarded")]
    LocalNotDiscardable,
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for ReviewError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveInput {
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    /// Open the PR even though required checks aren't passing.
    #[serde(default)]
    pub override_checks: Option<bool>,
    /// The worktree has uncommitted (incl. untracked) changes: commit them
    /// all (message = the task's name) before pushing. Without it a dirty
    /// worktree is refused with "worktree has uncommitted changes".
    #[serde(default)]
    pub commit_dirty: Option<bool>,
}

/// The two confirmations closing a task out can need, for Approve and for
/// Merge locally alike. Both are evaluated before anything happens, and
/// both may be given at once — the UI adds each as the user confirms it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CloseOutFlags {
    /// Go ahead although required checks aren't passing.
    pub override_checks: bool,
    /// Commit the worktree's uncommitted changes (message = the task's
    /// name) first.
    pub commit_dirty: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestOutcome {
    /// The PR (`via_gh`) or the browser compare page to open one.
    pub url: String,
    pub number: Option<i64>,
    /// `true` = `gh` created (or found) the PR; `false` = open `url` to
    /// create it by hand.
    pub via_gh: bool,
    pub draft: bool,
}

/// The PR description: the agent's own summary of what it did, then the
/// checks as a task list. Overridden (failing / stale) checks say so.
pub fn pr_body(
    summary: Option<&str>,
    runs: &[CheckRun],
    current_fingerprint: Option<&str>,
) -> String {
    let mut out = String::new();
    if let Some(summary) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str(summary);
        out.push_str("\n\n");
    }
    if !runs.is_empty() {
        out.push_str("### Checks\n\n");
        for run in runs {
            let stale =
                current_fingerprint.is_none() || run.fingerprint.as_deref() != current_fingerprint;
            let (mark, what) = match run.status {
                CheckStatus::Passed => ("x", "passed".to_string()),
                CheckStatus::Failed => (
                    " ",
                    match run.exit_code {
                        Some(code) => format!("failed (exit {code})"),
                        None => "failed".into(),
                    },
                ),
                CheckStatus::Timeout => (" ", "timed out".into()),
                CheckStatus::Cancelled => (" ", "cancelled".into()),
                CheckStatus::Error => (" ", "couldn't run".into()),
                CheckStatus::Queued | CheckStatus::Running => (" ", "still running".into()),
            };
            let duration = run
                .duration_ms
                .filter(|_| matches!(run.status, CheckStatus::Passed | CheckStatus::Failed))
                .map(|ms| format!(" in {}", human_duration(ms)))
                .unwrap_or_default();
            let stale = if stale {
                " — on an earlier version of this branch"
            } else {
                ""
            };
            out.push_str(&format!(
                "- [{mark}] `{}` {what}{duration}{stale}\n",
                run.name
            ));
        }
        out.push('\n');
    }
    out.push_str("_Opened with Phasr._");
    out
}

fn human_duration(ms: i64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        format!("{}s", secs.max(1))
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

/// Result of a PR refresh pass.
#[derive(Debug, Default)]
pub struct PrRefresh {
    /// Every task whose PR state or outcome changed.
    pub changed: Vec<Workspace>,
    /// The subset that just became `merged`.
    pub newly_merged: Vec<Workspace>,
}

/// Closing-out operations over the stores, the per-repo git lock and the
/// check gate.
#[derive(Clone)]
pub struct ReviewService {
    workspaces: WorkspaceRepo,
    repositories: RepositoryRepo,
    repo_locks: Arc<RepoLockRegistry>,
    checks: CheckService,
    /// To see whether an in-place agent is live in the main checkout
    /// before a local merge checks a branch out under it.
    runtime: Option<Arc<TaskRuntime>>,
    /// One PR refresh at a time. The 5-minute loop and the window-focus
    /// refresh overlapped: both read the same open PRs, both recorded the
    /// outcome and both suggested cleanup. Serialized, the second one
    /// re-reads after the first and finds nothing left to do.
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
}

async fn blocking<T, F>(f: F) -> Result<T, ReviewError>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ReviewError::Other(format!("git task failed: {e}")))?
        .map_err(ReviewError::Git)
}

impl ReviewService {
    pub fn new(
        workspaces: WorkspaceRepo,
        repositories: RepositoryRepo,
        repo_locks: Arc<RepoLockRegistry>,
        checks: CheckService,
    ) -> Self {
        Self {
            workspaces,
            repositories,
            repo_locks,
            checks,
            runtime: None,
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn with_runtime(mut self, runtime: Arc<TaskRuntime>) -> Self {
        self.runtime = Some(runtime);
        self
    }

    /// Discard refuses the repository's own checkout. Exposed so the
    /// command can ask BEFORE it stops the agent, run commands and checks.
    pub fn ensure_discardable(ws: &Workspace) -> Result<(), ReviewError> {
        if ws.workspace_kind == WorkspaceKind::Local {
            return Err(ReviewError::LocalNotDiscardable);
        }
        Ok(())
    }

    /// An agent is running in place (on the `local` row, in the main
    /// checkout) for this repository right now.
    async fn in_place_agent_running(&self, repository_id: &str) -> Result<bool, ReviewError> {
        let Some(runtime) = self.runtime.as_ref() else {
            return Ok(false);
        };
        let Some(local) = self
            .workspaces
            .get_local_by_repository(repository_id)
            .await?
        else {
            return Ok(false);
        };
        Ok(local.agent.is_some()
            && local.status == crate::domain::WorkspaceStatus::Running
            && runtime.get(&local.id).is_some())
    }

    fn worktree(ws: &Workspace) -> Result<PathBuf, ReviewError> {
        ws.worktree_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .ok_or(ReviewError::NoWorktree)
    }

    /// The branch a task merges into / opens its PR against: the base it
    /// was cut from, else the repository's default (resolved against the
    /// checkout so a `main`-configured master repo still works — never the
    /// checkout's current branch). Blocking (git): call off the runtime.
    pub fn base_of(ws: &Workspace, repository: &Repository) -> String {
        ws.base_branch.clone().unwrap_or_else(|| {
            git::resolve_base_branch(repository.local_path.as_deref(), &repository.default_branch)
        })
    }

    /// `base_of`, off the async runtime.
    pub async fn base_branch(ws: &Workspace, repository: &Repository) -> String {
        if let Some(base) = ws.base_branch.clone() {
            return base;
        }
        let fallback = repository.default_branch.clone();
        let (ws, repository) = (ws.clone(), repository.clone());
        tokio::task::spawn_blocking(move || Self::base_of(&ws, &repository))
            .await
            .unwrap_or(fallback)
    }

    /// What closing a task out (Approve, Merge locally) requires of its
    /// worktree before acting on its branch, all evaluated before anything
    /// changes:
    /// - HEAD is the task's branch — what's pushed / merged is the BRANCH,
    ///   while the checks vouch for HEAD;
    /// - required checks pass on the worktree as it is, unless
    ///   `override_checks`;
    /// - it has no uncommitted changes, unless `commit_dirty` — then they
    ///   are committed (message = the task's name) once both gates pass.
    ///
    /// Checks are reported before dirtiness. The fingerprint is the
    /// worktree's CONTENT, so committing doesn't make a passing run stale.
    async fn close_out_gate(
        &self,
        ws: &Workspace,
        user_id: &str,
        cwd: &Path,
        branch: &str,
        flags: CloseOutFlags,
    ) -> Result<(), ReviewError> {
        let head = {
            let cwd = cwd.to_path_buf();
            blocking(move || git::current_branch(&cwd)).await?
        };
        if head.as_deref() != Some(branch) {
            return Err(ReviewError::BranchMismatch {
                expected: branch.to_string(),
                actual: head.unwrap_or_else(|| "a detached HEAD".into()),
            });
        }
        let failing = self.checks.unsatisfied_required(ws, user_id).await?;
        let dirty = {
            let cwd = cwd.to_path_buf();
            blocking(move || git::is_dirty(&cwd)).await?
        };
        if !failing.is_empty() && !flags.override_checks {
            return Err(ReviewError::ChecksNotPassing(failing));
        }
        if dirty && !flags.commit_dirty {
            return Err(ReviewError::DirtyWorktree);
        }
        if dirty {
            let (cwd, message) = (cwd.to_path_buf(), ws.name.clone());
            blocking(move || {
                git::stage(&cwd, &[])?;
                git::commit(&cwd, &message)?;
                Ok(())
            })
            .await?;
        }
        Ok(())
    }

    /// Gate (see `close_out_gate`) → push → `gh pr create` (or the compare
    /// URL) → record the PR on the task. `summary` = the agent's last
    /// message.
    pub async fn approve_and_create_pr(
        &self,
        ws: &Workspace,
        user_id: &str,
        input: ApproveInput,
        summary: Option<String>,
    ) -> Result<PullRequestOutcome, ReviewError> {
        let branch = ws.branch.clone().ok_or(ReviewError::NoBranch)?;
        let cwd = Self::worktree(ws)?;
        let repository = self
            .repositories
            .get_for_user(&ws.repository_id, user_id)
            .await?;
        let flags = CloseOutFlags {
            override_checks: input.override_checks.unwrap_or(false),
            commit_dirty: input.commit_dirty.unwrap_or(false),
        };
        self.close_out_gate(ws, user_id, &cwd, &branch, flags)
            .await?;
        {
            let (cwd, branch) = (cwd.clone(), branch.clone());
            blocking(move || git::push(&cwd, "origin", &branch)).await?;
        }
        let remote_url = match repository.remote_url.clone() {
            Some(url) => url,
            None => {
                let cwd = cwd.clone();
                blocking(move || Ok(git::get_remote_url(&cwd)))
                    .await?
                    .ok_or(ReviewError::NoRemote)?
            }
        };
        let base = Self::base_branch(ws, &repository).await;
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(&ws.name)
            .to_string();
        let body = match input
            .body
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
        {
            Some(body) => body.to_string(),
            None => {
                let runs = self
                    .checks
                    .latest_runs(ws, user_id)
                    .await
                    .unwrap_or_default();
                let current = self.checks.fingerprint(&cwd).await;
                pr_body(summary.as_deref(), &runs, current.as_deref())
            }
        };
        let draft = input.draft.unwrap_or(false);

        if let (Some((host, owner, repo)), Some(gh_bin)) =
            (git::parse_remote_url(&remote_url), gh::find_gh().await)
        {
            if gh::authenticated(&gh_bin, &host).await {
                let created = gh::create_pr(
                    &gh_bin,
                    &cwd,
                    &gh::CreatePr {
                        host: &host,
                        owner: &owner,
                        repo: &repo,
                        base: &base,
                        head: &branch,
                        title: &title,
                        body: &body,
                        draft,
                    },
                )
                .await?;
                // An existing PR keeps its own draft-ness; we don't know it
                // until the next refresh, so report what was asked.
                let state = if draft { "draft" } else { "open" };
                self.workspaces
                    .set_pull_request(&ws.id, created.number, Some(&created.url), Some(state))
                    .await?;
                return Ok(PullRequestOutcome {
                    url: created.url,
                    number: created.number,
                    via_gh: true,
                    draft,
                });
            }
        }

        // No usable gh: hand back the compare page. Nothing is recorded —
        // no PR exists until the user submits that page.
        let target = git::build_pull_request_target(&remote_url, &base, &branch)
            .ok_or_else(|| ReviewError::UnknownHost(remote_url.clone()))?;
        Ok(PullRequestOutcome {
            url: target.url,
            number: None,
            via_gh: false,
            draft: false,
        })
    }

    /// Re-read open/draft PRs with `gh`; a merged PR finishes the task
    /// (`merged` into its base), a closed one closes it. Returns the tasks
    /// that changed. Without a signed-in `gh` this is a no-op.
    ///
    /// Also names the tasks whose outcome just became `merged`
    /// (cleanup-after-merge runs for exactly those).
    pub async fn refresh_pr_states_detailed(
        &self,
        user_id: &str,
        repository_id: Option<&str>,
    ) -> Result<PrRefresh, ReviewError> {
        let _single_flight = self.refresh_lock.lock().await;
        let tasks: Vec<Workspace> = self
            .workspaces
            .list_tasks_for_user(user_id, repository_id)
            .await?
            .into_iter()
            .filter(|t| {
                t.pr_url.is_some()
                    && matches!(t.pr_state.as_deref(), None | Some("open") | Some("draft"))
            })
            .collect();
        if tasks.is_empty() {
            return Ok(PrRefresh::default());
        }
        let Some(gh_bin) = gh::find_gh().await else {
            return Ok(PrRefresh::default());
        };
        let mut changed = Vec::new();
        let mut newly_merged = Vec::new();
        for task in tasks {
            let Some(url) = task.pr_url.as_deref() else {
                continue;
            };
            let view = match gh::view_pr(&gh_bin, url).await {
                Ok(view) => view,
                // One unreachable PR (deleted repo, revoked access) must not
                // stop the others refreshing.
                Err(err) => {
                    eprintln!("refresh of {url} failed: {err}");
                    continue;
                }
            };
            let state = view.pr_state();
            let mut updated = None;
            if task.pr_state.as_deref() != Some(state) {
                updated = Some(
                    self.workspaces
                        .set_pull_request(&task.id, task.pr_number, Some(url), Some(state))
                        .await?,
                );
            }
            if task.outcome.is_none() && matches!(state, "merged" | "closed") {
                let base = match task.base_branch.clone() {
                    Some(base) => base,
                    None => {
                        self.repositories
                            .get(&task.repository_id)
                            .await?
                            .default_branch
                    }
                };
                let (outcome, into) = if state == "merged" {
                    (TaskOutcome::Merged, Some(base.as_str()))
                } else {
                    (TaskOutcome::Closed, None)
                };
                // Only if still unset: a Discard (Closed) or a local merge
                // that landed while `gh` was answering wins.
                if let Some(row) = self
                    .workspaces
                    .set_outcome_if_unset(&task.id, outcome, into)
                    .await?
                {
                    if outcome == TaskOutcome::Merged {
                        newly_merged.push(row.clone());
                    }
                    updated = Some(row);
                }
            }
            if let Some(w) = updated {
                changed.push(w);
            }
        }
        Ok(PrRefresh {
            changed,
            newly_merged,
        })
    }

    /// Merge the task's branch into `target` (default: its base) in the
    /// repository's main checkout, under the repo lock — gated like Approve
    /// (`close_out_gate`: branch, required checks, uncommitted work) when
    /// the task's worktree is still here. A clean merge records the
    /// `merged` outcome against the branch it actually landed on; conflicts
    /// are left in the checkout (finishing them via `git_continue_merge`
    /// records it too — see `record_continued_merge`).
    pub async fn merge_locally(
        &self,
        ws: &Workspace,
        user_id: &str,
        strategy: MergeStrategy,
        target: Option<String>,
        flags: CloseOutFlags,
    ) -> Result<MergeOutcome, ReviewError> {
        let branch = ws.branch.clone().ok_or(ReviewError::NoBranch)?;
        let repository = self
            .repositories
            .get_for_user(&ws.repository_id, user_id)
            .await?;
        let main_repo = repository
            .local_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or(ReviewError::NoRepositoryPath)?;
        match Self::worktree(ws) {
            Ok(cwd) => {
                self.close_out_gate(ws, user_id, &cwd, &branch, flags)
                    .await?
            }
            // No worktree left to vouch for: only the check gate applies
            // (with nothing to fingerprint, a required check can't pass).
            Err(_) => {
                let failing = self.checks.unsatisfied_required(ws, user_id).await?;
                if !failing.is_empty() && !flags.override_checks {
                    return Err(ReviewError::ChecksNotPassing(failing));
                }
            }
        }
        let target = match target {
            Some(target) => target,
            None => Self::base_branch(ws, &repository).await,
        };
        // Checks out `target` in the SHARED main checkout: serialize against
        // every worktree-add / branch-delete on this repo (F6).
        let lock = self.repo_locks.for_repository(&ws.repository_id);
        let guard = lock.lock().await;
        // Under the lock: an in-place start holds it through its spawn, so
        // the answer can't change before the checkout below.
        if self.in_place_agent_running(&ws.repository_id).await? {
            return Err(ReviewError::InPlaceAgentRunning);
        }
        let merged =
            blocking(move || git::merge_to(&main_repo, &target, &branch, strategy)).await?;
        drop(guard);
        if matches!(merged.outcome, MergeOutcome::Clean { .. })
            && ws.workspace_kind == WorkspaceKind::Agent
        {
            self.workspaces
                .set_outcome(&ws.id, Some(TaskOutcome::Merged), Some(&merged.into))
                .await?;
        }
        Ok(merged.outcome)
    }

    /// A paused merge was just finished cleanly in `checkout` (a `local`
    /// workspace = the repository's main checkout) where `merged_branches`
    /// were MERGE_HEAD and `target` the checked-out branch: mark the task
    /// whose branch that was as merged. Only for the main checkout and only
    /// into the task's own base — a sync-with-main inside a task worktree
    /// (merging main INTO a task) must never mark anything.
    pub async fn record_continued_merge(
        &self,
        checkout: &Workspace,
        user_id: &str,
        merged_branches: &[String],
        target: Option<&str>,
    ) -> Result<Vec<Workspace>, ReviewError> {
        let Some(target) = target else {
            return Ok(Vec::new());
        };
        if checkout.workspace_kind != WorkspaceKind::Local || merged_branches.is_empty() {
            return Ok(Vec::new());
        }
        let repository = self
            .repositories
            .get_for_user(&checkout.repository_id, user_id)
            .await?;
        let mut done = Vec::new();
        for task in self
            .workspaces
            .list_tasks_for_user(user_id, Some(&checkout.repository_id))
            .await?
        {
            let Some(branch) = task.branch.as_deref() else {
                continue;
            };
            if task.outcome.is_some() || !merged_branches.iter().any(|b| b == branch) {
                continue;
            }
            if Self::base_branch(&task, &repository).await != target {
                continue;
            }
            // Conditional: a Discard or a PR refresh may have recorded it
            // since the list above was read.
            if let Some(row) = self
                .workspaces
                .set_outcome_if_unset(&task.id, TaskOutcome::Merged, Some(target))
                .await?
            {
                done.push(row);
            }
        }
        Ok(done)
    }

    /// Throw the task's work away: remove its worktree and force-delete its
    /// branch (under the repo lock), and close it. The row, its notes and
    /// its history stay — the Board shows "closed without merge". Callers
    /// stop the agent, run commands and checks first.
    pub async fn discard(&self, ws: &Workspace, user_id: &str) -> Result<Workspace, ReviewError> {
        Self::ensure_discardable(ws)?;
        let repository = self
            .repositories
            .get_for_user(&ws.repository_id, user_id)
            .await?;
        if let Some(repo_path) = repository.local_path.as_deref().map(PathBuf::from) {
            let lock = self.repo_locks.for_repository(&ws.repository_id);
            let _guard = lock.lock().await;
            let worktree = ws.worktree_path.clone();
            let branch = ws.branch.clone();
            blocking(move || {
                if let Some(worktree) = worktree.as_deref() {
                    git::remove_worktree(&repo_path, Path::new(worktree))?;
                }
                if let Some(branch) = branch.as_deref() {
                    git::branch_delete(&repo_path, branch)?;
                }
                Ok(())
            })
            .await?;
        }
        Ok(self
            .workspaces
            .set_outcome(&ws.id, Some(TaskOutcome::Closed), None)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{init_pool, AppMetaRepo, CheckRunRepo, RunCommandRepo};
    use chrono::Utc;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn run(name: &str, status: CheckStatus, fp: &str, ms: i64, exit: Option<i64>) -> CheckRun {
        CheckRun {
            id: name.into(),
            workspace_id: "ws".into(),
            run_command_id: Some(name.into()),
            name: name.into(),
            command: name.into(),
            status,
            exit_code: exit,
            fingerprint: Some(fp.into()),
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            duration_ms: Some(ms),
            output_tail: String::new(),
            log_path: None,
        }
    }

    #[test]
    fn pr_body_has_summary_and_checks() {
        let runs = [
            run("test", CheckStatus::Passed, "fp", 12_400, Some(0)),
            run("lint", CheckStatus::Failed, "fp", 3_000, Some(1)),
            run("e2e", CheckStatus::Passed, "old", 95_000, Some(0)),
        ];
        assert_eq!(
            pr_body(Some("Fixed the login redirect.\n"), &runs, Some("fp")),
            "Fixed the login redirect.\n\n### Checks\n\n\
             - [x] `test` passed in 12s\n\
             - [ ] `lint` failed (exit 1) in 3s\n\
             - [x] `e2e` passed in 1m 35s — on an earlier version of this branch\n\n\
             _Opened with Phasr._"
        );
        assert_eq!(pr_body(None, &[], None), "_Opened with Phasr._");
    }

    struct Fx {
        review: ReviewService,
        workspaces: WorkspaceRepo,
        run_commands: RunCommandRepo,
        repo_path: PathBuf,
        repository: Repository,
        _dir: tempfile::TempDir,
    }

    async fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES ('u', 'u', 'n', 'u@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let repo_path = dir.path().join("repo");
        std::fs::create_dir_all(&repo_path).unwrap();
        git(&repo_path, &["init", "-q", "-b", "main"]);
        git(&repo_path, &["config", "user.email", "t@example.com"]);
        git(&repo_path, &["config", "user.name", "t"]);
        std::fs::write(repo_path.join("a.txt"), "a\n").unwrap();
        git(&repo_path, &["add", "-A"]);
        git(&repo_path, &["commit", "-qm", "init"]);

        let repositories = RepositoryRepo::new(pool.clone());
        let mut repository = Repository::new(
            "r".into(),
            Some(repo_path.to_string_lossy().into_owned()),
            None,
        );
        repository.default_branch = "main".into();
        repositories
            .insert_for_user(&repository, "u")
            .await
            .unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let checks = CheckService::new(
            CheckRunRepo::new(pool.clone()),
            RunCommandRepo::new(pool.clone()),
            workspaces.clone(),
            AppMetaRepo::new(pool.clone()),
            dir.path().join("logs"),
        );
        let review = ReviewService::new(
            workspaces.clone(),
            repositories,
            Arc::new(RepoLockRegistry::new()),
            checks,
        );
        Fx {
            review,
            workspaces,
            run_commands: RunCommandRepo::new(pool),
            repo_path,
            repository,
            _dir: dir,
        }
    }

    async fn task_with_worktree(f: &Fx, name: &str) -> Workspace {
        let mut ws = Workspace::new(f.repository.id.clone(), name.into(), "c".into());
        let branch = format!("phasr/{name}");
        let wt = f.repo_path.parent().unwrap().join(format!("wt-{name}"));
        git::create_worktree(&f.repo_path, &wt, &branch, "main").unwrap();
        std::fs::write(wt.join(format!("{name}.txt")), "work\n").unwrap();
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-qm", name]);
        ws.branch = Some(branch);
        ws.worktree_path = Some(wt.to_string_lossy().into_owned());
        ws.base_branch = Some("main".into());
        ws.status = crate::domain::WorkspaceStatus::Stopped;
        f.workspaces.insert_for_user(&ws, "u").await.unwrap();
        ws
    }

    fn branch_exists(repo: &Path, branch: &str) -> bool {
        Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .current_dir(repo)
            .status()
            .unwrap()
            .success()
    }

    #[tokio::test]
    async fn discard_keeps_the_row_removes_worktree_and_branch_and_closes() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "throwaway").await;
        let wt = PathBuf::from(ws.worktree_path.clone().unwrap());
        assert!(wt.exists() && branch_exists(&f.repo_path, "phasr/throwaway"));

        let closed = f.review.discard(&ws, "u").await.unwrap();
        assert_eq!(closed.outcome, Some(TaskOutcome::Closed));
        assert!(closed.outcome_at.is_some());
        assert!(!wt.exists(), "worktree removed");
        assert!(
            !branch_exists(&f.repo_path, "phasr/throwaway"),
            "branch force-deleted"
        );
        // The row (and everything hanging off it, e.g. notes) stays.
        let row = f.workspaces.get_for_user(&ws.id, "u").await.unwrap();
        assert_eq!(row.name, "throwaway");
        // Another account can't discard it.
        assert!(f.review.discard(&ws, "someone-else").await.is_err());
    }

    #[tokio::test]
    async fn merge_locally_records_merged_into_base_on_a_clean_merge() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "feature").await;
        let outcome = f
            .review
            .merge_locally(
                &ws,
                "u",
                MergeStrategy::Merge,
                None,
                CloseOutFlags::default(),
            )
            .await
            .unwrap();
        assert!(matches!(outcome, MergeOutcome::Clean { .. }));
        let row = f.workspaces.get(&ws.id).await.unwrap();
        assert_eq!(row.outcome, Some(TaskOutcome::Merged));
        assert_eq!(row.merged_into.as_deref(), Some("main"));
        assert!(f.repo_path.join("feature.txt").exists());
    }

    /// The one local-merge path merges into the TASK's base (not the
    /// repository default) and records it there.
    #[tokio::test]
    async fn merge_locally_targets_the_tasks_own_base_branch() {
        let f = fx().await;
        git(&f.repo_path, &["branch", "develop"]);
        let mut ws = Workspace::new(f.repository.id.clone(), "on-develop".into(), "c".into());
        let wt = f.repo_path.parent().unwrap().join("wt-on-develop");
        git::create_worktree(&f.repo_path, &wt, "phasr/on-develop", "develop").unwrap();
        std::fs::write(wt.join("d.txt"), "d\n").unwrap();
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-qm", "d"]);
        ws.branch = Some("phasr/on-develop".into());
        ws.worktree_path = Some(wt.to_string_lossy().into_owned());
        ws.base_branch = Some("develop".into());
        f.workspaces.insert_for_user(&ws, "u").await.unwrap();

        let outcome = f
            .review
            .merge_locally(
                &ws,
                "u",
                MergeStrategy::Merge,
                None,
                CloseOutFlags::default(),
            )
            .await
            .unwrap();
        assert!(matches!(outcome, MergeOutcome::Clean { .. }));
        let row = f.workspaces.get(&ws.id).await.unwrap();
        assert_eq!(row.merged_into.as_deref(), Some("develop"));
        let on_develop = Command::new("git")
            .args(["cat-file", "-e", "develop:d.txt"])
            .current_dir(&f.repo_path)
            .status()
            .unwrap();
        assert!(on_develop.success(), "merged into develop");
        let on_main = Command::new("git")
            .args(["cat-file", "-e", "main:d.txt"])
            .current_dir(&f.repo_path)
            .status()
            .unwrap();
        assert!(!on_main.success(), "main untouched");
    }

    /// "Merge locally" checks a branch out in the main checkout: refused
    /// while an in-place agent is live there.
    #[tokio::test]
    async fn merge_locally_refuses_while_an_in_place_agent_runs() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "busy").await;
        let mut local = Workspace::new(f.repository.id.clone(), "local".into(), "claude".into());
        local.workspace_kind = WorkspaceKind::Local;
        local.worktree_path = Some(f.repo_path.to_string_lossy().into_owned());
        local.agent = Some(crate::domain::Agent::Claude);
        local.status = crate::domain::WorkspaceStatus::Running;
        f.workspaces.insert_for_user(&local, "u").await.unwrap();
        let runtime = Arc::new(TaskRuntime::new(f.repo_path.parent().unwrap().join("logs")));
        let handle = runtime
            .spawn(
                crate::pty::SpawnSpec::new(local.id.clone(), f.repo_path.clone())
                    .with_shell(Some("/bin/sh".into())),
            )
            .unwrap();
        let review = f.review.clone().with_runtime(runtime.clone());

        let err = review
            .merge_locally(
                &ws,
                "u",
                MergeStrategy::Merge,
                None,
                CloseOutFlags::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ReviewError::InPlaceAgentRunning), "{err}");
        assert!(!f.repo_path.join("busy.txt").exists(), "nothing was merged");

        handle.kill().unwrap();
        runtime.drop_task(&local.id);
        assert!(review
            .merge_locally(
                &ws,
                "u",
                MergeStrategy::Merge,
                None,
                CloseOutFlags::default()
            )
            .await
            .is_ok());
    }

    #[test]
    fn the_main_checkout_is_never_discardable() {
        let mut local = Workspace::new("r".into(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        assert!(matches!(
            ReviewService::ensure_discardable(&local),
            Err(ReviewError::LocalNotDiscardable)
        ));
        let task = Workspace::new("r".into(), "t".into(), "c".into());
        assert!(ReviewService::ensure_discardable(&task).is_ok());
    }

    #[tokio::test]
    async fn a_continued_merge_marks_only_the_matching_task_in_the_main_checkout() {
        let f = fx().await;
        let a = task_with_worktree(&f, "a").await;
        let b = task_with_worktree(&f, "b").await;
        let mut local = Workspace::new(f.repository.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        local.worktree_path = Some(f.repo_path.to_string_lossy().into_owned());
        f.workspaces.insert_for_user(&local, "u").await.unwrap();

        let done = f
            .review
            .record_continued_merge(&local, "u", &["phasr/a".into()], Some("main"))
            .await
            .unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(
            f.workspaces.get(&a.id).await.unwrap().outcome,
            Some(TaskOutcome::Merged)
        );
        assert_eq!(f.workspaces.get(&b.id).await.unwrap().outcome, None);
        // Inside a task worktree (sync-with-main), nothing is recorded.
        assert!(f
            .review
            .record_continued_merge(&b, "u", &["phasr/b".into()], Some("phasr/b"))
            .await
            .unwrap()
            .is_empty());
        // Merging into a branch that isn't the task's base doesn't count.
        assert!(f
            .review
            .record_continued_merge(&local, "u", &["phasr/b".into()], Some("release"))
            .await
            .unwrap()
            .is_empty());
    }

    /// Approve pushes the branch, so uncommitted work would silently miss
    /// the PR: refused unless `commitDirty`, which commits everything
    /// (untracked included) under the task's name, then pushes.
    #[tokio::test]
    async fn approve_refuses_a_dirty_worktree_unless_asked_to_commit_it() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "dirty").await;
        let wt = PathBuf::from(ws.worktree_path.clone().unwrap());
        let origin = f.repo_path.parent().unwrap().join("origin.git");
        git(
            f.repo_path.parent().unwrap(),
            &["init", "-q", "--bare", origin.to_str().unwrap()],
        );
        git(&wt, &["remote", "add", "origin", origin.to_str().unwrap()]);
        std::fs::write(wt.join("untracked.txt"), "agent output\n").unwrap();

        let err = f
            .review
            .approve_and_create_pr(&ws, "u", ApproveInput::default(), None)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "worktree has uncommitted changes");
        // Nothing was pushed.
        let pushed = Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", "refs/heads/phasr/dirty"])
            .current_dir(&origin)
            .status()
            .unwrap();
        assert!(!pushed.success());

        // With commitDirty: committed (message = task name) and pushed.
        // (It then fails deriving a PR URL from a local-path remote.)
        let _ = f
            .review
            .approve_and_create_pr(
                &ws,
                "u",
                ApproveInput {
                    commit_dirty: Some(true),
                    ..Default::default()
                },
                None,
            )
            .await;
        assert!(!git::is_dirty(&wt).unwrap(), "everything committed");
        let subject = Command::new("git")
            .args(["log", "-1", "--format=%s", "phasr/dirty"])
            .current_dir(&origin)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&subject.stdout).trim(),
            "dirty",
            "pushed with the task's name"
        );
        let files = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", "phasr/dirty"])
            .current_dir(&origin)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&files.stdout).contains("untracked.txt"));
    }

    #[tokio::test]
    async fn approve_is_gated_on_required_checks() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "gated").await;
        let mut rc =
            crate::domain::RunCommand::new(f.repository.id.clone(), "test".into(), "true".into());
        rc.required_for_approve = true;
        f.run_commands.insert_for_user(&rc, "u").await.unwrap();
        let err = f
            .review
            .approve_and_create_pr(&ws, "u", ApproveInput::default(), None)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "required checks not passing: test");
        // Overridden, it gets past the gate (and then fails on the missing
        // remote — this repo has no `origin`).
        let err = f
            .review
            .approve_and_create_pr(
                &ws,
                "u",
                ApproveInput {
                    override_checks: Some(true),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap_err();
        assert!(!err.to_string().starts_with("required checks"), "{err}");
    }

    fn with_origin(f: &Fx, ws: &Workspace) -> (PathBuf, PathBuf) {
        let wt = PathBuf::from(ws.worktree_path.clone().unwrap());
        let origin = f
            .repo_path
            .parent()
            .unwrap()
            .join(format!("origin-{}.git", ws.name));
        git(
            f.repo_path.parent().unwrap(),
            &["init", "-q", "--bare", origin.to_str().unwrap()],
        );
        git(&wt, &["remote", "add", "origin", origin.to_str().unwrap()]);
        (wt, origin)
    }

    fn pushed(origin: &Path, branch: &str) -> bool {
        Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .current_dir(origin)
            .status()
            .unwrap()
            .success()
    }

    async fn require_check(f: &Fx, command: &str) -> crate::domain::RunCommand {
        let mut rc =
            crate::domain::RunCommand::new(f.repository.id.clone(), "test".into(), command.into());
        rc.required_for_approve = true;
        f.run_commands.insert_for_user(&rc, "u").await.unwrap();
        rc
    }

    fn approve(override_checks: bool, commit_dirty: bool) -> ApproveInput {
        ApproveInput {
            override_checks: Some(override_checks),
            commit_dirty: Some(commit_dirty),
            ..Default::default()
        }
    }

    /// Second review #4: the gate was checked before dirtiness, and each
    /// retry sent only the flag for the LAST refusal — a loop. Both are
    /// evaluated up front, nothing happens until both are answered, and
    /// the two flags work together.
    #[tokio::test]
    async fn approve_evaluates_checks_and_dirtiness_together() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "both").await;
        require_check(&f, "true").await;
        let (wt, origin) = with_origin(&f, &ws);
        std::fs::write(wt.join("wip.txt"), "wip\n").unwrap();

        let err = f
            .review
            .approve_and_create_pr(&ws, "u", approve(false, false), None)
            .await
            .unwrap_err();
        assert!(
            err.to_string().starts_with("required checks not passing"),
            "{err}"
        );
        let err = f
            .review
            .approve_and_create_pr(&ws, "u", approve(false, true), None)
            .await
            .unwrap_err();
        assert!(
            err.to_string().starts_with("required checks not passing"),
            "{err}"
        );
        let err = f
            .review
            .approve_and_create_pr(&ws, "u", approve(true, false), None)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "worktree has uncommitted changes");
        assert!(
            git::is_dirty(&wt).unwrap(),
            "nothing committed while a gate was unanswered"
        );
        assert!(!pushed(&origin, "phasr/both"), "nothing pushed");

        // Both answered: committed and pushed (then the PR URL can't be
        // derived from a local-path remote).
        let _ = f
            .review
            .approve_and_create_pr(&ws, "u", approve(true, true), None)
            .await;
        assert!(!git::is_dirty(&wt).unwrap());
        assert!(pushed(&origin, "phasr/both"));
    }

    /// New #5: Approve pushes `ws.branch` while checks vouch for HEAD. If
    /// the agent switched branches, refuse rather than commit there and
    /// push something else.
    #[tokio::test]
    async fn approve_refuses_when_the_worktree_is_not_on_the_tasks_branch() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "moved").await;
        let (wt, origin) = with_origin(&f, &ws);
        git(&wt, &["checkout", "-qb", "agent-side-quest"]);
        std::fs::write(wt.join("x.txt"), "x\n").unwrap();

        let err = f
            .review
            .approve_and_create_pr(&ws, "u", approve(true, true), None)
            .await
            .unwrap_err();
        assert!(matches!(err, ReviewError::BranchMismatch { .. }), "{err}");
        assert!(err.to_string().contains("`agent-side-quest`"), "{err}");
        assert!(
            git::is_dirty(&wt).unwrap(),
            "nothing committed on the wrong branch"
        );
        assert!(!pushed(&origin, "phasr/moved"));
        // Merge locally refuses too.
        let both = CloseOutFlags {
            override_checks: true,
            commit_dirty: true,
        };
        let err = f
            .review
            .merge_locally(&ws, "u", MergeStrategy::Merge, None, both)
            .await
            .unwrap_err();
        assert!(matches!(err, ReviewError::BranchMismatch { .. }), "{err}");
    }

    /// Merge locally skipped required checks; now it's gated like Approve,
    /// with the same prefix and the same override.
    #[tokio::test]
    async fn merge_locally_is_gated_like_approve() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "gated-merge").await;
        require_check(&f, "true").await;
        let err = f
            .review
            .merge_locally(
                &ws,
                "u",
                MergeStrategy::Merge,
                None,
                CloseOutFlags::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "required checks not passing: test");
        assert!(
            !f.repo_path.join("gated-merge.txt").exists(),
            "nothing merged"
        );

        let wt = PathBuf::from(ws.worktree_path.clone().unwrap());
        std::fs::write(wt.join("late.txt"), "late\n").unwrap();
        let override_only = CloseOutFlags {
            override_checks: true,
            commit_dirty: false,
        };
        let err = f
            .review
            .merge_locally(&ws, "u", MergeStrategy::Merge, None, override_only)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "worktree has uncommitted changes");

        let both = CloseOutFlags {
            override_checks: true,
            commit_dirty: true,
        };
        let outcome = f
            .review
            .merge_locally(&ws, "u", MergeStrategy::Merge, None, both)
            .await
            .unwrap();
        assert!(matches!(outcome, MergeOutcome::Clean { .. }));
        assert!(
            f.repo_path.join("gated-merge.txt").exists() && f.repo_path.join("late.txt").exists()
        );
        assert_eq!(
            f.workspaces
                .get(&ws.id)
                .await
                .unwrap()
                .merged_into
                .as_deref(),
            Some("main")
        );
    }

    /// The merge lands on the base even when the main checkout is on
    /// another branch, and `merged_into` names where it landed.
    #[tokio::test]
    async fn merge_locally_lands_on_the_base_not_the_checked_out_branch() {
        let f = fx().await;
        let ws = task_with_worktree(&f, "elsewhere").await;
        git(&f.repo_path, &["checkout", "-qb", "user-wip"]);
        let outcome = f
            .review
            .merge_locally(
                &ws,
                "u",
                MergeStrategy::Merge,
                None,
                CloseOutFlags::default(),
            )
            .await
            .unwrap();
        assert!(matches!(outcome, MergeOutcome::Clean { .. }));
        let on = |rev: &str| {
            Command::new("git")
                .args(["cat-file", "-e", &format!("{rev}:elsewhere.txt")])
                .current_dir(&f.repo_path)
                .status()
                .unwrap()
                .success()
        };
        assert!(on("main") && !on("user-wip"));
        assert_eq!(
            f.workspaces
                .get(&ws.id)
                .await
                .unwrap()
                .merged_into
                .as_deref(),
            Some("main")
        );
    }

    /// A continued merge doesn't overwrite an outcome recorded meanwhile.
    #[tokio::test]
    async fn a_continued_merge_never_overwrites_a_recorded_outcome() {
        let f = fx().await;
        let a = task_with_worktree(&f, "closed-first").await;
        let mut local = Workspace::new(f.repository.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        f.workspaces.insert_for_user(&local, "u").await.unwrap();
        f.workspaces
            .set_outcome(&a.id, Some(TaskOutcome::Closed), None)
            .await
            .unwrap();
        let done = f
            .review
            .record_continued_merge(&local, "u", &["phasr/closed-first".into()], Some("main"))
            .await
            .unwrap();
        assert!(done.is_empty());
        assert_eq!(
            f.workspaces.get(&a.id).await.unwrap().outcome,
            Some(TaskOutcome::Closed)
        );
    }
}
