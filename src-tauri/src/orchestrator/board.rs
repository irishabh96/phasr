//! The Board: every task as a card in its derived lane, with its diff vs
//! base, live agent state and usage — plus a cheap "cards changed" signal
//! so the UI refetches instead of polling.
//!
//! Tauri-agnostic like the rest of the orchestrator: changes go out on a
//! `tokio::broadcast` and `commands::events` re-emits them as
//! `phasr://task-cards-changed`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::{broadcast, Notify, Semaphore};

use crate::agent_signals::state::AgentStateKind;
use crate::agent_signals::{AgentSignalEvent, AgentSignals, TaskAgentState};
use crate::domain::board::{derive_lane, AgentPhase, DiffStats, Lane};
use crate::domain::usage::TaskUsage;
use crate::domain::{Workspace, WorkspaceStatus};
use crate::git::DiffStatCache;
use crate::store::{RepositoryRepo, StoreError, TaskUsageRepo, WorkspaceRepo};

use super::service::TaskStatusEvent;

/// How long a computed diff is trusted without an invalidating signal.
const DIFF_TTL: Duration = Duration::from_secs(15);
/// Diffs computed at once on a cold cache (each is a few git processes).
const DIFF_CONCURRENCY: usize = 4;
/// Change notifications are coalesced per repository over this window, so
/// a burst of agent events costs the UI one refetch.
const CHANGE_COALESCE: Duration = Duration::from_millis(300);
const EVENT_CAPACITY: usize = 256;

/// One task on the Board. `list_task_cards` returns these.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCard {
    pub workspace: Workspace,
    pub lane: Lane,
    /// Changes vs the task's base; `None` before launch, when archived, or
    /// when the worktree isn't on this machine.
    pub diff: Option<DiffStats>,
    /// `None` when phasr hasn't tracked the agent since startup.
    pub agent_state: Option<TaskAgentState>,
    /// Stored token/cost snapshot; `None` for agents without usage.
    pub usage: Option<TaskUsage>,
    /// When it stopped working ("finished 18m ago"); finished lanes only.
    pub finished_at: Option<DateTime<Utc>>,
    /// Name of the task a queued task waits on.
    pub depends_on_name: Option<String>,
}

#[derive(Debug, Clone)]
pub enum BoardEvent {
    /// A card in this repository may have moved lanes or changed.
    CardsChanged { repository_id: String },
}

struct Inner {
    workspaces: WorkspaceRepo,
    repositories: RepositoryRepo,
    usage: TaskUsageRepo,
    signals: Option<AgentSignals>,
    diffs: DiffStatCache,
    events: broadcast::Sender<BoardEvent>,
    /// Repositories with a change not yet announced.
    pending: Mutex<HashSet<String>>,
    flush: Notify,
    /// `task_id → repository_id` for tasks a card was built for, so a
    /// file-change signal (which only knows the task) can be announced.
    task_repos: Mutex<HashMap<String, String>>,
    /// Last (state, attention) seen per task: activity-line-only updates
    /// can't move a card, so they don't announce one.
    last_agent: Mutex<HashMap<String, (AgentStateKind, Option<String>)>>,
}

#[derive(Clone)]
pub struct TaskBoard {
    inner: Arc<Inner>,
}

impl TaskBoard {
    pub fn new(
        workspaces: WorkspaceRepo,
        repositories: RepositoryRepo,
        usage: TaskUsageRepo,
        signals: Option<AgentSignals>,
    ) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                workspaces,
                repositories,
                usage,
                signals,
                diffs: DiffStatCache::new(DIFF_TTL),
                events,
                pending: Mutex::new(HashSet::new()),
                flush: Notify::new(),
                task_repos: Mutex::new(HashMap::new()),
                last_agent: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BoardEvent> {
        self.inner.events.subscribe()
    }

    // ── cards ───────────────────────────────────────────────────────────

