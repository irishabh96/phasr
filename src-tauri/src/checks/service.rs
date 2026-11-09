//! `CheckService`: queue / run / cancel checks for a task, the approve
//! gate, and auto-running `before_review` checks when a task reaches
//! review.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use parking_lot::Mutex;
use thiserror::Error;
use tokio::sync::{broadcast, watch, Semaphore};

use crate::agent_signals::state::AgentStateKind;
use crate::agent_signals::AgentSignalEvent;
use crate::domain::board::Lane;
use crate::domain::review::{latest_by_command, run_is_current, unsatisfied_required};
use crate::domain::{
    CheckRun, CheckStatus, CheckSummary, RunCommand, RunWhen, Workspace, WorkspaceStatus,
};
use crate::git::{self, GitError};
use crate::orchestrator::{TaskBoard, TaskStatusEvent};
use crate::store::{
    AppMetaRepo, CheckRunFinish, CheckRunRepo, RunCommandRepo, StoreError, WorkspaceRepo,
};

use super::runner::{run_check, CheckEnd, CheckSpec, ProcessGroups};

/// A check that runs longer than this is killed and recorded `timeout`.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Checks run at once per task; the rest wait `queued`. Two keeps a
/// test + lint pair parallel without a full suite saturating the machine
/// alongside the agent.
const MAX_CONCURRENT_PER_TASK: usize = 2;
/// `get_check_output` returns at most this much of the log (its end).
const OUTPUT_READ_CAP: u64 = 4 * 1024 * 1024;
const EVENT_CAPACITY: usize = 1024;
/// Settled runs kept per check per task; older ones (and their logs) are
/// pruned after each run and at startup.
const RUNS_KEPT_PER_CHECK: i64 = 20;

#[derive(Debug, Error)]
pub enum CheckError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("this task has no worktree on this machine")]
    NoWorktree,
    #[error("unknown run command `{0}`")]
    UnknownCommand(String),
}

impl serde::Serialize for CheckError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone)]
pub enum CheckEvent {
    /// A run was queued, started or settled — the full row.
    Run(CheckRun),
    /// New output for a running check (throttled, see `runner`).
    Output {
        check_run_id: String,
        workspace_id: String,
        chunk: String,
    },
}

struct Active {
    workspace_id: String,
    run_command_id: Option<String>,
    cancel: watch::Sender<bool>,
}

struct Inner {
    runs: CheckRunRepo,
    run_commands: RunCommandRepo,
    workspaces: WorkspaceRepo,
    meta: AppMetaRepo,
    log_dir: PathBuf,
    timeout: Duration,
    events: broadcast::Sender<CheckEvent>,
    /// Per-task concurrency limit.
    limits: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// Queued + running runs, by run id.
    active: Mutex<HashMap<String, Active>>,
    /// Last lane seen per task, to catch the move INTO needs-review.
    lanes: Mutex<HashMap<String, Lane>>,
    /// Worktree → (cheap key, full fingerprint). The full fingerprint
    /// (`git diff HEAD` + reading untracked files) is only recomputed when
    /// `git::fingerprint_key` moves.
    fingerprints: Mutex<HashMap<PathBuf, (String, Option<String>)>>,
    /// Held across "is this check already active?" → insert row →
    /// register in `active`. Without it, two callers (auto-run on entering
    /// review + a click on Run) both saw nothing active across the insert's
    /// `.await` and queued the same check twice.
    queue_lock: tokio::sync::Mutex<()>,
    /// Process groups of running checks, so quitting the app can kill
    /// them (they run in their own group, outside any PTY).
    groups: ProcessGroups,
}

/// Fingerprint cache entries kept before dropping those whose worktree is
/// gone (removed / discarded tasks), so the map can't grow forever.
const FINGERPRINT_CACHE_SOFT_CAP: usize = 64;

#[derive(Clone)]
pub struct CheckService {
    inner: Arc<Inner>,
}

impl CheckService {
    /// `log_dir` is the app's log directory; check logs go in
    /// `<log_dir>/checks/<run id>.log`.
    pub fn new(
        runs: CheckRunRepo,
        run_commands: RunCommandRepo,
        workspaces: WorkspaceRepo,
        meta: AppMetaRepo,
        log_dir: PathBuf,
    ) -> Self {
        Self::with_timeout(runs, run_commands, workspaces, meta, log_dir, CHECK_TIMEOUT)
    }

