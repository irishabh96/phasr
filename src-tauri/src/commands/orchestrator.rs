//! Tauri commands that drive the task orchestrator.
//!
//! Thin handlers: each one validates inputs and delegates to
//! `TaskOrchestrator`. Status events from the orchestrator's
//! broadcast channel are re-emitted onto Tauri's event bus by
//! `commands::events`.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::SessionState;
use crate::agent_stream::{Suggestion, TranscriptItem};
use crate::domain::{Agent, AgentView, PermissionMode, Workspace};
use crate::notifications::NotificationService;
use crate::orchestrator::{
    launch, OrchestratorError, RunIn, StartTaskRequest, StartedTask, TaskOrchestrator, TaskStart,
};
use crate::pty::PtyEvent;
use crate::run_commands::{RunCommandRuntime, TaskRunError};
use crate::store::{AppMetaRepo, RunCommandRepo, SettingsRepo, WorkspaceRepo};
use crate::sync::CloudSyncState;

use super::require_user;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskInput {
    pub repository_id: String,
    pub agent: Agent,
    pub name: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub cols: Option<u16>,
    /// `None` → the user's `defaultPermissionMode` (clamped to what the
    /// agent supports). An explicit mode the agent can't express is an
    /// error, never silently swapped.
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// `None` → true.
    #[serde(default)]
    pub notify_on_attention: Option<bool>,
    /// `None` → a new worktree.
    #[serde(default)]
    pub run_in: Option<RunIn>,
    /// New task's Run chip: a run command to start in the task's worktree
    /// once its agent is up (setup runs after this command returns).
    #[serde(default)]
    pub run_command_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTaskInfo {
    pub task_id: String,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub task_id: String,
    /// Wall-clock epoch ms of the task terminal's most recent output
    /// (spawn time until the first byte). Compared against `Date.now()`.
    pub last_output_at: i64,
}

/// Last-output timestamps for every task with a live PTY. A task missing
/// from the list has no running terminal process at all.
#[tauri::command]
pub async fn list_task_activity(
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TaskActivity>, OrchestratorError> {
    session.require()?;
    Ok(orchestrator
        .task_activity()
        .into_iter()
        .map(|(task_id, last_output_at)| TaskActivity {
            task_id,
            last_output_at,
        })
        .collect())
}

/// Returns as soon as the task row exists: its worktree setup and agent
/// spawn run in the background (`TaskOrchestrator::start_task`), so the
/// returned workspace is usually still `pending` — the board shows it as
/// setting up, and its terminal attaches once the agent is up.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_task(
    input: StartTaskInput,
    orchestrator: State<'_, TaskOrchestrator>,
    settings: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    run_commands: State<'_, RunCommandRepo>,
    runs: State<'_, RunCommandRuntime>,
    notifier: State<'_, NotificationService>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<StartedTask, OrchestratorError> {
    let current_session = require_user(&session)?;
    // Synced templates not confirmed on this machine fall back to the default.
    let user_settings = crate::settings_trust::launch_settings(&settings, &meta).await?;
    let (mode, command) =
        launch::resolve_launch(input.agent, input.permission_mode, &user_settings)?;
    let user_id = current_session.user_id;
    let request = StartTaskRequest {
        repository_id: input.repository_id,
        user_id: Some(user_id.clone()),
        agent: input.agent,
        command,
        name: input.name,
        prompt: input.prompt,
        base_branch: input.base_branch,
        rows: input.rows,
        cols: input.cols,
        permission_mode: Some(mode),
        notify_on_attention: input.notify_on_attention.unwrap_or(true),
        run_in: input.run_in.unwrap_or_default(),
        agent_view: None,
    };
    let start = orchestrator.start_task(request).await?;
    sync_state.request_sync();
    let started = start.started.clone();
    let run = input.run_command_id.map(|run_command_id| RunAtStart {
        run_command_id,
        user_id,
        runs: runs.inner().clone(),
        workspaces: workspaces.inner().clone(),
        run_commands: run_commands.inner().clone(),
        meta: meta.inner().clone(),
        notifier: notifier.inner().clone(),
    });
    tauri::async_runtime::spawn(finish_start(start, run, sync_state.inner().clone()));
    Ok(started)
}

/// New task's Run chip: the command to start with the task, once its
/// agent is up.
pub(crate) struct RunAtStart {
    pub run_command_id: String,
    pub user_id: String,
    pub runs: RunCommandRuntime,
    pub workspaces: WorkspaceRepo,
    pub run_commands: RunCommandRepo,
    pub meta: AppMetaRepo,
    pub notifier: NotificationService,
}

/// The rest of a `start_task` (or `start_queued_task`, without a Run
/// chip) after it returned: wait for the background
/// launch, sync again (it recorded the branch, worktree and status), then
/// start the Run chip's command. In the backend, not the form: the form's
/// dialog is gone by then, and the worktree it needs doesn't exist before
/// the launch. A command that can't start becomes an inbox entry (+ toast)
/// — never a failed task; a task that didn't start has its own.
pub(crate) async fn finish_start(
    start: TaskStart,
    run: Option<RunAtStart>,
    sync_state: Arc<CloudSyncState>,
) {
    let launched = start.launched().await;
    sync_state.request_sync();
    let (Some(run), Ok(task)) = (run, launched) else {
        return;
    };
    let started = run
        .runs
        .start_once_launched(
            &task.workspace,
            &run.run_command_id,
            &run.user_id,
            &run.workspaces,
            &run.run_commands,
            &run.meta,
        )
        .await;
    let err = match started {
        Ok(_) | Err(TaskRunError::TaskNotRunning) => return,
        Err(err) => err,
    };
    eprintln!(
        "[run] couldn't start run command {} for task {}: {err}",
        run.run_command_id, task.task_id
    );
    let name = run
        .run_commands
        .get_for_user(&run.run_command_id, &run.user_id)
        .await
        .map(|rc| rc.name)
        .unwrap_or_else(|_| "the run command".into());
    if let Err(err) = run
        .notifier
        .run_command_not_started(
            &run.user_id,
            &task.task_id,
            &run.run_command_id,
            &name,
            &err.to_string(),
        )
        .await
    {
        eprintln!("failed to record a run-command notification: {err}");
    }
}

#[tauri::command]
pub async fn stop_task(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.stop_task(&task_id).await
}

#[tauri::command]
pub async fn open_task_terminal(
    task_id: String,
    on_event: Channel<PtyEvent>,
    rows: Option<u16>,
    cols: Option<u16>,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RunningTaskInfo, OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    let sub = orchestrator
        .open_terminal(&task_id, rows.unwrap_or(24), cols.unwrap_or(80))
        .await?;
    let info = RunningTaskInfo {
        task_id: sub.task_id.clone(),
        started_at: sub.started_at,
    };
    spawn_task_event_forwarder(sub.replay, sub.rx, on_event);
    Ok(info)
}

fn spawn_task_event_forwarder(
    replay: Vec<PtyEvent>,
    mut rx: tokio::sync::broadcast::Receiver<PtyEvent>,
    channel: Channel<PtyEvent>,
) {
    tauri::async_runtime::spawn(async move {
        for event in replay {
            let _ = channel.send(event);
        }
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let is_exit = matches!(event, PtyEvent::Exit { .. });
                    let _ = channel.send(event);
                    if is_exit {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[tauri::command]
pub async fn send_input_to_task(
    task_id: String,
    data: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.send_input(&task_id, data.as_bytes())
}

/// Send one composed message to the task's agent (paste-framed when the
/// agent asked for bracketed paste), pressing Enter if `submit`.
#[tauri::command]
pub async fn send_message_to_task(
    task_id: String,
    text: String,
    submit: bool,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.send_message(&task_id, &text, submit).await
}

#[tauri::command]
pub async fn read_task_log(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.read_task_log(&task_id).await
}

#[tauri::command]
pub async fn resize_task(
    task_id: String,
    rows: u16,
    cols: u16,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.resize_task(&task_id, rows, cols)
}

#[tauri::command]
pub async fn interrupt_task(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.interrupt_task(&task_id).await
}

/// Stop one background command of a transcript-view task (the Background
/// strip's ×). `tool_use_id` is the id of the `Bash` call that started it
/// (its transcript item's id). Claude's turn and session go on.
#[tauri::command]
pub async fn stop_background_shell(
    task_id: String,
    tool_use_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.stop_background_shell(&task_id, &tool_use_id).await
}

/// The task's transcript (transcript view), oldest first: every item the
/// stream produced, persisted per task, with updates folded in. Empty for
/// a task that never ran headless. `phasr://transcript` carries what
/// changes after this snapshot.
#[tauri::command]
pub async fn get_transcript(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TranscriptItem>, OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    Ok(orchestrator.transcript(&task_id).await)
}

/// Reply suggestions for a transcript-view task's last turn: the
/// composer's chips. Cached per turn, or generated now (a one-shot Haiku
/// call through the user's `claude`, single-flight per task); empty while
/// a turn runs, before one ended, or when generation fails.
/// `phasr://suggestions` carries them too. The frontend only calls this
/// with "Suggest replies" on, so off means no call.
#[tauri::command]
pub async fn suggest_replies(
    task_id: String,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Suggestion>, OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    Ok(orchestrator.suggest_replies(&task_id).await)
}

/// Show the task as a transcript or a terminal on this machine (local-only:
/// never synced), restarting its running agent in the other mode on the
/// same Claude session. Refused while a turn runs.
#[tauri::command]
pub async fn set_agent_view(
    task_id: String,
    view: AgentView,
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Workspace, OrchestratorError> {
    let current = require_user(&session)?;
    orchestrator
        .assert_owner(&task_id, &current.user_id)
        .await?;
    orchestrator.set_agent_view(&task_id, view).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Duration;

    use crate::domain::{Repository, RunCommand, WorkspaceStatus};
    use crate::orchestrator::{RepoLockRegistry, TaskConfig};
    use crate::pty::TaskRuntime;
    use crate::store::{init_pool, NotificationRepo, RepositoryConfigRepo, RepositoryRepo};

    fn git(dir: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success());
    }

    /// Generous: run commands spawn real login shells.
    async fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn request(repository_id: &str, name: &str) -> StartTaskRequest {
        StartTaskRequest {
            repository_id: repository_id.into(),
            user_id: Some("u".into()),
            agent: Agent::Claude,
            command: "sleep 30".into(),
            name: name.into(),
            prompt: None,
            base_branch: None,
            rows: None,
            cols: None,
            permission_mode: None,
            notify_on_attention: true,
            run_in: RunIn::Worktree,
            agent_view: None,
        }
    }

    /// New task's Run chip with the setup in the background: the picked
    /// command starts in the task's worktree once the agent is up — not
    /// before (there is no worktree yet) — and one that can't start
    /// becomes an inbox entry instead of vanishing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_run_chip_starts_once_the_background_launch_is_done() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES ('u', 'u', 'n', 'u@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let checkout = dir.path().join("repo");
        std::fs::create_dir_all(&checkout).unwrap();
        git(&checkout, &["init", "-q", "-b", "main"]);
        git(&checkout, &["config", "user.email", "t@example.com"]);
        git(&checkout, &["config", "user.name", "tester"]);
        std::fs::write(checkout.join("README.md"), "hi").unwrap();
        git(&checkout, &["add", "-A"]);
        git(&checkout, &["commit", "-qm", "init"]);
        let repositories = RepositoryRepo::new(pool.clone());
        let mut repo = Repository::new(
            "r".into(),
            Some(checkout.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert_for_user(&repo, "u").await.unwrap();

        // The setup waits for `GO`; worktrees live under the tempdir.
        let gate = dir.path().join("GO");
        let configs = RepositoryConfigRepo::new(pool.clone());
        let mut cfg = configs.get(&repo.id).await.unwrap();
        cfg.worktree_base_path = Some(dir.path().join("wt").to_string_lossy().into_owned());
        cfg.pre_task_hook = Some(format!(
            "while [ ! -f '{}' ]; do sleep 0.05; done",
            gate.display()
        ));
        configs.upsert(&cfg, None).await.unwrap();

        let workspaces = WorkspaceRepo::new(pool.clone());
        let task_runtime = Arc::new(TaskRuntime::new(dir.path().join("logs")));
        let orchestrator = TaskOrchestrator::new(
            workspaces.clone(),
            repositories,
            task_runtime.clone(),
            Arc::new(RepoLockRegistry::new()),
        )
        .with_task_config(TaskConfig::new(
            configs,
            SettingsRepo::new(pool.clone()),
            None,
        ));
        let runs = RunCommandRuntime::new(task_runtime);
        let run_commands = RunCommandRepo::new(pool.clone());
        let meta = AppMetaRepo::new(pool.clone());
        let notifications = NotificationRepo::new(pool.clone());
        let notifier = NotificationService::new(notifications.clone(), workspaces.clone(), None);
        let dev = RunCommand::new(repo.id.clone(), "dev".into(), "pwd > picked; sleep 30".into());
        run_commands.insert_for_user(&dev, "u").await.unwrap();
        meta.trust_run_command(&dev).await.unwrap();
        let chip = |run_command_id: &str| RunAtStart {
            run_command_id: run_command_id.into(),
            user_id: "u".into(),
            runs: runs.clone(),
            workspaces: workspaces.clone(),
            run_commands: run_commands.clone(),
            meta: meta.clone(),
            notifier: notifier.clone(),
        };
        let sync = Arc::new(CloudSyncState::default());

        let start = orchestrator
            .start_task(request(&repo.id, "with dev"))
            .await
            .unwrap();
        let task_id = start.started.task_id.clone();
        let finish = tokio::spawn(finish_start(start, Some(chip(&dev.id)), sync.clone()));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            runs.list("u", Some(&task_id)).is_empty(),
            "nothing runs while the task is set up"
        );
        std::fs::write(&gate, "").unwrap();
        finish.await.unwrap();
        let worktree = PathBuf::from(
            workspaces
                .get(&task_id)
                .await
                .unwrap()
                .worktree_path
                .unwrap(),
        );
        wait_for("the run command in the worktree", || {
            worktree.join("picked").exists()
        })
        .await;
        assert_eq!(runs.list("u", Some(&task_id)).len(), 1);
        assert_eq!(notifications.unread_count("u").await.unwrap(), 0);

        // Not allowed on this machine: the task still starts; the chip
        // becomes an inbox entry.
        let synced = RunCommand::new(repo.id.clone(), "synced".into(), "true".into());
        run_commands.insert_for_user(&synced, "u").await.unwrap();
        let start = orchestrator
            .start_task(request(&repo.id, "untrusted"))
            .await
            .unwrap();
        let other_id = start.started.task_id.clone();
        finish_start(start, Some(chip(&synced.id)), sync).await;
        assert_eq!(
            workspaces.get(&other_id).await.unwrap().status,
            WorkspaceStatus::Running
        );
        assert!(runs.list("u", Some(&other_id)).is_empty());
        assert_eq!(notifications.unread_count("u").await.unwrap(), 1);

        runs.stop_for_workspace(&task_id);
        for id in [&task_id, &other_id] {
            let _ = orchestrator.stop_task(id).await;
        }
    }
}