    /// Every task card, one repository or all, newest first. `user_id:
    /// None` = every owner (the sessionless test path).
    pub async fn cards(
        &self,
        user_id: Option<&str>,
        repository_id: Option<&str>,
    ) -> Result<Vec<TaskCard>, StoreError> {
        let tasks = match user_id {
            Some(user_id) => {
                self.inner
                    .workspaces
                    .list_tasks_for_user(user_id, repository_id)
                    .await?
            }
            None => self.inner.workspaces.list_tasks(repository_id).await?,
        };
        {
            let mut repos = self.inner.task_repos.lock();
            for task in &tasks {
                repos.insert(task.id.clone(), task.repository_id.clone());
            }
        }
        let states: HashMap<String, TaskAgentState> = self
            .inner
            .signals
            .as_ref()
            .map(|s| s.states().into_iter().map(|st| (st.task_id.clone(), st)).collect())
            .unwrap_or_default();
        let diffs = self.diffs_for(&tasks).await;
        let names: HashMap<&str, &str> = tasks.iter().map(|t| (t.id.as_str(), t.name.as_str())).collect();

        let mut cards = Vec::with_capacity(tasks.len());
        for task in &tasks {
            let state = states.get(&task.id).cloned();
            let diff = diffs.get(&task.id).copied();
            let Some(lane) = derive_lane(task, state.as_ref().map(|s| s.state.into()), diff.as_ref())
            else {
                continue;
            };
            let depends_on_name = match task.depends_on_workspace_id.as_deref() {
                None => None,
                Some(id) => match names.get(id) {
                    Some(name) => Some((*name).to_string()),
                    // Filtered to another repository, or gone.
                    None => self.inner.workspaces.get(id).await.ok().map(|w| w.name),
                },
            };
            let usage = if task.agent.is_some_and(|a| a.usage_supported()) && task.branch.is_some() {
                self.inner.usage.get(&task.id).await.ok().flatten()
            } else {
                None
            };
            cards.push(TaskCard {
                finished_at: finished_at(task, lane, state.as_ref()),
                workspace: task.clone(),
                lane,
                diff,
                agent_state: state,
                usage,
                depends_on_name,
            });
        }
        Ok(cards)
    }

    /// One task's lane right now (the queue's dependency check).
    pub async fn lane_of(&self, task: &Workspace) -> Option<Lane> {
        let phase: Option<AgentPhase> = self.inner.signals.as_ref().and_then(|s| {
            s.states()
                .into_iter()
                .find(|st| st.task_id == task.id)
                .map(|st| st.state.into())
        });
        let diff = self.diffs_for(std::slice::from_ref(task)).await.remove(&task.id);
        derive_lane(task, phase, diff.as_ref())
    }

    /// Diff stats for the tasks that have a worktree here, computed (or
    /// served from the cache) a few at a time off the async runtime.
    async fn diffs_for(&self, tasks: &[Workspace]) -> HashMap<String, DiffStats> {
        let mut bases: HashMap<String, String> = HashMap::new();
        let mut jobs: Vec<(String, PathBuf, String)> = Vec::new();
        for task in tasks {
            if task.status == WorkspaceStatus::Archived || task.branch.is_none() {
                continue;
            }
            let Some(path) = task.worktree_path.as_deref().map(PathBuf::from) else {
                continue;
            };
            let base = match task.base_branch.clone() {
                Some(base) => base,
                None => match bases.get(&task.repository_id) {
                    Some(base) => base.clone(),
                    None => {
                        let Ok(repo) = self.inner.repositories.get(&task.repository_id).await else {
                            continue;
                        };
                        bases.insert(task.repository_id.clone(), repo.default_branch.clone());
                        repo.default_branch
                    }
                },
            };
            jobs.push((task.id.clone(), path, base));
        }

        let limit = Arc::new(Semaphore::new(DIFF_CONCURRENCY));
        let mut set = tokio::task::JoinSet::new();
        for (task_id, path, base) in jobs {
            let board = self.clone();
            let limit = limit.clone();
            set.spawn(async move {
                let _permit = limit.acquire_owned().await.ok()?;
                tokio::task::spawn_blocking(move || {
                    if !path.exists() {
                        return None;
                    }
                    let diffs = &board.inner.diffs;
                    // A base that only exists on the remote (never checked
                    // out locally) still has a merge-base there.
                    let stats = diffs
                        .stats(&task_id, &path, &base)
                        .or_else(|_| diffs.stats(&task_id, &path, &format!("origin/{base}")))
                        .ok()?;
                    Some((task_id, stats))
                })
                .await
                .ok()
                .flatten()
            });
        }
        let mut out = HashMap::new();
        while let Some(done) = set.join_next().await {
            if let Ok(Some((task_id, stats))) = done {
                out.insert(task_id, stats);
            }
        }
        out
    }

