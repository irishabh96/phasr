mod auth;
mod commands;
mod domain;
mod git;
mod launcher;
mod localfs;
mod pty;
mod store;

use std::sync::Arc;

use auth::SessionState;
use pty::TaskRuntime;
use store::{
    default_db_path, init_pool, AgentRepo, RepositoryRepo, RunCommandRepo, SettingsRepo,
    WorkspaceRepo,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_state = Arc::new(SessionState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session_state)
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");
            let db_path = default_db_path(&app_data_dir);
            let log_dir = app_data_dir.join("logs");

            let task_runtime = Arc::new(TaskRuntime::new(log_dir));
            app.manage(task_runtime);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match init_pool(&db_path).await {
                    Ok(pool) => {
                        let agent_repo = AgentRepo::new(pool.clone());
                        if let Err(err) = agent_repo.ensure_seeded().await {
                            eprintln!("agent seeding failed: {err}");
                        }
                        handle.manage(RepositoryRepo::new(pool.clone()));
                        handle.manage(WorkspaceRepo::new(pool.clone()));
                        handle.manage(RunCommandRepo::new(pool.clone()));
                        handle.manage(agent_repo);
                        handle.manage(SettingsRepo::new(pool));
                    }
                    Err(err) => {
                        eprintln!("failed to initialize SQLite at {}: {err}", db_path.display());
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
            commands::workspaces::create_workspace,
            commands::workspaces::list_workspaces,
            commands::workspaces::get_workspace,
            commands::workspaces::update_workspace,
            commands::workspaces::delete_workspace,
            commands::agents::list_agents,
            commands::agents::set_agent_enabled,
            commands::agents::set_agent_command,
            commands::agents::set_agent_default,
            commands::agents::create_custom_agent,
            commands::agents::delete_agent,
            commands::settings::get_user_settings,
            commands::settings::update_user_settings,
            commands::runtime::start_workspace,
            commands::runtime::read_workspace_log,
            commands::runtime::send_workspace_input,
            commands::runtime::resize_workspace,
            commands::runtime::interrupt_workspace,
            commands::runtime::stop_workspace,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_commit,
            commands::git::git_push,
            localfs::validate_workspace_path,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
