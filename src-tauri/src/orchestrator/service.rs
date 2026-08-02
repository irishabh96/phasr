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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::{broadcast, Semaphore};

use crate::domain::{Agent, Workspace, WorkspaceContract, WorkspaceDependency, WorkspaceStatus};
use crate::git;
use crate::pty::handle::PtyHandle;
use crate::pty::{PtyEvent, TaskRuntime};
use crate::store::{BoardRepo, RepositoryRepo, WorkspaceRepo, WorkspaceUpdate};

use super::cli_tokens::{CliSpawnConfig, CliTokenRegistry};
use super::error::OrchestratorError;
use super::liveness::{classify, DerivedState, LivenessThresholds, CPU_BUSY_THRESHOLD_NS, LIVENESS_POLL_INTERVAL};
use super::repo_locks::RepoLockRegistry;
use super::personas;
use super::scheduler::{
    augment_prompt, brief_prompt_pointer, cli_commands_prompt_segment, consumer_prompt_prefix,
    contract_file_is_ready, epic_docs_prompt_pointer, incoming_producer_ids, is_producer,
    producer_prompt_suffix, ready_subtask_ids, ContractSeed, SchedulerConfig,
};
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
    /// The stored lifecycle status — UNCHANGED. There is deliberately no
    /// `Wedged`/`Idle` stored variant (spec validation #1); those live only
    /// on `derived_state`.
    pub status: WorkspaceStatus,
    pub exit_code: Option<i64>,
    /// Honest status (E0). `Some` on liveness-poller transitions
    /// (`Working`/`Idle`/`Wedged`) and on exit-watcher terminal events
    /// (`Done`/`Failed`); `None` on the plain lifecycle transitions
    /// (pending→running, →stopped) so those stay additive and the existing
    /// frontend keeps working untouched.
    pub derived_state: Option<DerivedState>,
    /// Raw wall-clock timestamp of the agent's last output, carried on
    /// poller transitions so the frontend can count "Ns ago" upward locally
    /// between events (no per-second bus traffic).
    pub last_activity_at: Option<DateTime<Utc>>,
    /// E-P1: the agent's process subtree was burning CPU over the last poll
    /// interval — the reason a quiet agent can honestly stay `Working`
    /// ("busy, no output"). Always `false` on non-poller events and whenever
    /// the sampler degrades (no pid / non-macOS / sampling failure) — the
    /// sensor only ever ADDS confidence.
    pub busy: bool,
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