    /// `(agents running, worktrees on disk)` for the status bar. Agents =
    /// task PTYs whose row has an agent and is running (plain shells, run
    /// commands and session terminals don't count); worktrees = the user's
    /// tasks whose worktree exists on this machine.
    pub async fn system_counts(
        &self,
        user_id: Option<&str>,
        running_ptys: &HashSet<String>,
    ) -> Result<(usize, usize), StoreError> {
        let mut agents = 0;
        for id in running_ptys {
            let row = match user_id {
                Some(user_id) => self.inner.workspaces.get_for_user(id, user_id).await,
                None => self.inner.workspaces.get(id).await,
            };
            if row.is_ok_and(|w| w.agent.is_some() && w.status == WorkspaceStatus::Running) {
                agents += 1;
            }
        }
        let tasks = match user_id {
            Some(user_id) => self.inner.workspaces.list_tasks_for_user(user_id, None).await?,
            None => self.inner.workspaces.list_tasks(None).await?,
        };
        let worktrees = tasks
            .iter()
            .filter_map(|t| t.worktree_path.as_deref())
            .filter(|p| std::path::Path::new(p).exists())
            .count();
        Ok((agents, worktrees))
    }

    // ── change notifications ────────────────────────────────────────────

    /// A card in `repository_id` may have changed. Coalesced.
    pub fn notify_changed(&self, repository_id: &str) {
        let first = self.inner.pending.lock().insert(repository_id.to_string());
        if first {
            self.inner.flush.notify_one();
        }
    }

    /// The task's files changed (fs watcher, a finished tool call): drop
    /// its cached diff and announce its card.
    pub fn invalidate_diff(&self, task_id: &str) {
        self.inner.diffs.invalidate(task_id);
        let repository_id = self.inner.task_repos.lock().get(task_id).cloned();
        if let Some(repository_id) = repository_id {
            self.notify_changed(&repository_id);
        }
    }

    fn on_status(&self, event: &TaskStatusEvent) {
        self.inner
            .task_repos
            .lock()
            .insert(event.task_id.clone(), event.repository_id.clone());
        // Stopping/finishing is exactly when the diff decides the lane.
        self.inner.diffs.invalidate(&event.task_id);
        self.notify_changed(&event.repository_id);
    }

    fn on_agent_signal(&self, event: &AgentSignalEvent) {
        match event {
            AgentSignalEvent::State(state) => {
                let key = (state.state, state.attention.as_ref().map(|a| a.id.clone()));
                let changed = self
                    .inner
                    .last_agent
                    .lock()
                    .insert(state.task_id.clone(), key.clone())
                    .is_none_or(|prev| prev != key);
                self.inner
                    .task_repos
                    .lock()
                    .insert(state.task_id.clone(), state.repository_id.clone());
                if changed {
                    // A turn ending is when "idle with changes" appears.
                    if state.state == AgentStateKind::Idle {
                        self.inner.diffs.invalidate(&state.task_id);
                    }
                    self.notify_changed(&state.repository_id);
                }
            }
            AgentSignalEvent::ToolFinished { task_id, repository_id } => {
                self.inner.diffs.invalidate(task_id);
                self.notify_changed(repository_id);
            }
            AgentSignalEvent::Usage { .. } | AgentSignalEvent::TurnEnded => {}
        }
    }

