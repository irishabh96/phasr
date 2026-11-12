mod agent_signals;
mod agent_stream;
mod auth;
mod auth_deeplink;
mod checks;
mod commands;
mod detect;
#[cfg(target_os = "macos")]
mod dock_icon;
mod domain;
mod fswatch;
mod git;
mod launcher;
mod localfs;
mod notifications;
mod orchestrator;
/// Terminal-path benchmark harness; see docs/adr/ADR-002-terminal-engine.md.
/// Test-only.
#[cfg(test)]
mod perfbench;
/// Multi-agent load harness. Test-only, and gated on PHASR_LOAD=1.
#[cfg(test)]
mod loadtest;
mod pty;
mod review;
mod run_commands;
mod secrets;
mod settings_trust;
mod store;
mod sync;
mod util;
mod vt;
mod voice;
#[cfg(target_os = "macos")]
mod writing_tools;

use std::path::Path;
use std::sync::Arc;

use auth::SessionState;
use domain::WorkspaceStatus;
use orchestrator::{QueueScheduler, RepoLockRegistry, TaskBoard, TaskOrchestrator};
use pty::TaskRuntime;
use store::{
    checkpoint, checkpoint_and_close, default_db_path, init_pool, AppMetaRepo, CheckRunRepo,
    NoteRepo, NotificationRepo, RepositoryConfigRepo, RepositoryRepo, ReviewCommentRepo,
    RunCommandRepo, SettingsRepo, TaskUsageRepo, UserRepo, WorkspaceRepo, WorkspaceUpdate,
};
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_state = Arc::new(SessionState::default());
    let cloud_sync_state = Arc::new(sync::CloudSyncState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(auth_deeplink::AuthDeepLinkState::default())
        .manage(session_state)
        .manage(cloud_sync_state)
        // Agent/environment detection spawns real processes; cached for the
        // app's lifetime, refreshed on demand (`force`).
        .manage(Arc::new(detect::DetectionCache::default()))
        // Holds per-task routing metadata for the notification-activation seam
        // (DDR-003 §6); the plugin drops `extra` on desktop, so the frontend
        // records it here before firing each OS notification.
        .manage(Arc::new(
            commands::notifications::NotificationRouteRegistry::default(),
        ))
        .setup(|app| {
            // The main window is declared in tauri.conf.json with
            // `"create": false` and built here, first, from that same
            // config, so its webview can be given a configuration before it
            // exists (Writing Tools off on macOS; see writing_tools.rs).
            let main_window = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json declares no window")?;
            let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &main_window)?;
            #[cfg(target_os = "macos")]
            let builder = match objc2::MainThreadMarker::new() {
                Some(mtm) => {
                    builder.with_webview_configuration(writing_tools::webview_configuration(mtm))
                }
                None => builder,
            };
            builder.build()?;

            auth_deeplink::configure_auth_deeplink(app)?;

            #[cfg(target_os = "macos")]
            dock_icon::set_dock_icon();

            // Custom macOS menu that reaches parity with Tauri's default
            // (App / Edit / View / Window) EXCEPT it omits `close_window`,
            // so `⌘W` is no longer claimed by `Window → Close Window` and
            // the JS handler can use it to close the active in-app tab.
            // muda hardcodes ⌘W onto `PredefinedMenuItem::close_window`
            // with no accelerator setter, so omitting the item is the only
            // way to free the key. All other items keep native
            // accelerators (⌘C/⌘V/⌘Z/⌃⌘F/…).
            let app_submenu = SubmenuBuilder::new(app, "Phasr")
                .items(&[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ])
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .items(&[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ])
                .build()?;
            let view_submenu = SubmenuBuilder::new(app, "View")
                .items(&[&PredefinedMenuItem::fullscreen(app, None)?])
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .items(&[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ])
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_submenu, &edit_submenu, &view_submenu, &window_submenu])
                .build()?;
            app.set_menu(menu)?;

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");
            let db_path = default_db_path(&app_data_dir);
            let log_dir = app_data_dir.join("logs");

            // Voice input: downloaded Whisper models live beside the DB.
            let voice = voice::VoiceService::new(app_data_dir.join("models").join("whisper"));
            commands::events::spawn_voice_bridge(&voice, app.handle().clone());
            app.manage(voice);
            // Hold fn to dictate.
            #[cfg(target_os = "macos")]
            voice::fn_key::install(app.handle().clone());

            let task_runtime = Arc::new(TaskRuntime::new(log_dir));
            app.manage(task_runtime.clone());

            let watch_registry =
                Arc::new(fswatch::WorktreeWatchRegistry::new(app.handle().clone()));
            app.manage(watch_registry.clone());

            tauri::async_runtime::block_on(initialize_database_state(
                app.handle(),
                &db_path,
                &app_data_dir,
                task_runtime,
            ))?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::voice::list_voice_models,
            commands::voice::download_voice_model,
            commands::voice::cancel_voice_model_download,
            commands::voice::delete_voice_model,
            commands::voice::microphone_access,
            commands::voice::start_dictation,
            commands::voice::stop_dictation,
            commands::voice::cancel_dictation,
            commands::voice::open_microphone_settings,
            commands::voice::globe_key_action,
            commands::voice::open_keyboard_settings,
            commands::voice::list_dictation_polishers,
            commands::voice::polish_dictation,
            auth::set_session,
            auth::clear_session,
            auth::current_user_id,
            auth_deeplink::consume_pending_auth_callback,
            sync::start_cloud_sync,
            sync::stop_cloud_sync,
            commands::repositories::create_repository,
            commands::repositories::list_repositories,
            commands::repositories::get_repository,
            commands::repositories::update_repository,
            commands::repositories::delete_repository,
            commands::repositories::git_init_repository,
            commands::repositories::git_clone_repository,
            commands::repositories::git_init_from_template,
            commands::repositories::git_init_empty_repository,
            commands::repositories::list_repo_files,
            commands::repositories::list_local_branches,
            commands::workspaces::create_workspace,
            commands::workspaces::list_workspaces,
            commands::workspaces::get_workspace,
            commands::workspaces::update_workspace,
            commands::workspaces::archive_workspace,
            commands::workspaces::open_pull_request,
            commands::workspaces::check_workspace_delete,
            commands::workspaces::delete_workspace,
            commands::workspaces::watch_workspace,
            commands::workspaces::unwatch_workspace,
            commands::agents::list_agents,
            commands::agents::detect_agents,
            commands::agents::check_environment,
            commands::agents::preview_agent_command,
            commands::settings::get_user_settings,
            commands::settings::update_user_settings,
            commands::settings::list_unconfirmed_settings,
            commands::settings::confirm_settings_on_this_machine,
            commands::settings::list_shells,
            commands::repository_config::get_repository_config,
            commands::repository_config::update_repository_config,
            commands::repository_config::list_repository_worktrees,
            commands::repository_config::compute_worktree_sizes,
            commands::repository_config::remove_worktrees,
            commands::api_keys::list_api_keys,
            commands::api_keys::set_api_key,
            commands::api_keys::delete_api_key,
            commands::orchestrator::start_task,
            commands::orchestrator::stop_task,
            commands::orchestrator::open_task_terminal,
            commands::orchestrator::list_task_activity,
            commands::orchestrator::send_input_to_task,
            commands::orchestrator::send_message_to_task,
            commands::orchestrator::read_task_log,
            commands::orchestrator::resize_task,
            commands::orchestrator::interrupt_task,
            commands::orchestrator::stop_background_shell,
            commands::orchestrator::get_transcript,
            commands::orchestrator::suggest_replies,
            commands::orchestrator::set_agent_view,
            commands::agent_signals::list_agent_states,
            commands::agent_signals::respond_to_attention,
            commands::agent_signals::notify_attention,
            commands::agent_signals::get_task_usage,
            commands::agent_signals::get_agent_summary,
            commands::agent_signals::list_agent_file_edits,
            commands::board::list_task_cards,
            commands::board::create_task_draft,
            commands::board::update_task_draft,
            commands::board::set_task_queued,
            commands::board::start_queued_task,
            commands::board::get_system_status,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_branch_status,
            commands::git::git_fetch,
            commands::git::git_sync_with_main,
            commands::git::git_merge_to_main,
            commands::git::git_merge_in_progress,
            commands::git::git_abort_merge,
            commands::git::git_continue_merge,
            commands::git::git_resolve_conflict,
            commands::git::git_log,
            commands::git::git_commit_files,
            commands::git::git_commit_diff,
            commands::review::git_review_files,
            commands::review::run_checks,
            commands::review::cancel_checks,
            commands::review::list_check_runs,
            commands::review::get_check_output,
            commands::review::list_review_comments,
            commands::review::create_review_comment,
            commands::review::update_review_comment,
            commands::review::delete_review_comment,
            commands::review::send_review_comments,
            commands::review::request_changes,
            commands::review::approve_and_create_pr,
            commands::review::refresh_pr_states,
            commands::review::discard_workspace,
            commands::notifications::register_notification_route,
            commands::notifications::activate_notification,
            commands::notifications::list_notifications,
            commands::notifications::unread_notification_count,
            commands::notifications::mark_notifications_read,
            commands::notifications::clear_notifications,
            localfs::validate_workspace_path,
            localfs::default_projects_dir,
            localfs::ensure_dir,
            launcher::list_launchers,
            launcher::launch_app,
            commands::run_commands::create_run_command,
            commands::run_commands::list_run_commands,
            commands::run_commands::update_run_command,
            commands::run_commands::delete_run_command,
            commands::run_commands::attach_run_command,
            commands::run_commands::start_run_command,
            commands::run_commands::stop_run_command,
            commands::run_commands::send_run_command_input,
            commands::run_commands::resize_run_command,
            commands::run_commands::confirm_run_command,
            commands::run_commands::list_untrusted_run_commands,
            commands::run_commands::start_run_command_for_task,
            commands::run_commands::list_running_commands,
            commands::run_commands::detect_package_scripts,
            commands::notes::create_note,
            commands::notes::list_notes_for_repository,
            commands::notes::update_note,
            commands::notes::set_note_done,
            commands::notes::delete_note,
            commands::session_terminal::start_session_terminal,
            commands::session_terminal::attach_session_terminal,
            commands::session_terminal::send_session_input,
            commands::session_terminal::resize_session,
            commands::session_terminal::stop_session_terminal,
            commands::files::read_text_file,
            commands::files::list_workspace_tree,
            commands::files::read_workspace_file,
            commands::files::write_workspace_file,
            commands::files::revert_hunk,
            commands::attachments::save_attachment,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Nothing started in a phasr terminal (agents, dev servers,
                // background jobs) may outlive the app. Bounded: ~1s.
                if let Some(runtime) = app_handle.try_state::<Arc<TaskRuntime>>() {
                    runtime.terminate_all_blocking(std::time::Duration::from_millis(500));
                }
                // Headless Claude processes (transcript view) run in their
                // own process groups, outside any PTY.
                if let Some(orchestrator) = app_handle.try_state::<TaskOrchestrator>() {
                    orchestrator
                        .streams()
                        .terminate_all_blocking(std::time::Duration::from_millis(500));
                }
                // Checks run in their own process groups, outside any PTY.
                if let Some(checks) = app_handle.try_state::<checks::CheckService>() {
                    checks.terminate_all_blocking(std::time::Duration::from_millis(500));
                }
                // Last chance before the process dies: fold the WAL into the
                // main db file and close the pool. Tauri never drops managed
                // state, so without this the WAL grows forever and the
                // .sqlite file alone is not a database.
                if let Some(pool) = app_handle.try_state::<store::Db>() {
                    tauri::async_runtime::block_on(checkpoint_and_close(pool.inner()));
                }
            }
        });
}

