//! The Board: every task as a card in its derived lane, with its diff vs
//! base, live agent state and usage — plus a cheap "cards changed" signal
//! so the UI refetches instead of polling.
//!
//! Tauri-agnostic like the rest of the orchestrator: changes go out on a
//! `tokio::broadcast` and `commands::events` re-emits them as
//! `phasr://task-cards-changed`.
//!
//! A refetch follows every agent tool call, so `cards` must be cheap when
//! nothing moved: settled tasks (merged, closed, archived) do no git work,
//! a task whose HEAD and index are unchanged is served from the diff cache
//! without spawning git (`git::DiffStatCache`), and usage is one query.

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

/// How long a running task's cached diff is trusted without an
/// invalidating signal: an agent without tool hooks edits files with
/// nothing telling the board, and neither HEAD nor the index moves.
const LIVE_DIFF_TTL: Duration = Duration::from_secs(15);
/// The same for a task nothing is running in. Its files change only by
/// hand (the fs watcher sees that while it's open), so this only bounds
/// edits made with the task closed.
const SETTLED_DIFF_TTL: Duration = Duration::from_secs(5 * 60);
/// Diffs computed at once on a cold cache (each is a few git processes).
const DIFF_CONCURRENCY: usize = 4;
/// Change notifications are coalesced per repository over this window, so
/// a burst of agent events costs the UI one refetch.
const CHANGE_COALESCE: Duration = Duration::from_millis(300);
const EVENT_CAPACITY: usize = 256;
/// Finished tasks (merged, closed, archived) on the board: those finished
/// within this many days, plus the `FINISHED_RECENT` latest. The board
/// shows finished cards from today (or its last few); the rest only cost
/// every refetch. `cards(.., all_finished: true)` returns all of them.
const FINISHED_DAYS: i64 = 7;
const FINISHED_RECENT: i64 = 50;

/// One task on the Board. `list_task_cards` returns these.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCard {
    pub workspace: Workspace,
    pub lane: Lane,
    /// Changes vs the task's base; `None` before launch, when archived,
    /// when the worktree isn't on this machine, or for a merged/closed
    /// task whose diff wasn't computed since startup.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoardEvent {
    /// Cards in this repository may have moved lanes or changed.
    /// `task_ids`: exactly which ones, when every coalesced cause named
    /// its task; `None` = any card in the repository.
    CardsChanged {
        repository_id: String,
        task_ids: Option<Vec<String>>,
    },
}

