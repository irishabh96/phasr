//! The task queue: starts queued tasks once whatever they wait on is
//! satisfied.
//!
//! A queued task is a never-launched `pending` row with `queued_at` set
//! (see `Workspace::is_queued`). With no dependency it starts on the next
//! pass; with one, when that task reaches review or is done
//! (`domain::board::dependency_satisfied`). A dependency that no longer
//! exists counts as satisfied — there is nothing left to wait for, and a
//! queue that can never drain is worse than an early start.
//!
//! Passes run on startup, on every task status / agent state change, on an
//! explicit `kick` (a task was queued), and on a slow tick as a backstop.
//! A pass is idempotent: `TaskOrchestrator::launch` re-reads the row under
//! the repo lock and returns an already-launched task untouched, so two
//! passes — or a pass racing "Start now" — never start a task twice.
//!
//! A task that fails to start backs off exponentially (in memory, per
//! task): passes fire on every agent-state event, and each attempt can
//! spend up to a minute fetching. After `MAX_START_FAILURES` it leaves the
//! queue as `failed` — which raises the "task failed" notification — with
//! the error in its log; "Start now" retries it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::{broadcast, Notify};

use crate::agent_signals::AgentSignalEvent;
use crate::domain::board::dependency_satisfied;
use crate::store::{StoreError, WorkspaceRepo};

use super::service::{TaskOrchestrator, TaskStatusEvent};

/// Events arrive in bursts (a turn ending is several); one pass after
/// they settle is enough.
const PASS_DEBOUNCE: Duration = Duration::from_millis(300);
/// Backstop for transitions no event reports (e.g. sign-in after boot).
const PASS_TICK: Duration = Duration::from_secs(30);
/// Wait after a task's first failed start; doubles per further failure.
const RETRY_BASE: Duration = Duration::from_secs(30);
/// Longest wait between two attempts.
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);
/// Failed starts before a task leaves the queue as `failed`.
const MAX_START_FAILURES: u32 = 5;

/// One queued task's failed starts.
#[derive(Debug, Clone, Copy)]
struct Backoff {
    failures: u32,
    next_attempt: Instant,
}

#[derive(Debug, Clone, Copy)]
struct RetryPolicy {
    base: Duration,
    max: Duration,
    max_failures: u32,
}

impl RetryPolicy {
    /// `base × 2^(failures − 1)`, capped at `max`.
    fn delay(&self, failures: u32) -> Duration {
        let factor = 2u32.saturating_pow(failures.saturating_sub(1).min(16));
        self.base.saturating_mul(factor).min(self.max)
    }
}

#[derive(Clone)]
pub struct QueueScheduler {
    orchestrator: TaskOrchestrator,
    workspaces: WorkspaceRepo,
    kick: Arc<Notify>,
    /// One pass at a time.
    pass_lock: Arc<tokio::sync::Mutex<()>>,
    backoff: Arc<Mutex<HashMap<String, Backoff>>>,
    retry: RetryPolicy,
}

impl QueueScheduler {
    pub fn new(orchestrator: TaskOrchestrator, workspaces: WorkspaceRepo) -> Self {
        Self {
            orchestrator,
            workspaces,
            kick: Arc::new(Notify::new()),
            pass_lock: Arc::new(tokio::sync::Mutex::new(())),
            backoff: Arc::new(Mutex::new(HashMap::new())),
            retry: RetryPolicy {
                base: RETRY_BASE,
                max: RETRY_MAX,
                max_failures: MAX_START_FAILURES,
            },
        }
    }

    /// Whether `task_id` is waiting out a backoff right now.
    fn backing_off(&self, task_id: &str, now: Instant) -> bool {
        self.backoff
            .lock()
            .get(task_id)
            .is_some_and(|b| b.next_attempt > now)
    }

    /// Count a failed start. `true` once the task should leave the queue.
    fn record_failure(&self, task_id: &str, now: Instant) -> bool {
        let mut backoff = self.backoff.lock();
        let entry = backoff.entry(task_id.to_string()).or_insert(Backoff {
            failures: 0,
            next_attempt: now,
        });
        entry.failures += 1;
        entry.next_attempt = now + self.retry.delay(entry.failures);
        if entry.failures >= self.retry.max_failures {
            backoff.remove(task_id);
            return true;
        }
        false
    }