async fn initialize_database_state(
    handle: &tauri::AppHandle,
    db_path: &Path,
    app_data_dir: &Path,
    task_runtime: Arc<TaskRuntime>,
) -> Result<(), store::StoreError> {
    let pool = init_pool(db_path).await?;

    // Heal whatever the previous process left in the WAL: exits that never
    // closed the pool strand every row (and the schema) in the -wal
    // sidecar, leaving the .sqlite file an empty header page that any
    // backup/copy/cleanup would "preserve" as a total data loss.
    if let Err(err) = checkpoint(&pool).await {
        eprintln!("startup wal checkpoint failed: {err}");
    }

    // Daily safety-net snapshot OUTSIDE the app data dir (uninstall
    // cleaners delete that dir wholesale). Best-effort: a failed backup
    // must never block boot.
    match store::default_backups_dir() {
        Some(backups_dir) => {
            if let Err(err) = store::backup_rotate(&pool, &backups_dir, 7).await {
                eprintln!("startup db backup failed: {err}");
            }
        }
        None => eprintln!("startup db backup skipped: HOME is not set"),
    }

    let repository_repo = RepositoryRepo::new(pool.clone());
    let workspace_repo = WorkspaceRepo::new(pool.clone());
    recover_startup_state(&workspace_repo, &repository_repo).await;

    // One registry shared between the orchestrator (guards `git worktree
    // add` in start_task) and the command layer (guards create_workspace /
    // merge_to_main / delete_workspace) so every shared-`.git` mutation for
    // a repo serializes against the same lock.
    let repo_locks = Arc::new(RepoLockRegistry::new());

    // Needs-you state, approvals and usage for every agent launch. Installs
    // the hook script under app data; degrades to heuristics if it can't.
    let agent_signals = agent_signals::AgentSignals::new(
        agent_signals::SignalsConfig::for_app(app_data_dir.to_path_buf()),
        workspace_repo.clone(),
        TaskUsageRepo::new(pool.clone()),
    );
    agent_signals.start();
    commands::events::spawn_agent_signal_bridge(&agent_signals, handle.clone());

    // Settings + repository rules for every launch (M11): branch template,
    // worktree base, fetch / copy / after-create hook, shell, and each
    // agent's API key from the Keychain.
    let repository_configs = RepositoryConfigRepo::new(pool.clone());
    let app_meta = AppMetaRepo::new(pool.clone());
    // Before anything can launch: what's stored today already ran on this
    // machine; from now on synced agent templates / shells need confirming.
    settings_trust::grandfather_existing(&app_meta, &SettingsRepo::new(pool.clone())).await;
    let api_keys = secrets::ApiKeys::new(
        Arc::new(secrets::KeychainStore::default()),
        app_meta.clone(),
    )
    .with_current_user(Arc::new(current_user_fn(handle)));
    let orchestrator = TaskOrchestrator::new(
        workspace_repo.clone(),
        repository_repo.clone(),
        task_runtime.clone(),
        repo_locks.clone(),
    )
    .with_agent_signals(agent_signals.clone())
    .with_task_config(
        orchestrator::TaskConfig::new(
            repository_configs.clone(),
            SettingsRepo::new(pool.clone()),
            Some(api_keys.clone()),
        )
        .with_trust(app_meta.clone()),
    );
    commands::events::spawn_status_bridge(Arc::new(orchestrator.clone()), handle.clone());
    commands::events::spawn_transcript_bridge(orchestrator.streams(), handle.clone());
    commands::events::spawn_suggestions_bridge(orchestrator.streams(), handle.clone());
    let attention_notifications = commands::events::start_attention_notifications(
        handle,
        orchestrator.clone(),
        &agent_signals,
        current_user_fn(handle),
    );

    // The Board: derived lanes + diff cache, and the queue that starts
    // queued tasks once their dependency reaches review.
    let board = TaskBoard::new(
        workspace_repo.clone(),
        repository_repo.clone(),
        TaskUsageRepo::new(pool.clone()),
        Some(agent_signals.clone()),
    );
    board.start(orchestrator.subscribe_status(), Some(agent_signals.subscribe()));
    commands::events::spawn_board_bridge(&board, handle.clone());
    let scheduler = QueueScheduler::new(orchestrator.clone(), workspace_repo.clone());
    scheduler.start(
        orchestrator.subscribe_status(),
        Some(agent_signals.subscribe()),
        // Only the signed-in user's queue runs; signed out, nothing starts.
        current_user_fn(handle),
    );

    // Review (M8): checks per worktree state, auto-run on entering review.
    let run_command_repo = RunCommandRepo::new(pool.clone());
    let checks = checks::CheckService::new(
        CheckRunRepo::new(pool.clone()),
        run_command_repo.clone(),
        workspace_repo.clone(),
        app_meta.clone(),
        task_runtime.log_dir.clone(),
    );
    checks.settle_interrupted().await;
    checks.start(
        board.clone(),
        orchestrator.subscribe_status(),
        Some(agent_signals.subscribe()),
        current_user_fn(handle),
    );
    commands::events::spawn_check_bridge(&checks, handle.clone());

    // Run commands per task worktree; `task_start` ones start with the task.
    let run_runtime = run_commands::RunCommandRuntime::new(task_runtime.clone());
    run_runtime.start_task_hooks(
        orchestrator.subscribe_status(),
        workspace_repo.clone(),
        run_command_repo.clone(),
        app_meta.clone(),
        current_user_fn(handle),
    );
    commands::events::spawn_run_command_bridge(&run_runtime, handle.clone());

    let review = review::ReviewService::new(
        workspace_repo.clone(),
        repository_repo.clone(),
        repo_locks.clone(),
        checks.clone(),
    )
    .with_runtime(task_runtime.clone());

    // The inbox.
    let notification_repo = NotificationRepo::new(pool.clone());
    let notifier = notifications::NotificationService::new(
        notification_repo.clone(),
        workspace_repo.clone(),
        Some(checks.clone()),
    );
    // At startup and hourly after (not only at launch).
    notifier.start_pruning();
    notifier.start(
        orchestrator.subscribe_status(),
        Some(agent_signals.subscribe()),
        Some(checks.subscribe()),
        Some(run_runtime.subscribe()),
        current_user_fn(handle),
    );
    commands::events::spawn_notification_bridge(&notifier, handle.clone());

    // Cleanup after merge (Settings → Worktrees): remove, or ask in the inbox.
    let merge_cleanup = review::cleanup::MergeCleanup::new(
        repository_configs.clone(),
        repository_repo.clone(),
        repo_locks.clone(),
        task_runtime,
    )
    .with_services(run_runtime.clone(), checks.clone())
    .with_notifier(notifier.clone());
    spawn_pr_refresh(review.clone(), board.clone(), merge_cleanup.clone(), handle.clone());

    handle.manage(repository_repo);
    handle.manage(repository_configs);
    handle.manage(api_keys);
    handle.manage(merge_cleanup);
    handle.manage(workspace_repo);
    handle.manage(run_command_repo);
    handle.manage(app_meta);
    handle.manage(ReviewCommentRepo::new(pool.clone()));
    handle.manage(notification_repo);
    handle.manage(checks);
    handle.manage(run_runtime);
    handle.manage(review);
    handle.manage(notifier);
    handle.manage(NoteRepo::new(pool.clone()));
    handle.manage(SettingsRepo::new(pool.clone()));
    handle.manage(UserRepo::new(pool.clone()));
    handle.manage(pool);
    handle.manage(repo_locks);
    handle.manage(orchestrator);
    handle.manage(agent_signals);
    handle.manage(attention_notifications);
    handle.manage(board);
    handle.manage(scheduler);

    Ok(())
}

