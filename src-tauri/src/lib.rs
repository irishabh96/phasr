mod auth;
mod auth_deeplink;
mod commands;
#[cfg(target_os = "macos")]
mod dock_icon;
mod domain;
mod fswatch;
mod git;
mod launcher;
mod localfs;
mod orchestrator;
/// Terminal-path benchmark harness; see docs/adr/ADR-002-terminal-engine.md.
/// Test-only.
#[cfg(test)]
mod perfbench;
/// Multi-agent load harness. Test-only, and gated on PHASR_LOAD=1.
#[cfg(test)]
mod loadtest;
mod pty;
mod store;
mod sync;
mod vt;

use std::path::Path;
use std::sync::Arc;

use auth::SessionState;
use domain::WorkspaceStatus;
use orchestrator::{RepoLockRegistry, TaskOrchestrator};
use pty::TaskRuntime;
use store::{
    checkpoint, checkpoint_and_close, default_db_path, init_pool, NoteRepo, RepositoryRepo,
    RunCommandRepo, SettingsRepo, UserRepo, WorkspaceRepo, WorkspaceUpdate,
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
        // Holds per-task routing metadata for the notification-activation seam
        // (DDR-003 §6); the plugin drops `extra` on desktop, so the frontend
        // records it here before firing each OS notification.
        .manage(Arc::new(
            commands::notifications::NotificationRouteRegistry::default(),
        ))
        .setup(|app| {
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

            let task_runtime = Arc::new(TaskRuntime::new(log_dir));
            app.manage(task_runtime.clone());

            let watch_registry =
                Arc::new(fswatch::WorktreeWatchRegistry::new(app.handle().clone()));
            app.manage(watch_registry.clone());

            tauri::async_runtime::block_on(initialize_database_state(
                app.handle(),
                &db_path,
                task_runtime,
            ))?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::settings::get_user_settings,
            commands::settings::update_user_settings,
            commands::orchestrator::start_task,
            commands::orchestrator::stop_task,
            commands::orchestrator::open_task_terminal,
            commands::orchestrator::send_input_to_task,
            commands::orchestrator::read_task_log,
            commands::orchestrator::resize_task,
            commands::orchestrator::interrupt_task,
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
            commands::notifications::register_notification_route,
            commands::notifications::activate_notification,
            localfs::validate_workspace_path,
            localfs::default_projects_dir,
            localfs::ensure_dir,
            launcher::list_launchers,
            launcher::launch_app,
            commands::run_commands::create_run_command,
            commands::run_commands::list_run_commands,
            commands::run_commands::update_run_command,
            commands::run_commands::delete_run_command,
            commands::run_commands::start_run_command,
            commands::run_commands::stop_run_command,
            commands::run_commands::send_run_command_input,
            commands::run_commands::resize_run_command,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
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

    let orchestrator = TaskOrchestrator::new(
        workspace_repo.clone(),
        repository_repo.clone(),
        task_runtime,
        repo_locks.clone(),
    );
    commands::orchestrator::spawn_status_bridge(Arc::new(orchestrator.clone()), handle.clone());

    handle.manage(repository_repo);
    handle.manage(workspace_repo);
    handle.manage(RunCommandRepo::new(pool.clone()));
    handle.manage(NoteRepo::new(pool.clone()));
    handle.manage(SettingsRepo::new(pool.clone()));
    handle.manage(UserRepo::new(pool.clone()));
    handle.manage(pool);
    handle.manage(repo_locks);
    handle.manage(orchestrator);

    Ok(())
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