struct Inner {
    workspaces: WorkspaceRepo,
    repositories: RepositoryRepo,
    usage: TaskUsageRepo,
    signals: Option<AgentSignals>,
    diffs: DiffStatCache,
    events: broadcast::Sender<BoardEvent>,
    /// Repositories with a change not yet announced, with the tasks that
    /// changed (`None` once anything repository-wide joins the batch).
    pending: Mutex<HashMap<String, Option<HashSet<String>>>>,
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
                diffs: DiffStatCache::new(),
                events,
                pending: Mutex::new(HashMap::new()),
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
    /// None` = every owner (the sessionless test path). Finished tasks are
    /// limited to the recent ones (`FINISHED_DAYS` / `FINISHED_RECENT`)
    /// unless `all_finished`.
    pub async fn cards(
        &self,
        user_id: Option<&str>,
        repository_id: Option<&str>,
        all_finished: bool,
    ) -> Result<Vec<TaskCard>, StoreError> {
        let workspaces = &self.inner.workspaces;
        let tasks = match (all_finished, user_id) {
            (true, Some(user_id)) => workspaces.list_tasks_for_user(user_id, repository_id).await?,
            (true, None) => workspaces.list_tasks(repository_id).await?,
            (false, user_id) => {
                let since = Utc::now() - chrono::Duration::days(FINISHED_DAYS);
                workspaces
                    .list_board_tasks(user_id, repository_id, since, FINISHED_RECENT)
                    .await?
            }
        };
        {
            let mut repos = self.inner.task_repos.lock();
            for task in &tasks {
                repos.insert(task.id.clone(), task.repository_id.clone());
            }
        }
        if repository_id.is_none() {
            // Everything this user can see: drop cached diffs of deleted
            // (or no longer listed) tasks.
            let listed: HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
            self.inner.diffs.retain(&listed);
        }
        let states: HashMap<String, TaskAgentState> = self
            .inner
            .signals
            .as_ref()
            .map(|s| s.states().into_iter().map(|st| (st.task_id.clone(), st)).collect())
            .unwrap_or_default();
        let diffs = self.diffs_for(&tasks).await;
        let names: HashMap<&str, &str> = tasks.iter().map(|t| (t.id.as_str(), t.name.as_str())).collect();
        let usage_ids: Vec<&str> = tasks
            .iter()
            .filter(|t| t.agent.is_some_and(|a| a.usage_supported()) && t.branch.is_some())
            .map(|t| t.id.as_str())
            .collect();
        // One query for the whole board; a failed read just hides usage.
        let mut usage = self.inner.usage.get_many(&usage_ids).await.unwrap_or_default();

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
                    // Filtered to another repository, finished long ago, or gone.
                    None => self.inner.workspaces.get(id).await.ok().map(|w| w.name),
                },
            };
            cards.push(TaskCard {
                finished_at: finished_at(task, lane, state.as_ref()),
                workspace: task.clone(),
                lane,
                diff,
                agent_state: state,
                usage: usage.remove(&task.id),
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

    /// Diff stats for the tasks that have a worktree here, served from the
    /// cache or computed a few at a time off the async runtime.
    async fn diffs_for(&self, tasks: &[Workspace]) -> HashMap<String, DiffStats> {
        let mut out = HashMap::new();
        let mut bases: HashMap<String, String> = HashMap::new();
        let mut jobs: Vec<(String, PathBuf, String, Duration)> = Vec::new();
        for task in tasks {
            if task.status == WorkspaceStatus::Archived || task.branch.is_none() {
                continue;
            }
            if task.outcome.is_some() {
                // Merged or closed: the lane is Done whatever the diff, so
                // no git at all. Its last diff (often the one it was merged
                // with) still shows if this run computed one.
                if let Some(stats) = self.inner.diffs.peek(&task.id) {
                    out.insert(task.id.clone(), stats);
                }
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
            let max_age = match task.status {
                WorkspaceStatus::Running | WorkspaceStatus::Pending => LIVE_DIFF_TTL,
                _ => SETTLED_DIFF_TTL,
            };
            jobs.push((task.id.clone(), path, base, max_age));
        }

        let limit = Arc::new(Semaphore::new(DIFF_CONCURRENCY));
        let mut set = tokio::task::JoinSet::new();
        for (task_id, path, base, max_age) in jobs {
            let board = self.clone();
            let limit = limit.clone();
            set.spawn(async move {
                let _permit = limit.acquire_owned().await.ok()?;
                tokio::task::spawn_blocking(move || {
                    if !path.exists() {
                        return None;
                    }
                    let stats = board.inner.diffs.get_or_compute(&task_id, &path, max_age, || {
                        // A base that only exists on the remote (never
                        // checked out locally) still has a merge-base there.
                        crate::git::diff_stats_vs_base(&path, &base)
                            .or_else(|_| crate::git::diff_stats_vs_base(&path, &format!("origin/{base}")))
                            .ok()
                    })?;
                    Some((task_id, stats))
                })
                .await
                .ok()
                .flatten()
            });
        }
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

    /// Some card in `repository_id` may have changed (the caller doesn't
    /// know which). Coalesced.
    pub fn notify_changed(&self, repository_id: &str) {
        self.queue_change(repository_id, None);
    }

    /// `task_id`'s card in `repository_id` may have changed. Coalesced with
    /// every other change to the repository in the same window.
    pub fn notify_task_changed(&self, repository_id: &str, task_id: &str) {
        self.queue_change(repository_id, Some(task_id));
    }

    fn queue_change(&self, repository_id: &str, task_id: Option<&str>) {
        let first = {
            let mut pending = self.inner.pending.lock();
            let first = !pending.contains_key(repository_id);
            let tasks = pending
                .entry(repository_id.to_string())
                .or_insert_with(|| Some(HashSet::new()));
            match (task_id, tasks.as_mut()) {
                (Some(id), Some(set)) => {
                    set.insert(id.to_string());
                }
                (None, _) => *tasks = None,
                (Some(_), None) => {}
            }
            first
        };
        if first {
            self.inner.flush.notify_one();
        }
    }

    /// Take everything queued: one event per repository.
    fn drain_changes(&self) -> Vec<BoardEvent> {
        let mut events: Vec<BoardEvent> = self
            .inner
            .pending
            .lock()
            .drain()
            .map(|(repository_id, tasks)| BoardEvent::CardsChanged {
                repository_id,
                task_ids: tasks.map(|set| {
                    let mut ids: Vec<String> = set.into_iter().collect();
                    ids.sort();
                    ids
                }),
            })
            .collect();
        events.sort_by(|a, b| {
            let (BoardEvent::CardsChanged { repository_id: a, .. }, BoardEvent::CardsChanged { repository_id: b, .. }) =
                (a, b);
            a.cmp(b)
        });
        events
    }

    /// The task's files changed (fs watcher, a finished tool call): mark
    /// its cached diff stale and announce its card.
    pub fn invalidate_diff(&self, task_id: &str) {
        self.inner.diffs.invalidate(task_id);
        let repository_id = self.inner.task_repos.lock().get(task_id).cloned();
        if let Some(repository_id) = repository_id {
            self.notify_task_changed(&repository_id, task_id);
        }
    }

    fn on_status(&self, event: &TaskStatusEvent) {
        self.inner
            .task_repos
            .lock()
            .insert(event.task_id.clone(), event.repository_id.clone());
        // Stopping/finishing is exactly when the diff decides the lane.
        self.inner.diffs.invalidate(&event.task_id);
        self.notify_task_changed(&event.repository_id, &event.task_id);
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
                    self.notify_task_changed(&state.repository_id, &state.task_id);
                }
            }
            AgentSignalEvent::ToolFinished { task_id, repository_id } => {
                self.inner.diffs.invalidate(task_id);
                self.notify_task_changed(repository_id, task_id);
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
                for event in board.drain_changes() {
                    let _ = board.inner.events.send(event);
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
        usage: TaskUsageRepo,
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
        let usage = TaskUsageRepo::new(pool);
        let board = TaskBoard::new(workspaces.clone(), repositories, usage.clone(), None);
        Fixture {
            board,
            workspaces,
            usage,
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

    async fn cards(f: &Fixture) -> Vec<TaskCard> {
        f.board.cards(None, None, false).await.unwrap()
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

        let cards = f.board.cards(None, Some(&f.repo.id), false).await.unwrap();
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
        // Merged: no git work, and nothing computed for it this run.
        assert_eq!(m.diff, None);
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
        assert_eq!(cards(&f).await[0].diff.unwrap().files, 1);

        std::fs::write(path.join("more.txt"), "x\n").unwrap();
        // Cached (same HEAD and index, inside the TTL)…
        assert_eq!(cards(&f).await[0].diff.unwrap().files, 1);
        // …until the file signal lands.
        f.board.invalidate_diff(&t.id);
        assert_eq!(cards(&f).await[0].diff.unwrap().files, 2);
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        assert_eq!(
            event,
            BoardEvent::CardsChanged {
                repository_id: f.repo.id.clone(),
                task_ids: Some(vec![t.id.clone()]),
            }
        );
    }

    /// A commit or `git add` is seen without any signal: HEAD and the
    /// index are part of the cache key.
    #[tokio::test]
    async fn a_commit_or_staging_refreshes_the_diff_without_a_signal() {
        let f = fixture().await;
        let path = checkout(f.dir.path(), "wt", 1);
        task(&f, "t", WorkspaceStatus::Stopped, Some(&path)).await;
        assert_eq!(cards(&f).await[0].diff.unwrap().files, 1);
        std::fs::write(path.join("staged.txt"), "x\n").unwrap();
        git(&path, &["add", "staged.txt"]);
        assert_eq!(cards(&f).await[0].diff.unwrap().files, 2);
        std::fs::write(path.join("committed.txt"), "x\n").unwrap();
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-qm", "c"]);
        assert_eq!(cards(&f).await[0].diff.unwrap().files, 3);
    }

    /// Settled tasks never touch git: a merged task's worktree can vanish
    /// (or be anything) and its card still serves the last known diff.
    #[tokio::test]
    async fn merged_tasks_serve_their_last_diff_without_git() {
        let f = fixture().await;
        let path = checkout(f.dir.path(), "wt", 2);
        let t = task(&f, "t", WorkspaceStatus::Stopped, Some(&path)).await;
        let before = cards(&f).await[0].diff;
        assert_eq!(before.unwrap().files, 2);
        f.workspaces
            .set_outcome(&t.id, Some(TaskOutcome::Merged), Some("main"))
            .await
            .unwrap();
        f.board.invalidate_diff(&t.id);
        std::fs::remove_dir_all(&path).unwrap();
        let card = &cards(&f).await[0];
        assert_eq!(card.lane, Lane::Done);
        assert_eq!(card.diff, before);
    }

    /// Concurrent refetches share one computation per task.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_refetches_compute_each_diff_once() {
        let f = fixture().await;
        let path = checkout(f.dir.path(), "wt", 3);
        let t = task(&f, "t", WorkspaceStatus::Stopped, Some(&path)).await;
        let calls: Vec<_> = (0..8)
            .map(|_| {
                let board = f.board.clone();
                tokio::spawn(async move { board.cards(None, None, false).await.unwrap() })
            })
            .collect();
        for call in calls {
            assert_eq!(call.await.unwrap()[0].diff.unwrap().files, 3);
        }
        // Single-flight + cache: the eight callers left one entry, and it
        // is fresh (no invalidation, same key), so a peek equals a hit.
        assert_eq!(f.board.inner.diffs.peek(&t.id).unwrap().files, 3);
    }

    #[tokio::test]
    async fn usage_comes_from_one_batched_read() {
        let f = fixture().await;
        let a = task(&f, "a", WorkspaceStatus::Stopped, Some(Path::new("/nowhere/a"))).await;
        let b = task(&f, "b", WorkspaceStatus::Stopped, Some(Path::new("/nowhere/b"))).await;
        // A draft (no branch) never shows usage, even with a stray row.
        let draft = task(&f, "draft", WorkspaceStatus::Pending, None).await;
        let usage = |n: i64| TaskUsage {
            source: crate::domain::usage::UsageSource::Claude,
            model: None,
            input_tokens: n,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd_micros: None,
            cost_partial: false,
            updated_at: Utc::now(),
            transcript_path: None,
        };
        f.usage.upsert(&a.id, &usage(7)).await.unwrap();
        f.usage.upsert(&draft.id, &usage(9)).await.unwrap();
        let cards = cards(&f).await;
        let by_id = |id: &str| cards.iter().find(|c| c.workspace.id == id).unwrap();
        assert_eq!(by_id(&a.id).usage.as_ref().unwrap().input_tokens, 7);
        assert!(by_id(&b.id).usage.is_none());
        assert!(by_id(&draft.id).usage.is_none());
    }

    /// Finished tasks are limited to the recent ones unless asked; open
    /// work always shows.
    #[tokio::test]
    async fn old_finished_tasks_are_left_out_unless_asked_for() {
        let f = fixture().await;
        let old = |days: i64| Some(Utc::now() - chrono::Duration::days(days));
        // Recent finished tasks: kept by the time window.
        for i in 0..3 {
            let mut w = Workspace::new(f.repo.id.clone(), format!("recent{i}"), "claude".into());
            w.status = WorkspaceStatus::Archived;
            w.archived_at = old(1);
            f.workspaces.insert(&w).await.unwrap();
        }
        // Old finished tasks: only the FINISHED_RECENT newest are kept.
        let extra = FINISHED_RECENT as usize - 3 + 5;
        for i in 0..extra {
            let mut w = Workspace::new(f.repo.id.clone(), format!("old{i}"), "claude".into());
            w.status = WorkspaceStatus::Archived;
            w.archived_at = old(30 + i as i64);
            f.workspaces.insert(&w).await.unwrap();
        }
        // An old stopped task without an outcome: still open work.
        let mut stale = Workspace::new(f.repo.id.clone(), "stale".into(), "claude".into());
        stale.status = WorkspaceStatus::Stopped;
        stale.branch = Some("phasr/stale".into());
        stale.finished_at = old(400);
        f.workspaces.insert(&stale).await.unwrap();

        let shown = cards(&f).await;
        let names: HashSet<String> = shown.iter().map(|c| c.workspace.name.clone()).collect();
        assert_eq!(shown.len(), FINISHED_RECENT as usize + 1, "{names:?}");
        assert!(names.contains("stale") && names.contains("recent0"));
        // The newest old ones made the cut, the oldest didn't.
        assert!(names.contains("old0"));
        assert!(!names.contains(&format!("old{}", extra - 1)));

        let all = f.board.cards(None, None, true).await.unwrap();
        assert_eq!(all.len(), 3 + extra + 1);
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

    /// A burst of causes is one event per repository, naming its tasks; a
    /// repository-wide cause in the burst widens it to "any card".
    #[tokio::test]
    async fn changes_coalesce_per_repository_with_task_ids() {
        let f = fixture().await;
        f.board.notify_task_changed("r1", "b");
        f.board.notify_task_changed("r1", "a");
        f.board.notify_task_changed("r1", "a");
        f.board.notify_task_changed("r2", "c");
        f.board.notify_changed("r2");
        f.board.notify_task_changed("r2", "d");
        assert_eq!(
            f.board.drain_changes(),
            vec![
                BoardEvent::CardsChanged {
                    repository_id: "r1".into(),
                    task_ids: Some(vec!["a".into(), "b".into()]),
                },
                BoardEvent::CardsChanged {
                    repository_id: "r2".into(),
                    task_ids: None,
                },
            ]
        );
        assert!(f.board.drain_changes().is_empty());

        // A status change and the agent's matching state change (a task
        // stopping fires both) are one event, not two.
        let mut rx = f.board.subscribe();
        f.board.start(broadcast::channel(1).1, None);
        f.board.on_status(&TaskStatusEvent {
            task_id: "t".into(),
            repository_id: "r1".into(),
            status: WorkspaceStatus::Stopped,
            exit_code: None,
        });
        f.board.on_agent_signal(&AgentSignalEvent::ToolFinished {
            task_id: "t".into(),
            repository_id: "r1".into(),
        });
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        assert_eq!(
            event,
            BoardEvent::CardsChanged {
                repository_id: "r1".into(),
                task_ids: Some(vec!["t".into()]),
            }
        );
        assert!(tokio::time::timeout(Duration::from_millis(700), rx.recv()).await.is_err());
    }
}