/// The signed-in user's id, re-read on every call — for background
/// services that must act as the current user (and do nothing signed out).
fn current_user_fn(handle: &tauri::AppHandle) -> impl Fn() -> Option<String> + Send + Sync + 'static {
    let session = handle.state::<Arc<SessionState>>().inner().clone();
    move || session.require().ok().flatten().map(|s| s.user_id)
}

/// How often open/draft PRs are re-read with `gh` (the frontend also
/// refreshes on window focus via `refresh_pr_states`).
const PR_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn spawn_pr_refresh(
    review: review::ReviewService,
    board: TaskBoard,
    cleanup: review::cleanup::MergeCleanup,
    handle: tauri::AppHandle,
) {
    let current_user = current_user_fn(&handle);
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(PR_REFRESH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let Some(user_id) = current_user() else { continue };
            match review.refresh_pr_states_detailed(&user_id, None).await {
                Ok(refresh) if !refresh.changed.is_empty() => {
                    for merged in &refresh.newly_merged {
                        cleanup.on_merged(merged, &user_id).await;
                    }
                    let changed = refresh.changed;
                    for w in &changed {
                        board.notify_changed(&w.repository_id);
                    }
                    if let Some(sync) = handle.try_state::<Arc<sync::CloudSyncState>>() {
                        sync.request_sync();
                    }
                }
                Ok(_) => {}
                Err(err) => eprintln!("pr refresh failed: {err}"),
            }
        }
    });
}