    /// Follow status + agent events and flush coalesced notifications.
    /// Call once, inside a Tokio runtime.
    pub fn start(
        &self,
        status: broadcast::Receiver<TaskStatusEvent>,
        signals: Option<broadcast::Receiver<AgentSignalEvent>>,
    ) {
        let board = self.clone();
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
                tokio::select! {
                    event = status.recv() => match event {
                        Ok(event) => board.on_status(&event),
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    event = signal => match event {
                        Ok(event) => board.on_agent_signal(&event),
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => signals = None,
                    },
                }
            }
        });
        let board = self.clone();
        tokio::spawn(async move {
            loop {
                board.inner.flush.notified().await;
                tokio::time::sleep(CHANGE_COALESCE).await;
                let pending: Vec<String> = board.inner.pending.lock().drain().collect();
                for repository_id in pending {
                    let _ = board
                        .inner
                        .events
                        .send(BoardEvent::CardsChanged { repository_id });
                }
            }
        });
    }
}

/// When a finished card stopped working. Outcome first (merged/closed),
/// then the row's own finish, then the agent's last turn end (a running
/// agent idle at its prompt "finished" its work then), then archiving.
fn finished_at(task: &Workspace, lane: Lane, state: Option<&TaskAgentState>) -> Option<DateTime<Utc>> {
    if !matches!(lane, Lane::NeedsReview | Lane::Done | Lane::Failed | Lane::Archived) {
        return None;
    }
    let row_finished = (task.status != WorkspaceStatus::Running)
        .then_some(task.finished_at)
        .flatten();
    task.outcome_at
        .or(row_finished)
        .or_else(|| state.and_then(|s| s.last_turn_ended_at))
        .or(task.last_turn_ended_at)
        .or(task.archived_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, TaskOutcome};
    use crate::store::init_pool;
    use std::path::Path;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    struct Fixture {
        board: TaskBoard,
        workspaces: WorkspaceRepo,
        repo: Repository,
        dir: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repositories = RepositoryRepo::new(pool.clone());
        let mut repo = Repository::new("r".into(), None, None);
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = TaskBoard::new(
            workspaces.clone(),
            repositories,
            TaskUsageRepo::new(pool),
            None,
        );
        Fixture {
            board,
            workspaces,
            repo,
            dir,
        }
    }

    /// A worktree-ish git checkout on branch `task` forked from `main`,
    /// with `changes` files added on top.
    fn checkout(dir: &Path, name: &str, changes: usize) -> PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(&p).unwrap();
        git(&p, &["init", "-q", "-b", "main"]);
        git(&p, &["config", "user.email", "t@example.com"]);
        git(&p, &["config", "user.name", "t"]);
        std::fs::write(p.join("README.md"), "hi\n").unwrap();
        git(&p, &["add", "-A"]);
        git(&p, &["commit", "-qm", "init"]);
        git(&p, &["checkout", "-qb", "task"]);
        for i in 0..changes {
            std::fs::write(p.join(format!("f{i}.txt")), "a\nb\n").unwrap();
        }
        p
    }

    async fn task(f: &Fixture, name: &str, status: WorkspaceStatus, worktree: Option<&Path>) -> Workspace {
        let mut w = Workspace::new(f.repo.id.clone(), name.into(), "claude".into());
        w.agent = Some(crate::domain::Agent::Claude);
        w.status = status;
        if let Some(path) = worktree {
            w.branch = Some(format!("phasr/{name}"));
            w.worktree_path = Some(path.to_string_lossy().into_owned());
        }
        f.workspaces.insert(&w).await.unwrap();
        w
    }

    #[tokio::test]
    async fn cards_carry_lanes_diffs_and_dependency_names() {
        let f = fixture().await;
        let changed = checkout(f.dir.path(), "changed", 2);
        let clean = checkout(f.dir.path(), "clean", 0);
        let review = task(&f, "review me", WorkspaceStatus::Stopped, Some(&changed)).await;
        task(&f, "nothing", WorkspaceStatus::Completed, Some(&clean)).await;
        let mut merged = task(&f, "merged", WorkspaceStatus::Stopped, Some(&changed)).await;
        merged = f
            .workspaces
            .set_outcome(&merged.id, Some(TaskOutcome::Merged), Some("main"))
            .await
            .unwrap();
        let mut queued = Workspace::new(f.repo.id.clone(), "after review".into(), "claude".into());
        queued.queued_at = Some(Utc::now());
        queued.depends_on_workspace_id = Some(review.id.clone());
        f.workspaces.insert(&queued).await.unwrap();
        let draft = Workspace::new(f.repo.id.clone(), "someday".into(), "claude".into());
        f.workspaces.insert(&draft).await.unwrap();
        let mut local = Workspace::new(f.repo.id.clone(), "local".into(), String::new());
        local.workspace_kind = crate::domain::WorkspaceKind::Local;
        f.workspaces.insert(&local).await.unwrap();

        let cards = f.board.cards(None, Some(&f.repo.id)).await.unwrap();
        let by_name = |n: &str| cards.iter().find(|c| c.workspace.name == n).unwrap();
        assert_eq!(cards.len(), 5, "local workspaces are not cards");
        let r = by_name("review me");
        assert_eq!(r.lane, Lane::NeedsReview);
        assert_eq!(r.diff, Some(DiffStats { adds: 4, removes: 0, files: 2 }));
        assert_eq!(by_name("nothing").lane, Lane::Done);
        assert_eq!(by_name("nothing").diff, Some(DiffStats::default()));
        let m = by_name("merged");
        assert_eq!(m.lane, Lane::Done);
        assert_eq!(m.finished_at, merged.outcome_at);
        let q = by_name("after review");
        assert_eq!(q.lane, Lane::Queued);
        assert_eq!(q.depends_on_name.as_deref(), Some("review me"));
        assert_eq!(q.diff, None);
        assert_eq!(by_name("someday").lane, Lane::Draft);
        assert_eq!(f.board.lane_of(&review).await, Some(Lane::NeedsReview));

        // Wire shape the frontend reads.
        let json = serde_json::to_value(r).unwrap();
        for key in ["workspace", "lane", "diff", "agentState", "usage", "finishedAt", "dependsOnName"] {
            assert!(json.get(key).is_some(), "{key} missing: {json}");
        }
        assert_eq!(json["lane"], "needs-review");
    }

    #[tokio::test]
    async fn invalidation_refreshes_a_cached_diff_and_announces_the_card() {
        let f = fixture().await;
        let path = checkout(f.dir.path(), "wt", 1);
        let t = task(&f, "t", WorkspaceStatus::Stopped, Some(&path)).await;
        let mut rx = f.board.subscribe();
        f.board.start(broadcast::channel(1).1, None);
        assert_eq!(f.board.cards(None, None).await.unwrap()[0].diff.unwrap().files, 1);

        std::fs::write(path.join("more.txt"), "x\n").unwrap();
        // Cached (same HEAD, inside the TTL)…
        assert_eq!(f.board.cards(None, None).await.unwrap()[0].diff.unwrap().files, 1);
        // …until the file signal lands.
        f.board.invalidate_diff(&t.id);
        assert_eq!(f.board.cards(None, None).await.unwrap()[0].diff.unwrap().files, 2);
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        let BoardEvent::CardsChanged { repository_id } = event;
        assert_eq!(repository_id, f.repo.id);
    }

    #[tokio::test]
    async fn agent_events_announce_only_lane_relevant_changes() {
        let f = fixture().await;
        let mut rx = f.board.subscribe();
        f.board.start(broadcast::channel(1).1, None);
        let state = |kind: AgentStateKind, activity: &str| TaskAgentState {
            task_id: "t".into(),
            repository_id: f.repo.id.clone(),
            state: kind,
            attention: None,
            last_activity: Some(activity.into()),
            last_turn_ended_at: None,
        };
        f.board.on_agent_signal(&AgentSignalEvent::State(state(AgentStateKind::Working, "Reading a")));
        assert!(tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.is_ok());
        // Same state, new activity line: no card can move.
        f.board.on_agent_signal(&AgentSignalEvent::State(state(AgentStateKind::Working, "Reading b")));
        assert!(tokio::time::timeout(Duration::from_millis(700), rx.recv()).await.is_err());
        f.board.on_agent_signal(&AgentSignalEvent::State(state(AgentStateKind::Idle, "")));
        assert!(tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.is_ok());
    }
}
