//! Task orchestrator. Owns the lifecycle of an agent run:
//!
//!   1. Resolve the agent's command template + interpolate vars.
//!   2. Create the per-task git worktree on a deterministic `phasr/*` branch.
//!   3. Spawn the PTY in that worktree, transition to `running`.
//!   4. Watch the PTY's exit event and flip the row to
//!      `completed` / `failed` once it fires.
//!   5. Expose `stop` (SIGINT, then SIGTERM after 3s) and
//!      `send_input` for the interactive terminal.
//!
//! The orchestrator is *Tauri-agnostic*: it exposes status changes via
//! a `tokio::broadcast` channel. The command layer subscribes and
//! re-emits onto Tauri's event bus.
//!
//! Naming bridge: the orchestrator's public API uses **task** vocabulary
//! to match the plan and user-facing UI. The persistence layer renamed
//! `tasks` to `workspaces` in migration 0002; we keep the orchestrator
//! talking to `WorkspaceRepo` under the hood but expose `task_id` in
//! the API so the React side can use the same noun everywhere.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::domain::{Agent, Workspace, WorkspaceStatus};
use crate::git;
use crate::pty::handle::PtyHandle;
use crate::pty::{PtyEvent, TaskRuntime};
use crate::store::{RepositoryRepo, WorkspaceRepo, WorkspaceUpdate};

use super::error::OrchestratorError;
use super::repo_locks::RepoLockRegistry;
use super::templating::interpolate_command;

/// How long we wait for SIGINT to gracefully shut a process down
/// before escalating to SIGKILL (via portable_pty's killer).
const SIGINT_GRACE: Duration = Duration::from_secs(3);

/// Capacity for the status-event broadcast channel. Status events are
/// rare (a few per task lifecycle) and consumers re-emit them onto
/// Tauri events, so a small buffer is plenty.
const STATUS_BROADCAST_CAPACITY: usize = 256;