    /// Ask for a pass soon (a task was just queued).
    pub fn kick(&self) {
        self.kick.notify_one();
    }

    /// Start every queued task (of `user_id`; `None` = every owner) whose
    /// dependency is satisfied. Returns the ids it started.
    pub async fn run_pass(&self, user_id: Option<&str>) -> Result<Vec<String>, StoreError> {
        let _pass = self.pass_lock.lock().await;
        let mut started = Vec::new();
        for task in self.workspaces.list_queued(user_id).await? {
            if self.backing_off(&task.id, Instant::now()) {
                continue;
            }
            let ready = match task.depends_on_workspace_id.as_deref() {
                None => true,
                Some(dependency_id) => {
                    let dependency = match user_id {
                        Some(user_id) => self.workspaces.get_for_user(dependency_id, user_id).await,
                        None => self.workspaces.get(dependency_id).await,
                    };
                    match dependency {
                        Ok(dependency) => {
                            let agent = self.orchestrator.agent_phase(&dependency.id);
                            dependency_satisfied(&dependency, agent)
                        }
                        Err(StoreError::NotFound) => true,
                        Err(err) => return Err(err),
                    }
                }
            };
            if !ready {
                continue;
            }
            match self.orchestrator.launch(&task.id, user_id, None, None).await {
                // `launch` returns the row untouched when "Start now" is
                // already starting it: that start isn't this pass's.
                Ok(launched) => {
                    self.backoff.lock().remove(&task.id);
                    if !launched.workspace.is_unlaunched() {
                        started.push(task.id);
                    }
                }
                // One task that can't start (its repository moved, a git
                // error) must not hold up the rest of the queue. It stays
                // queued and is retried after a backoff — until it has
                // failed too often, then it leaves the queue as failed.
                Err(err) => {
                    eprintln!("[queue] failed to start queued task {}: {err}", task.id);
                    if self.record_failure(&task.id, Instant::now()) {
                        let reason = err.to_string();
                        if let Err(err) = self.orchestrator.fail_unlaunched(&task.id, &reason).await {
                            eprintln!("[queue] failed to give up on queued task {}: {err}", task.id);
                        }
                    }
                }
            }
        }
        Ok(started)
    }