/// The CLI seam (CLI1 / §R5/§J3): the shared token registry + the two runtime
/// paths (`PHASR_BIN`/`PHASR_SOCK`) the scheduler injects so a spawned subtask's
/// agent can advance its OWN board via `phasr <verb>`. Present in production (set
/// at boot via `with_cli`); `None` under `cargo test`, so scheduled spawns inject
/// NOTHING and stay byte-identical to pre-CLI behavior.
#[derive(Clone)]
pub(crate) struct CliSeam {
    pub(crate) tokens: Arc<CliTokenRegistry>,
    pub(crate) config: CliSpawnConfig,
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
    cli: Option<CliSeam>,
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
            // Off by default: only `with_cli` (called once at app boot) turns on
            // per-subtask token minting + PHASR_* env injection. Tests never set
            // it → scheduled spawns are unchanged.
            cli: None,
        }
    }

    /// Turn on the CLI seam (CLI1): from now on `spawn_ready_subtask` mints a
    /// per-subtask token in `tokens` and injects `PHASR_BIN`/`PHASR_SOCK`/
    /// `PHASR_TOKEN` + the "commands you can run" prompt segment, and the
    /// exit-watcher invalidates the token on subtask exit. Called once from
    /// `lib.rs::initialize_database_state`; the SAME `tokens` Arc is shared with
    /// the IPC server so mint (here) and resolve (there) see one map.
    pub fn with_cli(mut self, tokens: Arc<CliTokenRegistry>, config: CliSpawnConfig) -> Self {
        self.cli = Some(CliSeam { tokens, config });
        self
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
            // A standalone agent gets no CLI env — only decomposition subtasks
            // (spawn_ready_subtask) advance a board, so only they get PHASR_* (§J3).
            Vec::new(),
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.clone(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
            // Lifecycle transition only — the liveness poller emits the first
            // `Working` derived state on its next tick.
            derived_state: None,
            last_activity_at: None,
            busy: false,
        });

        self.spawn_exit_watcher(task_id.clone(), updated.repository_id.clone(), pty_handle);

        Ok(StartedTask {
            task_id,
            workspace: updated,
        })
    }

    /// Stop a running task. Commits `stopped` **before** signalling the
    /// child, then sends SIGINT (gives the agent a chance to exit cleanly —
    /// Claude/Codex/Cursor all clean up state on SIGINT) and escalates to
    /// SIGKILL after `SIGINT_GRACE` if the child is still alive. The worktree
    /// is preserved — only `delete_task` removes it.
    ///
    /// Ordering matters (a fixed TOCTOU): SIGINT wakes the exit-watcher,
    /// whose flip is guarded on `status = running`. By committing `stopped`
    /// first we guarantee the watcher reads a non-running row and leaves the
    /// user's stop intact — a user-stopped task must **never** flash `failed`
    /// (the child dies on our SIGINT with a nonzero code), which is exactly
    /// the dishonest state Step 0 exists to prevent. `spawn_exit_watcher`'s
    /// atomic conditional flip is the belt to this suspenders.
    pub async fn stop_task(&self, task_id: &str) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;

        // Commit `stopped` FIRST, before any signal that could wake the
        // exit-watcher. A live handle implies a `running` row (both
        // `start_task` and `open_terminal` set `running` before the spawn),
        // so this transition is always valid here.
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

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id,
            status: WorkspaceStatus::Stopped,
            exit_code: None,
            derived_state: None,
            last_activity_at: None,
            busy: false,
        });
        Ok(())
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
            // Resuming a terminal re-attaches the existing task; the CLI env is
            // seeded once at the scheduler spawn, not on every re-open.
            Vec::new(),
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
            derived_state: None,
            last_activity_at: None,
            busy: false,
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

    /// Re-engage the agent for `task_id` with review change-request feedback by
    /// typing it into the agent's LIVE PTY as a follow-up prompt (paste-framed +
    /// submitted, like the spawn-time hand-off — see `PtyHandle::paste_and_submit`).
    /// Returns `true` when a live PTY received it, `false` when the agent had
    /// already exited (nothing to type into).
    ///
    /// This is what makes the review "request changes" gate actually re-drive the
    /// producing agent instead of stalling the ticket at `changes-requested`. The
    /// PTY is keyed on the subtask id — the same id the scheduler spawned it under
    /// — so the caller passes the reviewed subtask's id verbatim. `claude`
    /// interactive never self-exits, so the common case IS a live PTY; a `false`
    /// (a one-shot agent that finished, or a stopped one) is the caller's cue to
    /// record an honest "re-run to apply changes" note rather than silently drop
    /// the feedback. Best-effort: a write race with an exiting child degrades to
    /// `false` rather than surfacing as an error on the bounce.
    pub fn deliver_rework_feedback(&self, task_id: &str, feedback: &str) -> bool {
        match self.runtime.get(task_id) {
            Some(handle) => handle.paste_and_submit(feedback).is_ok(),
            None => false,
        }
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
        // Invalidate the subtask's CLI token when its process exits, so a dead
        // agent's `PHASR_TOKEN` can't be replayed (§R5). A no-op for standalone
        // agents (never minted) and under test (no CLI seam).
        let cli = self.cli.clone();

        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(PtyEvent::Output { .. }) => continue,
                    Ok(PtyEvent::Exit { exit_code, .. }) => {
                        if let Some(cli) = &cli {
                            cli.tokens.invalidate_subtask(&task_id);
                        }
                        let next = if exit_code == Some(0) {
                            WorkspaceStatus::Completed
                        } else {
                            WorkspaceStatus::Failed
                        };
                        // Atomic conditional flip: only `running` → terminal,
                        // in one statement. `None` means the row already left
                        // `running` — a concurrent `stop_task` won the race, so
                        // leave the user's `stopped` intact and emit nothing.
                        // This can't clobber a stop the way a read-then-write
                        // `get()` + `update()` could.
                        let flipped = workspaces
                            .finish_if_running(&task_id, next, exit_code)
                            .await
                            .ok()
                            .flatten();
                        runtime.drop_task(&task_id);
                        if flipped.is_some() {
                            let _ = status_tx.send(TaskStatusEvent {
                                task_id: task_id.clone(),
                                repository_id: repository_id.clone(),
                                status: next,
                                exit_code,
                                // Honest status (E0): the terminal derived state
                                // (Done/Failed) rides the same event. Additive —
                                // consumers keying off `status` are unaffected.
                                derived_state: Some(DerivedState::for_exit(exit_code)),
                                last_activity_at: None,
                                busy: false,
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

    /// Start the single liveness poller (E0-T3). Mirrors the
    /// subscribe-never-block shape of `spawn_exit_watcher`: a background
    /// `tokio::interval` that samples every running agent's in-memory
    /// `last_activity` stamp and broadcasts derived-state *transitions* over
    /// the same status channel. One poller per orchestrator; started once at
    /// app boot from `lib.rs::initialize_database_state`.
    pub fn spawn_liveness_poller(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            let thresholds = LivenessThresholds::default();
            // Per-task memory of the last derived state so we only emit on a
            // change — the bus carries transitions, never one event per tick.
            let mut last_derived: HashMap<String, DerivedState> = HashMap::new();
            // E-P1: per-task cumulative subtree CPU ns from the previous tick,
            // so each pass measures a DELTA over one poll interval.
            let mut last_cpu_ns: HashMap<String, u64> = HashMap::new();
            let mut interval = tokio::time::interval(LIVENESS_POLL_INTERVAL);
            loop {
                interval.tick().await;
                this.run_liveness_tick(&mut last_derived, &mut last_cpu_ns, &thresholds)
                    .await;
            }
        });
    }

    /// One poll pass: classify every running *agent* row and broadcast the
    /// ones whose derived state changed since last tick. Reads only the
    /// in-memory activity stamp — **zero writes to the DB from this path**.
    /// Factored out of the loop so tests can drive it deterministically with
    /// injected thresholds instead of waiting on the real 5 s / 60 s / 180 s
    /// clock.
    async fn run_liveness_tick(
        &self,
        last_derived: &mut HashMap<String, DerivedState>,
        last_cpu_ns: &mut HashMap<String, u64>,
        thresholds: &LivenessThresholds,
    ) {
        let running = match self.workspaces.list_by_status(WorkspaceStatus::Running).await {
            Ok(rows) => rows,
            Err(err) => {
                log::warn!("liveness poll: failed to list running workspaces: {err}");
                return;
            }
        };

        let now_ms = Utc::now().timestamp_millis();
        let mut still_running: HashSet<String> = HashSet::new();

        for workspace in running {
            // Only PTY-backed agent kinds have an activity story. A `subtask`
            // is a real agent exactly like a standalone `Agent`, so it MUST be
            // classified here (spec claim #3 / LANDMINE #1 — the old
            // `!= Agent` filter silently skipped subtasks, so a wedged subtask
            // card never showed honest status). A `local` workspace has no
            // liveness model and a `parent` row has no PTY, so both are skipped.
            if !workspace.workspace_kind.runs_agent() {
                continue;
            }
            let task_id = workspace.id.clone();
            still_running.insert(task_id.clone());

            // A running row with no live PTY = an orphan → classify() reads it
            // as Wedged, never a confident Working.
            let (has_handle, last_activity_ms, pid) = match self.runtime.get(&task_id) {
                Some(handle) => (true, handle.last_activity_ms(), handle.pid()),
                None => (false, now_ms, None),
            };
            // E-P1: subtree CPU delta over the last poll. First sample for a
            // task establishes the baseline (busy=false); any degrade (no pid,
            // sampler failure, non-macOS) is busy=false — P0 behavior exactly.
            let cpu_busy = match pid.and_then(super::cpu_macos::sample_subtree_cpu_ns) {
                Some(total) => match last_cpu_ns.insert(task_id.clone(), total) {
                    Some(prev) => total.saturating_sub(prev) > CPU_BUSY_THRESHOLD_NS,
                    None => false,
                },
                None => {
                    last_cpu_ns.remove(&task_id);
                    false
                }
            };
            let elapsed = Duration::from_millis((now_ms - last_activity_ms).max(0) as u64);
            let derived = classify(elapsed, has_handle, cpu_busy, thresholds);

            if last_derived.get(&task_id) != Some(&derived) {
                last_derived.insert(task_id.clone(), derived);
                self.broadcast_status(TaskStatusEvent {
                    task_id,
                    repository_id: workspace.repository_id,
                    status: WorkspaceStatus::Running, // stored status unchanged
                    exit_code: None,
                    derived_state: Some(derived),
                    last_activity_at: DateTime::<Utc>::from_timestamp_millis(last_activity_ms),
                    busy: cpu_busy,
                });
            }
        }

        // Forget tasks that have left `running` (exit/stop) so the maps can't
        // grow without bound and a later re-run of the same id starts fresh.
        last_derived.retain(|task_id, _| still_running.contains(task_id));
        last_cpu_ns.retain(|task_id, _| still_running.contains(task_id));
    }

    // ===== Scheduler (E2-T2): dependency-aware fan-out =====

    /// Start the single decomposition scheduler. Mirrors
    /// `spawn_liveness_poller` exactly: ONE background `tokio::interval` task,
    /// started once at app boot from `lib.rs::initialize_database_state`. It is
    /// an additive DB/contract-file consumer that spawns ready subtasks — no
    /// writes to the PTY hot path (spec claim #8). The initial ready set (the
    /// root `backend`) spawns within one interval of `start_decomposition`
    /// writing the DAG; no direct nudge is needed (polling picks it up).
    pub fn spawn_scheduler(&self, board: BoardRepo) {
        let this = self.clone();
        tokio::spawn(async move {
            let config = SchedulerConfig::default();
            let mut interval = tokio::time::interval(config.poll_interval);
            loop {
                interval.tick().await;
                this.run_scheduler_tick(&board, &config).await;
            }
        });
    }

    /// Build + start the autopilot driver (Phase 5a S4). The counterpart to
    /// `spawn_scheduler`, but for the FULL gate ladder rather than just spawn: it
    /// auto-advances Validate → Request-review and auto-integrates a fully-approved,
    /// clean epic, parking hard at every human-judgment / outward edge. Owns the
    /// runtime clone (for the I3 liveness read) + the shared per-parent lock map +
    /// the durable last-fired markers, and starts its three trigger paths (event +
    /// 3s backstop UNGATED by `has_work` + boot sweep). Called once at app boot
    /// from `lib.rs::initialize_database_state`.
    pub fn spawn_autopilot_driver(
        &self,
        board: BoardRepo,
        run_commands: crate::store::RunCommandRepo,
        write_registry: Arc<crate::tickets::TicketWriteRegistry>,
        board_events: Arc<super::board_events::BoardEventBus>,
        autopilot_state: crate::store::AutopilotStateRepo,
    ) {
        let driver = Arc::new(
            super::autopilot::AutopilotDriver::new(
                self.workspaces.clone(),
                board,
                self.repositories.clone(),
                run_commands,
                self.repo_locks.clone(),
                write_registry,
                board_events,
                autopilot_state,
                self.runtime.clone(),
            )
            // Stage B: the reviewer spawn injects PHASR_* like any producer
            // spawn — same seam, `None` under cargo test.
            .with_cli_seam(self.cli.clone()),
        );
        driver.spawn();
    }

    /// One scheduler pass. For every active decomposition parent:
    ///   1. Bridge any newly-published contract FILE into a
    ///      `workspace_contracts` row (the file→DB bridge, B3) — this is what
    ///      flips a producer's outgoing edges from unsatisfied → satisfied.
    ///   2. Re-read contracts, derive the READY set (pending + every incoming
    ///      edge satisfied), and spawn each ready subtask under the per-repo
    ///      lock with its handoff prompt seeded (B5), capped at `max_concurrent`
    ///      in-flight via a `tokio::Semaphore`.
    /// Factored out of the loop so tests drive it directly with an injected
    /// config (hand-driven tick, tiny cap, a tempdir contract root) instead of
    /// the 3 s clock — exactly like `run_liveness_tick`.
    async fn run_scheduler_tick(&self, board: &BoardRepo, config: &SchedulerConfig) {
        let parents = match self.workspaces.list_parents().await {
            Ok(parents) => parents,
            Err(err) => {
                log::warn!("scheduler: failed to list parents: {err}");
                return;
            }
        };
        if parents.is_empty() {
            return;
        }

        let now = Utc::now();
        // Gather per-parent state and the GLOBAL count of already-running
        // subtasks — the concurrency cap is app-wide, not per-parent.
        let mut plans: Vec<ParentPlan> = Vec::new();
        let mut running_now = 0usize;
        for parent in parents {
            let subtasks = match self.workspaces.list_by_parent(&parent.id).await {
                Ok(subtasks) => subtasks,
                Err(err) => {
                    log::warn!("scheduler: list_by_parent({}) failed: {err}", parent.id);
                    continue;
                }
            };
            // Skip a parent whose subtasks have all left pending/running — there
            // is nothing to bridge or spawn (a fully done/dead decomposition).
            let has_work = subtasks
                .iter()
                .any(|s| matches!(s.status, WorkspaceStatus::Pending | WorkspaceStatus::Running));
            if !has_work {
                continue;
            }

            // 1. File→DB bridge FIRST, so a contract published this tick already
            //    counts toward edge-satisfaction below (same-tick handoff).
            self.bridge_published_contracts(board, &parent.id, &subtasks, config, now)
                .await;

            let deps = match board.list_dependencies(&parent.id).await {
                Ok(deps) => deps,
                Err(err) => {
                    log::warn!("scheduler: list_dependencies({}) failed: {err}", parent.id);
                    continue;
                }
            };
            // Re-read contracts AFTER the bridge — the just-published row is now
            // visible to the ready derivation.
            let contracts = match board.list_contracts(&parent.id).await {
                Ok(contracts) => contracts,
                Err(err) => {
                    log::warn!("scheduler: list_contracts({}) failed: {err}", parent.id);
                    continue;
                }
            };

            running_now += subtasks
                .iter()
                .filter(|s| s.status == WorkspaceStatus::Running)
                .count();
            plans.push(ParentPlan {
                parent,
                subtasks,
                deps,
                contracts,
            });
        }

        // Concurrency cap: only `max_concurrent - already_running` NEW subtasks
        // may spawn this tick. A `tokio::Semaphore` is the gate (spec §D);
        // permits are `forget`-ted so the count holds across the tick's
        // sequential spawns. Zero slots → nothing spawns until a running subtask
        // frees one (its row leaves `running`), re-derived next tick.
        let available = config.max_concurrent.saturating_sub(running_now);
        let slots = Semaphore::new(available);

        for plan in &plans {
            let ready = ready_subtask_ids(&plan.subtasks, &plan.deps, &plan.contracts);
            for subtask_id in ready {
                let Some(subtask) = plan.subtasks.iter().find(|s| s.id == subtask_id) else {
                    continue;
                };
                match slots.try_acquire() {
                    Ok(permit) => permit.forget(),
                    // Cap reached for this tick — the rest wait for a free slot.
                    Err(_) => return,
                }
                if let Err(err) = self
                    .spawn_ready_subtask(&plan.parent, subtask, &plan.deps, &plan.contracts, config)
                    .await
                {
                    log::warn!(
                        "scheduler: failed to spawn subtask {} ({:?}): {err}",
                        subtask.id, subtask.role
                    );
                }
            }
        }
    }

    /// The file→DB bridge (B3): for each subtask whose contract FILE now exists
    /// and is non-empty, ensure a *published* `workspace_contracts` row exists.
    /// This is what satisfies a producer's outgoing edges. Idempotent — an
    /// already-published contract is skipped; a row that exists but is
    /// unpublished (e.g. seeded by the manual override before the file settled)
    /// is stamped. Detection keys off the deterministic
    /// `<parent>/contracts/<role>.md` path, so no dir scan + reverse-map.
    async fn bridge_published_contracts(
        &self,
        board: &BoardRepo,
        parent_id: &str,
        subtasks: &[Workspace],
        config: &SchedulerConfig,
        now: DateTime<Utc>,
    ) {
        for subtask in subtasks {
            let Some(role) = subtask.role.as_deref() else {
                continue;
            };
            let path = config.contract_file(parent_id, role);
            if !contract_file_is_ready(&path, config.min_contract_bytes) {
                continue;
            }
            match board.find_contract(&subtask.id).await {
                // Already published — the edge is already satisfied, nothing to do.
                Ok(Some(existing)) if existing.published_at.is_some() => {}
                // A row exists but isn't published yet — stamp it (bridge firing).
                Ok(Some(existing)) => {
                    if let Err(err) = board.mark_contract_published(&existing.id, now).await {
                        log::warn!("scheduler: mark_contract_published failed: {err}");
                    }
                }
                // No row yet — mirror the file as a freshly-published contract.
                Ok(None) => {
                    let mut contract = WorkspaceContract::new(
                        parent_id.to_string(),
                        subtask.id.clone(),
                        role.to_string(),
                        path.to_string_lossy().into_owned(),
                    );
                    contract.published_at = Some(now);
                    if let Err(err) = board.insert_contract(&contract).await {
                        log::warn!("scheduler: insert_contract failed: {err}");
                    }
                }
                Err(err) => log::warn!("scheduler: find_contract failed: {err}"),
            }
        }
    }

    /// True while this task id owns a live PTY. The human-bounce respawn path
    /// probes this AFTER `resolve_review` ran: a live handle means the change
    /// request was typed into the running agent, a dead one means the ticket
    /// needs `respawn_for_rework`.
    pub fn has_live_task(&self, task_id: &str) -> bool {
        self.runtime.get(task_id).is_some()
    }

    /// Manually start ONE ready subtask now — the human Start gate (Phase 5 of
    /// the completion program). The scheduler owns routine spawning; this is
    /// the explicit override for "I want THIS ticket running now", so it
    /// deliberately bypasses the tick cap. The caller (commands/board.rs)
    /// verified readiness (Pending + every incoming edge satisfied) — the
    /// status guard + `spawn_ready_subtask`'s under-lock idempotency re-check
    /// still make a scheduler race harmless (one of the two spawns no-ops).
    pub async fn start_subtask_now(
        &self,
        parent: &Workspace,
        subtask: &Workspace,
        deps: &[WorkspaceDependency],
        contracts: &[WorkspaceContract],
        config: &SchedulerConfig,
    ) -> Result<(), OrchestratorError> {
        if subtask.status != WorkspaceStatus::Pending {
            return Err(OrchestratorError::AlreadyFinished(
                subtask.status.as_str().into(),
            ));
        }
        self.spawn_ready_subtask(parent, subtask, deps, contracts, config)
            .await
    }

    /// Re-spawn an EXITED producer to act on a human bounce (Phase 5). The
    /// agent re-enters its OWN worktree (`cwd_for_task` recreates a missing
    /// one) running its persisted command — the original brief/handoff prompt
    /// is already baked into `workspace.command` by `spawn_ready_subtask` —
    /// and the CHANGE REQUEST rides as the delivered initial prompt (the same
    /// TUI-ready delivery a fresh spawn uses). The CLI grant is re-minted
    /// (minting for the same subtask invalidates the old token, §R5).
    ///
    /// Guarded to the dead-PTY case: a live handle means the pipe path already
    /// delivered, so this no-ops rather than double-spawn. Autopilot NEVER
    /// calls this — re-work stays a human decision (Stage A §2).
    pub async fn respawn_for_rework(
        &self,
        task_id: &str,
        feedback: &str,
    ) -> Result<(), OrchestratorError> {
        if self.runtime.get(task_id).is_some() {
            return Ok(());
        }
        let workspace = self.workspaces.get(task_id).await?;
        let cwd = self.cwd_for_task(&workspace).await?;

        let prompt = format!(
            "## Change requested\n\nThe reviewer bounced this ticket back with \
             the following change request:\n\n{feedback}\n\nAct on it in this \
             worktree — your brief and earlier instructions still stand (re-read \
             the ticket brief if you need the full context). When the rework is \
             done, hand off again: validate and re-request review."
        );

        // Re-mint the CLI grant so the respawned producer can self-advance the
        // board again (mint-for-same-subtask invalidates the previous token).
        let cli_env = match &self.cli {
            Some(cli) => match self.workspaces.owner_id(task_id).await.ok().flatten() {
                Some(user_id) => {
                    let parent_id = workspace.parent_id.clone().unwrap_or_default();
                    let token = cli.tokens.mint(task_id, &user_id, &parent_id);
                    vec![
                        (
                            "PHASR_BIN".to_string(),
                            cli.config.bin_path.to_string_lossy().into_owned(),
                        ),
                        (
                            "PHASR_SOCK".to_string(),
                            cli.config.socket_path.to_string_lossy().into_owned(),
                        ),
                        ("PHASR_TOKEN".to_string(), token),
                    ]
                }
                None => Vec::new(),
            },
            None => Vec::new(),
        };

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

        let command = if workspace.command.trim().is_empty() {
            None
        } else {
            Some(workspace.command.clone())
        };
        let handle =
            self.runtime
                .spawn(task_id.to_string(), command, Some(prompt), cwd, 24, 80, cli_env)?;

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
            derived_state: None,
            last_activity_at: None,
            busy: false,
        });
        self.spawn_exit_watcher(task_id.to_string(), updated.repository_id, handle);
        Ok(())
    }

    /// Spawn one READY subtask: mint its worktree+branch, seed its handoff
    /// prompt (B5), transition it `Pending → Running`, spawn its PTY, and attach
    /// the exit-watcher. REUSES `start_task`'s spawn internals verbatim (the
    /// per-repo F6 lock, `create_worktree`, `runtime.spawn`, `spawn_exit_watcher`,
    /// the status broadcast). The ONLY deltas: the row already EXISTS (the gate
    /// wrote it `Pending`), so we UPDATE rather than insert; and the prompt is
    /// augmented with the contract handoff.
    async fn spawn_ready_subtask(
        &self,
        parent: &Workspace,
        subtask: &Workspace,
        deps: &[WorkspaceDependency],
        contracts: &[WorkspaceContract],
        config: &SchedulerConfig,
    ) -> Result<(), OrchestratorError> {
        // A subtask with no role is malformed — the gate always stamps one, so
        // this is a defensive skip, never a real path.
        let Some(role) = subtask.role.clone() else {
            return Ok(());
        };

        let repository = self.repositories.get(&subtask.repository_id).await?;
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
        let base_ref = repository.default_branch.clone();

        // Build the handoff-seeded prompt (B5) BEFORE taking the lock — it reads
        // the predecessors' contract files (pure I/O, no shared-`.git`
        // contention):
        //   - PRODUCER → append the "write your contract to <path>" instruction.
        //   - CONSUMER → prepend each satisfied predecessor's contract CONTENTS.
        let producer_suffix = if is_producer(&subtask.id, deps) {
            // Create the contract dir BEFORE the agent runs, so writing the
            // handoff file is a plain write into an existing directory — a
            // strict agent that won't `mkdir -p` an absolute out-of-worktree
            // path still succeeds. Best-effort: publish_contract also
            // create_dir_all's as a fallback, and Claude's writer auto-creates
            // parents, so a transient failure here isn't fatal to the spawn.
            let _ = std::fs::create_dir_all(config.contract_dir(&parent.id));
            Some(producer_prompt_suffix(&config.contract_file(&parent.id, &role)))
        } else {
            None
        };
        let seeds = gather_contract_seeds(&subtask.id, deps, contracts);
        let consumer_prefix = if seeds.is_empty() {
            None
        } else {
            Some(consumer_prompt_prefix(&seeds))
        };

        // Brief pointer (T3): name the ticket's brief files on the MAIN checkout
        // (`repository_path` is `repository.local_path`, NOT the worktree). The
        // dir is scaffolded at decompose (T2); we best-effort `create_dir_all`
        // here too — mirroring the contract-dir precreate above — so the paths
        // the pointer names always exist, then ALWAYS include the pointer once
        // the dir is scaffolded (an empty brief is not an error, architect #5).
        let brief = crate::tickets::ensure_ticket_dir(&repository_path, &subtask.id)
            .map(|ticket_dir| brief_prompt_pointer(&ticket_dir))
            .ok();

        // CLI seam (CLI1 / §J3): resolve the subtask's owner ONCE here (a pure
        // read, before the lock) — it gates BOTH the "commands you can run" prompt
        // segment and (below) the PHASR_* env injection, so an agent is only told
        // about `phasr` when it actually has a token. `None` when the CLI is off
        // (tests) or the row is ownerless → nothing injected, byte-identical spawn.
        let owner_id = match &self.cli {
            Some(_) => self.workspaces.owner_id(&subtask.id).await.ok().flatten(),
            None => None,
        };
        // Prepend the CLI orientation block to the brief slot (both are read-only
        // orientation), leaving the rest of the composition order untouched.
        let brief = match (owner_id.as_ref().map(|_| cli_commands_prompt_segment()), brief) {
            (Some(cli), Some(b)) => Some(format!("{cli}{b}")),
            (Some(cli), None) => Some(cli),
            (None, b) => b,
        };

        // Epic-docs inheritance (Phase 2b E4): every subtask of `parent` shares
        // ONE PRD/TRD/design at `<repo>/.phasr/epics/<parent.id>/`, read by
        // absolute path on the MAIN checkout (same reach-not-copy mechanism as
        // the ticket brief, A3). Prepend it to the FRONT of the brief slot so
        // shared context leads the per-ticket brief. Emit the pointer ONLY when
        // the epic actually has docs on disk — a doc-less epic stays byte-identical
        // (no empty-file pointer). Derived from `parent.id`, so a CLI-added sibling
        // (claim 11) or a re-decompose inherits with zero extra wiring.
        let brief = match crate::tickets::epic_dir(&repository_path, &parent.id) {
            Ok(epic_dir) if crate::tickets::epic_has_docs(&repository_path, &parent.id) => {
                let epic = epic_docs_prompt_pointer(&epic_dir);
                Some(match brief {
                    Some(b) => format!("{epic}{b}"),
                    None => epic,
                })
            }
            _ => brief,
        };

        // Leading segment: the role persona (Phase 4) followed IMMEDIATELY by the
        // ticket's own task, clearly labeled. The task rides at the FRONT (right
        // behind the role) instead of the `base` slot, so the agent — and anyone
        // reading the terminal — sees WHAT to build before the contract/brief/CLI
        // orientation, rather than it being buried mid-prompt after the CLI block.
        // Both parts derive purely from `role`/`subtask.prompt`, so an unmatched
        // role or a blank prompt just drops its part (a fully-empty lead → None).
        let persona = personas::persona_for_role(&role).map(|p| p.trim().to_string());
        let task = subtask
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| format!("## Your task\n\n{p}"));
        let lead = match (persona, task) {
            (Some(p), Some(t)) => Some(format!("{p}\n\n---\n\n{t}\n\n---\n\n")),
            (Some(p), None) => Some(format!("{p}\n\n---\n\n")),
            (None, Some(t)) => Some(format!("{t}\n\n---\n\n")),
            (None, None) => None,
        };

        let augmented_prompt = augment_prompt(
            // The task now LEADS (folded into `lead`), so the `base` slot is empty.
            None,
            brief.as_deref(),
            producer_suffix.as_deref(),
            consumer_prefix.as_deref(),
            lead.as_deref(),
        );

        // Interpolate the stored command template with the augmented prompt,
        // exactly as start_task does (a `{{prompt}}` template gets the prompt
        // baked in; a seeded-preset template comes back verbatim).
        let interpolated = interpolate_for_task(&subtask.command, augmented_prompt.as_deref());

        // --- everything that touches the shared `.git` under the per-repo lock ---
        let lock = self.repo_locks.for_repository(&subtask.repository_id);
        let guard = lock.lock().await;

        // Idempotency (spec E2-T2): re-read the active subtask for
        // `(parent, role)` UNDER the lock. If a prior tick already flipped it to
        // `running`, or it is no longer the same pending row, DO NOTHING — a
        // re-tick can't mint a second worktree/branch/PTY. This is the
        // scheduler's twin of start_task's `find_active_by_name` dedup, keyed on
        // `(parent_id, role)` (never name, spec claim #2).
        let still_pending = matches!(
            self.workspaces.find_active_subtask(&parent.id, &role).await?,
            Some(current) if current.status == WorkspaceStatus::Pending && current.id == subtask.id
        );
        if !still_pending {
            drop(guard);
            return Ok(());
        }

        let slug = git::slugify(&subtask.name);
        let branch_seed = git::default_branch_name(&slug, git::short_id(&subtask.id));
        let branch =
            git::unique_branch_name(&repository_path, &branch_seed, git::short_id(&subtask.id));
        let worktree_path = git::default_worktree_base_path().join(&subtask.id);
        git::create_worktree(&repository_path, &worktree_path, &branch, &base_ref)?;

        // Persist branch/worktree + the seeded command/prompt and transition to
        // running — still under the lock, so the idempotency re-check above stays
        // valid against a concurrent tick.
        let started_at = Utc::now();
        let updated = self
            .workspaces
            .update(
                &subtask.id,
                WorkspaceUpdate {
                    command: Some(interpolated.clone()),
                    prompt: Some(augmented_prompt.clone()),
                    branch: Some(Some(branch)),
                    worktree_path: Some(Some(worktree_path.to_string_lossy().into_owned())),
                    status: Some(WorkspaceStatus::Running),
                    started_at: Some(Some(started_at)),
                    ..Default::default()
                },
            )
            .await?;

        // Release before the PTY spawn/broadcast — those touch only this
        // subtask's own row/process, not the shared `.git` (start_task's order).
        drop(guard);

        // Mint the per-subtask CLI token + assemble its PHASR_* env NOW — AFTER the
        // idempotency check confirmed this tick owns the spawn, so a bailed re-tick
        // never re-mints (and thus never invalidates) a live token (§R5). Empty
        // when the CLI is off (tests) or the row is ownerless.
        let cli_env = match (&self.cli, owner_id.as_deref()) {
            (Some(cli), Some(user_id)) => {
                let token = cli.tokens.mint(&subtask.id, user_id, &parent.id);
                vec![
                    (
                        "PHASR_BIN".to_string(),
                        cli.config.bin_path.to_string_lossy().into_owned(),
                    ),
                    (
                        "PHASR_SOCK".to_string(),
                        cli.config.socket_path.to_string_lossy().into_owned(),
                    ),
                    ("PHASR_TOKEN".to_string(), token),
                ]
            }
            _ => Vec::new(),
        };

        let pty_handle = self.runtime.spawn(
            subtask.id.clone(),
            Some(interpolated),
            augmented_prompt,
            worktree_path,
            24,
            80,
            cli_env,
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: subtask.id.clone(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
            // Lifecycle transition only — the liveness poller emits the first
            // `Working` derived state for this subtask on its next tick (it is a
            // real agent kind, `runs_agent()`).
            derived_state: None,
            last_activity_at: None,
            busy: false,
        });

        self.spawn_exit_watcher(subtask.id.clone(), updated.repository_id.clone(), pty_handle);
        Ok(())
    }
}

