//! The notifications inbox: turns task / agent / check / run-command events
//! into stored entries, deduped, and announces each new one. Whether an
//! entry also becomes a banner / sound is the frontend's call
//! (`notificationPolicy.ts`), from the user's prefs, focus and local time.
//!
//! Tauri-agnostic: `commands::events` re-emits `subscribe()` as
//! `phasr://notification-created`.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::broadcast;

use crate::agent_signals::state::AgentStateKind;
use crate::agent_signals::{AgentSignalEvent, TaskAgentState};
use crate::checks::{CheckEvent, CheckService};
use crate::domain::{AppNotification, CheckRun, CheckStatus, NotificationKind, Workspace, WorkspaceStatus};
use crate::orchestrator::TaskStatusEvent;
use crate::run_commands::RunCommandEvent;
use crate::store::{NotificationRepo, StoreError, WorkspaceRepo};

/// Entries older than this are pruned — at startup and then every
/// `PRUNE_INTERVAL` while the app runs.
pub const RETENTION_DAYS: i64 = 30;
/// How often old notifications are pruned while the app runs.
const PRUNE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);
const EVENT_CAPACITY: usize = 256;

struct Inner {
    repo: NotificationRepo,
    workspaces: WorkspaceRepo,
    checks: Option<CheckService>,
    events: broadcast::Sender<AppNotification>,
    /// Last agent state per task: a turn ending is Working → Idle.
    last_agent: Mutex<HashMap<String, AgentStateKind>>,
    /// Makes "already suggested?" + insert one step for cleanup
    /// suggestions (two merge reports racing must not both insert).
    cleanup_suggest: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct NotificationService {
    inner: Arc<Inner>,
}

/// What to do when the task already has an unread entry of the same kind.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dedupe {
    /// Keep the existing one; drop the new one ("needs approval" — one is
    /// enough to bring the user back).
    KeepExisting,
    /// The new one supersedes it (a newer checks result): the old is marked
    /// read, the new one is recorded.
    Replace,
}

impl NotificationService {
    pub fn new(repo: NotificationRepo, workspaces: WorkspaceRepo, checks: Option<CheckService>) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                repo,
                workspaces,
                checks,
                events,
                last_agent: Mutex::new(HashMap::new()),
                cleanup_suggest: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppNotification> {
        self.inner.events.subscribe()
    }

    pub async fn prune_old(&self) {
        let cutoff = Utc::now() - chrono::Duration::days(RETENTION_DAYS);
        if let Err(err) = self.inner.repo.prune_before(cutoff).await {
            eprintln!("failed to prune old notifications: {err}");
        }
    }

    /// Prune now and then every `PRUNE_INTERVAL` for as long as the app
    /// runs — a Mac that stays up for weeks would otherwise only ever
    /// prune at launch. Call once, inside a Tokio runtime.
    pub fn start_pruning(&self) {
        self.start_pruning_every(PRUNE_INTERVAL);
    }

