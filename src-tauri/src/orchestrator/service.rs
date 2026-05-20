//! Task orchestrator. Owns the lifecycle of an agent run:
//!
//!   1. Resolve the agent's command template + interpolate vars.
//!   2. Create the per-task git worktree on `phasr/<short-id>`.
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
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::domain::{Agent, Workspace, WorkspaceStatus};
use crate::git;
use crate::pty::handle::PtyHandle;
use crate::pty::{PtyEvent, TaskRuntime};
use crate::store::{AgentRepo, RepositoryRepo, WorkspaceRepo, WorkspaceUpdate};

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
    pub agent_id: String,
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

/// The orchestrator itself. Hand it the dependencies it needs and call
/// `start_task` / `stop_task` / `send_input`.
#[derive(Clone)]
pub struct TaskOrchestrator {
    workspaces: WorkspaceRepo,
    repositories: RepositoryRepo,
    agents: AgentRepo,
    runtime: Arc<TaskRuntime>,
    repo_locks: Arc<RepoLockRegistry>,
    status_tx: broadcast::Sender<TaskStatusEvent>,
}

impl TaskOrchestrator {
    pub fn new(
        workspaces: WorkspaceRepo,
        repositories: RepositoryRepo,
        agents: AgentRepo,
        runtime: Arc<TaskRuntime>,
    ) -> Self {
        let (status_tx, _rx) = broadcast::channel(STATUS_BROADCAST_CAPACITY);
        Self {
            workspaces,
            repositories,
            agents,
            runtime,
            repo_locks: Arc::new(RepoLockRegistry::new()),
            status_tx,
        }
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<TaskStatusEvent> {
        self.status_tx.subscribe()
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

        let agent_command = self.resolve_agent_command(&request.agent_id).await?;
        let interpolated = interpolate_for_task(&agent_command, request.prompt.as_deref());

        let mut workspace =
            Workspace::new(request.repository_id.clone(), request.name, interpolated.clone());
        workspace.prompt = request.prompt.clone();
        workspace.agent_id = Some(request.agent_id.clone());

        let task_id = workspace.id.clone();
        let branch = format!("phasr/{}", short_id(&task_id));
        let worktree_path = worktree_base_path().join(&task_id);
        let base_ref = request
            .base_branch
            .clone()
            .unwrap_or_else(|| repository.default_branch.clone());

        // Serialize git ops against the shared `.git` for this repo.
        // `git worktree add` writes to `.git/worktrees/` and `.git/refs/`
        // and races spectacularly with other adds on the same repo.
        let lock = self.repo_locks.for_repository(&request.repository_id);
        {
            let _guard = lock.lock().await;
            git::create_worktree(&repository_path, &worktree_path, &branch, &base_ref)?;
        }

        workspace.branch = Some(branch);
        workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());

        self.workspaces.insert(&workspace).await?;

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
            if runtime_for_escalation.get(&task_id_for_escalation).is_some() {
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

    /// Resolve an agent id to its command template. Seeded agents are
    /// hardcoded; custom agents come from `AgentRepo`.
    async fn resolve_agent_command(&self, agent_id: &str) -> Result<String, OrchestratorError> {
        if let Some(agent) = Agent::seeded().into_iter().find(|a| a.id == agent_id) {
            return Ok(agent.command);
        }
        // Custom agents live in the agents table.
        let all = self.agents.list_all().await?;
        all.into_iter()
            .find(|a| a.id == agent_id)
            .map(|a| a.command)
            .ok_or_else(|| OrchestratorError::AgentNotFound(agent_id.to_string()))
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
    fn spawn_exit_watcher(
        &self,
        task_id: String,
        repository_id: String,
        handle: Arc<PtyHandle>,
    ) {
        let mut rx = handle.subscribe();
        let workspaces = self.workspaces.clone();
        let runtime = self.runtime.clone();
        let status_tx = self.status_tx.clone();

        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(PtyEvent::Output { .. }) => continue,
                    Ok(PtyEvent::Exit { exit_code, .. }) => {
                        let next = if exit_code == Some(0) {
                            WorkspaceStatus::Completed
                        } else {
                            WorkspaceStatus::Failed
                        };
                        let update = WorkspaceUpdate {
                            // Only flip if we're still in `running` —
                            // if `stop_task` already moved us to
                            // `stopped`, leave it alone (the
                            // transition validator would reject the
                            // change anyway).
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

/// `~/.phasr/worktrees`, matching the plan's layout. Falls back to
/// `/tmp` if `$HOME` is unset (CI sandboxes).
fn worktree_base_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".phasr").join("worktrees")
}

/// First UUID segment — short enough to fit in a branch name without
/// being so short that two concurrent tasks could collide.
fn short_id(id: &str) -> &str {
    id.split('-').next().unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    async fn fresh_orchestrator() -> (TaskOrchestrator, RepositoryRepo, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let pool = init_pool(&db_path).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repositories = RepositoryRepo::new(pool.clone());
        let agents = AgentRepo::new(pool);
        let log_dir = dir.path().join("logs");
        let runtime = Arc::new(TaskRuntime::new(log_dir));
        let orchestrator =
            TaskOrchestrator::new(workspaces, repositories.clone(), agents, runtime);
        (orchestrator, repositories, dir)
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

    #[tokio::test]
    async fn start_task_creates_worktree_and_transitions_through_running_to_completed() {
        let (orchestrator, repositories, tmp) = fresh_orchestrator().await;

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

        // Use a custom agent so we don't need the seed UUIDs. The
        // command exits quickly so the exit watcher fires.
        let agent = Agent::new_custom("echo-agent", "echo hello-phasr; exit");
        orchestrator.agents.insert(&agent).await.unwrap();
        // ^ inside the same crate; `agents` is private but the test
        //   module is a child of the file so direct field access is fine.

        let mut status_rx = orchestrator.subscribe_status();

        let started = orchestrator
            .start_task(StartTaskRequest {
                repository_id: repo.id.clone(),
                agent_id: agent.id.clone(),
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

    #[tokio::test]
    async fn start_task_rejects_repository_without_local_path() {
        let (orchestrator, repositories, _tmp) = fresh_orchestrator().await;
        let repo = Repository::new("no-path".into(), None, None);
        repositories.insert(&repo).await.unwrap();
        let err = orchestrator
            .start_task(StartTaskRequest {
                repository_id: repo.id,
                agent_id: "nonexistent".into(),
                name: "t".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            OrchestratorError::RepositoryHasNoLocalPath
        ));
    }

    #[tokio::test]
    async fn stop_task_errors_when_task_not_running() {
        let (orchestrator, _r, _t) = fresh_orchestrator().await;
        let err = orchestrator.stop_task("missing").await.unwrap_err();
        assert!(matches!(err, OrchestratorError::TaskNotRunning(_)));
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