    pub fn with_timeout(
        runs: CheckRunRepo,
        run_commands: RunCommandRepo,
        workspaces: WorkspaceRepo,
        meta: AppMetaRepo,
        log_dir: PathBuf,
        timeout: Duration,
    ) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                runs,
                run_commands,
                workspaces,
                meta,
                log_dir,
                timeout,
                events,
                limits: Mutex::new(HashMap::new()),
                active: Mutex::new(HashMap::new()),
                lanes: Mutex::new(HashMap::new()),
                fingerprints: Mutex::new(HashMap::new()),
                queue_lock: tokio::sync::Mutex::new(()),
                groups: ProcessGroups::default(),
            }),
        }
    }

    /// App quit: SIGTERM every running check's process group, wait up to
    /// `grace`, then SIGKILL what's left. Blocking — called from the
    /// `RunEvent::Exit` handler, where nothing async runs any more. A
    /// check's test runner / dev server would otherwise outlive the app.
    pub fn terminate_all_blocking(&self, grace: Duration) {
        self.inner.groups.terminate_all_blocking(grace);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CheckEvent> {
        self.inner.events.subscribe()
    }

    /// Startup: runs left queued/running by the previous process are
    /// settled as `error` (nothing is running them any more).
    pub async fn settle_interrupted(&self) {
        if let Err(err) = self.inner.runs.settle_interrupted().await {
            eprintln!("failed to settle interrupted check runs: {err}");
        }
        self.prune(None).await;
    }

    /// Drop all but the newest `RUNS_KEPT_PER_CHECK` settled runs per check
    /// (one task, or all), with their log files.
    async fn prune(&self, workspace_id: Option<&str>) {
        match self
            .inner
            .runs
            .prune(RUNS_KEPT_PER_CHECK, workspace_id)
            .await
        {
            Ok(logs) => {
                for log in logs {
                    let _ = tokio::fs::remove_file(log).await;
                }
            }
            Err(err) => eprintln!("failed to prune check runs: {err}"),
        }
    }

    /// Queued + running checks for a task.
    pub fn active_count(&self, workspace_id: &str) -> usize {
        self.inner
            .active
            .lock()
            .values()
            .filter(|a| a.workspace_id == workspace_id)
            .count()
    }

    /// The task's worktree, if it exists on this machine.
    pub fn worktree_of(workspace: &Workspace) -> Result<PathBuf, CheckError> {
        workspace
            .worktree_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .ok_or(CheckError::NoWorktree)
    }

    /// The worktree's current fingerprint; `None` if git couldn't say.
    /// Served from the cache while `git::fingerprint_key` is unchanged.
    pub async fn fingerprint(&self, worktree: &Path) -> Option<String> {
        let path = worktree.to_path_buf();
        let cached = self.inner.fingerprints.lock().get(&path).cloned();
        let (key, fingerprint) = tokio::task::spawn_blocking(move || {
            let key = git::fingerprint_key(&path).ok();
            if let (Some(key), Some((cached_key, cached_fp))) = (key.as_ref(), cached) {
                if *key == cached_key {
                    return (Some(key.clone()), cached_fp);
                }
            }
            (key, git::worktree_fingerprint(&path).ok())
        })
        .await
        .ok()?;
        if let Some(key) = key {
            let mut cache = self.inner.fingerprints.lock();
            if cache.len() >= FINGERPRINT_CACHE_SOFT_CAP && !cache.contains_key(worktree) {
                cache.retain(|path, _| path.exists());
                if cache.len() >= FINGERPRINT_CACHE_SOFT_CAP {
                    cache.clear();
                }
            }
            cache.insert(worktree.to_path_buf(), (key, fingerprint.clone()));
        }
        fingerprint
    }

    /// Drop a worktree's cached fingerprint (it was removed).
    pub fn forget_worktree(&self, worktree: &Path) {
        self.inner.fingerprints.lock().remove(worktree);
    }

    async fn commands_for(
        &self,
        workspace: &Workspace,
        user_id: &str,
    ) -> Result<Vec<RunCommand>, CheckError> {
        Ok(self
            .inner
            .run_commands
            .list_by_repository_for_user(&workspace.repository_id, user_id)
            .await?)
    }

    /// Run checks now: `ids` (any run commands of the task's repository,
    /// trusted or not — the user picked them), or, when `None`, every check
    /// (`is_check`) whose command is trusted on this machine — "Run checks"
    /// must not run a synced command nobody here has confirmed (those show
    /// up in the summary's `needs_confirmation`). A command already
    /// queued/running for this task isn't started twice; its active run is
    /// returned instead.
    pub async fn run(
        &self,
        workspace: &Workspace,
        user_id: &str,
        ids: Option<&[String]>,
    ) -> Result<Vec<CheckRun>, CheckError> {
        let worktree = Self::worktree_of(workspace)?;
        let commands = self.commands_for(workspace, user_id).await?;
        let selected: Vec<RunCommand> = match ids {
            Some(ids) => ids
                .iter()
                .map(|id| {
                    commands
                        .iter()
                        .find(|rc| &rc.id == id)
                        .cloned()
                        .ok_or_else(|| CheckError::UnknownCommand(id.clone()))
                })
                .collect::<Result<_, _>>()?,
            None => {
                let mut trusted = Vec::new();
                for rc in commands.into_iter().filter(RunCommand::is_check) {
                    if self.inner.meta.is_run_command_trusted(&rc).await? {
                        trusted.push(rc);
                    }
                }
                trusted
            }
        };
        self.start_runs(workspace, &worktree, user_id, selected)
            .await
    }

    async fn start_runs(
        &self,
        workspace: &Workspace,
        worktree: &Path,
        user_id: &str,
        commands: Vec<RunCommand>,
    ) -> Result<Vec<CheckRun>, CheckError> {
        if commands.is_empty() {
            return Ok(Vec::new());
        }
        let fingerprint = self.fingerprint(worktree).await;
        let mut out = Vec::with_capacity(commands.len());
        // Lookup → insert → register as one step (see `queue_lock`).
        let _queueing = self.inner.queue_lock.lock().await;
        for rc in commands {
            let already = self
                .inner
                .active
                .lock()
                .iter()
                .find(|(_, a)| {
                    a.workspace_id == workspace.id && a.run_command_id.as_deref() == Some(&rc.id)
                })
                .map(|(id, _)| id.clone());
            if let Some(run_id) = already {
                out.push(self.inner.runs.get(&run_id).await?);
                continue;
            }
            out.push(
                self.queue(workspace, worktree, user_id, &rc, fingerprint.clone())
                    .await?,
            );
        }
        Ok(out)
    }

    async fn queue(
        &self,
        workspace: &Workspace,
        worktree: &Path,
        user_id: &str,
        rc: &RunCommand,
        fingerprint: Option<String>,
    ) -> Result<CheckRun, CheckError> {
        let id = uuid::Uuid::new_v4().to_string();
        let log_path = self.inner.log_dir.join("checks").join(format!("{id}.log"));
        let run = CheckRun {
            id: id.clone(),
            workspace_id: workspace.id.clone(),
            run_command_id: Some(rc.id.clone()),
            name: rc.name.clone(),
            command: rc.command.clone(),
            status: CheckStatus::Queued,
            exit_code: None,
            fingerprint,
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            duration_ms: None,
            output_tail: String::new(),
            log_path: Some(log_path.to_string_lossy().into_owned()),
        };
        self.inner.runs.insert(&run, Some(user_id)).await?;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.inner.active.lock().insert(
            id.clone(),
            Active {
                workspace_id: workspace.id.clone(),
                run_command_id: Some(rc.id.clone()),
                cancel: cancel_tx,
            },
        );
        let _ = self.inner.events.send(CheckEvent::Run(run.clone()));

        let limit = self
            .inner
            .limits
            .lock()
            .entry(workspace.id.clone())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PER_TASK)))
            .clone();
        let spec = CheckSpec {
            command: rc.command.clone(),
            cwd: worktree.to_path_buf(),
            log_path,
            timeout: self.inner.timeout,
            shell: crate::pty::resolve_shell(),
            env: crate::pty::terminal_env(&crate::pty::resolve_shell()),
            groups: self.inner.groups.clone(),
        };
        let service = self.clone();
        tokio::spawn(async move {
            service.execute(id, spec, limit, cancel_rx).await;
        });
        Ok(run)
    }

    async fn execute(
        &self,
        id: String,
        spec: CheckSpec,
        limit: Arc<Semaphore>,
        mut cancel: watch::Receiver<bool>,
    ) {
        // Wait for a slot — or a cancel while still queued.
        let permit = tokio::select! {
            permit = limit.acquire_owned() => permit.ok(),
            _ = wait_cancelled(&mut cancel) => None,
        };
        let Some(_permit) = permit else {
            self.settle(&id, CheckStatus::Cancelled, None, None, String::new())
                .await;
            return;
        };
        // The fingerprint is the code the check is ABOUT to run on — taken
        // now, when it gets its slot (it may have waited in the queue while
        // the agent kept editing), and kept. Taking it after the run tied a
        // pass to whatever the worktree looked like at the end — edits made
        // DURING the run included.
        let at_start = self.fingerprint(&spec.cwd).await;
        let running = match self
            .inner
            .runs
            .mark_running(&id, Utc::now(), at_start.as_deref())
            .await
        {
            Ok(Some(run)) => run,
            // Settled while queued, or the row is gone.
            _ => {
                self.inner.active.lock().remove(&id);
                return;
            }
        };
        let workspace_id = running.workspace_id.clone();
        let _ = self.inner.events.send(CheckEvent::Run(running));
        let task_id = workspace_id.clone();

        let events = self.inner.events.clone();
        let run_id = id.clone();
        let result = run_check(spec, cancel, move |chunk| {
            let _ = events.send(CheckEvent::Output {
                check_run_id: run_id.clone(),
                workspace_id: workspace_id.clone(),
                chunk,
            });
        })
        .await;
        let (status, exit_code) = match &result.end {
            CheckEnd::Exited(Some(0)) => (CheckStatus::Passed, Some(0)),
            CheckEnd::Exited(code) => (CheckStatus::Failed, *code),
            CheckEnd::TimedOut => (CheckStatus::Timeout, None),
            CheckEnd::Cancelled => (CheckStatus::Cancelled, None),
            CheckEnd::Failed(_) => (CheckStatus::Error, None),
        };
        let mut tail = result.tail;
        if let CheckEnd::Failed(msg) = &result.end {
            tail.push_str(msg);
        }
        let duration = i64::try_from(result.duration.as_millis()).ok();
        // The fingerprint stays the one taken at start. A check that
        // rewrites files (a formatter) is then stale against its own
        // output — correctly: nothing has checked the rewritten code.
        self.settle(&id, status, exit_code, duration, tail).await;
        self.prune(Some(&task_id)).await;
    }

    /// Record the final state, drop the run from `active`, then announce —
    /// in that order, so a listener seeing the final row also sees whether
    /// this was the task's last active check.
    async fn settle(
        &self,
        id: &str,
        status: CheckStatus,
        exit_code: Option<i64>,
        duration_ms: Option<i64>,
        tail: String,
    ) {
        let finished = self
            .inner
            .runs
            .finish(
                id,
                CheckRunFinish {
                    status,
                    exit_code,
                    finished_at: Utc::now(),
                    duration_ms,
                    output_tail: tail,
                },
            )
            .await;
        self.inner.active.lock().remove(id);
        match finished {
            Ok(run) => {
                let _ = self.inner.events.send(CheckEvent::Run(run));
            }
            Err(err) => eprintln!("failed to record check run {id}: {err}"),
        }
    }

    /// Cancel every queued/running check of a task. Returns how many were
    /// signalled; each settles `cancelled` on its own task.
    pub fn cancel(&self, workspace_id: &str) -> usize {
        let active = self.inner.active.lock();
        let mut n = 0;
        for a in active.values().filter(|a| a.workspace_id == workspace_id) {
            let _ = a.cancel.send(true);
            n += 1;
        }
        n
    }

    /// `cancel`, then wait (up to `timeout`) for the runs to settle — for
    /// callers about to delete the worktree the checks run in.
    pub async fn cancel_and_wait(&self, workspace_id: &str, timeout: Duration) {
        if self.cancel(workspace_id) == 0 {
            return;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        while self.active_count(workspace_id) > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Latest run of each run command + the approve gate + what's stale /
    /// unconfirmed.
    pub async fn summary(
        &self,
        workspace: &Workspace,
        user_id: &str,
    ) -> Result<CheckSummary, CheckError> {
        let commands = self.commands_for(workspace, user_id).await?;
        let runs = self.inner.runs.list_for_workspace(&workspace.id).await?;
        let current = match Self::worktree_of(workspace) {
            Ok(worktree) => self.fingerprint(&worktree).await,
            Err(_) => None,
        };
        let latest = latest_by_command(&runs);
        // Checks first, then other commands that were run as checks, each
        // group in run-command order.
        let mut ordered: Vec<&RunCommand> = commands.iter().filter(|rc| rc.is_check()).collect();
        ordered.extend(commands.iter().filter(|rc| !rc.is_check()));
        let shown_with_rc: Vec<(&RunCommand, CheckRun)> = ordered
            .iter()
            .filter_map(|rc| latest.get(&rc.id).map(|r| (*rc, (*r).clone())))
            .collect();
        // Stale = ran on other code, or ran a command since edited.
        let stale_ids = shown_with_rc
            .iter()
            .filter(|(rc, r)| !r.status.is_active() && !run_is_current(r, rc, current.as_deref()))
            .map(|(_, r)| r.id.clone())
            .collect();
        let shown: Vec<CheckRun> = shown_with_rc.into_iter().map(|(_, r)| r).collect();
        let mut needs_confirmation = Vec::new();
        for rc in commands.iter().filter(|rc| rc.run_when.is_automatic()) {
            if !self.inner.meta.is_run_command_trusted(rc).await? {
                needs_confirmation.push(rc.id.clone());
            }
        }
        Ok(CheckSummary {
            required: commands
                .iter()
                .filter(|rc| rc.required_for_approve)
                .map(|rc| rc.id.clone())
                .collect(),
            required_satisfied: unsatisfied_required(&commands, &runs, current.as_deref())
                .is_empty(),
            runs: shown,
            stale_ids,
            needs_confirmation,
        })
    }

    /// Names of required checks without a passing run on the worktree as
    /// it is now (empty = the approve gate is open).
    pub async fn unsatisfied_required(
        &self,
        workspace: &Workspace,
        user_id: &str,
    ) -> Result<Vec<String>, CheckError> {
        let commands = self.commands_for(workspace, user_id).await?;
        if !commands.iter().any(|rc| rc.required_for_approve) {
            return Ok(Vec::new());
        }
        let runs = self.inner.runs.list_for_workspace(&workspace.id).await?;
        let current = match Self::worktree_of(workspace) {
            Ok(worktree) => self.fingerprint(&worktree).await,
            Err(_) => None,
        };
        Ok(unsatisfied_required(&commands, &runs, current.as_deref()))
    }

    /// Latest settled run per check, for the PR body.
    pub async fn latest_runs(
        &self,
        workspace: &Workspace,
        user_id: &str,
    ) -> Result<Vec<CheckRun>, CheckError> {
        Ok(self.summary(workspace, user_id).await?.runs)
    }

    /// The run's full output (the end of its log, capped), else its tail.
    pub async fn output(&self, run: &CheckRun) -> String {
        let Some(path) = run.log_path.as_deref() else {
            return run.output_tail.clone();
        };
        match read_tail(Path::new(path), OUTPUT_READ_CAP).await {
            Some(text) => text,
            None => run.output_tail.clone(),
        }
    }

    pub async fn get_run_for_user(&self, id: &str, user_id: &str) -> Result<CheckRun, CheckError> {
        Ok(self.inner.runs.get_for_user(id, user_id).await?)
    }

    /// Auto-run the task's `before_review` checks — only those whose
    /// command is trusted on this machine, and only when the worktree
    /// changed since that check's last run (a re-entry into review with
    /// the same code reruns nothing).
    pub async fn auto_run_before_review(
        &self,
        workspace: &Workspace,
        user_id: &str,
    ) -> Result<Vec<CheckRun>, CheckError> {
        let Ok(worktree) = Self::worktree_of(workspace) else {
            return Ok(Vec::new());
        };
        let mut candidates = Vec::new();
        for rc in self.commands_for(workspace, user_id).await? {
            if rc.run_when == RunWhen::BeforeReview
                && self.inner.meta.is_run_command_trusted(&rc).await?
            {
                candidates.push(rc);
            }
        }
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let current = self.fingerprint(&worktree).await;
        let runs = self.inner.runs.list_for_workspace(&workspace.id).await?;
        let latest = latest_by_command(&runs);
        let due: Vec<RunCommand> = candidates
            .into_iter()
            .filter(|rc| match latest.get(&rc.id) {
                Some(last) => {
                    !last.status.is_active() && !run_is_current(last, rc, current.as_deref())
                }
                None => true,
            })
            .collect();
        self.start_runs(workspace, &worktree, user_id, due).await
    }

    /// A task event arrived: if its lane just became needs-review, auto-run
    /// its `before_review` checks.
    async fn on_task_event(&self, board: &TaskBoard, task_id: &str, user_id: &str) {
        let Ok(workspace) = self.inner.workspaces.get_for_user(task_id, user_id).await else {
            return;
        };
        let Some(lane) = board.lane_of(&workspace).await else {
            return;
        };
        let previous = self.inner.lanes.lock().insert(task_id.to_string(), lane);
        if lane == Lane::NeedsReview && previous != Some(Lane::NeedsReview) {
            if let Err(err) = self.auto_run_before_review(&workspace, user_id).await {
                eprintln!("auto-run checks for {task_id} failed: {err}");
            }
        }
    }

    /// Follow task status + agent state and auto-run checks on entry into
    /// needs-review. `current_user` = the signed-in user (nothing runs
    /// signed out). Call once, inside a Tokio runtime.
    pub fn start<F>(
        &self,
        board: TaskBoard,
        status: broadcast::Receiver<TaskStatusEvent>,
        signals: Option<broadcast::Receiver<AgentSignalEvent>>,
        current_user: F,
    ) where
        F: Fn() -> Option<String> + Send + Sync + 'static,
    {
        let service = self.clone();
        tokio::spawn(async move {
            let mut status = status;
            let mut signals = signals;
            loop {
                let signal = async {
                    match signals.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                };
                // Only events that can move a card INTO needs-review: the
                // agent stopping (row) or going idle/exiting (live state).
                let task_id = tokio::select! {
                    event = status.recv() => match event {
                        Ok(e) if matches!(e.status, WorkspaceStatus::Stopped | WorkspaceStatus::Completed) => Some(e.task_id),
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => None,
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    event = signal => match event {
                        Ok(AgentSignalEvent::State(s)) if matches!(s.state, AgentStateKind::Idle | AgentStateKind::Exited) => Some(s.task_id),
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => None,
                        Err(broadcast::error::RecvError::Closed) => { signals = None; None }
                    },
                };
                let (Some(task_id), Some(user_id)) = (task_id, current_user()) else {
                    continue;
                };
                service.on_task_event(&board, &task_id, &user_id).await;
            }
        });
    }
}

async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            // Sender gone without cancelling: never resolves.
            std::future::pending::<()>().await;
        }
    }
}

