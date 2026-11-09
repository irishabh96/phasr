//! Running run commands: one PTY per `(run command, task)` — in the task's
//! worktree, so two tasks' dev servers run side by side — with real exit
//! codes (`LaunchMode::Exec`), dev-server port detection, and headless
//! auto-start of `task_start` commands.
//!
//! Tauri-agnostic: state changes go out on a `tokio::broadcast`;
//! `commands::events` re-emits them as `phasr://run-command-state`.

pub mod ports;
pub mod scripts;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::agent_signals::heuristics::AnsiStripper;
use crate::domain::{RunCommand, RunWhen, WorkspaceStatus};
use crate::orchestrator::TaskStatusEvent;
use crate::pty::handle::{PtyError, PtyHandle};
use crate::pty::{LaunchMode, PtyEvent, SpawnSpec, TaskRuntime};
use crate::store::{AppMetaRepo, RunCommandRepo, WorkspaceRepo};

use ports::PortScanner;

/// Every run-command PTY id starts with this, so it can never collide with
/// a workspace UUID (or a `session:` terminal) in the `TaskRuntime` map.
const RUN_PTY_PREFIX: &str = "run:";
/// The key's scope for a command run in the repository's own checkout.
const REPO_SCOPE: &str = "repo";
const EVENT_CAPACITY: usize = 256;
/// Per step of the SIGHUP → SIGTERM → SIGKILL escalation on stop.
const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// `run:<run command id>@<workspace id | "repo">`. Scoped by task so the
/// same command (say `pnpm dev`) runs once PER TASK, each in its own
/// worktree, instead of all tasks sharing one process.
pub fn pty_key(run_command_id: &str, workspace_id: Option<&str>) -> String {
    format!(
        "{RUN_PTY_PREFIX}{run_command_id}@{}",
        workspace_id.unwrap_or(REPO_SCOPE)
    )
}

/// `list_running_commands` / `phasr://run-command-state`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningCommand {
    pub run_command_id: String,
    /// `None` = running in the repository's own checkout.
    pub workspace_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub running: bool,
    /// Set once it exited; `None` while running or when killed by a signal.
    pub exit_code: Option<i64>,
    /// A dev-server port seen in its output that accepts connections.
    pub port: Option<u16>,
}

/// What the runtime announces. `state` is the wire payload; the rest is
/// for in-process listeners (notifications).
#[derive(Debug, Clone)]
pub struct RunCommandEvent {
    pub state: RunningCommand,
    pub user_id: String,
    pub repository_id: String,
    pub name: String,
    /// It exited because the user stopped it (not a failure to report).
    pub stopped_by_user: bool,
}

struct Entry {
    state: RunningCommand,
    user_id: String,
    repository_id: String,
    name: String,
    stopped_by_user: bool,
    /// Identity of the PTY this entry describes (a restart replaces it).
    handle: Weak<PtyHandle>,
}

impl Entry {
    fn event(&self) -> RunCommandEvent {
        RunCommandEvent {
            state: self.state.clone(),
            user_id: self.user_id.clone(),
            repository_id: self.repository_id.clone(),
            name: self.name.clone(),
            stopped_by_user: self.stopped_by_user,
        }
    }
}

struct Inner {
    runtime: Arc<TaskRuntime>,
    /// By PTY key. Exited entries stay (running = false, exit code) until
    /// the command is started again or deleted, so the run pane can show
    /// "exited 1".
    entries: Mutex<HashMap<String, Entry>>,
    events: broadcast::Sender<RunCommandEvent>,
}

#[derive(Clone)]
pub struct RunCommandRuntime {
    inner: Arc<Inner>,
}

/// Where to run and for whom.
pub struct RunTarget {
    pub workspace_id: Option<String>,
    pub cwd: PathBuf,
    pub user_id: String,
    pub rows: u16,
    pub cols: u16,
}

impl RunCommandRuntime {
    pub fn new(runtime: Arc<TaskRuntime>) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                runtime,
                entries: Mutex::new(HashMap::new()),
                events,
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RunCommandEvent> {
        self.inner.events.subscribe()
    }

    /// The live PTY under `key`, if any.
    pub fn handle(&self, key: &str) -> Option<Arc<PtyHandle>> {
        self.inner.runtime.get(key)
    }

    /// The PTY under `key` to attach a viewer to — ONLY if its process is
    /// still running. Never spawns: opening a run tab in another task (or
    /// coming back after an exec-mode command exited) must not start the
    /// command; only an explicit Run does (`start`). An exited PTY can
    /// linger in the runtime map for a moment before its monitor
    /// unregisters it, hence the exit-code check.
    pub fn attachable(&self, key: &str) -> Option<Arc<PtyHandle>> {
        self.inner
            .runtime
            .get(key)
            .filter(|handle| handle.exit_code().is_none())
    }