    fn start_pruning_every(&self, interval: std::time::Duration) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                // The first tick fires immediately: the startup prune.
                tick.tick().await;
                this.prune_old().await;
            }
        });
    }

    /// Store + announce `n` for `task`, applying the task's
    /// `notify_on_attention` switch and the dedupe rule.
    async fn record(
        &self,
        user_id: &str,
        task: &Workspace,
        mut n: AppNotification,
        dedupe: Dedupe,
    ) -> Result<Option<AppNotification>, StoreError> {
        if n.kind.is_attention() && !task.notify_on_attention {
            return Ok(None);
        }
        if self.inner.repo.has_unread(user_id, n.kind, &task.id).await? {
            match dedupe {
                Dedupe::KeepExisting => return Ok(None),
                Dedupe::Replace => {
                    self.inner.repo.mark_read_for_task(user_id, n.kind, &task.id).await?;
                }
            }
        }
        n.workspace_id = Some(task.id.clone());
        n.repository_id = Some(task.repository_id.clone());
        if let Some(obj) = n.payload.as_object_mut() {
            obj.insert("taskId".into(), json!(task.id));
            obj.insert("repositoryId".into(), json!(task.repository_id));
        }
        self.inner.repo.insert(&n, user_id).await?;
        let _ = self.inner.events.send(n.clone());
        Ok(Some(n))
    }

    /// "Merged — remove its worktree?" (Settings → Worktrees → cleanup after
    /// merge = ask). Recorded as `task_finished` with
    /// `payload.suggestion = "cleanup"`: a new kind would reach clients
    /// whose delivery matrix can't name it. Bypasses the task's
    /// `notify_on_attention` switch and the unread dedupe — it's a question
    /// about the user's disk, asked once per merge: `None` when the task
    /// already has one (several paths can report the same merge — a local
    /// merge, a continued merge, overlapping PR refreshes).
    pub async fn suggest_cleanup(&self, user_id: &str, task: &Workspace) -> Result<Option<AppNotification>, StoreError> {
        let _once = self.inner.cleanup_suggest.lock().await;
        if self.inner.repo.has_cleanup_suggestion(user_id, &task.id).await? {
            return Ok(None);
        }
        let mut n = AppNotification::new(NotificationKind::TaskFinished, format!("{} merged", task.name));
        n.body = Some("Remove its worktree and local branch?".into());
        n.workspace_id = Some(task.id.clone());
        n.repository_id = Some(task.repository_id.clone());
        n.payload = json!({
            "suggestion": "cleanup",
            "taskId": task.id,
            "repositoryId": task.repository_id,
            "worktreePath": task.worktree_path,
            "branch": task.branch,
        });
        self.inner.repo.insert(&n, user_id).await?;
        let _ = self.inner.events.send(n.clone());
        Ok(Some(n))
    }

    async fn task(&self, user_id: &str, task_id: &str) -> Option<Workspace> {
        self.inner.workspaces.get_for_user(task_id, user_id).await.ok()
    }

    pub async fn on_status(&self, user_id: &str, event: &TaskStatusEvent) -> Result<Option<AppNotification>, StoreError> {
        let (kind, verb) = match event.status {
            WorkspaceStatus::Failed => (NotificationKind::TaskFailed, "failed"),
            WorkspaceStatus::Completed => (NotificationKind::TaskFinished, "finished"),
            _ => return Ok(None),
        };
        let Some(task) = self.task(user_id, &event.task_id).await else {
            return Ok(None);
        };
        let mut n = AppNotification::new(kind, format!("{} {verb}", task.name));
        n.body = match (event.status, event.exit_code) {
            (WorkspaceStatus::Failed, Some(code)) => Some(format!("The agent exited with code {code}.")),
            (WorkspaceStatus::Failed, None) => Some("The agent exited unexpectedly.".into()),
            _ => Some("Ready for review.".into()),
        };
        n.payload = json!({ "status": event.status.as_str(), "exitCode": event.exit_code });
        self.record(user_id, &task, n, Dedupe::KeepExisting).await
    }

    pub async fn on_agent_state(&self, user_id: &str, state: &TaskAgentState) -> Result<Option<AppNotification>, StoreError> {
        let previous = self
            .inner
            .last_agent
            .lock()
            .insert(state.task_id.clone(), state.state);
        if previous == Some(state.state) {
            return Ok(None);
        }
        // Answered (or moved on): its approval entry is no longer news.
        if previous == Some(AgentStateKind::NeedsYou) {
            self.inner
                .repo
                .mark_read_for_task(user_id, NotificationKind::NeedsApproval, &state.task_id)
                .await?;
        }
        let Some(task) = self.task(user_id, &state.task_id).await else {
            return Ok(None);
        };
        match state.state {
            AgentStateKind::NeedsYou => {
                let mut n = AppNotification::new(NotificationKind::NeedsApproval, format!("{} needs you", task.name));
                n.body = state
                    .attention
                    .as_ref()
                    .map(|a| match a.detail.as_deref() {
                        Some(detail) => format!("{}: {detail}", a.title),
                        None => a.title.clone(),
                    });
                n.payload = json!({ "attentionId": state.attention.as_ref().map(|a| a.id.clone()) });
                self.record(user_id, &task, n, Dedupe::KeepExisting).await
            }
            // A turn ended: the agent is waiting at its prompt with its work.
            AgentStateKind::Idle if previous == Some(AgentStateKind::Working) => {
                let mut n = AppNotification::new(NotificationKind::TaskFinished, format!("{} finished", task.name));
                n.body = Some("The agent finished its turn.".into());
                self.record(user_id, &task, n, Dedupe::KeepExisting).await
            }
            _ => Ok(None),
        }
    }

    /// A check settled: once the task has no check left queued/running, one
    /// entry summarizes the batch. A batch the user cancelled says nothing.
    pub async fn on_check_run(&self, user_id: &str, run: &CheckRun) -> Result<Option<AppNotification>, StoreError> {
        if run.status.is_active() || run.status == CheckStatus::Cancelled {
            return Ok(None);
        }
        let Some(checks) = self.inner.checks.as_ref() else {
            return Ok(None);
        };
        if checks.active_count(&run.workspace_id) > 0 {
            return Ok(None);
        }
        let Some(task) = self.task(user_id, &run.workspace_id).await else {
            return Ok(None);
        };
        let latest = checks.latest_runs(&task, user_id).await.unwrap_or_default();
        let failed: Vec<&str> = latest
            .iter()
            .filter(|r| matches!(r.status, CheckStatus::Failed | CheckStatus::Timeout | CheckStatus::Error))
            .map(|r| r.name.as_str())
            .collect();
        let passed = latest.iter().filter(|r| r.status == CheckStatus::Passed).count();
        let mut n = AppNotification::new(
            NotificationKind::ChecksFinished,
            if failed.is_empty() {
                format!("Checks passed on {}", task.name)
            } else {
                format!("Checks failed on {}", task.name)
            },
        );
        n.body = Some(if failed.is_empty() {
            format!("{passed} passed")
        } else {
            format!("{} failed: {}", failed.len(), failed.join(", "))
        });
        n.payload = json!({ "failed": failed, "passed": passed });
        self.record(user_id, &task, n, Dedupe::Replace).await
    }

    pub async fn on_run_command(&self, event: &RunCommandEvent) -> Result<Option<AppNotification>, StoreError> {
        let state = &event.state;
        if state.running || event.stopped_by_user || state.exit_code == Some(0) {
            return Ok(None);
        }
        let mut n = AppNotification::new(NotificationKind::RunCommandFailed, format!("{} exited", event.name));
        n.body = Some(match state.exit_code {
            Some(code) => format!("Exited with code {code}."),
            None => "It was killed.".into(),
        });
        n.payload = json!({
            "runCommandId": state.run_command_id,
            "workspaceId": state.workspace_id,
            "exitCode": state.exit_code,
        });
        match state.workspace_id.as_deref() {
            Some(task_id) => {
                let Some(task) = self.task(&event.user_id, task_id).await else {
                    return Ok(None);
                };
                self.record(&event.user_id, &task, n, Dedupe::Replace).await
            }
            None => {
                n.repository_id = Some(event.repository_id.clone());
                if let Some(obj) = n.payload.as_object_mut() {
                    obj.insert("repositoryId".into(), json!(event.repository_id));
                }
                self.inner.repo.insert(&n, &event.user_id).await?;
                let _ = self.inner.events.send(n.clone());
                Ok(Some(n))
            }
        }
    }

    /// Follow every source. `current_user` = the signed-in user (signed
    /// out, nothing is recorded). Call once, inside a Tokio runtime.
    pub fn start<F>(
        &self,
        status: broadcast::Receiver<TaskStatusEvent>,
        signals: Option<broadcast::Receiver<AgentSignalEvent>>,
        checks: Option<broadcast::Receiver<CheckEvent>>,
        runs: Option<broadcast::Receiver<RunCommandEvent>>,
        current_user: F,
    ) where
        F: Fn() -> Option<String> + Send + Sync + 'static,
    {
        let current_user = Arc::new(current_user);
        let report = |what: &str, r: Result<Option<AppNotification>, StoreError>| {
            if let Err(err) = r {
                eprintln!("notification ({what}) failed: {err}");
            }
        };

        let this = self.clone();
        let user = current_user.clone();
        tokio::spawn(async move {
            let mut rx = status;
            loop {
                match rx.recv().await {
                    Ok(e) => {
                        if let Some(u) = user() {
                            report("status", this.on_status(&u, &e).await);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        if let Some(mut rx) = signals {
            let this = self.clone();
            let user = current_user.clone();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(AgentSignalEvent::State(state)) => {
                            if let Some(u) = user() {
                                report("agent state", this.on_agent_state(&u, &state).await);
                            }
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        if let Some(mut rx) = checks {
            let this = self.clone();
            let user = current_user.clone();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(CheckEvent::Run(run)) => {
                            if let Some(u) = user() {
                                report("checks", this.on_check_run(&u, &run).await);
                            }
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        if let Some(mut rx) = runs {
            let this = self.clone();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(e) => report("run command", this.on_run_command(&e).await),
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_signals::state::{Attention, AttentionKind, AttentionSource};
    use crate::domain::Repository;
    use crate::run_commands::RunningCommand;
    use crate::store::{init_pool, RepositoryRepo};

    async fn fx() -> (NotificationService, NotificationRepo, WorkspaceRepo, Workspace, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES ('u', 'u', 'n', 'u@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert_for_user(&repo, "u").await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let ws = Workspace::new(repo.id, "Fix login".into(), "c".into());
        workspaces.insert_for_user(&ws, "u").await.unwrap();
        let repo = NotificationRepo::new(pool);
        let service = NotificationService::new(repo.clone(), workspaces.clone(), None);
        (service, repo, workspaces, ws, dir)
    }

    fn agent(ws: &Workspace, state: AgentStateKind, attention: Option<&str>) -> TaskAgentState {
        TaskAgentState {
            task_id: ws.id.clone(),
            repository_id: ws.repository_id.clone(),
            state,
            attention: attention.map(|id| Attention {
                id: id.into(),
                kind: AttentionKind::Shell,
                title: "Run a command".into(),
                detail: Some("rm -rf build".into()),
                since: Utc::now(),
                source: AttentionSource::Hook,
                can_respond: true,
                can_allow_for_task: false,
                keys: Default::default(),
            }),
            last_activity: None,
            last_turn_ended_at: None,
        }
    }

    #[tokio::test]
    async fn one_unread_needs_approval_per_task() {
        let (svc, repo, _w, ws, _d) = fx().await;
        let mut rx = svc.subscribe();
        let first = svc.on_agent_state("u", &agent(&ws, AgentStateKind::NeedsYou, Some("a1"))).await.unwrap();
        let n = first.expect("first approval is recorded");
        assert_eq!(n.kind, NotificationKind::NeedsApproval);
        assert_eq!(n.title, "Fix login needs you");
        assert_eq!(n.body.as_deref(), Some("Run a command: rm -rf build"));
        assert_eq!(n.payload["taskId"], ws.id.as_str());
        assert_eq!(rx.try_recv().unwrap().id, n.id, "announced");

        // Working, then a second approval while the first is still unread.
        svc.on_agent_state("u", &agent(&ws, AgentStateKind::Working, None)).await.unwrap();
        // Leaving needs-you marked it read, so a NEW dialog is news again…
        assert_eq!(repo.unread_count("u").await.unwrap(), 0);
        assert!(svc.on_agent_state("u", &agent(&ws, AgentStateKind::NeedsYou, Some("a2"))).await.unwrap().is_some());
        // …but a repeat of the same state, or a second unread, is not.
        assert!(svc.on_agent_state("u", &agent(&ws, AgentStateKind::NeedsYou, Some("a2"))).await.unwrap().is_none());
        svc.inner.last_agent.lock().clear();
        assert!(svc.on_agent_state("u", &agent(&ws, AgentStateKind::NeedsYou, Some("a3"))).await.unwrap().is_none());
        assert_eq!(repo.unread_count("u").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn notify_on_attention_off_silences_attention_kinds_only() {
        let (svc, repo, workspaces, ws, _d) = fx().await;
        workspaces
            .update(&ws.id, crate::store::WorkspaceUpdate { notify_on_attention: Some(false), ..Default::default() })
            .await
            .unwrap();
        assert!(svc.on_agent_state("u", &agent(&ws, AgentStateKind::NeedsYou, Some("a"))).await.unwrap().is_none());
        let failed = TaskStatusEvent {
            task_id: ws.id.clone(),
            repository_id: ws.repository_id.clone(),
            status: WorkspaceStatus::Failed,
            exit_code: Some(1),
        };
        assert!(svc.on_status("u", &failed).await.unwrap().is_none());
        // A run command failing isn't an attention kind.
        let event = RunCommandEvent {
            state: RunningCommand {
                run_command_id: "rc".into(),
                workspace_id: Some(ws.id.clone()),
                started_at: Utc::now(),
                running: false,
                exit_code: Some(1),
                port: None,
            },
            user_id: "u".into(),
            repository_id: ws.repository_id.clone(),
            name: "dev".into(),
            stopped_by_user: false,
        };
        let n = svc.on_run_command(&event).await.unwrap().unwrap();
        assert_eq!((n.kind, n.title.as_str()), (NotificationKind::RunCommandFailed, "dev exited"));
        // The user's own stop, or a clean exit, says nothing.
        let mut stopped = event.clone();
        stopped.stopped_by_user = true;
        assert!(svc.on_run_command(&stopped).await.unwrap().is_none());
        let mut clean = event;
        clean.state.exit_code = Some(0);
        assert!(svc.on_run_command(&clean).await.unwrap().is_none());
        assert_eq!(repo.unread_count("u").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn turn_end_and_failures_are_recorded_for_the_owner_only() {
        let (svc, repo, _w, ws, _d) = fx().await;
        svc.on_agent_state("u", &agent(&ws, AgentStateKind::Working, None)).await.unwrap();
        let done = svc.on_agent_state("u", &agent(&ws, AgentStateKind::Idle, None)).await.unwrap().unwrap();
        assert_eq!(done.kind, NotificationKind::TaskFinished);
        // Idle without a working turn before it (e.g. at startup) isn't news.
        svc.inner.last_agent.lock().clear();
        repo.mark_read("u", None).await.unwrap();
        assert!(svc.on_agent_state("u", &agent(&ws, AgentStateKind::Idle, None)).await.unwrap().is_none());

        let failed = TaskStatusEvent {
            task_id: ws.id.clone(),
            repository_id: ws.repository_id.clone(),
            status: WorkspaceStatus::Failed,
            exit_code: Some(2),
        };
        let n = svc.on_status("u", &failed).await.unwrap().unwrap();
        assert_eq!(n.body.as_deref(), Some("The agent exited with code 2."));
        // Another account's task id records nothing.
        assert!(svc.on_status("x", &failed).await.unwrap().is_none());
    }

    /// Pruning runs on a timer for as long as the app runs (first pass
    /// immediately), not only once at launch.
    #[tokio::test]
    async fn old_notifications_are_pruned_periodically() {
        let (service, repo, _w, _ws, _dir) = fx().await;
        let mut old = AppNotification::new(NotificationKind::TaskFailed, "old");
        old.created_at = Utc::now() - chrono::Duration::days(RETENTION_DAYS + 1);
        repo.insert(&old, "u").await.unwrap();
        // The production cadence is hourly; the mechanism is the same.
        service.start_pruning_every(std::time::Duration::from_millis(100));
        let wait_for_count = |want: usize| {
            let repo = repo.clone();
            async move {
                for _ in 0..200 {
                    if repo.list_for_user("u", false, None).await.unwrap().len() == want {
                        return true;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                false
            }
        };
        assert!(wait_for_count(0).await, "pruned at start");
        // Something that ages past retention while the app stays up is
        // pruned on a later pass, not just at launch.
        let mut later = AppNotification::new(NotificationKind::TaskFailed, "aged");
        later.created_at = Utc::now() - chrono::Duration::days(RETENTION_DAYS + 1);
        repo.insert(&later, "u").await.unwrap();
        assert!(wait_for_count(0).await, "pruned again on the next tick");
        assert_eq!(PRUNE_INTERVAL, std::time::Duration::from_secs(3600));
    }
}