async fn recover_startup_state(workspace_repo: &WorkspaceRepo, repository_repo: &RepositoryRepo) {
    match workspace_repo
        .list_by_status(WorkspaceStatus::Running)
        .await
    {
        Ok(running) => {
            let now = chrono::Utc::now();
            for workspace in running {
                if let Err(err) = workspace_repo
                    .update(
                        &workspace.id,
                        WorkspaceUpdate {
                            status: Some(WorkspaceStatus::Stopped),
                            exit_code: Some(None),
                            finished_at: Some(Some(now)),
                            ..Default::default()
                        },
                    )
                    .await
                {
                    eprintln!(
                        "failed to recover orphaned running workspace {}: {err}",
                        workspace.id
                    );
                }
            }
        }
        Err(err) => eprintln!("failed to list running workspaces during startup recovery: {err}"),
    }

    match repository_repo.list().await {
        Ok(repositories) => {
            for repository in repositories {
                let Some(path) = repository.local_path.as_deref() else {
                    continue;
                };
                let path = std::path::Path::new(path);
                if !path.exists() || !path.join(".git").exists() {
                    continue;
                }
                if let Err(err) = crate::git::prune_worktrees(path) {
                    eprintln!(
                        "failed to prune git worktrees for repository {}: {err}",
                        repository.id
                    );
                }
            }
        }
        Err(err) => eprintln!("failed to list repositories during startup recovery: {err}"),
    }
}