    /// Start `rc` for `target` in exec mode. Errors with `AlreadyRunning`
    /// if that key has a live PTY — callers re-attach instead.
    pub fn start(&self, rc: &RunCommand, target: RunTarget) -> Result<Arc<PtyHandle>, PtyError> {
        let key = pty_key(&rc.id, target.workspace_id.as_deref());
        // An exited PTY its monitor hasn't unregistered yet must not block
        // an explicit re-run with "already running".
        if self.inner.runtime.get(&key).is_some_and(|h| h.exit_code().is_some()) {
            self.inner.runtime.drop_task(&key);
        }
        let handle = self.inner.runtime.spawn(
            SpawnSpec::new(key.clone(), target.cwd)
                .with_launch(LaunchMode::Exec(rc.command.clone()))
                .with_size(target.rows, target.cols),
        )?;
        let entry = Entry {
            state: RunningCommand {
                run_command_id: rc.id.clone(),
                workspace_id: target.workspace_id,
                started_at: Utc::now(),
                running: true,
                exit_code: None,
                port: None,
            },
            user_id: target.user_id,
            repository_id: rc.repository_id.clone(),
            name: rc.name.clone(),
            stopped_by_user: false,
            handle: Arc::downgrade(&handle),
        };
        let event = entry.event();
        self.inner.entries.lock().insert(key.clone(), entry);
        let _ = self.inner.events.send(event);
        self.monitor(key, handle.clone(), rc.detect_port);
        Ok(handle)
    }

    /// Kill the PTY under `key` as the user's own stop (no failure
    /// notification). `false` if nothing is running there.
    pub fn stop(&self, key: &str) -> Result<bool, PtyError> {
        let Some(handle) = self.inner.runtime.get(key) else {
            return Ok(false);
        };
        if let Some(entry) = self.inner.entries.lock().get_mut(key) {
            entry.stopped_by_user = true;
        }
        // The command's whole session: `pnpm dev` → node → esbuild etc.
        // A SIGHUP to the shell alone left the server holding its port.
        handle.terminate(STOP_GRACE);
        Ok(true)
    }

