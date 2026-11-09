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

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, Notify};

use crate::agent_signals::AgentSignalEvent;
use crate::domain::board::dependency_satisfied;
use crate::store::{StoreError, WorkspaceRepo};

use super::board::TaskBoard;
use super::service::{TaskOrchestrator, TaskStatusEvent};

/// Events arrive in bursts (a turn ending is several); one pass after
/// they settle is enough.
const PASS_DEBOUNCE: Duration = Duration::from_millis(300);
/// Backstop for transitions no event reports (e.g. sign-in after boot).
const PASS_TICK: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct QueueScheduler {
    orchestrator: TaskOrchestrator,
    board: TaskBoard,
    workspaces: WorkspaceRepo,
    kick: Arc<Notify>,
    /// One pass at a time.
    pass_lock: Arc<tokio::sync::Mutex<()>>,
}

impl QueueScheduler {
    pub fn new(orchestrator: TaskOrchestrator, board: TaskBoard, workspaces: WorkspaceRepo) -> Self {
        Self {
            orchestrator,
            board,
            workspaces,
            kick: Arc::new(Notify::new()),
            pass_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
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
            let ready = match task.depends_on_workspace_id.as_deref() {
                None => true,
                Some(dependency_id) => {
                    let dependency = match user_id {
                        Some(user_id) => self.workspaces.get_for_user(dependency_id, user_id).await,
                        None => self.workspaces.get(dependency_id).await,
                    };
                    match dependency {
                        Ok(dependency) => {
                            let lane = self.board.lane_of(&dependency).await;
                            dependency_satisfied(&dependency, lane)
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
                Ok(_) => started.push(task.id),
                // One task that can't start (its repository moved, a git
                // error) must not hold up the rest of the queue. It stays
                // queued and is retried on the next pass.
                Err(err) => eprintln!("[queue] failed to start queued task {}: {err}", task.id),
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
    use crate::store::{init_pool, RepositoryRepo, TaskUsageRepo};
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
        let board = TaskBoard::new(workspaces.clone(), repositories, TaskUsageRepo::new(pool), None);
        let scheduler = QueueScheduler::new(orchestrator.clone(), board, workspaces.clone());
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

    /// B waits on A: not while A is running with nothing to review; yes
    /// once A has stopped with changes (needs review).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dependent_task_starts_when_its_dependency_reaches_review() {
        let f = fixture().await;
        let a = f
            .orchestrator
            .start_task(StartTaskRequest {
                repository_id: f.repo.id.clone(),
                user_id: None,
                agent: Agent::Claude,
                command: "sleep 30".into(),
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

        // A produces work and stops → needs review → B goes.
        let a_path = a.workspace.worktree_path.clone().unwrap();
        std::fs::write(Path::new(&a_path).join("work.txt"), "done\n").unwrap();
        f.orchestrator.stop_task(&a.task_id).await.unwrap();
        assert_eq!(f.scheduler.run_pass(None).await.unwrap(), vec![b.id.clone()]);
        assert_eq!(f.workspaces.get(&b.id).await.unwrap().status, WorkspaceStatus::Running);
        teardown(&f, &[&a.task_id, &b.id]).await;
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