    /// Run passes for the signed-in user (`owner()`; `None` → skip) on
    /// startup, events, kicks and the tick. Call once, inside a Tokio
    /// runtime.
    pub fn start<F>(
        &self,
        status: broadcast::Receiver<TaskStatusEvent>,
        signals: Option<broadcast::Receiver<AgentSignalEvent>>,
        owner: F,
    ) where
        F: Fn() -> Option<String> + Send + Sync + 'static,
    {
        let scheduler = self.clone();
        tokio::spawn(async move {
            let mut status = status;
            let mut signals = signals;
            let mut tick = tokio::time::interval(PASS_TICK);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                // The first tick fires immediately: the startup pass.
                let signal = async {
                    match signals.as_mut() {
                        Some(rx) => rx.recv().await.map(|e| matches!(e, AgentSignalEvent::State(_))),
                        None => std::future::pending().await,
                    }
                };
                let wake = tokio::select! {
                    _ = tick.tick() => true,
                    _ = scheduler.kick.notified() => true,
                    event = status.recv() => match event {
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => true,
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    event = signal => match event {
                        Ok(relevant) => relevant,
                        Err(broadcast::error::RecvError::Lagged(_)) => true,
                        Err(broadcast::error::RecvError::Closed) => {
                            signals = None;
                            false
                        }
                    },
                };
                if !wake {
                    continue;
                }
                tokio::time::sleep(PASS_DEBOUNCE).await;
                // Everything that arrived during the debounce rides this pass.
                while status.try_recv().is_ok() {}
                if let Some(rx) = signals.as_mut() {
                    while rx.try_recv().is_ok() {}
                }
                let Some(user_id) = owner() else {
                    continue;
                };
                if let Err(err) = scheduler.run_pass(Some(&user_id)).await {
                    eprintln!("[queue] pass failed: {err}");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Agent, Repository, Workspace, WorkspaceStatus};
    use crate::orchestrator::{RepoLockRegistry, StartTaskRequest, TaskRow};
    use crate::orchestrator::launch::RunIn;
    use crate::pty::TaskRuntime;
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::Path;
    use std::process::Command;

    struct Fixture {
        orchestrator: TaskOrchestrator,
        scheduler: QueueScheduler,
        workspaces: WorkspaceRepo,
        repo: Repository,
        _dir: tempfile::TempDir,
    }

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repositories = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repo_dir = dir.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        git(&repo_dir, &["init", "-q", "-b", "main"]);
        git(&repo_dir, &["config", "user.email", "t@example.com"]);
        git(&repo_dir, &["config", "user.name", "t"]);
        std::fs::write(repo_dir.join("README.md"), "hi").unwrap();
        git(&repo_dir, &["add", "-A"]);
        git(&repo_dir, &["commit", "-qm", "init"]);
        let mut repo = Repository::new("r".into(), Some(repo_dir.to_string_lossy().into_owned()), None);
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();
        let orchestrator = TaskOrchestrator::new(
            workspaces.clone(),
            repositories.clone(),
            Arc::new(TaskRuntime::new(dir.path().join("logs"))),
            Arc::new(RepoLockRegistry::new()),
        );
        let scheduler = QueueScheduler::new(orchestrator.clone(), workspaces.clone());
        Fixture {
            orchestrator,
            scheduler,
            workspaces,
            repo,
            _dir: dir,
        }
    }

    fn row(f: &Fixture, name: &str, queued: bool, depends_on: Option<String>) -> TaskRow {
        TaskRow {
            repository_id: f.repo.id.clone(),
            agent: Agent::Claude,
            // Stays running for the whole test.
            command: "sleep 30".into(),
            name: name.into(),
            prompt: None,
            base_branch: None,
            permission_mode: None,
            notify_on_attention: true,
            queued,
            depends_on,
        }
    }

    async fn teardown(f: &Fixture, ids: &[&str]) {
        for id in ids {
            f.orchestrator.quiesce_task(id).await;
            if let Ok(w) = f.workspaces.get(id).await {
                if let Some(path) = w.worktree_path {
                    let _ = std::fs::remove_dir_all(path);
                }
            }
        }
    }

    fn phasr_branches(repo: &Repository) -> usize {
        let out = Command::new("git")
            .args(["branch", "--list", "phasr/*"])
            .current_dir(repo.local_path.as_deref().unwrap())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).count()
    }

    /// Concurrent passes and a concurrent "Start now" all race one queued
    /// task: it starts exactly once (one branch, one PTY).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_queued_task_starts_exactly_once_under_racing_passes() {
        let f = fixture().await;
        let queued = f.orchestrator.create_row(row(&f, "q", true, None), None).await.unwrap();
        let draft = f.orchestrator.create_row(row(&f, "d", false, None), None).await.unwrap();
        assert!(queued.is_queued() && draft.is_draft());

        let (a, b, c) = tokio::join!(
            f.scheduler.run_pass(None),
            f.scheduler.run_pass(None),
            f.orchestrator.launch(&queued.id, None, None, None),
        );
        let started: Vec<String> = a.unwrap().into_iter().chain(b.unwrap()).collect();
        let launched = c.unwrap();
        assert_eq!(launched.task_id, queued.id);
        assert!(started.len() <= 1, "started twice: {started:?}");
        assert_eq!(phasr_branches(&f.repo), 1);
        let row = f.workspaces.get(&queued.id).await.unwrap();
        assert_eq!(row.status, WorkspaceStatus::Running);
        assert!(row.queued_at.is_none(), "launch leaves the queue");
        assert_eq!(row.base_branch.as_deref(), Some("main"));
        assert!(f.orchestrator.running_task_ids().contains(&queued.id));
        // Drafts are never started by the queue.
        assert!(f.workspaces.get(&draft.id).await.unwrap().is_draft());
        // A later pass finds nothing to do.
        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());
        teardown(&f, &[&queued.id]).await;
    }