/// Fired whenever a task row transitions to a new status. Subscribers
/// (the Tauri command layer, the sync worker) re-emit / persist as
/// they see fit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusEvent {
    pub task_id: String,
    pub repository_id: String,
    pub status: WorkspaceStatus,
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct StartTaskRequest {
    pub repository_id: String,
    /// The signed-in user the workspace belongs to. Required for the row
    /// to be picked up by cloud sync (`dirty_workspace_rows` filters on
    /// `user_id`). `None` only in tests, which run without a session.
    pub user_id: Option<String>,
    /// The agent recorded on the workspace (metadata).
    pub agent: Agent,
    /// The command to actually run. In production this is
    /// `agent.command()`, resolved by the command layer; kept separate
    /// so tests can substitute a fast-exiting command.
    pub command: String,
    pub name: String,
    pub prompt: Option<String>,
    pub base_branch: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedTask {
    pub task_id: String,
    pub workspace: Workspace,
}

pub struct TaskTerminalSubscription {
    pub task_id: String,
    pub started_at: DateTime<Utc>,
    pub replay: Vec<PtyEvent>,
    pub rx: broadcast::Receiver<PtyEvent>,
}

/// The orchestrator itself. Hand it the dependencies it needs and call
/// `start_task` / `stop_task` / `send_input`.
#[derive(Clone)]
pub struct TaskOrchestrator {
    workspaces: WorkspaceRepo,
    repositories: RepositoryRepo,
    runtime: Arc<TaskRuntime>,
    repo_locks: Arc<RepoLockRegistry>,
    status_tx: broadcast::Sender<TaskStatusEvent>,
}

impl TaskOrchestrator {
    /// `repo_locks` is passed in (rather than created here) so the same
    /// registry is shared with the command layer via Tauri `State` —
    /// `create_workspace`, `merge_to_main`, and `delete_workspace` must
    /// serialize their shared-`.git` mutations against the same locks
    /// this orchestrator uses for `git worktree add` (F6).
    pub fn new(
        workspaces: WorkspaceRepo,
        repositories: RepositoryRepo,
        runtime: Arc<TaskRuntime>,
        repo_locks: Arc<RepoLockRegistry>,
    ) -> Self {
        let (status_tx, _rx) = broadcast::channel(STATUS_BROADCAST_CAPACITY);
        Self {
            workspaces,
            repositories,
            runtime,
            repo_locks,
            status_tx,
        }
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<TaskStatusEvent> {
        self.status_tx.subscribe()
    }

    /// `(task_id, last-output wall-clock ms)` for every task with a live
    /// PTY. Tasks whose PTY has exited are absent, not zero.
    pub fn task_activity(&self) -> Vec<(String, i64)> {
        self.runtime.activity()
    }

    /// Create a task row, build its worktree, spawn the PTY, and
    /// transition `pending → running`. Returns the row id once the
    /// runtime has accepted the spawn.
    pub async fn start_task(
        &self,
        request: StartTaskRequest,
    ) -> Result<StartedTask, OrchestratorError> {
        let repository = self.repositories.get(&request.repository_id).await?;
        let repository_path = repository
            .local_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or(OrchestratorError::RepositoryHasNoLocalPath)?;
        if !repository_path.exists() {
            return Err(OrchestratorError::RepositoryPathMissing(
                repository_path.to_string_lossy().into_owned(),
            ));
        }
        if !repository_path.join(".git").exists() {
            return Err(OrchestratorError::RepositoryNotAGitRepo(
                repository_path.to_string_lossy().into_owned(),
            ));
        }

        let base_ref = request
            .base_branch
            .clone()
            .unwrap_or_else(|| repository.default_branch.clone());

        // Serialize git ops against the shared `.git` for this repo.
        // `git worktree add` writes to `.git/worktrees/` and `.git/refs/`
        // and races spectacularly with other adds on the same repo.
        //
        // The lock is taken *before* the duplicate check (not just around
        // `git worktree add`) so the whole check → worktree-add → row-insert
        // is atomic per repo. That's what makes start_task idempotent (task
        // #12, the durable server-side twin of the D1 client re-entrancy
        // guard): a rapid duplicate / replayed IPC / second window blocks
        // here, then finds the row this call inserted and returns it —
        // instead of minting a SECOND task_id/branch/worktree/agent.
        let lock = self.repo_locks.for_repository(&request.repository_id);
        let guard = lock.lock().await;

        // Idempotency guard: return the existing ACTIVE (pending/running)
        // task for this `(repository_id, name)` rather than creating a
        // duplicate. Bounded to *active* tasks so a deliberate re-run after
        // the first has stopped/completed/been deleted still starts fresh.
        // Owner-scoped when we have a user_id (production); the unscoped
        // variant covers the sessionless test path.
        let existing = match request.user_id.as_deref() {
            Some(user_id) => {
                self.workspaces
                    .find_active_by_name_for_user(&request.repository_id, &request.name, user_id)
                    .await?
            }
            None => {
                self.workspaces
                    .find_active_by_name(&request.repository_id, &request.name)
                    .await?
            }
        };
        if let Some(existing) = existing {
            return Ok(StartedTask {
                task_id: existing.id.clone(),
                workspace: existing,
            });
        }

        let interpolated = interpolate_for_task(&request.command, request.prompt.as_deref());

        let mut workspace = Workspace::new(
            request.repository_id.clone(),
            request.name,
            interpolated.clone(),
        );
        workspace.prompt = request.prompt.clone();
        workspace.agent = Some(request.agent);

        let task_id = workspace.id.clone();
        let slug = git::slugify(&workspace.name);
        let branch_seed = git::default_branch_name(&slug, git::short_id(&task_id));
        let branch =
            git::unique_branch_name(&repository_path, &branch_seed, git::short_id(&task_id));
        let worktree_path = git::default_worktree_base_path().join(&task_id);

        git::create_worktree(&repository_path, &worktree_path, &branch, &base_ref)?;

        workspace.branch = Some(branch);
        workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());

        // Stamp the owner so cloud sync picks the row up. Without a
        // user_id the workspace stays local-only forever.
        match request.user_id.as_deref() {
            Some(user_id) => self.workspaces.insert_for_user(&workspace, user_id).await?,
            None => self.workspaces.insert(&workspace).await?,
        }

        // Release the per-repo lock before the PTY spawn + status update:
        // those touch only this task's own row/process, not the shared
        // `.git`, so there's no reason to hold up other repo tasks for them.
        drop(guard);

        let started_at = Utc::now();
        let updated = self
            .workspaces
            .update(
                &task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    started_at: Some(Some(started_at)),
                    ..Default::default()
                },
            )
            .await?;

        let pty_handle = self.runtime.spawn(
            task_id.clone(),
            Some(interpolated),
            request.prompt.clone(),
            worktree_path,
            request.rows.unwrap_or(24),
            request.cols.unwrap_or(80),
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.clone(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
        });

        self.spawn_exit_watcher(task_id.clone(), updated.repository_id.clone(), pty_handle);

        Ok(StartedTask {
            task_id,
            workspace: updated,
        })
    }

    /// Stop a running task. Sends SIGINT first (gives the agent a
    /// chance to exit cleanly — Claude/Codex/Cursor all clean up
    /// state on SIGINT) and escalates to SIGKILL after `SIGINT_GRACE`
    /// if the child is still alive. Status flips to `stopped`. The
    /// worktree is preserved — only `delete_task` removes it.
    pub async fn stop_task(&self, task_id: &str) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;

        // Best-effort SIGINT. Errors are non-fatal — we'll escalate.
        let _ = handle.interrupt();

        let handle_for_escalation = handle.clone();
        let task_id_for_escalation = task_id.to_string();
        let runtime_for_escalation = self.runtime.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SIGINT_GRACE).await;
            // If the runtime no longer tracks the task, the wait
            // thread already saw the child exit — nothing to do.
            if runtime_for_escalation
                .get(&task_id_for_escalation)
                .is_some()
            {
                let _ = handle_for_escalation.kill();
            }
        });

        let updated = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Stopped),
                    finished_at: Some(Some(Utc::now())),
                    ..Default::default()
                },
            )
            .await?;
        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id,
            status: WorkspaceStatus::Stopped,
            exit_code: None,
        });
        Ok(())
    }

    /// Kill a task's PTY immediately, for callers that are tearing the
    /// workspace down (archive, delete). Unlike `stop_task` there's no
    /// SIGINT grace period — nothing in-process is worth preserving.
    ///
    /// **The order is the entire point.** `spawn_exit_watcher` flips a
    /// still-`running` row to `failed` on any non-zero exit — which is
    /// exactly what SIGKILL produces — and broadcasts it. Killing first
    /// therefore reports the user's own delete back to them as "the
    /// agent exited with an error", for a workspace that no longer
    /// exists. Moving the row out of `running` first makes the watcher's
    /// guard skip it. `stop_task` already honours this contract; every
    /// other teardown path must too.
    ///
    /// No status broadcast: the caller is about to archive or delete the
    /// row and will publish that transition itself.
    pub async fn quiesce_task(&self, task_id: &str) {
        let Some(handle) = self.runtime.get(task_id) else {
            return;
        };
        let _ = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Stopped),
                    finished_at: Some(Some(Utc::now())),
                    ..Default::default()
                },
            )
            .await;
        let _ = handle.kill();
        self.runtime.drop_task(task_id);
    }

    /// Open the task's terminal stream. If the PTY is still alive, this
    /// attaches to it with replay. If the row is pending/stopped (or a
    /// stale running row somehow has no process), this resumes the task
    /// in the same worktree and starts a fresh exit watcher.
    pub async fn open_terminal(
        &self,
        task_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<TaskTerminalSubscription, OrchestratorError> {
        let workspace = self.workspaces.get(task_id).await?;

        if let Some(handle) = self.runtime.get(task_id) {
            let (replay, rx) = handle.subscribe_with_replay();
            return Ok(TaskTerminalSubscription {
                task_id: task_id.to_string(),
                started_at: workspace.started_at.unwrap_or_else(Utc::now),
                replay,
                rx,
            });
        }

        if matches!(
            workspace.status,
            WorkspaceStatus::Completed | WorkspaceStatus::Failed | WorkspaceStatus::Archived
        ) {
            return Err(OrchestratorError::AlreadyFinished(
                workspace.status.as_str().into(),
            ));
        }

        let cwd = self.cwd_for_task(&workspace).await?;
        let initial_command = if workspace.command.trim().is_empty() {
            None
        } else {
            Some(workspace.command.clone())
        };
        let initial_prompt = workspace.prompt.as_ref().and_then(|p| {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        let now = Utc::now();
        let updated = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    started_at: Some(Some(now)),
                    exit_code: Some(None),
                    finished_at: Some(None),
                    ..Default::default()
                },
            )
            .await?;

        let handle = self.runtime.spawn(
            task_id.to_string(),
            initial_command,
            initial_prompt,
            cwd,
            rows,
            cols,
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
        });

        self.spawn_exit_watcher(task_id.to_string(), updated.repository_id, handle.clone());

        let (replay, rx) = handle.subscribe_with_replay();
        Ok(TaskTerminalSubscription {
            task_id: task_id.to_string(),
            started_at: now,
            replay,
            rx,
        })
    }

    pub async fn read_task_log(&self, task_id: &str) -> Result<String, OrchestratorError> {
        let path = self.runtime.log_dir.join(format!("{task_id}.log"));
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Err(err) => return Err(OrchestratorError::Pty(err.into())),
        };
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn resize_task(
        &self,
        task_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;
        handle.resize(rows, cols)?;
        Ok(())
    }

    pub fn interrupt_task(&self, task_id: &str) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;
        handle.interrupt()?;
        Ok(())
    }

    /// Write bytes to the task's PTY stdin — used by the React
    /// terminal for live agent input.
    pub fn send_input(&self, task_id: &str, bytes: &[u8]) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;
        handle.write(bytes)?;
        Ok(())
    }

    async fn cwd_for_task(&self, workspace: &Workspace) -> Result<PathBuf, OrchestratorError> {
        if let Some(path) = workspace.worktree_path.as_deref() {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
            // Self-heal (F1): the DB still points at a worktree dir that's
            // gone — a moved repo, a cleaned temp dir, or a row synced from
            // another machine. Recreate it from the workspace's branch
            // instead of returning `RepositoryPathMissing` → the terminal's
            // "✗ Failed to start". `create_worktree` is idempotent and
            // re-attaches an existing branch, so this restores the exact
            // branch the agent was on.
            return self.recreate_missing_worktree(workspace, &path).await;
        }

        let repository = self.repositories.get(&workspace.repository_id).await?;
        let path = repository
            .local_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or(OrchestratorError::RepositoryHasNoLocalPath)?;
        if !path.exists() {
            return Err(OrchestratorError::RepositoryPathMissing(
                path.to_string_lossy().into_owned(),
            ));
        }
        Ok(path)
    }

    /// Recreate a missing worktree at `worktree_path` from the workspace's
    /// branch, under the shared per-repo lock. Returns the calm
    /// `WorktreeUnavailable` error — not a hard `RepositoryPathMissing` —
    /// when recreation is impossible: no branch recorded, the repository
    /// has no local path on this machine, or that checkout is itself gone.
    async fn recreate_missing_worktree(
        &self,
        workspace: &Workspace,
        worktree_path: &Path,
    ) -> Result<PathBuf, OrchestratorError> {
        let branch = workspace
            .branch
            .as_deref()
            .ok_or(OrchestratorError::WorktreeUnavailable)?;
        let repository = self.repositories.get(&workspace.repository_id).await?;
        let repo_path = repository
            .local_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or(OrchestratorError::WorktreeUnavailable)?;
        if !repo_path.join(".git").exists() {
            return Err(OrchestratorError::WorktreeUnavailable);
        }
        let base_ref = repository.default_branch.clone();
        let worktree_path = worktree_path.to_path_buf();

        // Serialize the worktree-add against every other shared-`.git`
        // mutation for this repo (F6) — same lock start_task uses.
        let lock = self.repo_locks.for_repository(&workspace.repository_id);
        let _guard = lock.lock().await;
        git::create_worktree(&repo_path, &worktree_path, branch, &base_ref)?;
        Ok(worktree_path)
    }

    fn broadcast_status(&self, event: TaskStatusEvent) {
        // No-op if there are no subscribers — that's fine.
        let _ = self.status_tx.send(event);
    }

    /// Spawn a task that listens for the PTY's `Exit` event and flips
    /// the row to `completed` (code 0) or `failed` (otherwise). Note
    /// that interactive agents (Claude, Codex, etc.) almost never
    /// exit on their own — they sit at a prompt waiting for input.
    /// This handler only fires on real process death: a crash, the
    /// user typing `exit`, or an explicit kill.
    fn spawn_exit_watcher(&self, task_id: String, repository_id: String, handle: Arc<PtyHandle>) {
        let mut rx = handle.subscribe();
        let workspaces = self.workspaces.clone();
        let runtime = self.runtime.clone();
        let status_tx = self.status_tx.clone();

        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(PtyEvent::Output { .. }) => continue,
                    Ok(PtyEvent::Exit { exit_code, .. }) => {
                        let current = workspaces.get(&task_id).await.ok();
                        if !current
                            .as_ref()
                            .is_some_and(|w| w.status == WorkspaceStatus::Running)
                        {
                            runtime.drop_task(&task_id);
                            break;
                        }
                        let next = if exit_code == Some(0) {
                            WorkspaceStatus::Completed
                        } else {
                            WorkspaceStatus::Failed
                        };
                        let update = WorkspaceUpdate {
                            // Only flip if we're still in `running` —
                            // if `stop_task` already moved us to
                            // `stopped`, leave it alone.
                            status: Some(next),
                            exit_code: Some(exit_code),
                            finished_at: Some(Some(Utc::now())),
                            ..Default::default()
                        };
                        let flipped = workspaces.update(&task_id, update).await.ok();
                        runtime.drop_task(&task_id);
                        if flipped.is_some() {
                            let _ = status_tx.send(TaskStatusEvent {
                                task_id: task_id.clone(),
                                repository_id: repository_id.clone(),
                                status: next,
                                exit_code,
                            });
                        }
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

/// Build the variable map and run the template through. Centralised
/// here so the seeded-presets case (no `{{prompt}}` in the template)
/// returns the command verbatim without an empty-prompt placeholder
/// appearing in the output.
fn interpolate_for_task(template: &str, prompt: Option<&str>) -> String {
    let prompt_value = prompt.unwrap_or("");
    let mut vars = HashMap::new();
    vars.insert("prompt", prompt_value);
    interpolate_command(template, &vars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, WorkspaceKind};
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    async fn fresh_orchestrator(
    ) -> (TaskOrchestrator, RepositoryRepo, crate::store::Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let pool = init_pool(&db_path).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repositories = RepositoryRepo::new(pool.clone());
        let log_dir = dir.path().join("logs");
        let runtime = Arc::new(TaskRuntime::new(log_dir));
        let repo_locks = Arc::new(RepoLockRegistry::new());
        let orchestrator =
            TaskOrchestrator::new(workspaces, repositories.clone(), runtime, repo_locks);
        (orchestrator, repositories, pool, dir)
    }

    fn init_repo(path: &Path) {
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "t@example.com"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "tester"])
            .current_dir(path)
            .status()
            .unwrap();
        std::fs::write(path.join("README.md"), "hi").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(path)
            .status()
            .unwrap();
    }

    /// Number of worktrees registered against `repo` (the main checkout
    /// counts as one).
    fn count_worktrees(repo: &Path) -> usize {
        let out = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(repo)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count()
    }

    /// Number of local `phasr/*` branches in `repo`.
    fn count_phasr_branches(repo: &Path) -> usize {
        let out = Command::new("git")
            .args(["branch", "--list", "phasr/*"])
            .current_dir(repo)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    }

    /// Insert a repository whose local path is a fresh, one-commit git repo
    /// under `tmp/<dir_name>`, so worktree creation actually works.
    async fn repo_with_git(
        repositories: &RepositoryRepo,
        tmp: &tempfile::TempDir,
        dir_name: &str,
    ) -> Repository {
        let repo_dir = tmp.path().join(dir_name);
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();
        repo
    }

    /// A long-lived start request. `sleep 30` keeps the agent `running` for
    /// the whole test, so a subsequent duplicate deterministically observes
    /// an ACTIVE task regardless of PTY scheduling. `user_id: None` exercises
    /// the sessionless (unscoped) dedup path.
    fn sleep_request(repository_id: &str, name: &str) -> StartTaskRequest {
        StartTaskRequest {
            repository_id: repository_id.to_string(),
            user_id: None,
            agent: Agent::Claude,
            command: "sleep 30".into(),
            name: name.to_string(),
            prompt: None,
            base_branch: None,
            rows: None,
            cols: None,
        }
    }

    /// Kill each task's PTY (SIGINT terminates `sleep`) and drop its worktree
    /// dir — worktrees live under `$HOME/.phasr`, outside the test TempDir, so
    /// they'd otherwise linger. Safe to call with deduped tasks that share a
    /// task_id/worktree (double stop/remove is a no-op).
    async fn cleanup(orchestrator: &TaskOrchestrator, tasks: &[&StartedTask]) {
        for t in tasks {
            let _ = orchestrator.stop_task(&t.task_id).await;
            if let Some(path) = t.workspace.worktree_path.as_deref() {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }

    #[tokio::test]
    async fn start_task_creates_worktree_and_transitions_through_running_to_completed() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;

        // Build a real git repo so the worktree create works.
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);

        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();

        let mut status_rx = orchestrator.subscribe_status();

        let started = orchestrator
            .start_task(StartTaskRequest {
                repository_id: repo.id.clone(),
                user_id: None,
                agent: Agent::Claude,
                // A quick-exiting command so the exit watcher fires
                // deterministically regardless of which agents are
                // installed on the machine running the test.
                command: "echo hello-phasr; exit".into(),
                name: "test task".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
            })
            .await
            .expect("start_task should succeed");

        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert!(started
            .workspace
            .branch
            .as_deref()
            .unwrap()
            .starts_with("phasr/"));
        let worktree_path = started.workspace.worktree_path.as_ref().unwrap();
        assert!(Path::new(worktree_path).join("README.md").exists());

        // First event = Running (from start_task).
        let first = tokio::time::timeout(Duration::from_secs(2), status_rx.recv())
            .await
            .expect("status event")
            .expect("recv ok");
        assert_eq!(first.status, WorkspaceStatus::Running);

        // Wait for the PTY's `exit; ` to fire — flip should be
        // Completed (code 0).
        let mut saw_completion = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), status_rx.recv()).await {
                Ok(Ok(event))
                    if matches!(
                        event.status,
                        WorkspaceStatus::Completed | WorkspaceStatus::Failed
                    ) =>
                {
                    saw_completion = Some(event);
                    break;
                }
                _ => continue,
            }
        }
        let completion = saw_completion.expect("expected a terminal status event");
        assert_eq!(completion.task_id, started.task_id);
        // Some shells synthesise non-zero exits even on a clean
        // `exit; ` — accept either Completed or Failed as long as we
        // got *a* terminal event. The transition itself is what's
        // under test.
        assert!(matches!(
            completion.status,
            WorkspaceStatus::Completed | WorkspaceStatus::Failed
        ));
    }

    // Task #12: server-side idempotency. A concurrent/rapid duplicate
    // start_task for the SAME (repository_id, name) must NOT create a
    // second worktree/branch/agent — it returns the EXISTING task. Fire
    // two starts concurrently against one repo (the double-fire the guard
    // defends against), then a third back-to-back, and assert every call
    // resolves to the same task_id with exactly one worktree + one
    // `phasr/*` branch created.
    #[tokio::test]
    async fn duplicate_start_task_is_idempotent() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();

        // A long-lived command keeps the agent `running` for the whole
        // test, so later duplicates deterministically observe an ACTIVE
        // task regardless of PTY scheduling.
        let request = StartTaskRequest {
            repository_id: repo.id.clone(),
            user_id: None,
            agent: Agent::Claude,
            command: "sleep 30".into(),
            name: "add-feature".into(),
            prompt: None,
            base_branch: None,
            rows: None,
            cols: None,
        };

        // Fire both concurrently. The per-repo lock serializes them: one
        // creates, the other blocks, then finds the freshly-inserted row
        // and returns it — no second worktree/branch/agent.
        let other = orchestrator.clone();
        let (first_res, second_res) = tokio::join!(
            orchestrator.start_task(request.clone()),
            other.start_task(request.clone()),
        );
        let first = first_res.expect("first start_task should succeed");
        let second = second_res.expect("second start_task should succeed");

        assert_eq!(
            first.task_id, second.task_id,
            "a duplicate start_task must return the existing task_id"
        );
        assert_eq!(
            count_worktrees(&repo_dir),
            2,
            "duplicate start_task must not create a second worktree (main + one task)"
        );
        assert_eq!(
            count_phasr_branches(&repo_dir),
            1,
            "duplicate start_task must not create a second branch"
        );

        // A duplicate arriving AFTER the first, back-to-back, is caught by
        // the same active-task guard.
        let third = orchestrator
            .start_task(request.clone())
            .await
            .expect("back-to-back duplicate should succeed");
        assert_eq!(third.task_id, first.task_id);
        assert_eq!(count_worktrees(&repo_dir), 2);
        assert_eq!(count_phasr_branches(&repo_dir), 1);

        // Kill the PTY (a single task_id thanks to dedup) and drop its
        // worktree dir so the `sleep` doesn't linger — the worktree lives
        // under $HOME/.phasr, outside the test's TempDir.
        cleanup(&orchestrator, &[&first]).await;
    }

    // --- Dedup correctness: distinct requests must stay distinct ---

    // Case 1: same repo, DIFFERENT names → two distinct tasks. The guard
    // must not over-dedup on repository alone.
    #[tokio::test]
    async fn distinct_names_same_repo_create_distinct_tasks() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());

        let a = orchestrator
            .start_task(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        let b = orchestrator
            .start_task(sleep_request(&repo.id, "fix-bug"))
            .await
            .unwrap();

        assert_ne!(a.task_id, b.task_id, "different names must not be deduped");
        assert_eq!(
            count_worktrees(repo_path),
            3,
            "main checkout + two distinct task worktrees"
        );
        assert_eq!(count_phasr_branches(repo_path), 2);

        cleanup(&orchestrator, &[&a, &b]).await;
    }

    // Case 2: SAME name, DIFFERENT repos → two distinct tasks. The dedup key
    // is repo-scoped.
    #[tokio::test]
    async fn same_name_distinct_repos_create_distinct_tasks() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo1 = repo_with_git(&repositories, &tmp, "repo1").await;
        let repo2 = repo_with_git(&repositories, &tmp, "repo2").await;

        let a = orchestrator
            .start_task(sleep_request(&repo1.id, "add-feature"))
            .await
            .unwrap();
        let b = orchestrator
            .start_task(sleep_request(&repo2.id, "add-feature"))
            .await
            .unwrap();

        assert_ne!(
            a.task_id, b.task_id,
            "same name in different repos must not be deduped"
        );
        assert_eq!(
            count_worktrees(Path::new(repo1.local_path.as_deref().unwrap())),
            2
        );
        assert_eq!(
            count_worktrees(Path::new(repo2.local_path.as_deref().unwrap())),
            2
        );

        cleanup(&orchestrator, &[&a, &b]).await;
    }

    // Case 3: N-way concurrency (8 parallel identical starts on a multi-thread
    // runtime) → EXACTLY one worktree/branch, all calls return the same
    // task_id. This is the real double-fire, amplified.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn n_way_concurrent_duplicates_create_exactly_one_task() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path_str = repo.local_path.clone().unwrap();

        let mut handles = Vec::new();
        for _ in 0..8 {
            let o = orchestrator.clone();
            let req = sleep_request(&repo.id, "add-feature");
            handles.push(tokio::spawn(async move { o.start_task(req).await }));
        }
        let mut started = Vec::new();
        for h in handles {
            started.push(
                h.await
                    .unwrap()
                    .expect("each concurrent start_task must succeed"),
            );
        }

        let ids: Vec<&str> = started.iter().map(|s| s.task_id.as_str()).collect();
        assert!(
            ids.windows(2).all(|w| w[0] == w[1]),
            "all concurrent duplicates must resolve to one task_id, got {ids:?}"
        );
        let repo_path = Path::new(&repo_path_str);
        assert_eq!(
            count_worktrees(repo_path),
            2,
            "exactly one task worktree despite the N-way race"
        );
        assert_eq!(count_phasr_branches(repo_path), 1);

        cleanup(&orchestrator, &[&started[0]]).await;
    }

    // --- Active-bounding: a re-run must work once the first is no longer active ---

    // Case 4: after the first reaches each TERMINAL/non-active status
    // (stopped, completed, failed, archived), a re-run of the same
    // (repo, name) creates a NEW task — it is NOT deduped to the dead one.
    #[tokio::test]
    async fn rerun_after_non_active_status_creates_new_task() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        let mut created: Vec<StartedTask> = Vec::new();
        for status in [
            WorkspaceStatus::Stopped,
            WorkspaceStatus::Completed,
            WorkspaceStatus::Failed,
            WorkspaceStatus::Archived,
        ] {
            // Distinct name per status so the sub-cases don't interfere.
            let name = format!("task-{}", status.as_str());
            // Seed a matching agent row already in the terminal status.
            // `insert` does not validate transitions, so we set it directly.
            let mut dead = Workspace::new(repo.id.clone(), name.clone(), "cmd".into());
            dead.status = status;
            workspaces.insert(&dead).await.unwrap();

            let started = orchestrator
                .start_task(sleep_request(&repo.id, &name))
                .await
                .unwrap_or_else(|e| {
                    panic!("re-run after `{}` should create a task: {e}", status.as_str())
                });
            assert_ne!(
                started.task_id,
                dead.id,
                "re-run after `{}` must not dedup to the inactive task",
                status.as_str()
            );
            assert_eq!(started.workspace.status, WorkspaceStatus::Running);
            assert!(
                started
                    .workspace
                    .worktree_path
                    .as_deref()
                    .map(|p| Path::new(p).exists())
                    .unwrap_or(false),
                "the re-run must build a fresh worktree"
            );
            created.push(started);
        }

        let refs: Vec<&StartedTask> = created.iter().collect();
        cleanup(&orchestrator, &refs).await;
    }

    // Case 5: after the first is SOFT-DELETED (deleted_at set), a re-run of
    // the same (repo, name) creates a NEW task.
    #[tokio::test]
    async fn rerun_after_soft_delete_creates_new_task() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        // A running agent task, then tombstoned.
        let mut ghost = Workspace::new(repo.id.clone(), "add-feature".into(), "cmd".into());
        ghost.status = WorkspaceStatus::Running;
        workspaces.insert(&ghost).await.unwrap();
        workspaces.delete(&ghost.id).await.unwrap();

        let started = orchestrator
            .start_task(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        assert_ne!(
            started.task_id, ghost.id,
            "a soft-deleted task must not be deduped against"
        );
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);

        cleanup(&orchestrator, &[&started]).await;
    }

    // Case 6: PENDING is active. A duplicate arriving while the first row is
    // still `pending` (the exact state a start_task is in before it flips to
    // running) is deduped — and the dedup path creates NO worktree/branch.
    #[tokio::test]
    async fn pending_task_is_treated_as_active_and_deduped() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());

        let pending = Workspace::new(repo.id.clone(), "add-feature".into(), "cmd".into());
        assert_eq!(pending.status, WorkspaceStatus::Pending);
        workspaces.insert(&pending).await.unwrap();

        let started = orchestrator
            .start_task(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        assert_eq!(
            started.task_id, pending.id,
            "a duplicate while the first is pending must return the existing task"
        );
        assert_eq!(
            count_worktrees(repo_path),
            1,
            "the dedup path creates no worktree (only the main checkout)"
        );
        assert_eq!(count_phasr_branches(repo_path), 0);
        // Nothing was spawned by the deduped call — no cleanup needed.
    }

    // --- Scoping refinements ---

    // Case 7: a LOCAL workspace named X (even a RUNNING one) must never be
    // treated as a duplicate agent task — the guard is `workspace_kind='agent'`
    // scoped. A second agent start then dedups to the AGENT task, not the local.
    #[tokio::test]
    async fn agent_start_task_ignores_a_local_workspace_of_the_same_name() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());

        // The ever-present local workspace, forced RUNNING so only the KIND
        // filter (not status) can keep it out of the dedup lookup.
        let mut local = Workspace::new(repo.id.clone(), "add-feature".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        local.status = WorkspaceStatus::Running;
        workspaces.insert(&local).await.unwrap();

        let agent = orchestrator
            .start_task(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        assert_ne!(
            agent.task_id, local.id,
            "agent start_task must not dedup against the local workspace"
        );
        assert_eq!(agent.workspace.workspace_kind, WorkspaceKind::Agent);
        assert_eq!(
            count_worktrees(repo_path),
            2,
            "the new agent task got its own worktree"
        );

        // A second agent start with the same name dedups to the AGENT task.
        let agent2 = orchestrator
            .start_task(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        assert_eq!(agent2.task_id, agent.task_id);
        assert_eq!(count_worktrees(repo_path), 2, "still one agent worktree");
        assert_eq!(count_phasr_branches(repo_path), 1);

        cleanup(&orchestrator, &[&agent]).await;
    }

    // --- Name / input semantics (decisions documented in-line) ---

    // Case 9: name dedup is a RAW, exact-string match (SQLite BINARY
    // collation) — no case-folding, no trimming. This is deliberate and
    // consistent with the frontend: NewTaskForm trims the name (and requires
    // it non-empty) before invoking start_task, so a genuine double-fire
    // always sends byte-identical names, while legitimately-different names
    // ("fix" vs "Fix") remain distinct tasks.
    #[tokio::test]
    async fn name_dedup_is_exact_match_case_and_whitespace_sensitive() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;

        let lower = orchestrator
            .start_task(sleep_request(&repo.id, "fix"))
            .await
            .unwrap();
        let upper = orchestrator
            .start_task(sleep_request(&repo.id, "Fix"))
            .await
            .unwrap();
        let trailing = orchestrator
            .start_task(sleep_request(&repo.id, "fix "))
            .await
            .unwrap();

        assert_ne!(
            lower.task_id, upper.task_id,
            "case differences must not be folded"
        );
        assert_ne!(
            lower.task_id, trailing.task_id,
            "trailing whitespace is significant"
        );
        assert_ne!(upper.task_id, trailing.task_id);

        cleanup(&orchestrator, &[&lower, &upper, &trailing]).await;
    }

    // Case 10: empty / whitespace-only names. NewTaskForm requires a non-empty
    // trimmed name, so these shouldn't reach the backend in practice — but they
    // must not crash, and two empty-name requests must dedup (idempotent),
    // never spawn duplicates. `""` and `" "` are DIFFERENT exact strings.
    #[tokio::test]
    async fn empty_and_whitespace_names_are_handled_defensively() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;

        let empty1 = orchestrator
            .start_task(sleep_request(&repo.id, ""))
            .await
            .expect("an empty name must not crash");
        let empty2 = orchestrator
            .start_task(sleep_request(&repo.id, ""))
            .await
            .unwrap();
        assert_eq!(
            empty1.task_id, empty2.task_id,
            "two empty-name requests must dedup to one task"
        );
        // Empty slug falls back to a `phasr/<id>` branch — no crash / no
        // empty branch name.
        assert!(empty1
            .workspace
            .branch
            .as_deref()
            .unwrap()
            .starts_with("phasr/"));

        let space = orchestrator
            .start_task(sleep_request(&repo.id, " "))
            .await
            .unwrap();
        assert_ne!(
            space.task_id, empty1.task_id,
            "a single-space name is a different exact string from empty"
        );

        cleanup(&orchestrator, &[&empty1, &space]).await;
    }

    // Case 11: the dedup key is (repository_id, name) ONLY — base_branch,
    // agent, and prompt are intentionally ignored, because a genuine
    // double-fire carries identical fields. KNOWN LIMITATION: a user wanting
    // two same-named tasks off different base branches within the active
    // window is blocked (vary the name, or wait for the first to finish);
    // the frontend never produces this from a single form submission.
    #[tokio::test]
    async fn duplicate_with_different_base_agent_prompt_still_dedups() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());

        let first = orchestrator
            .start_task(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();

        // Same name, but a different agent, a (non-existent) base branch, and
        // a prompt. The base branch is never resolved because dedup returns
        // before any worktree work — proving those fields aren't in the key.
        let mut variant = sleep_request(&repo.id, "add-feature");
        variant.agent = Agent::Codex;
        variant.base_branch = Some("some-other-base".into());
        variant.prompt = Some("a totally different prompt".into());
        let second = orchestrator.start_task(variant).await.unwrap();

        assert_eq!(
            second.task_id, first.task_id,
            "differing base/agent/prompt must still dedup on (repo, name)"
        );
        // The first task wins — the duplicate returns the existing row.
        assert_eq!(second.workspace.agent, Some(Agent::Claude));
        assert_eq!(count_worktrees(repo_path), 2, "no second worktree");
        assert_eq!(count_phasr_branches(repo_path), 1);

        cleanup(&orchestrator, &[&first]).await;
    }

    // Regression: workspaces created via the orchestrator must carry the
    // signed-in user_id, otherwise cloud sync (which filters dirty rows by
    // user_id) never pushes them and they stay invisible in Supabase.
    #[tokio::test]
    async fn start_task_stamps_user_id_for_sync() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();

        // workspaces.user_id has a FK to users(id), so seed a user row.
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES ('user-x', 'user-x', 'X', 'x@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let started = orchestrator
            .start_task(StartTaskRequest {
                repository_id: repo.id.clone(),
                user_id: Some("user-x".into()),
                agent: Agent::Claude,
                command: "echo hi; exit".into(),
                name: "owned task".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
            })
            .await
            .expect("start_task should succeed");

        let user_id: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM workspaces WHERE id = ?")
                .bind(&started.workspace.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(user_id.as_deref(), Some("user-x"));

        // And it must be dirty so the sync worker picks it up.
        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = ?")
            .bind(&started.workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty, 1);
    }

    #[tokio::test]
    async fn start_task_rejects_repository_without_local_path() {
        let (orchestrator, repositories, _pool, _tmp) = fresh_orchestrator().await;
        let repo = Repository::new("no-path".into(), None, None);
        repositories.insert(&repo).await.unwrap();
        let err = orchestrator
            .start_task(StartTaskRequest {
                repository_id: repo.id,
                user_id: None,
                agent: Agent::Claude,
                command: Agent::Claude.command().into(),
                name: "t".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, OrchestratorError::RepositoryHasNoLocalPath));
    }

    #[tokio::test]
    async fn stop_task_errors_when_task_not_running() {
        let (orchestrator, _r, _pool, _t) = fresh_orchestrator().await;
        let err = orchestrator.stop_task("missing").await.unwrap_err();
        assert!(matches!(err, OrchestratorError::TaskNotRunning(_)));
    }

    /// Regression: archiving or deleting a workspace with a live agent
    /// used to kill the PTY while the row was still `running`. The exit
    /// watcher then saw a non-zero exit (SIGKILL) and broadcast
    /// `failed`, which surfaced as "the agent exited with an error" for
    /// a workspace the user had just removed. `quiesce_task` must move
    /// the row out of `running` FIRST so the watcher stays silent.
    #[tokio::test]
    async fn quiesce_task_kills_without_reporting_a_failure() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();

        let mut status_rx = orchestrator.subscribe_status();

        let started = orchestrator
            .start_task(StartTaskRequest {
                repository_id: repo.id.clone(),
                user_id: None,
                agent: Agent::Claude,
                // Long-running, so the process is still alive when we
                // tear it down — the situation the bug needed.
                command: "sleep 120".into(),
                name: "doomed task".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
            })
            .await
            .expect("start_task should succeed");
        let task_id = started.workspace.id.clone();

        let first = tokio::time::timeout(Duration::from_secs(2), status_rx.recv())
            .await
            .expect("status event")
            .expect("recv ok");
        assert_eq!(first.status, WorkspaceStatus::Running);

        orchestrator.quiesce_task(&task_id).await;

        // Give the exit watcher every chance to misbehave.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), status_rx.recv()).await {
                Ok(Ok(event)) => panic!(
                    "teardown must not broadcast a status event, got {:?} (exit {:?})",
                    event.status, event.exit_code
                ),
                Ok(Err(_)) => break,
                Err(_) => continue,
            }
        }

        // And the row records a deliberate stop, not a failure.
        let row = orchestrator.workspaces.get(&task_id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Stopped);
        assert!(row.finished_at.is_some());
    }

    // F1: opening a workspace whose worktree dir is gone (moved repo,
    // cleaned temp dir, synced from another machine) must self-heal by
    // recreating the worktree from the branch — not fail to start.
    #[tokio::test]
    async fn cwd_for_task_recreates_a_missing_worktree() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();

        // Points at a worktree dir that doesn't exist, but records a branch
        // we can re-attach.
        let worktree_path = tmp.path().join("gone-worktree");
        assert!(!worktree_path.exists());
        let mut workspace = Workspace::new(repo.id.clone(), "restore me".into(), "echo".into());
        workspace.branch = Some("phasr/restore".into());
        workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());

        let cwd = orchestrator
            .cwd_for_task(&workspace)
            .await
            .expect("self-heal should recreate the missing worktree");
        assert_eq!(cwd, worktree_path);
        assert!(
            worktree_path.join("README.md").exists(),
            "recreated worktree should carry the repo's tracked files"
        );
    }

    // The calm path: a missing worktree with no branch to recreate from
    // returns WorktreeUnavailable, not a hard RepositoryPathMissing.
    #[tokio::test]
    async fn cwd_for_task_returns_calm_error_when_it_cannot_recreate() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "test".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();

        let mut workspace = Workspace::new(repo.id.clone(), "no branch".into(), "echo".into());
        workspace.branch = None;
        workspace.worktree_path =
            Some(tmp.path().join("gone").to_string_lossy().into_owned());

        let err = orchestrator.cwd_for_task(&workspace).await.unwrap_err();
        assert!(matches!(err, OrchestratorError::WorktreeUnavailable));
    }

    #[test]
    fn interpolate_for_task_substitutes_prompt() {
        let out = interpolate_for_task(r#"claude -p "{{prompt}}""#, Some("hi"));
        assert_eq!(out, r#"claude -p "hi""#);
    }

    #[test]
    fn interpolate_for_task_returns_template_when_no_placeholder() {
        let out = interpolate_for_task("claude --dangerously-skip-permissions", None);
        assert_eq!(out, "claude --dangerously-skip-permissions");
    }

    #[test]
    fn interpolate_for_task_handles_missing_prompt_as_empty() {
        let out = interpolate_for_task(r#"agent --p "{{prompt}}""#, None);
        assert_eq!(out, r#"agent --p """#);
    }
}
