//! Cleanup after merge (Settings → Worktrees): once a task's outcome
//! becomes `merged`, its worktree and local branch are dead weight.
//! `always` removes them; `ask` drops a suggestion in the inbox; `never`
//! leaves them.
//!
//! Called from every place that records a `merged` outcome (merge to main,
//! a continued merge, merge locally, a PR seen merged by the refresh).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::checks::CheckService;
use crate::domain::{CleanupAfterMerge, TaskOutcome, Workspace, WorkspaceKind};
use crate::git;
use crate::notifications::NotificationService;
use crate::orchestrator::RepoLockRegistry;
use crate::pty::TaskRuntime;
use crate::run_commands::RunCommandRuntime;
use crate::store::{RepositoryConfigRepo, RepositoryRepo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupAction {
    /// Worktree and local branch removed.
    Removed,
    /// An inbox entry asks the user.
    Suggested,
    /// Nothing to do (policy `never`, not a merged agent task, no worktree).
    None,
}

/// What to do for a merged task. Pure.
///
/// `always` degrades to a suggestion the user can act on when removal
/// would hurt: an agent still running in the worktree is never pulled out
/// from under it, and removal (`worktree remove -f` + `branch -D`) never
/// destroys `unsaved_work` — uncommitted changes, or commits that are in
/// neither the merge target nor `origin` (e.g. pushed after the PR merged).
pub fn decide(
    policy: CleanupAfterMerge,
    has_worktree: bool,
    agent_running: bool,
    unsaved_work: bool,
) -> CleanupAction {
    if !has_worktree {
        return CleanupAction::None;
    }
    match policy {
        CleanupAfterMerge::Never => CleanupAction::None,
        CleanupAfterMerge::Ask => CleanupAction::Suggested,
        CleanupAfterMerge::Always if agent_running || unsaved_work => CleanupAction::Suggested,
        CleanupAfterMerge::Always => CleanupAction::Removed,
    }
}

#[derive(Clone)]
pub struct MergeCleanup {
    configs: RepositoryConfigRepo,
    repositories: RepositoryRepo,
    repo_locks: Arc<RepoLockRegistry>,
    runtime: Arc<TaskRuntime>,
    runs: Option<RunCommandRuntime>,
    checks: Option<CheckService>,
    notifier: Option<NotificationService>,
}

impl MergeCleanup {
    pub fn new(
        configs: RepositoryConfigRepo,
        repositories: RepositoryRepo,
        repo_locks: Arc<RepoLockRegistry>,
        runtime: Arc<TaskRuntime>,
    ) -> Self {
        Self {
            configs,
            repositories,
            repo_locks,
            runtime,
            runs: None,
            checks: None,
            notifier: None,
        }
    }

    /// Stop these before removing a worktree (both run processes in it).
    pub fn with_services(mut self, runs: RunCommandRuntime, checks: CheckService) -> Self {
        self.runs = Some(runs);
        self.checks = Some(checks);
        self
    }

    pub fn with_notifier(mut self, notifier: NotificationService) -> Self {
        self.notifier = Some(notifier);
        self
    }

    /// Apply the repository's policy to `task`, which was just recorded as
    /// merged. Never fails the caller's merge: problems are logged and
    /// reported as `None`.
    pub async fn on_merged(&self, task: &Workspace, user_id: &str) -> CleanupAction {
        if task.workspace_kind != WorkspaceKind::Agent || task.outcome != Some(TaskOutcome::Merged)
        {
            return CleanupAction::None;
        }
        let worktree = task
            .worktree_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.exists());
        let policy = match self.configs.get(&task.repository_id).await {
            Ok(config) => config.cleanup_after_merge,
            Err(err) => {
                eprintln!(
                    "cleanup after merge: config for {} unreadable: {err}",
                    task.repository_id
                );
                return CleanupAction::None;
            }
        };
        let running = self.runtime.get(&task.id).is_some();
        // Only `always` deletes anything, so only it pays for the probe.
        let unsaved = match (&worktree, policy) {
            (Some(worktree), CleanupAfterMerge::Always) => {
                self.has_unsaved_work(task, user_id, worktree).await
            }
            _ => false,
        };
        match decide(policy, worktree.is_some(), running, unsaved) {
            CleanupAction::None => CleanupAction::None,
            CleanupAction::Suggested => self.suggest(task, user_id).await,
            CleanupAction::Removed => {
                let Some(worktree) = worktree else {
                    return CleanupAction::None;
                };
                match self.remove(task, user_id, &worktree).await {
                    Ok(true) => CleanupAction::Removed,
                    // Work appeared (or an agent started) between the probe
                    // and the lock: ask instead.
                    Ok(false) => self.suggest(task, user_id).await,
                    Err(err) => {
                        eprintln!("cleanup after merge for {} failed: {err}", task.id);
                        CleanupAction::None
                    }
                }
            }
        }
    }

    async fn suggest(&self, task: &Workspace, user_id: &str) -> CleanupAction {
        match &self.notifier {
            Some(notifier) => match notifier.suggest_cleanup(user_id, task).await {
                Ok(_) => CleanupAction::Suggested,
                Err(err) => {
                    eprintln!("cleanup suggestion for {} failed: {err}", task.id);
                    CleanupAction::None
                }
            },
            None => CleanupAction::None,
        }
    }

    /// Uncommitted changes in the worktree, or commits on the task's branch
    /// kept neither in what it merged into (or its base) nor on `origin`.
    /// A probe that fails counts as "yes": never force-delete on a guess.
    async fn has_unsaved_work(&self, task: &Workspace, user_id: &str, worktree: &Path) -> bool {
        let Ok(repository) = self
            .repositories
            .get_for_user(&task.repository_id, user_id)
            .await
        else {
            return true;
        };
        let Some(repo_path) = repository.local_path.as_deref().map(PathBuf::from) else {
            return true;
        };
        let kept_in: Vec<String> = task
            .merged_into
            .iter()
            .chain(task.base_branch.iter())
            .cloned()
            .chain(std::iter::once(repository.default_branch.clone()))
            .collect();
        let (worktree, branch) = (worktree.to_path_buf(), task.branch.clone());
        tokio::task::spawn_blocking(move || {
            if git::is_dirty(&worktree).unwrap_or(true) {
                return true;
            }
            let Some(branch) = branch else { return false };
            let kept: Vec<&str> = kept_in.iter().map(String::as_str).collect();
            git::has_unsaved_commits(&repo_path, &branch, &kept).unwrap_or(true)
        })
        .await
        .unwrap_or(true)
    }

    /// Remove the worktree and branch, unless — re-checked under the repo
    /// lock, right before `worktree remove -f` — an agent is now running in
    /// it or it now holds unsaved work. The probe in `on_merged` ran
    /// outside the lock (and before stopping run commands / checks, which
    /// can write files): what it saw could be stale by now. `Ok(false)` =
    /// left alone.
    async fn remove(
        &self,
        task: &Workspace,
        user_id: &str,
        worktree: &Path,
    ) -> Result<bool, String> {
        let repository = self
            .repositories
            .get_for_user(&task.repository_id, user_id)
            .await
            .map_err(|e| e.to_string())?;
        let repo_path = repository
            .local_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or("repository has no local path")?;
        if let Some(runs) = &self.runs {
            runs.stop_for_workspace(&task.id);
        }
        if let Some(checks) = &self.checks {
            checks
                .cancel_and_wait(&task.id, Duration::from_secs(5))
                .await;
        }
        // Shared `.git` (worktree registry + refs): same lock as every other
        // worktree add/remove and branch delete on this repository.
        let lock = self.repo_locks.for_repository(&task.repository_id);
        let _guard = lock.lock().await;
        if self.runtime.get(&task.id).is_some()
            || self.has_unsaved_work(task, user_id, worktree).await
        {
            return Ok(false);
        }
        let (wt, branch) = (worktree.to_path_buf(), task.branch.clone());
        tokio::task::spawn_blocking(move || {
            git::remove_worktree(&repo_path, &wt)?;
            if let Some(branch) = branch.as_deref() {
                git::branch_delete(&repo_path, branch)?;
            }
            Ok::<(), git::GitError>(())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        if let Some(checks) = &self.checks {
            checks.forget_worktree(worktree);
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::{init_pool, NotificationRepo, WorkspaceRepo};
    use std::process::Command;

    #[test]
    fn decide_follows_the_policy_and_never_yanks_a_running_agent() {
        use CleanupAfterMerge::*;
        assert_eq!(decide(Always, true, false, false), CleanupAction::Removed);
        assert_eq!(decide(Always, true, true, false), CleanupAction::Suggested);
        assert_eq!(
            decide(Always, true, false, true),
            CleanupAction::Suggested,
            "unsaved work"
        );
        assert_eq!(decide(Ask, true, false, false), CleanupAction::Suggested);
        assert_eq!(decide(Never, true, false, true), CleanupAction::None);
        assert_eq!(
            decide(Always, false, false, false),
            CleanupAction::None,
            "nothing on disk"
        );
    }

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

    struct Fixture {
        _dir: tempfile::TempDir,
        repo_path: PathBuf,
        cleanup: MergeCleanup,
        configs: RepositoryConfigRepo,
        notifications: NotificationRepo,
        task: Workspace,
    }

    async fn fixture() -> Fixture {
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
        let worktree = dir.path().join("wt/task");
        git::create_worktree(&repo_path, &worktree, "phasr/task", "main").unwrap();

        let repositories = RepositoryRepo::new(pool.clone());
        let repo = Repository::new(
            "r".into(),
            Some(repo_path.to_string_lossy().into_owned()),
            None,
        );
        repositories.insert_for_user(&repo, "u").await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let mut task = Workspace::new(repo.id.clone(), "Fix it".into(), "c".into());
        task.branch = Some("phasr/task".into());
        task.worktree_path = Some(worktree.to_string_lossy().into_owned());
        workspaces.insert_for_user(&task, "u").await.unwrap();
        let task = workspaces
            .set_outcome(&task.id, Some(TaskOutcome::Merged), Some("main"))
            .await
            .unwrap();

        let configs = RepositoryConfigRepo::new(pool.clone());
        let notifications = NotificationRepo::new(pool.clone());
        let notifier = NotificationService::new(notifications.clone(), workspaces.clone(), None);
        let cleanup = MergeCleanup::new(
            configs.clone(),
            repositories,
            Arc::new(RepoLockRegistry::new()),
            Arc::new(TaskRuntime::new(dir.path().join("logs"))),
        )
        .with_notifier(notifier);
        Fixture {
            _dir: dir,
            repo_path,
            cleanup,
            configs,
            notifications,
            task,
        }
    }

    async fn set_policy(f: &Fixture, policy: CleanupAfterMerge) {
        let mut cfg = f.configs.get(&f.task.repository_id).await.unwrap();
        cfg.cleanup_after_merge = policy;
        f.configs.upsert(&cfg, None).await.unwrap();
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
    async fn always_removes_the_worktree_and_local_branch() {
        let f = fixture().await;
        set_policy(&f, CleanupAfterMerge::Always).await;
        assert_eq!(
            f.cleanup.on_merged(&f.task, "u").await,
            CleanupAction::Removed
        );
        assert!(!Path::new(f.task.worktree_path.as_deref().unwrap()).exists());
        assert!(!branch_exists(&f.repo_path, "phasr/task"));
        assert_eq!(f.notifications.unread_count("u").await.unwrap(), 0);
    }

    /// `always` must not `remove -f` + `branch -D` over work that exists
    /// nowhere else: a dirty worktree, or a commit made after the merge.
    #[tokio::test]
    async fn always_falls_back_to_ask_when_work_would_be_lost() {
        let f = fixture().await;
        set_policy(&f, CleanupAfterMerge::Always).await;
        let wt = PathBuf::from(f.task.worktree_path.as_deref().unwrap());
        std::fs::write(wt.join("uncommitted.txt"), "x\n").unwrap();
        assert_eq!(
            f.cleanup.on_merged(&f.task, "u").await,
            CleanupAction::Suggested
        );
        assert!(wt.join("uncommitted.txt").exists(), "worktree kept");

        // Committed on the branch but not in main / origin: still at risk.
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-qm", "after the merge"]);
        assert_eq!(
            f.cleanup.on_merged(&f.task, "u").await,
            CleanupAction::Suggested
        );
        assert!(branch_exists(&f.repo_path, "phasr/task"), "branch kept");

        // Once that commit is in main, nothing would be lost → removed.
        git(
            &f.repo_path,
            &["merge", "-q", "--no-ff", "-m", "m", "phasr/task"],
        );
        assert_eq!(
            f.cleanup.on_merged(&f.task, "u").await,
            CleanupAction::Removed
        );
        assert!(!wt.exists());
    }

    #[tokio::test]
    async fn ask_suggests_in_the_inbox_and_keeps_everything() {
        let f = fixture().await;
        // The default policy is "ask".
        assert_eq!(
            f.cleanup.on_merged(&f.task, "u").await,
            CleanupAction::Suggested
        );
        assert!(Path::new(f.task.worktree_path.as_deref().unwrap()).exists());
        assert!(branch_exists(&f.repo_path, "phasr/task"));
        let inbox = f
            .notifications
            .list_for_user("u", true, None)
            .await
            .unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].payload["suggestion"], "cleanup");
        assert_eq!(inbox[0].workspace_id.as_deref(), Some(f.task.id.as_str()));

        set_policy(&f, CleanupAfterMerge::Never).await;
        assert_eq!(f.cleanup.on_merged(&f.task, "u").await, CleanupAction::None);
    }

    /// The same merge reported again (overlapping PR refreshes, a local
    /// merge then a refresh) — even concurrently — asks once.
    #[tokio::test]
    async fn the_cleanup_suggestion_is_made_once_per_task() {
        let f = fixture().await;
        let (a, b) = tokio::join!(
            f.cleanup.on_merged(&f.task, "u"),
            f.cleanup.on_merged(&f.task, "u")
        );
        assert_eq!((a, b), (CleanupAction::Suggested, CleanupAction::Suggested));
        assert_eq!(
            f.cleanup.on_merged(&f.task, "u").await,
            CleanupAction::Suggested
        );
        let inbox = f
            .notifications
            .list_for_user("u", false, None)
            .await
            .unwrap();
        assert_eq!(
            inbox
                .iter()
                .filter(|n| n.payload["suggestion"] == "cleanup")
                .count(),
            1
        );
    }

    /// The removal itself re-checks under the repo lock: work that appeared
    /// after `on_merged`'s probe (outside the lock) is never force-removed.
    #[tokio::test]
    async fn removal_rechecks_for_unsaved_work_under_the_lock() {
        let f = fixture().await;
        let wt = PathBuf::from(f.task.worktree_path.as_deref().unwrap());
        std::fs::write(wt.join("late.txt"), "written after the probe\n").unwrap();
        assert!(
            !f.cleanup.remove(&f.task, "u", &wt).await.unwrap(),
            "left alone"
        );
        assert!(wt.join("late.txt").exists());
        assert!(branch_exists(&f.repo_path, "phasr/task"));
        std::fs::remove_file(wt.join("late.txt")).unwrap();
        assert!(f.cleanup.remove(&f.task, "u", &wt).await.unwrap());
        assert!(!wt.exists());
    }

    #[tokio::test]
    async fn only_merged_agent_tasks_are_cleaned() {
        let f = fixture().await;
        set_policy(&f, CleanupAfterMerge::Always).await;
        let mut open = f.task.clone();
        open.outcome = None;
        assert_eq!(f.cleanup.on_merged(&open, "u").await, CleanupAction::None);
        let mut closed = f.task.clone();
        closed.outcome = Some(TaskOutcome::Closed);
        assert_eq!(f.cleanup.on_merged(&closed, "u").await, CleanupAction::None);
        assert!(Path::new(f.task.worktree_path.as_deref().unwrap()).exists());
    }
}
