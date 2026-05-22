mod auth;
mod commands;
#[cfg(target_os = "macos")]
mod dock_icon;
mod domain;
mod fswatch;
mod git;
mod launcher;
mod localfs;
mod orchestrator;
mod pty;
mod store;

use std::sync::Arc;

use auth::SessionState;
use orchestrator::TaskOrchestrator;
use pty::TaskRuntime;
use store::{
    default_db_path, init_pool, AgentRepo, RepositoryRepo, RunCommandRepo, SettingsRepo,
    WorkspaceRepo,
};
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_state = Arc::new(SessionState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session_state)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            dock_icon::set_dock_icon();

            // Replace the default macOS menu so `⌘W` is no longer claimed
            // by `Window → Close Window`. JS handles ⌘W to close the
            // active in-app tab. Edit + App items keep their native
            // accelerators (⌘C, ⌘V, ⌘Q, etc.).
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
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .items(&[&PredefinedMenuItem::minimize(app, None)?])
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_submenu, &edit_submenu, &window_submenu])
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

            let handle = app.handle().clone();
            let runtime_for_async = task_runtime;
            tauri::async_runtime::spawn(async move {
                match init_pool(&db_path).await {
                    Ok(pool) => {
                        let agent_repo = AgentRepo::new(pool.clone());
                        if let Err(err) = agent_repo.ensure_seeded().await {
                            eprintln!("agent seeding failed: {err}");
                        }
                        let repository_repo = RepositoryRepo::new(pool.clone());
                        let workspace_repo = WorkspaceRepo::new(pool.clone());
                        let orchestrator = TaskOrchestrator::new(
                            workspace_repo.clone(),
                            repository_repo.clone(),
                            agent_repo.clone(),
                            runtime_for_async,
                        );
                        commands::orchestrator::spawn_status_bridge(
                            Arc::new(orchestrator.clone()),
                            handle.clone(),
                        );

                        handle.manage(repository_repo);
                        handle.manage(workspace_repo);
                        handle.manage(RunCommandRepo::new(pool.clone()));
                        handle.manage(agent_repo);
                        handle.manage(SettingsRepo::new(pool));
                        handle.manage(orchestrator);
                    }
                    Err(err) => {
                        eprintln!(
                            "failed to initialize SQLite at {}: {err}",
                            db_path.display()
                        );
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::set_session,
            auth::clear_session,
            auth::current_user_id,
            commands::repositories::create_repository,
            commands::repositories::list_repositories,
            commands::repositories::get_repository,
            commands::repositories::update_repository,
            commands::repositories::delete_repository,
            commands::repositories::list_soft_deleted_repositories,
            commands::repositories::mark_repository_synced,
            commands::repositories::repository_is_soft_deleted,
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
            commands::agents::set_agent_enabled,
            commands::agents::set_agent_command,
            commands::agents::set_agent_default,
            commands::settings::get_user_settings,
            commands::settings::update_user_settings,
            commands::runtime::start_workspace,
            commands::runtime::read_workspace_log,
            commands::runtime::send_workspace_input,
            commands::runtime::resize_workspace,
            commands::runtime::interrupt_workspace,
            commands::runtime::stop_workspace,
            commands::orchestrator::start_task,
            commands::orchestrator::stop_task,
            commands::orchestrator::send_input_to_task,
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
            localfs::validate_workspace_path,
            localfs::default_projects_dir,
            localfs::ensure_dir,
            launcher::list_launchers,
            launcher::launch_app,
            commands::run_commands::create_run_command,
            commands::run_commands::list_run_commands,
            commands::run_commands::update_run_command,
            commands::run_commands::delete_run_command,
            commands::run_commands::upsert_run_command_from_cloud,
            commands::run_commands::start_run_command,
            commands::run_commands::stop_run_command,
            commands::run_commands::send_run_command_input,
            commands::run_commands::resize_run_command,
            commands::session_terminal::start_session_terminal,
            commands::session_terminal::send_session_input,
            commands::session_terminal::resize_session,
            commands::session_terminal::stop_session_terminal,
            commands::files::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