/// The last `cap` bytes of a file, lossily decoded; `None` if unreadable.
async fn read_tail(path: &Path, cap: u64) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    if len > cap {
        file.seek(std::io::SeekFrom::Start(len - cap)).await.ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await.ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, RunCommand};
    use crate::store::{init_pool, RepositoryRepo};
    use std::process::Command;

    struct Fx {
        service: CheckService,
        run_commands: RunCommandRepo,
        meta: AppMetaRepo,
        ws: Workspace,
        repo: Repository,
        _dir: tempfile::TempDir,
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

    async fn fx(timeout: Duration) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES ('u', 'u', 'n', 'u@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        git(&wt, &["init", "-q", "-b", "main"]);
        git(&wt, &["config", "user.email", "t@example.com"]);
        git(&wt, &["config", "user.name", "t"]);
        std::fs::write(wt.join("a.txt"), "a\n").unwrap();
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-qm", "init"]);

        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone())
            .insert_for_user(&repo, "u")
            .await
            .unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let mut ws = Workspace::new(repo.id.clone(), "t".into(), "c".into());
        ws.branch = Some("main".into());
        ws.worktree_path = Some(wt.to_string_lossy().into_owned());
        workspaces.insert_for_user(&ws, "u").await.unwrap();
        let run_commands = RunCommandRepo::new(pool.clone());
        let meta = AppMetaRepo::new(pool.clone());
        let service = CheckService::with_timeout(
            CheckRunRepo::new(pool.clone()),
            run_commands.clone(),
            workspaces,
            meta.clone(),
            dir.path().join("logs"),
            timeout,
        );
        Fx {
            service,
            run_commands,
            meta,
            ws,
            repo,
            _dir: dir,
        }
    }

    async fn add(f: &Fx, name: &str, command: &str, required: bool, when: RunWhen) -> RunCommand {
        let mut rc = RunCommand::new(f.repo.id.clone(), name.into(), command.into());
        rc.required_for_approve = required;
        rc.run_when = when;
        f.run_commands.insert_for_user(&rc, "u").await.unwrap();
        rc
    }

    async fn settle(f: &Fx) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while f.service.active_count(&f.ws.id) > 0 {
            assert!(std::time::Instant::now() < deadline, "checks never settled");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn required_check_is_satisfied_until_the_worktree_changes() {
        let f = fx(CHECK_TIMEOUT).await;
        let test = add(&f, "test", "test -f a.txt", true, RunWhen::Manual).await;
        f.meta.trust_run_command(&test).await.unwrap();
        add(&f, "dev", "sleep 100", false, RunWhen::Manual).await;

        assert_eq!(
            f.service.unsatisfied_required(&f.ws, "u").await.unwrap(),
            vec!["test"]
        );
        let mut events = f.service.subscribe();
        let queued = f.service.run(&f.ws, "u", None).await.unwrap();
        assert_eq!(queued.len(), 1, "only checks run by default: {queued:?}");
        settle(&f).await;

        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        assert_eq!(summary.runs.len(), 1);
        assert_eq!(summary.runs[0].status, CheckStatus::Passed);
        assert_eq!(summary.required, vec![test.id.clone()]);
        assert!(summary.required_satisfied);
        assert!(summary.stale_ids.is_empty());
        assert!(f
            .service
            .unsatisfied_required(&f.ws, "u")
            .await
            .unwrap()
            .is_empty());
        // queued → running → passed went out as events.
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let CheckEvent::Run(r) = event {
                seen.push(r.status);
            }
        }
        assert!(
            seen.starts_with(&[CheckStatus::Queued]) && seen.ends_with(&[CheckStatus::Passed]),
            "{seen:?}"
        );

        // An edit makes the pass stale and closes the gate again.
        std::fs::write(
            Path::new(f.ws.worktree_path.as_deref().unwrap()).join("b.txt"),
            "b\n",
        )
        .unwrap();
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        assert!(!summary.required_satisfied);
        assert_eq!(summary.stale_ids, vec![summary.runs[0].id.clone()]);
        assert_eq!(
            f.service.unsatisfied_required(&f.ws, "u").await.unwrap(),
            vec!["test"]
        );
    }

    #[tokio::test]
    async fn failures_timeouts_and_cancel_are_recorded() {
        let f = fx(Duration::from_millis(500)).await;
        let fail = add(&f, "fail", "echo boom; exit 2", true, RunWhen::Manual).await;
        let slow = add(&f, "slow", "sleep 30", false, RunWhen::Manual).await;
        f.service
            .run(&f.ws, "u", Some(&[fail.id.clone(), slow.id.clone()]))
            .await
            .unwrap();
        settle(&f).await;
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        let by = |id: &str| {
            summary
                .runs
                .iter()
                .find(|r| r.run_command_id.as_deref() == Some(id))
                .unwrap()
        };
        assert_eq!(
            (by(&fail.id).status, by(&fail.id).exit_code),
            (CheckStatus::Failed, Some(2))
        );
        assert!(by(&fail.id).output_tail.contains("boom"));
        assert!(f.service.output(by(&fail.id)).await.contains("boom"));
        assert_eq!(by(&slow.id).status, CheckStatus::Timeout);

        let f = fx(CHECK_TIMEOUT).await;
        let slow = add(&f, "slow", "sleep 30", false, RunWhen::Manual).await;
        f.service
            .run(&f.ws, "u", Some(std::slice::from_ref(&slow.id)))
            .await
            .unwrap();
        // Running twice doesn't queue a duplicate.
        let again = f
            .service
            .run(&f.ws, "u", Some(std::slice::from_ref(&slow.id)))
            .await
            .unwrap();
        assert_eq!(f.service.active_count(&f.ws.id), 1, "{again:?}");
        assert_eq!(f.service.cancel(&f.ws.id), 1);
        settle(&f).await;
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        assert_eq!(summary.runs[0].status, CheckStatus::Cancelled);
    }

    #[tokio::test]
    async fn at_most_two_run_at_once_per_task() {
        let f = fx(CHECK_TIMEOUT).await;
        let mut ids = Vec::new();
        for i in 0..3 {
            ids.push(
                add(&f, &format!("c{i}"), "sleep 1", false, RunWhen::Manual)
                    .await
                    .id,
            );
        }
        let mut events = f.service.subscribe();
        f.service.run(&f.ws, "u", Some(&ids)).await.unwrap();
        let mut running = 0usize;
        let mut max_running = 0usize;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut settled = 0;
        while settled < 3 {
            assert!(std::time::Instant::now() < deadline);
            match tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap()
            {
                CheckEvent::Run(r) if r.status == CheckStatus::Running => {
                    running += 1;
                    max_running = max_running.max(running);
                }
                CheckEvent::Run(r) if !r.status.is_active() => {
                    running -= 1;
                    settled += 1;
                }
                _ => {}
            }
        }
        assert_eq!(max_running, 2);
    }

    /// The trusted-hash guard: a synced (unconfirmed) before_review command
    /// never auto-runs and is reported; confirming it lets it run; a rerun
    /// needs the worktree to have changed.
    #[tokio::test]
    async fn auto_run_respects_trust_and_fingerprint() {
        let f = fx(CHECK_TIMEOUT).await;
        let rc = add(&f, "lint", "true", false, RunWhen::BeforeReview).await;
        assert!(f
            .service
            .auto_run_before_review(&f.ws, "u")
            .await
            .unwrap()
            .is_empty());
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        assert_eq!(summary.needs_confirmation, vec![rc.id.clone()]);

        f.meta.trust_run_command(&rc).await.unwrap();
        assert_eq!(
            f.service
                .auto_run_before_review(&f.ws, "u")
                .await
                .unwrap()
                .len(),
            1
        );
        settle(&f).await;
        assert!(f
            .service
            .summary(&f.ws, "u")
            .await
            .unwrap()
            .needs_confirmation
            .is_empty());
        // Same worktree state → nothing to rerun.
        assert!(f
            .service
            .auto_run_before_review(&f.ws, "u")
            .await
            .unwrap()
            .is_empty());
        std::fs::write(
            Path::new(f.ws.worktree_path.as_deref().unwrap()).join("c.txt"),
            "c\n",
        )
        .unwrap();
        assert_eq!(
            f.service
                .auto_run_before_review(&f.ws, "u")
                .await
                .unwrap()
                .len(),
            1
        );
        settle(&f).await;
    }

    /// "Run checks" with no ids runs only checks trusted on this machine:
    /// a synced, never-confirmed check is left for `needs_confirmation`.
    #[tokio::test]
    async fn run_all_skips_unconfirmed_synced_checks() {
        let f = fx(CHECK_TIMEOUT).await;
        let mine = add(&f, "test", "true", true, RunWhen::Manual).await;
        f.meta.trust_run_command(&mine).await.unwrap();
        let synced = add(
            &f,
            "lint",
            "echo from-elsewhere",
            true,
            RunWhen::BeforeReview,
        )
        .await;
        let queued = f.service.run(&f.ws, "u", None).await.unwrap();
        assert_eq!(
            queued
                .iter()
                .map(|r| r.run_command_id.clone().unwrap())
                .collect::<Vec<_>>(),
            vec![mine.id.clone()]
        );
        settle(&f).await;
        // Explicitly picked: the user asked, so it runs.
        assert_eq!(
            f.service
                .run(&f.ws, "u", Some(std::slice::from_ref(&synced.id)))
                .await
                .unwrap()
                .len(),
            1
        );
        settle(&f).await;
    }

    /// Second review #2: the fingerprint is the code the check STARTED on,
    /// and it is kept. It used to be retaken after the run, so an edit made
    /// while the check ran was vouched for by a check that never saw it.
    /// (A formatter is therefore stale against its own rewrite — nothing
    /// has checked the rewritten code.)
    #[tokio::test]
    async fn the_fingerprint_is_the_code_the_check_started_on() {
        let f = fx(CHECK_TIMEOUT).await;
        let wt = PathBuf::from(f.ws.worktree_path.clone().unwrap());
        let slow = add(&f, "slow", "sleep 1", true, RunWhen::Manual).await;
        f.service
            .run(&f.ws, "u", Some(std::slice::from_ref(&slow.id)))
            .await
            .unwrap();
        // Edit while it runs.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while f
            .service
            .inner
            .runs
            .list_for_workspace(&f.ws.id)
            .await
            .unwrap()[0]
            .status
            != CheckStatus::Running
        {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        std::fs::write(wt.join("during.txt"), "edited mid-run\n").unwrap();
        settle(&f).await;
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        assert_eq!(summary.runs[0].status, CheckStatus::Passed);
        assert!(
            !summary.required_satisfied,
            "the mid-run edit was never checked"
        );
        assert_eq!(summary.stale_ids, vec![summary.runs[0].id.clone()]);
        // Undo the edit: back to the code it ran on → current again.
        std::fs::remove_file(wt.join("during.txt")).unwrap();
        assert!(
            f.service
                .summary(&f.ws, "u")
                .await
                .unwrap()
                .required_satisfied
        );

        let fmt = add(
            &f,
            "fmt",
            "printf 'formatted\\n' > a.txt",
            false,
            RunWhen::Manual,
        )
        .await;
        f.service
            .run(&f.ws, "u", Some(std::slice::from_ref(&fmt.id)))
            .await
            .unwrap();
        settle(&f).await;
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        let fmt_run = summary
            .runs
            .iter()
            .find(|r| r.run_command_id.as_deref() == Some(fmt.id.as_str()))
            .unwrap();
        assert!(summary.stale_ids.contains(&fmt_run.id), "{summary:?}");
    }

    /// Second review #3: "Commit & push" commits exactly what the checks
    /// ran on; that must not make them stale (HEAD/status/diff all move).
    #[tokio::test]
    async fn committing_the_checked_content_keeps_checks_fresh() {
        let f = fx(CHECK_TIMEOUT).await;
        let wt = PathBuf::from(f.ws.worktree_path.clone().unwrap());
        std::fs::write(wt.join("a.txt"), "agent edit\n").unwrap();
        std::fs::write(wt.join("new.txt"), "new file\n").unwrap();
        let test = add(&f, "test", "test -f new.txt", true, RunWhen::Manual).await;
        f.service
            .run(&f.ws, "u", Some(std::slice::from_ref(&test.id)))
            .await
            .unwrap();
        settle(&f).await;
        assert!(f
            .service
            .unsatisfied_required(&f.ws, "u")
            .await
            .unwrap()
            .is_empty());
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-qm", "the task"]);
        assert!(
            f.service
                .unsatisfied_required(&f.ws, "u")
                .await
                .unwrap()
                .is_empty(),
            "still fresh"
        );
        assert!(f
            .service
            .summary(&f.ws, "u")
            .await
            .unwrap()
            .stale_ids
            .is_empty());
    }

    /// Editing a check's command makes its last pass stale: it vouched for
    /// a different command.
    #[tokio::test]
    async fn editing_a_checks_command_makes_its_pass_stale() {
        let f = fx(CHECK_TIMEOUT).await;
        let test = add(&f, "test", "true", true, RunWhen::Manual).await;
        f.service
            .run(&f.ws, "u", Some(std::slice::from_ref(&test.id)))
            .await
            .unwrap();
        settle(&f).await;
        assert!(
            f.service
                .summary(&f.ws, "u")
                .await
                .unwrap()
                .required_satisfied
        );
        let patch = crate::store::RunCommandUpdate {
            name: None,
            command: Some("test -f missing.txt".into()),
            shortcut: None,
            pinned: None,
            sort_order: None,
            run_when: None,
            detect_port: None,
            required_for_approve: None,
        };
        f.run_commands.update(&test.id, patch).await.unwrap();
        let summary = f.service.summary(&f.ws, "u").await.unwrap();
        assert!(!summary.required_satisfied);
        assert_eq!(summary.stale_ids.len(), 1);
    }

    /// Auto-run on entering review + a click on Run, at once: one run.
    #[tokio::test]
    async fn racing_starts_queue_a_check_once() {
        let f = fx(CHECK_TIMEOUT).await;
        let slow = add(&f, "slow", "sleep 2", false, RunWhen::Manual).await;
        let ids = [slow.id.clone()];
        let (a, b) = tokio::join!(
            f.service.run(&f.ws, "u", Some(&ids)),
            f.service.run(&f.ws, "u", Some(&ids))
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a[0].id, b[0].id, "the second start returned the active run");
        assert_eq!(f.service.active_count(&f.ws.id), 1);
        f.service.cancel(&f.ws.id);
        settle(&f).await;
        assert_eq!(
            f.service
                .inner
                .runs
                .list_for_workspace(&f.ws.id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn no_worktree_is_a_calm_error_and_unknown_ids_are_rejected() {
        let f = fx(CHECK_TIMEOUT).await;
        let mut gone = f.ws.clone();
        gone.worktree_path = Some("/nonexistent/phasr/wt".into());
        assert!(matches!(
            f.service.run(&gone, "u", None).await,
            Err(CheckError::NoWorktree)
        ));
        assert!(matches!(
            f.service.run(&f.ws, "u", Some(&["nope".into()])).await,
            Err(CheckError::UnknownCommand(_))
        ));
        // Another user sees none of this repository's commands.
        assert!(matches!(
            f.service.run(&f.ws, "other", Some(&["nope".into()])).await,
            Err(CheckError::UnknownCommand(_))
        ));
    }
}