    /// B waits on A: not while A runs, not when A is stopped with changes
    /// and a turn ended (Stop, like an app quit, isn't a finish) — yes once
    /// A exits cleanly (how agents with no turn-end signal release).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dependent_task_starts_only_when_its_dependency_really_finished() {
        let f = fixture().await;
        let a = f
            .orchestrator
            .start_task(StartTaskRequest {
                repository_id: f.repo.id.clone(),
                user_id: None,
                agent: Agent::Gemini,
                // A stand-in agent that exits 0 once told to.
                command: "while [ ! -f GO ]; do sleep 0.1; done; exit 0".into(),
                name: "a".into(),
                prompt: None,
                base_branch: None,
                rows: None,
                cols: None,
                permission_mode: None,
                notify_on_attention: true,
                run_in: RunIn::Worktree,
            })
            .await
            .unwrap();
        let b = f
            .orchestrator
            .create_row(row(&f, "b", true, Some(a.task_id.clone())), None)
            .await
            .unwrap();

        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());
        assert!(f.workspaces.get(&b.id).await.unwrap().is_queued());

        // A produces work and a turn ends, but A is then stopped — what
        // startup recovery also produces. Not finished: B still waits.
        let a_path = a.workspace.worktree_path.clone().unwrap();
        std::fs::write(Path::new(&a_path).join("work.txt"), "done\n").unwrap();
        f.workspaces.set_last_turn_ended_at(&a.task_id, chrono::Utc::now()).await.unwrap();
        let resumed = {
            f.orchestrator.stop_task(&a.task_id).await.unwrap();
            assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());
            assert!(f.workspaces.get(&b.id).await.unwrap().is_queued());
            // Resume A (a fresh run: the old turn end predates it).
            f.orchestrator.open_terminal(&a.task_id, 24, 80).await.unwrap()
        };
        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());

        // A exits cleanly → completed → B goes.
        std::fs::write(Path::new(&a_path).join("GO"), "").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while f.workspaces.get(&a.task_id).await.unwrap().status != WorkspaceStatus::Completed {
            assert!(std::time::Instant::now() < deadline, "A never completed");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        drop(resumed);
        assert_eq!(f.scheduler.run_pass(None).await.unwrap(), vec![b.id.clone()]);
        assert_eq!(f.workspaces.get(&b.id).await.unwrap().status, WorkspaceStatus::Running);
        teardown(&f, &[&a.task_id, &b.id]).await;
    }

    #[test]
    fn retry_delay_doubles_and_is_capped() {
        let policy = RetryPolicy {
            base: Duration::from_secs(30),
            max: Duration::from_secs(15 * 60),
            max_failures: 5,
        };
        assert_eq!(policy.delay(1), Duration::from_secs(30));
        assert_eq!(policy.delay(2), Duration::from_secs(60));
        assert_eq!(policy.delay(3), Duration::from_secs(120));
        assert_eq!(policy.delay(10), Duration::from_secs(15 * 60));
        assert_eq!(policy.delay(u32::MAX), Duration::from_secs(15 * 60));
    }

    /// A queued task that can't start isn't retried on every pass; after
    /// `max_failures` it leaves the queue as failed (a notification
    /// follows from the status event) and "Start now" may retry it.
    #[tokio::test]
    async fn a_failing_queued_task_backs_off_then_leaves_the_queue_as_failed() {
        let mut f = fixture().await;
        let task = f.orchestrator.create_row(row(&f, "broken", true, None), None).await.unwrap();
        // Its repository's checkout disappears: every start fails.
        let repo_path = f.repo.local_path.clone().unwrap();
        let moved = format!("{repo_path}-moved");
        std::fs::rename(&repo_path, &moved).unwrap();
        let mut status = f.orchestrator.subscribe_status();

        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());
        assert_eq!(f.scheduler.backoff.lock()[&task.id].failures, 1);
        // The next pass (an agent-state event, say) is inside the backoff:
        // no attempt at all.
        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());
        assert_eq!(f.scheduler.backoff.lock()[&task.id].failures, 1);

        // Out of patience: no wait between attempts, give up after 3.
        f.scheduler.retry = RetryPolicy {
            base: Duration::ZERO,
            max: Duration::ZERO,
            max_failures: 3,
        };
        f.scheduler.backoff.lock().get_mut(&task.id).unwrap().next_attempt = Instant::now();
        f.scheduler.run_pass(None).await.unwrap();
        assert!(f.workspaces.get(&task.id).await.unwrap().is_queued(), "2 failures: still queued");
        f.scheduler.run_pass(None).await.unwrap();
        let failed = f.workspaces.get(&task.id).await.unwrap();
        assert_eq!(failed.status, WorkspaceStatus::Failed);
        assert!(failed.queued_at.is_none(), "out of the queue");
        assert!(!f.scheduler.backoff.lock().contains_key(&task.id));
        let mut saw_failed = false;
        while let Ok(event) = status.try_recv() {
            saw_failed |= event.task_id == task.id && event.status == WorkspaceStatus::Failed;
        }
        assert!(saw_failed, "the failure is announced (→ notification)");
        let log = f.orchestrator.read_task_log(&task.id).await.unwrap();
        assert!(log.contains("couldn't start"), "{log}");
        // Later passes leave it alone.
        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());

        // "Start now" retries it: with the checkout back, it launches.
        std::fs::rename(&moved, &repo_path).unwrap();
        let started = f.orchestrator.launch(&task.id, None, None, None).await.unwrap();
        assert_eq!(started.workspace.status, WorkspaceStatus::Running);
        teardown(&f, &[&task.id]).await;
    }

    /// A row queued on ANOTHER machine arrives through sync (its own SQL,
    /// which never sets the local marker): it shows as queued here but the
    /// scheduler never starts it. Re-queueing it on this machine does.
    #[tokio::test]
    async fn a_task_queued_on_another_machine_never_auto_starts_here() {
        let f = fixture().await;
        let mut synced = Workspace::new(f.repo.id.clone(), "from-elsewhere".into(), "sleep 30".into());
        synced.agent = Some(Agent::Claude);
        synced.queued_at = Some(chrono::Utc::now());
        f.workspaces.insert(&synced).await.unwrap();
        // What a sync pull leaves behind: no local marker.
        sqlx::query("UPDATE workspaces SET queued_here = 0 WHERE id = ?")
            .bind(&synced.id)
            .execute(f.workspaces.pool())
            .await
            .unwrap();
        assert!(f.workspaces.get(&synced.id).await.unwrap().is_queued(), "still shows as queued");
        assert!(f.scheduler.run_pass(None).await.unwrap().is_empty());
        assert_eq!(phasr_branches(&f.repo), 0);

        // The user queues it on THIS machine → it's ours to start.
        f.orchestrator
            .update_unlaunched(
                &synced.id,
                None,
                crate::orchestrator::TaskRowPatch {
                    queued: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(f.scheduler.run_pass(None).await.unwrap(), vec![synced.id.clone()]);
        teardown(&f, &[&synced.id]).await;
    }

    #[tokio::test]
    async fn a_missing_dependency_does_not_block_and_cycles_are_refused() {
        let f = fixture().await;
        let a = f.orchestrator.create_row(row(&f, "a", false, None), None).await.unwrap();
        let b = f
            .orchestrator
            .create_row(row(&f, "b", false, Some(a.id.clone())), None)
            .await
            .unwrap();
        // a → b would close a cycle; a → a is itself.
        for dep in [&b.id, &a.id] {
            let err = f
                .orchestrator
                .update_unlaunched(
                    &a.id,
                    None,
                    crate::orchestrator::TaskRowPatch {
                        depends_on: Some(Some(dep.clone())),
                        ..Default::default()
                    },
                )
                .await
                .unwrap_err();
            assert!(matches!(err, crate::orchestrator::OrchestratorError::InvalidDependency(_)));
        }
        assert!(matches!(
            f.orchestrator.create_row(row(&f, "c", true, Some("nope".into())), None).await,
            Err(crate::orchestrator::OrchestratorError::InvalidDependency(_))
        ));
        // The dependency disappears: the queue doesn't wait forever.
        let queued = f
            .orchestrator
            .update_unlaunched(
                &b.id,
                None,
                crate::orchestrator::TaskRowPatch {
                    queued: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(queued.is_queued());
        f.workspaces.delete(&a.id).await.unwrap();
        assert_eq!(f.scheduler.run_pass(None).await.unwrap(), vec![b.id.clone()]);
        // Started tasks reject draft edits.
        assert!(matches!(
            f.orchestrator
                .update_unlaunched(&b.id, None, crate::orchestrator::TaskRowPatch::default())
                .await,
            Err(crate::orchestrator::OrchestratorError::AlreadyLaunched)
        ));
        let _: Workspace = f.workspaces.get(&b.id).await.unwrap();
        teardown(&f, &[&b.id]).await;
    }
}