/// Per-parent state gathered in one scheduler tick: the parent row, its
/// subtasks, the DAG edges, and the (post-bridge) published contracts. Kept
/// local to the scheduler so the tick can compute the ready set + seed prompts
/// without re-querying per subtask.
struct ParentPlan {
    parent: Workspace,
    subtasks: Vec<Workspace>,
    deps: Vec<WorkspaceDependency>,
    contracts: Vec<WorkspaceContract>,
}

/// Read the published contract CONTENTS for each satisfied predecessor of
/// `subtask_id`, to seed into a consumer's prompt (B5). Skips a predecessor
/// whose contract row is unpublished or whose file can't be read — a partial
/// handoff is better than blocking forever on a transient read error.
fn gather_contract_seeds(
    subtask_id: &str,
    deps: &[WorkspaceDependency],
    contracts: &[WorkspaceContract],
) -> Vec<ContractSeed> {
    let mut seeds = Vec::new();
    for producer_id in incoming_producer_ids(subtask_id, deps) {
        let Some(contract) = contracts
            .iter()
            .find(|c| c.subtask_id == producer_id && c.published_at.is_some())
        else {
            continue;
        };
        match std::fs::read_to_string(&contract.contract_path) {
            Ok(content) => seeds.push(ContractSeed {
                role: contract.role.clone(),
                content,
            }),
            Err(err) => log::warn!(
                "scheduler: failed to read contract {}: {err}",
                contract.contract_path
            ),
        }
    }
    seeds
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

    // --- Honest status (E0-T3 / E0-T4) ---

    /// Return the next status event carrying a derived state, skipping the
    /// plain lifecycle events (which have `derived_state: None`). `None` when
    /// the channel is drained.
    fn try_recv_derived(
        rx: &mut broadcast::Receiver<TaskStatusEvent>,
    ) -> Option<TaskStatusEvent> {
        loop {
            match rx.try_recv() {
                Ok(ev) if ev.derived_state.is_some() => return Some(ev),
                Ok(_) => continue,
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Empty)
                | Err(broadcast::error::TryRecvError::Closed) => return None,
            }
        }
    }

    fn drain_pending(rx: &mut broadcast::Receiver<TaskStatusEvent>) {
        while rx.try_recv().is_ok() {}
    }

    /// Wait for the shell's startup output (prompt + the typed initial
    /// command) to flush and go quiet, so a backdated activity stamp can't be
    /// clobbered by a late chunk. Requires stability AND that we're past the
    /// +300ms initial-command typing window `PtyHandle::spawn` schedules.
    async fn settle(handle: &Arc<PtyHandle>) {
        let start = std::time::Instant::now();
        let mut prev = handle.last_activity_ms();
        loop {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let cur = handle.last_activity_ms();
            let stable = cur == prev;
            prev = cur;
            if stable && start.elapsed() >= Duration::from_millis(750) {
                break;
            }
            if start.elapsed() >= Duration::from_secs(6) {
                break; // safety valve — never hang the suite
            }
        }
    }

    // E0-T3: a genuinely silent agent crosses Working→Idle→Wedged purely on
    // the timer (NO output event drives it), and each transition is emitted
    // EXACTLY once, not once per tick. Deterministic: we backdate the handle's
    // in-memory activity stamp and drive `run_liveness_tick` directly with 1s
    // /2s test thresholds instead of sleeping 60s/180s.
    #[tokio::test]
    async fn poller_emits_idle_then_wedged_transition_once() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;

        let started = orchestrator
            .start_task(sleep_request(&repo.id, "quiet"))
            .await
            .unwrap();
        let task_id = started.task_id.clone();
        let handle = orchestrator
            .runtime
            .get(&task_id)
            .expect("a freshly-started task has a live handle");
        settle(&handle).await;

        let thresholds = LivenessThresholds {
            idle: Duration::from_secs(1),
            wedged: Duration::from_secs(2),
        };
        let mut last_derived: HashMap<String, DerivedState> = HashMap::new();
        let mut last_cpu: HashMap<String, u64> = HashMap::new();
        let mut rx = orchestrator.subscribe_status();
        drain_pending(&mut rx); // the `running` lifecycle event from start_task

        let now = Utc::now().timestamp_millis();

        // Silent ~1.5s → Idle. Two ticks; only the first is a transition.
        handle.set_last_activity_ms(now - 1_500);
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &thresholds)
            .await;
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &thresholds)
            .await;
        let idle = try_recv_derived(&mut rx).expect("an idle transition");
        assert_eq!(idle.derived_state, Some(DerivedState::Idle));
        assert_eq!(idle.status, WorkspaceStatus::Running, "stored status unchanged");
        assert_eq!(idle.task_id, task_id);
        assert!(
            idle.last_activity_at.is_some(),
            "a derived transition carries the raw last-activity ts"
        );
        assert!(
            try_recv_derived(&mut rx).is_none(),
            "idle must emit once, not per tick"
        );

        // Silent ~2.5s → Wedged. Again exactly one transition.
        handle.set_last_activity_ms(now - 2_500);
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &thresholds)
            .await;
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &thresholds)
            .await;
        let wedged = try_recv_derived(&mut rx).expect("a wedged transition");
        assert_eq!(wedged.derived_state, Some(DerivedState::Wedged));
        assert!(
            try_recv_derived(&mut rx).is_none(),
            "wedged must emit once, not per tick"
        );

        // Once the row leaves `running`, the poller drops it and emits nothing.
        orchestrator.stop_task(&task_id).await.unwrap();
        drain_pending(&mut rx); // the `stopped` lifecycle event (derived None)
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &thresholds)
            .await;
        assert!(
            try_recv_derived(&mut rx).is_none(),
            "a stopped task must not emit further derived events"
        );

        cleanup(&orchestrator, &[&started]).await;
    }

    // E0-T3 (the no-handle branch): a row that is `running` in the DB but has
    // no live PTY in the runtime — the exact shape of a stale/orphaned row —
    // classifies as Wedged, never a confident Working. Fully deterministic:
    // no spawn, no sleep.
    #[tokio::test]
    async fn poller_marks_running_row_without_handle_as_wedged() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        let mut orphan = Workspace::new(repo.id.clone(), "orphan".into(), "cmd".into());
        orphan.status = WorkspaceStatus::Running;
        workspaces.insert(&orphan).await.unwrap();

        let mut rx = orchestrator.subscribe_status();
        let thresholds = LivenessThresholds::default();
        let mut last_derived: HashMap<String, DerivedState> = HashMap::new();
        let mut last_cpu: HashMap<String, u64> = HashMap::new();
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &thresholds)
            .await;

        let ev = try_recv_derived(&mut rx).expect("a wedged transition for the orphan row");
        assert_eq!(ev.task_id, orphan.id);
        assert_eq!(ev.derived_state, Some(DerivedState::Wedged));
        assert_eq!(ev.status, WorkspaceStatus::Running);
    }

    // A `local` workspace, even a running one, has no PTY-driven liveness
    // model and must be ignored by the poller (never emits a derived state).
    #[tokio::test]
    async fn poller_ignores_local_workspaces() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        let mut local = Workspace::new(repo.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        local.status = WorkspaceStatus::Running;
        workspaces.insert(&local).await.unwrap();

        let mut rx = orchestrator.subscribe_status();
        let mut last_derived: HashMap<String, DerivedState> = HashMap::new();
        let mut last_cpu: HashMap<String, u64> = HashMap::new();
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &LivenessThresholds::default())
            .await;

        assert!(
            try_recv_derived(&mut rx).is_none(),
            "a local workspace must not get a derived liveness state"
        );
    }

    // LANDMINE #1 regression (spec claim #3): a `subtask` is a real PTY agent,
    // so the liveness poller MUST classify it — the twin of the name-dedup
    // landmine. Before the `runs_agent()` widening at the `:658` filter, a
    // `subtask` row was silently skipped (`!= Agent`), so a wedged subtask card
    // would never show honest status. A running subtask row with no live PTY
    // (the orphan shape) must classify as Wedged, exactly like an agent —
    // this test FAILS on the old `!= Agent` filter (no event) and passes now.
    #[tokio::test]
    async fn poller_includes_subtask_rows() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        let mut subtask = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        subtask.workspace_kind = WorkspaceKind::Subtask;
        subtask.parent_id = Some("parent-1".into());
        subtask.role = Some("backend".into());
        subtask.status = WorkspaceStatus::Running;
        workspaces.insert(&subtask).await.unwrap();

        let mut rx = orchestrator.subscribe_status();
        let mut last_derived: HashMap<String, DerivedState> = HashMap::new();
        let mut last_cpu: HashMap<String, u64> = HashMap::new();
        orchestrator
            .run_liveness_tick(&mut last_derived, &mut last_cpu, &LivenessThresholds::default())
            .await;

        let ev = try_recv_derived(&mut rx)
            .expect("a running subtask must get an honest derived liveness state");
        assert_eq!(ev.task_id, subtask.id);
        assert_eq!(ev.derived_state, Some(DerivedState::Wedged));
        assert_eq!(ev.status, WorkspaceStatus::Running);
    }

    // E0-T4 + TOCTOU regression: a user stop must land `stopped`, keep
    // `interrupted_at` NULL (only relaunch recovery sets that), AND stay
    // stopped even when the child dies mid-stop and the exit-watcher fires.
    // Deterministic — no reliance on real SIGINT/exit timing:
    //  1. `stop_task` commits `stopped` before it signals the child, so we
    //     assert it the instant the call returns.
    //  2. We then drive the EXACT write the exit-watcher performs when the
    //     SIGINT'd child exits nonzero (`finish_if_running(.., Failed, ..)`)
    //     and prove it is a no-op against the stopped row — so a user stop can
    //     never flash `failed`.
    #[tokio::test]
    async fn user_stop_stays_stopped_even_when_the_child_dies_mid_stop() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        let started = orchestrator
            .start_task(sleep_request(&repo.id, "stop-me"))
            .await
            .unwrap();
        let task_id = started.task_id.clone();

        orchestrator.stop_task(&task_id).await.unwrap();

        // (1) stop_task commits `stopped` before returning — and calm.
        let stopped = workspaces.get(&task_id).await.unwrap();
        assert_eq!(stopped.status, WorkspaceStatus::Stopped);
        assert_eq!(
            stopped.interrupted_at, None,
            "a user stop must stay calm — never marked interrupted"
        );

        // (2) Simulate the racing exit-watcher: the SIGINT'd child exits
        // nonzero and the watcher tries `running → failed`. Against an
        // already-`stopped` row this MUST be a no-op — the honest `stopped`
        // stands, never a spurious `failed`.
        let clobber = workspaces
            .finish_if_running(&task_id, WorkspaceStatus::Failed, Some(130))
            .await
            .unwrap();
        assert!(
            clobber.is_none(),
            "the exit-watcher must not flip a user-stopped task"
        );
        assert_eq!(
            workspaces.get(&task_id).await.unwrap().status,
            WorkspaceStatus::Stopped,
            "a user-stopped task must never flash Failed"
        );

        cleanup(&orchestrator, &[&started]).await;
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

    // ===== Scheduler (E2-T2): dependency-aware fan-out =====

    /// A scheduler config wired for deterministic tests: a hand-driven tick, a
    /// contract root under the test TempDir (never the real `~/.phasr`), and an
    /// explicit concurrency cap.
    fn test_scheduler_config(contract_root: &Path, max_concurrent: usize) -> SchedulerConfig {
        SchedulerConfig {
            poll_interval: Duration::from_millis(1),
            max_concurrent,
            min_contract_bytes: 1,
            contract_root: contract_root.to_path_buf(),
        }
    }

    /// Persist a Parent + its Subtask rows + role edges, exactly as
    /// `start_decomposition` would — but with a benign `sleep 30` command so the
    /// spawned PTY never depends on a real agent binary being installed. Returns
    /// the parent id and a role → subtask_id map.
    async fn seed_decomposition(
        workspaces: &WorkspaceRepo,
        board: &BoardRepo,
        repo_id: &str,
        roles: &[&str],
        edges: &[(&str, &str)],
    ) -> (String, HashMap<String, String>) {
        let mut parent = Workspace::new(repo_id.to_string(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert(&parent).await.unwrap();

        let mut role_to_id: HashMap<String, String> = HashMap::new();
        for role in roles {
            let mut sub = Workspace::new(repo_id.to_string(), (*role).into(), "sleep 30".into());
            sub.workspace_kind = WorkspaceKind::Subtask;
            sub.parent_id = Some(parent.id.clone());
            sub.role = Some((*role).into());
            sub.prompt = Some(format!("do the {role}"));
            workspaces.insert(&sub).await.unwrap();
            role_to_id.insert((*role).to_string(), sub.id.clone());
        }
        for (from, to) in edges {
            let dep = WorkspaceDependency::new(
                parent.id.clone(),
                role_to_id.get(*from).unwrap().clone(),
                role_to_id.get(*to).unwrap().clone(),
            );
            board.insert_dependency(&dep).await.unwrap();
        }
        (parent.id, role_to_id)
    }

    /// Count a parent's subtasks currently in `Running`.
    async fn running_subtask_count(workspaces: &WorkspaceRepo, parent_id: &str) -> usize {
        workspaces
            .list_by_parent(parent_id)
            .await
            .unwrap()
            .into_iter()
            .filter(|s| s.status == WorkspaceStatus::Running)
            .count()
    }

    /// Stop every running subtask under `parent_id` (SIGINT the `sleep`) and
    /// remove its worktree dir — worktrees live under `$HOME/.phasr`, outside the
    /// test TempDir, so they'd otherwise linger.
    async fn cleanup_board(
        orchestrator: &TaskOrchestrator,
        workspaces: &WorkspaceRepo,
        parent_id: &str,
    ) {
        for sub in workspaces.list_by_parent(parent_id).await.unwrap() {
            let _ = orchestrator.stop_task(&sub.id).await;
            if let Some(path) = sub.worktree_path.as_deref() {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }

    // E2-T2 AC: on a fresh decomposition, the scheduler spawns the READY root
    // (`backend`, no incoming edge) in its own worktree+branch and does NOT spawn
    // the blocked dependent (`frontend`, its edge unsatisfied). The producer's
    // prompt carries the write-your-contract instruction (B5).
    #[tokio::test]
    async fn scheduler_spawns_ready_root_but_not_blocked_dependent() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (parent_id, roles) = seed_decomposition(
            &workspaces,
            &board,
            &repo.id,
            &["backend", "frontend"],
            &[("backend", "frontend")],
        )
        .await;
        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 4);

        orchestrator.run_scheduler_tick(&board, &config).await;

        let backend = workspaces.get(&roles["backend"]).await.unwrap();
        let frontend = workspaces.get(&roles["frontend"]).await.unwrap();
        assert_eq!(
            backend.status,
            WorkspaceStatus::Running,
            "the root subtask (no incoming edge) spawns immediately"
        );
        assert!(backend.worktree_path.is_some() && backend.branch.is_some());
        assert_eq!(
            frontend.status,
            WorkspaceStatus::Pending,
            "the blocked dependent must stay pending (its edge is unsatisfied)"
        );
        assert!(frontend.worktree_path.is_none() && frontend.branch.is_none());

        // Exactly one subtask worktree/branch minted (main checkout + backend).
        assert_eq!(count_worktrees(repo_path), 2);
        assert_eq!(count_phasr_branches(repo_path), 1);

        // The producer's seeded prompt names the exact contract path to write to.
        let expected_path = config.contract_file(&parent_id, "backend");
        assert!(
            backend
                .prompt
                .as_deref()
                .unwrap()
                .contains(&expected_path.display().to_string()),
            "the backend (producer) prompt must carry the write-contract instruction"
        );

        // The contract dir is pre-created at spawn time, so a producer agent
        // writes the handoff file into an existing directory rather than having
        // to `mkdir -p` an absolute out-of-worktree path.
        assert!(
            config.contract_dir(&parent_id).is_dir(),
            "the producer's contract dir must exist before the agent runs"
        );

        cleanup_board(&orchestrator, &workspaces, &parent_id).await;
    }

    // E2-T2 AC (the handoff): writing the backend contract file + ticking →
    // the file→DB bridge publishes backend's contract AND the now-ready frontend
    // spawns with the contract CONTENTS seeded into its initial prompt (B5).
    // Deterministic: the contract file is injected, not waited on.
    #[tokio::test]
    async fn scheduler_bridges_contract_file_and_seeds_the_dependent() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (parent_id, roles) = seed_decomposition(
            &workspaces,
            &board,
            &repo.id,
            &["backend", "frontend"],
            &[("backend", "frontend")],
        )
        .await;
        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 4);

        // Tick 1: backend spawns, frontend blocked, no contract published yet.
        orchestrator.run_scheduler_tick(&board, &config).await;
        assert!(board.list_contracts(&parent_id).await.unwrap().is_empty());
        assert_eq!(
            workspaces.get(&roles["frontend"]).await.unwrap().status,
            WorkspaceStatus::Pending
        );

        // Inject backend's contract file (the deterministic stand-in for the
        // agent writing it).
        let contract_body = "## Backend API\nGET /widgets -> [{id, name}]\nPOST /widgets";
        let backend_contract = config.contract_file(&parent_id, "backend");
        std::fs::create_dir_all(backend_contract.parent().unwrap()).unwrap();
        std::fs::write(&backend_contract, contract_body).unwrap();

        // Tick 2: bridge publishes backend's contract AND frontend fans out.
        orchestrator.run_scheduler_tick(&board, &config).await;

        // A published contract row now mirrors the file.
        let contracts = board.list_contracts(&parent_id).await.unwrap();
        assert_eq!(contracts.len(), 1);
        assert_eq!(contracts[0].subtask_id, roles["backend"]);
        assert!(
            contracts[0].published_at.is_some(),
            "the file→DB bridge must stamp published_at"
        );

        // Frontend is now running in its own worktree...
        let frontend = workspaces.get(&roles["frontend"]).await.unwrap();
        assert_eq!(frontend.status, WorkspaceStatus::Running);
        assert!(frontend.worktree_path.is_some() && frontend.branch.is_some());
        // ...with backend's contract CONTENTS seeded into its prompt (B5).
        let prompt = frontend.prompt.as_deref().unwrap();
        assert!(
            prompt.contains("GET /widgets -> [{id, name}]"),
            "the contract body must be seeded into the consumer prompt: {prompt}"
        );
        assert!(prompt.contains("`backend`"), "the seed names the producer role");
        assert!(prompt.contains("do the frontend"), "the base prompt is preserved");
        // The ticket's task LEADS (labeled), ahead of the consumer contract +
        // CLI orientation — so the agent sees WHAT to build first, not buried.
        assert!(
            prompt.contains("## Your task")
                && prompt.find("## Your task").unwrap() < prompt.find("GET /widgets").unwrap(),
            "the ticket's task must lead ahead of the contract/CLI orientation: {prompt}"
        );

        // main + backend + frontend worktrees.
        assert_eq!(count_worktrees(repo_path), 3);
        assert_eq!(count_phasr_branches(repo_path), 2);

        cleanup_board(&orchestrator, &workspaces, &parent_id).await;
    }

    // E2-T2 AC (no false unblock, §0.1): with NO contract ever published, the
    // blocked dependent stays pending across repeated ticks — a producer that
    // never publishes (e.g. Wedged) never unblocks its consumer.
    #[tokio::test]
    async fn blocked_subtask_stays_pending_until_its_edge_is_satisfied() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (parent_id, roles) = seed_decomposition(
            &workspaces,
            &board,
            &repo.id,
            &["backend", "frontend"],
            &[("backend", "frontend")],
        )
        .await;
        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 4);

        for _ in 0..3 {
            orchestrator.run_scheduler_tick(&board, &config).await;
        }

        let frontend = workspaces.get(&roles["frontend"]).await.unwrap();
        assert_eq!(
            frontend.status,
            WorkspaceStatus::Pending,
            "no published contract → the dependent must never spawn"
        );
        assert!(frontend.worktree_path.is_none());
        // The root did spawn — only the dependent is held back.
        assert_eq!(
            workspaces.get(&roles["backend"]).await.unwrap().status,
            WorkspaceStatus::Running
        );

        cleanup_board(&orchestrator, &workspaces, &parent_id).await;
    }

    // E2-T2 AC: the concurrency cap holds. Three INDEPENDENT ready subtasks with
    // a cap of 2 → only two spawn; a re-tick spawns nothing more; freeing a slot
    // (stopping one) lets the third spawn on the next tick.
    #[tokio::test]
    async fn scheduler_concurrency_cap_holds() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (parent_id, _roles) =
            seed_decomposition(&workspaces, &board, &repo.id, &["a", "b", "c"], &[]).await;
        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 2);

        // Tick 1: cap 2 → exactly two of the three ready subtasks spawn.
        orchestrator.run_scheduler_tick(&board, &config).await;
        assert_eq!(
            running_subtask_count(&workspaces, &parent_id).await,
            2,
            "the cap holds — only 2 of 3 ready subtasks spawn"
        );
        assert_eq!(count_worktrees(repo_path), 3, "main + exactly two subtask worktrees");

        // Tick 2: still capped, nothing new spawns.
        orchestrator.run_scheduler_tick(&board, &config).await;
        assert_eq!(
            running_subtask_count(&workspaces, &parent_id).await,
            2,
            "a full cap spawns nothing more"
        );

        // Free a slot by stopping one running subtask, then tick: the third spawns.
        let running = workspaces
            .list_by_parent(&parent_id)
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.status == WorkspaceStatus::Running)
            .unwrap();
        orchestrator.stop_task(&running.id).await.unwrap();
        orchestrator.run_scheduler_tick(&board, &config).await;
        assert_eq!(
            running_subtask_count(&workspaces, &parent_id).await,
            2,
            "a freed slot lets the third spawn (2 running again)"
        );
        assert_eq!(
            count_worktrees(repo_path),
            4,
            "all three subtasks have now been spawned (stopped one keeps its worktree)"
        );

        cleanup_board(&orchestrator, &workspaces, &parent_id).await;
    }

    // E2-T2 AC: a duplicate tick must NOT double-spawn. After backend is running,
    // a second back-to-back tick mints no second worktree/branch — enforced by
    // "ready = only pending" plus the `find_active_subtask(parent, role)` guard.
    #[tokio::test]
    async fn re_tick_does_not_double_spawn_a_running_subtask() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (parent_id, roles) = seed_decomposition(
            &workspaces,
            &board,
            &repo.id,
            &["backend", "frontend"],
            &[("backend", "frontend")],
        )
        .await;
        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 4);

        orchestrator.run_scheduler_tick(&board, &config).await;
        let first = workspaces.get(&roles["backend"]).await.unwrap();
        orchestrator.run_scheduler_tick(&board, &config).await;
        let second = workspaces.get(&roles["backend"]).await.unwrap();

        assert_eq!(
            first.worktree_path, second.worktree_path,
            "the re-tick must reuse the same worktree, not mint a fresh one"
        );
        assert_eq!(first.branch, second.branch);
        assert_eq!(
            count_worktrees(repo_path),
            2,
            "exactly one subtask worktree despite the duplicate tick"
        );
        assert_eq!(count_phasr_branches(repo_path), 1);

        cleanup_board(&orchestrator, &workspaces, &parent_id).await;
    }

    // E2-T3 recovery guard: a relaunch-interrupted subtask (Stopped +
    // interrupted_at, i.e. Wedged) is NEVER auto-restarted by the scheduler
    // (ready = only pending), and its blocked dependent stays pending. The
    // scheduler re-derives the DAG from the DB without blind-restarting anything.
    #[tokio::test]
    async fn scheduler_does_not_restart_a_relaunch_interrupted_subtask() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (_parent_id, roles) = seed_decomposition(
            &workspaces,
            &board,
            &repo.id,
            &["backend", "frontend"],
            &[("backend", "frontend")],
        )
        .await;

        // Simulate a mid-fan-out relaunch: backend was Running, recovery swept it
        // to Stopped + interrupted_at; frontend is still Pending, blocked.
        workspaces
            .update(
                &roles["backend"],
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let now = Utc::now();
        workspaces
            .update(
                &roles["backend"],
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Stopped),
                    interrupted_at: Some(Some(now)),
                    finished_at: Some(Some(now)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 4);
        orchestrator.run_scheduler_tick(&board, &config).await;

        assert_eq!(
            workspaces.get(&roles["backend"]).await.unwrap().status,
            WorkspaceStatus::Stopped,
            "an interrupted subtask must never be blind-restarted"
        );
        assert_eq!(
            workspaces.get(&roles["frontend"]).await.unwrap().status,
            WorkspaceStatus::Pending,
            "the dependent stays blocked (backend never published)"
        );
        assert_eq!(
            count_worktrees(repo_path),
            1,
            "nothing spawned → only the main checkout"
        );
        // Nothing was spawned, so no worktrees/PTYs to clean up.
    }

    // E2-T3 recovery (the resume path): a blocked dependent RESUMES on the first
    // post-relaunch tick when its predecessor's contract SURVIVED the crash. The
    // DAG is re-derived purely from the DB — backend is left Stopped+interrupted
    // (never blind-restarted), but because its published contract row persisted,
    // frontend's edge is satisfied and the scheduler spawns it (with the surviving
    // contract seeded into its prompt). This is "pending/blocked subtasks resume
    // via the scheduler" from the recovery AC.
    #[tokio::test]
    async fn scheduler_resumes_dependent_after_relaunch_when_predecessor_contract_survived() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let (parent_id, roles) = seed_decomposition(
            &workspaces,
            &board,
            &repo.id,
            &["backend", "frontend"],
            &[("backend", "frontend")],
        )
        .await;
        let config = test_scheduler_config(&tmp.path().join("contracts-root"), 4);

        // Simulate the relaunch sweep: backend was Running, recovery moved it to
        // Stopped + interrupted; frontend is still Pending, blocked.
        let now = Utc::now();
        workspaces
            .update(
                &roles["backend"],
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        workspaces
            .update(
                &roles["backend"],
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Stopped),
                    interrupted_at: Some(Some(now)),
                    finished_at: Some(Some(now)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        // Backend's contract SURVIVED the crash: a published row + its file both
        // persisted on disk (the file→DB bridge had already fired before the crash).
        let contract_path = config.contract_file(&parent_id, "backend");
        std::fs::create_dir_all(contract_path.parent().unwrap()).unwrap();
        std::fs::write(&contract_path, "## Backend API\nGET /widgets -> [{id}]").unwrap();
        let mut contract = WorkspaceContract::new(
            parent_id.clone(),
            roles["backend"].clone(),
            "backend".into(),
            contract_path.to_string_lossy().into_owned(),
        );
        contract.published_at = Some(now);
        board.insert_contract(&contract).await.unwrap();

        orchestrator.run_scheduler_tick(&board, &config).await;

        // Backend stays interrupted — the scheduler NEVER blind-restarts it.
        assert_eq!(
            workspaces.get(&roles["backend"]).await.unwrap().status,
            WorkspaceStatus::Stopped,
            "an interrupted predecessor must not be restarted"
        );
        // Frontend RESUMES: its edge was satisfied by the surviving contract.
        let frontend = workspaces.get(&roles["frontend"]).await.unwrap();
        assert_eq!(
            frontend.status,
            WorkspaceStatus::Running,
            "the dependent must resume once its predecessor's contract survives the crash"
        );
        assert!(frontend.worktree_path.is_some() && frontend.branch.is_some());
        // ...and the surviving contract is seeded into its prompt (handoff intact).
        assert!(
            frontend
                .prompt
                .as_deref()
                .unwrap()
                .contains("GET /widgets -> [{id}]"),
            "the surviving contract must be seeded into the resumed dependent's prompt"
        );

        cleanup_board(&orchestrator, &workspaces, &parent_id).await;
    }

    // ── respawn_for_rework (Phase 5, completion program) ────────────────────

    // A human bounce on an EXITED producer revives it: same row, same
    // worktree, status back to Running with a live PTY — and a second call
    // while it's alive no-ops instead of double-spawning.
    #[tokio::test]
    async fn respawn_for_rework_revives_a_completed_producer_in_its_worktree() {
        let (orchestrator, repositories, pool, dir) = fresh_orchestrator().await;
        let workspaces = WorkspaceRepo::new(pool.clone());

        let repo_dir = dir.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repository = Repository::new(
            "repo".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repository.default_branch = "main".into();
        repositories.insert(&repository).await.unwrap();

        // A finished producer with a REAL worktree (`cat` idles forever, so the
        // respawned PTY stays observably alive).
        let mut ws = Workspace::new(repository.id.clone(), "ticket".into(), "cat".into());
        ws.workspace_kind = WorkspaceKind::Subtask;
        ws.parent_id = Some("parent-x".into());
        ws.role = Some("backend".into());
        let worktree = dir.path().join("wt");
        let branch = "phasr/rework-test";
        Command::new("git")
            .args([
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                worktree.to_str().unwrap(),
                "main",
            ])
            .current_dir(&repo_dir)
            .status()
            .unwrap();
        ws.branch = Some(branch.into());
        ws.worktree_path = Some(worktree.to_string_lossy().into_owned());
        workspaces.insert(&ws).await.unwrap();
        for status in [WorkspaceStatus::Running, WorkspaceStatus::Completed] {
            workspaces
                .update(
                    &ws.id,
                    crate::store::WorkspaceUpdate {
                        status: Some(status),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }

        assert!(!orchestrator.has_live_task(&ws.id), "producer is dead");
        orchestrator
            .respawn_for_rework(&ws.id, "fix the spacing in the header")
            .await
            .expect("respawn must succeed on a completed row");

        assert!(orchestrator.has_live_task(&ws.id), "respawn owns a live PTY");
        let row = workspaces.get(&ws.id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Running);
        assert_eq!(row.exit_code, None);
        assert_eq!(
            row.worktree_path.as_deref(),
            Some(worktree.to_str().unwrap()),
            "the respawn re-enters the SAME worktree"
        );

        // While alive, a second respawn is a no-op — never a double spawn.
        orchestrator
            .respawn_for_rework(&ws.id, "another note")
            .await
            .expect("live-handle respawn must no-op");

        let _ = orchestrator.stop_task(&ws.id).await;
    }
}