    /// Stop every run command running for a task (discard / delete).
    pub fn stop_for_workspace(&self, workspace_id: &str) {
        let keys: Vec<String> = self
            .inner
            .entries
            .lock()
            .iter()
            .filter(|(_, e)| e.state.workspace_id.as_deref() == Some(workspace_id))
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let _ = self.stop(&key);
        }
    }

    /// A deleted run command: stop all its PTYs (every task) and forget them.
    pub fn forget_command(&self, run_command_id: &str) {
        let keys: Vec<String> = self
            .inner
            .entries
            .lock()
            .iter()
            .filter(|(_, e)| e.state.run_command_id == run_command_id)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let _ = self.stop(&key);
            self.inner.entries.lock().remove(&key);
        }
    }

    /// The user's run commands (running or exited this session), one task
    /// (`Some`) or all.
    pub fn list(&self, user_id: &str, workspace_id: Option<&str>) -> Vec<RunningCommand> {
        let mut out: Vec<RunningCommand> = self
            .inner
            .entries
            .lock()
            .values()
            .filter(|e| e.user_id == user_id)
            .filter(|e| workspace_id.is_none() || e.state.workspace_id.as_deref() == workspace_id)
            .map(|e| e.state.clone())
            .collect();
        out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        out
    }

    /// Whether `port`'s listener runs in this command's terminal (not
    /// another task's dev server, not a database it connects to).
    async fn owns_port(&self, handle: &Weak<PtyHandle>, port: u16) -> bool {
        let Some(handle) = handle.upgrade() else {
            return false;
        };
        let listeners = ports::listener_pids(port).await;
        let members = tokio::task::spawn_blocking(move || handle.process_ids())
            .await
            .unwrap_or_default();
        ports::owned_by(listeners.as_deref(), &members)
    }

    fn has_port(&self, key: &str) -> bool {
        self.inner.entries.lock().get(key).is_some_and(|e| e.state.port.is_some())
    }

    #[cfg(test)]
    pub fn is_running(&self, key: &str) -> bool {
        self.inner.entries.lock().get(key).is_some_and(|e| e.state.running)
    }

    fn update(&self, key: &str, handle: &Weak<PtyHandle>, f: impl FnOnce(&mut Entry)) {
        let event = {
            let mut entries = self.inner.entries.lock();
            let Some(entry) = entries.get_mut(key) else {
                return;
            };
            // A restart replaced the entry: this monitor's news is stale.
            if !Weak::ptr_eq(&entry.handle, handle) {
                return;
            }
            f(entry);
            entry.event()
        };
        let _ = self.inner.events.send(event);
    }

    /// Watch one PTY: ports in its output, then its exit (which also
    /// unregisters it from the runtime — no caller may be attached).
    fn monitor(&self, key: String, handle: Arc<PtyHandle>, detect_port: bool) {
        let mut rx = handle.subscribe();
        let weak = Arc::downgrade(&handle);
        // A fast command may have exited before the subscription existed.
        let already = handle.exit_code();
        drop(handle);
        let this = self.clone();
        tokio::spawn(async move {
            let mut stripper = AnsiStripper::default();
            let mut scanner = PortScanner::default();
            let exit_code = match already {
                Some(code) => code,
                None => loop {
                    match rx.recv().await {
                        Ok(PtyEvent::Output { chunk, .. }) => {
                            // Keep scanning until a candidate is confirmed:
                            // the first URL printed isn't always the server
                            // (an HMR socket, a proxy target).
                            if !detect_port || this.has_port(&key) {
                                continue;
                            }
                            for port in scanner.feed(&stripper.feed_text(&chunk)) {
                                let this = this.clone();
                                let key = key.clone();
                                let weak = weak.clone();
                                tokio::spawn(async move {
                                    if ports::confirm(port).await && this.owns_port(&weak, port).await {
                                        this.update(&key, &weak, |e| {
                                            if e.state.running && e.state.port.is_none() {
                                                e.state.port = Some(port);
                                            }
                                        });
                                    }
                                });
                            }
                        }
                        Ok(PtyEvent::Exit { exit_code, .. }) => break exit_code,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break None,
                    }
                },
            };
            let still_ours = this
                .inner
                .runtime
                .get(&key)
                .is_some_and(|current| std::ptr::eq(Arc::as_ptr(&current), weak.as_ptr()));
            if still_ours {
                this.inner.runtime.drop_task(&key);
            }
            this.update(&key, &weak, |e| {
                e.state.running = false;
                e.state.exit_code = exit_code;
                e.state.port = None;
            });
        });
    }

    /// Start the task's `task_start` commands headless in its worktree,
    /// whenever its agent starts (a first launch or a resume) — skipping
    /// ones already running, and any whose command text isn't trusted on
    /// this machine (synced from elsewhere, never confirmed here).
    pub async fn auto_start_for_task(
        &self,
        task_id: &str,
        user_id: &str,
        workspaces: &WorkspaceRepo,
        run_commands: &RunCommandRepo,
        meta: &AppMetaRepo,
    ) -> Vec<String> {
        let Ok(workspace) = workspaces.get_for_user(task_id, user_id).await else {
            return Vec::new();
        };
        let Some(cwd) = workspace.worktree_path.as_deref().map(PathBuf::from).filter(|p| p.exists()) else {
            return Vec::new();
        };
        let Ok(commands) = run_commands
            .list_by_repository_for_user(&workspace.repository_id, user_id)
            .await
        else {
            return Vec::new();
        };
        let mut started = Vec::new();
        for rc in commands.into_iter().filter(|rc| rc.run_when == RunWhen::TaskStart) {
            if !meta.is_run_command_trusted(&rc).await.unwrap_or(false) {
                continue;
            }
            if self.handle(&pty_key(&rc.id, Some(task_id))).is_some() {
                continue;
            }
            let target = RunTarget {
                workspace_id: Some(task_id.to_string()),
                cwd: cwd.clone(),
                user_id: user_id.to_string(),
                rows: 24,
                cols: 80,
            };
            match self.start(&rc, target) {
                Ok(_) => started.push(rc.id),
                Err(err) => eprintln!("auto-start of run command {} failed: {err}", rc.id),
            }
        }
        started
    }

    /// Auto-start `task_start` commands whenever a task goes running.
    /// Call once, inside a Tokio runtime.
    pub fn start_task_hooks<F>(
        &self,
        status: broadcast::Receiver<TaskStatusEvent>,
        workspaces: WorkspaceRepo,
        run_commands: RunCommandRepo,
        meta: AppMetaRepo,
        current_user: F,
    ) where
        F: Fn() -> Option<String> + Send + Sync + 'static,
    {
        let this = self.clone();
        tokio::spawn(async move {
            let mut status = status;
            loop {
                match status.recv().await {
                    Ok(event) if event.status == WorkspaceStatus::Running => {
                        if let Some(user_id) = current_user() {
                            this.auto_start_for_task(&event.task_id, &user_id, &workspaces, &run_commands, &meta)
                                .await;
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace};
    use crate::store::{init_pool, RepositoryRepo};
    use std::time::Duration;

    /// Generous: these spawn real login shells (`-l -i`, the user's rc
    /// files), which under a fully parallel test run can take many seconds.
    async fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn rc(id: &str, command: &str) -> RunCommand {
        let mut rc = RunCommand::new("repo".into(), id.into(), command.into());
        rc.id = id.into();
        rc
    }

    fn target(ws: Option<&str>, cwd: &std::path::Path) -> RunTarget {
        RunTarget {
            workspace_id: ws.map(str::to_string),
            cwd: cwd.to_path_buf(),
            user_id: "u".into(),
            rows: 24,
            cols: 80,
        }
    }

    /// Attaching never spawns: nothing running → `None`, and an exec-mode
    /// command that already exited is not started again by an attach.
    #[tokio::test]
    async fn attach_never_starts_or_respawns_a_command() {
        let logs = tempfile::tempdir().unwrap();
        let rt = RunCommandRuntime::new(Arc::new(TaskRuntime::new(logs.path().to_path_buf())));
        let dir = tempfile::tempdir().unwrap();
        let key = pty_key("once", Some("ws"));
        assert!(rt.attachable(&key).is_none(), "nothing was ever started");
        assert!(rt.handle(&key).is_none(), "attach must not spawn");

        std::fs::write(dir.path().join("count"), "").unwrap();
        rt.start(&rc("once", "echo x >> count"), target(Some("ws"), dir.path())).unwrap();
        wait_for("exit", || !rt.is_running(&key)).await;
        assert!(rt.attachable(&key).is_none(), "an exited exec command is not attachable");
        assert!(rt.handle(&key).is_none(), "and attaching did not respawn it");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let runs = std::fs::read_to_string(dir.path().join("count")).unwrap();
        assert_eq!(runs.lines().count(), 1, "ran exactly once");

        rt.start(&rc("long", "sleep 30"), target(Some("ws"), dir.path())).unwrap();
        assert!(rt.attachable(&pty_key("long", Some("ws"))).is_some());
        rt.stop(&pty_key("long", Some("ws"))).unwrap();
    }

    #[test]
    fn keys_are_scoped_by_task() {
        assert_eq!(pty_key("rc1", Some("ws-a")), "run:rc1@ws-a");
        assert_eq!(pty_key("rc1", None), "run:rc1@repo");
        assert_ne!(pty_key("rc1", Some("ws-a")), pty_key("rc1", Some("ws-b")));
    }

    /// Two tasks run the same command side by side, each in its own cwd,
    /// each with its own real exit code.
    #[tokio::test]
    async fn the_same_command_runs_isolated_per_task_with_real_exit_codes() {
        let logs = tempfile::tempdir().unwrap();
        let rt = RunCommandRuntime::new(Arc::new(TaskRuntime::new(logs.path().to_path_buf())));
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("code"), "3").unwrap();
        std::fs::write(b.path().join("code"), "0").unwrap();
        let cmd = rc("rc1", "sleep 0.5; exit $(cat code)");
        let mut events = rt.subscribe();
        rt.start(&cmd, target(Some("ws-a"), a.path())).unwrap();
        rt.start(&cmd, target(Some("ws-b"), b.path())).unwrap();
        assert!(rt.handle("run:rc1@ws-a").is_some() && rt.handle("run:rc1@ws-b").is_some());
        assert_eq!(rt.list("u", Some("ws-a")).len(), 1);
        assert_eq!(rt.list("u", None).len(), 2);
        assert!(rt.list("someone-else", None).is_empty());

        wait_for("both exits", || rt.list("u", None).iter().all(|r| !r.running)).await;
        let a_state = &rt.list("u", Some("ws-a"))[0];
        let b_state = &rt.list("u", Some("ws-b"))[0];
        assert_eq!(a_state.exit_code, Some(3));
        assert_eq!(b_state.exit_code, Some(0));
        // Exited PTYs are unregistered, so a restart is a fresh spawn.
        assert!(rt.handle("run:rc1@ws-a").is_none());
        let mut saw_exit = false;
        while let Ok(e) = events.try_recv() {
            saw_exit |= !e.state.running && e.state.exit_code == Some(3) && !e.stopped_by_user;
        }
        assert!(saw_exit);
    }

    #[tokio::test]
    async fn stop_is_marked_as_the_users_own() {
        let logs = tempfile::tempdir().unwrap();
        let rt = RunCommandRuntime::new(Arc::new(TaskRuntime::new(logs.path().to_path_buf())));
        let dir = tempfile::tempdir().unwrap();
        let mut events = rt.subscribe();
        rt.start(&rc("rc2", "sleep 30"), target(Some("ws"), dir.path())).unwrap();
        assert!(rt.stop("run:rc2@ws").unwrap());
        wait_for("exit", || !rt.is_running("run:rc2@ws")).await;
        let mut last = None;
        while let Ok(e) = events.try_recv() {
            last = Some(e);
        }
        assert!(last.unwrap().stopped_by_user);
        assert!(!rt.stop("run:rc2@ws").unwrap(), "nothing left to stop");
    }

    /// A port the command prints and accepts connections on, but that
    /// some OTHER process listens on (here: the test itself — think
    /// another task's `:3000`), is not this command's server.
    #[tokio::test]
    async fn a_port_owned_by_another_process_is_not_detected() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        if ports::listener_pids(port).await.is_none() {
            return; // no lsof here: ownership can't be checked
        }
        let logs = tempfile::tempdir().unwrap();
        let rt = RunCommandRuntime::new(Arc::new(TaskRuntime::new(logs.path().to_path_buf())));
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = rc("other", &format!("printf 'http://localhost:{port}/\\n'; sleep 30"));
        cmd.detect_port = true;
        rt.start(&cmd, target(Some("ws"), dir.path())).unwrap();
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert_eq!(rt.list("u", Some("ws"))[0].port, None);
        rt.stop("run:other@ws").unwrap();
        drop(listener);
    }

    #[tokio::test]
    async fn detects_a_port_only_once_it_accepts_connections() {
        // The listener must be the command's own (see the test above), so
        // it is a child of the command; here a tiny `nc` server.
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };
        let logs = tempfile::tempdir().unwrap();
        let rt = RunCommandRuntime::new(Arc::new(TaskRuntime::new(logs.path().to_path_buf())));
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = rc(
            "dev",
            &format!("printf '\\033[32m  ➜  Local:   http://localhost:{port}/\\033[0m\\n'; exec nc -lk 127.0.0.1 {port} || exec nc -l {port}"),
        );
        cmd.detect_port = true;
        rt.start(&cmd, target(Some("ws"), dir.path())).unwrap();
        wait_for("port", || rt.list("u", Some("ws"))[0].port == Some(port)).await;
        rt.stop("run:dev@ws").unwrap();
        wait_for("exit", || !rt.is_running("run:dev@ws")).await;
        assert_eq!(rt.list("u", Some("ws"))[0].port, None, "a stopped server has no port");
    }

    /// `task_start` commands auto-start in the task's worktree only when
    /// trusted on this machine.
    #[tokio::test]
    async fn auto_start_needs_a_trusted_command() {
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
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        let mut ws = Workspace::new(repo.id.clone(), "t".into(), "c".into());
        ws.worktree_path = Some(wt.to_string_lossy().into_owned());
        workspaces.insert_for_user(&ws, "u").await.unwrap();
        let run_commands = RunCommandRepo::new(pool.clone());
        let meta = AppMetaRepo::new(pool.clone());
        let mut dev = RunCommand::new(repo.id.clone(), "dev".into(), "pwd > started; sleep 30".into());
        dev.run_when = RunWhen::TaskStart;
        run_commands.insert_for_user(&dev, "u").await.unwrap();
        let mut manual = RunCommand::new(repo.id.clone(), "test".into(), "true".into());
        manual.run_when = RunWhen::Manual;
        run_commands.insert_for_user(&manual, "u").await.unwrap();

        let rt = RunCommandRuntime::new(Arc::new(TaskRuntime::new(dir.path().join("logs"))));
        assert!(rt.auto_start_for_task(&ws.id, "u", &workspaces, &run_commands, &meta).await.is_empty());
        meta.trust_run_command(&dev).await.unwrap();
        assert_eq!(rt.auto_start_for_task(&ws.id, "u", &workspaces, &run_commands, &meta).await, vec![dev.id.clone()]);
        // Already running → not started twice.
        assert!(rt.auto_start_for_task(&ws.id, "u", &workspaces, &run_commands, &meta).await.is_empty());
        // Another user can't start it.
        assert!(rt.auto_start_for_task(&ws.id, "x", &workspaces, &run_commands, &meta).await.is_empty());
        wait_for("cwd marker", || wt.join("started").exists()).await;
        rt.stop_for_workspace(&ws.id);
        wait_for("stop", || !rt.is_running(&pty_key(&dev.id, Some(&ws.id)))).await;
    }
}
