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
mod pty;
mod store;
mod sync;
mod tickets;
mod real_loop;
mod worktree_gc;

use std::path::Path;
use std::sync::Arc;

use auth::SessionState;
use domain::WorkspaceStatus;
use orchestrator::{BoardEventBus, RepoLockRegistry, TaskOrchestrator};
use pty::TaskRuntime;
use store::{
    default_db_path, init_pool, AutopilotStateRepo, BoardRepo, RepositoryRepo, RunCommandRepo,
    SettingsRepo, UserRepo, WorkspaceRepo, WorkspaceUpdate,
};
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_state = Arc::new(SessionState::default());
    let cloud_sync_state = Arc::new(sync::CloudSyncState::default());

    tauri::Builder::default()
        // Logging first, so every later plugin/setup failure is captured. A
        // bundled .app has no visible stderr — the rotating LogDir file
        // (~/Library/Logs/<bundle-id>/phasr.log) is the only way a user can
        // hand us diagnostics.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("phasr".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                // sqlx logs every statement at Debug and slow queries at Warn;
                // keep the file signal-only.
                .level_for("sqlx", log::LevelFilter::Warn)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
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
        // Records the hash of the bytes the ticket file-service last wrote to
        // each brief file. Shared so `write_ticket_section` (T4) can skip a
        // spurious mtime-only conflict and the future `watch_ticket` (T7) can
        // suppress its own-write change events by hash (architect #2).
        .manage(Arc::new(tickets::TicketWriteRegistry::default()))
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

            // The ticket-dir watcher (T7) shares the SAME TicketWriteRegistry as
            // `write_ticket_section` (managed above) so it can suppress its own
            // writes by hash — a save never round-trips as a phantom "changed on
            // disk" (architect #2). Fetch the managed instance and hand it a clone.
            let ticket_write_registry = app
                .state::<Arc<tickets::TicketWriteRegistry>>()
                .inner()
                .clone();
            let ticket_watch_registry = Arc::new(fswatch::TicketWatchRegistry::new(
                app.handle().clone(),
                ticket_write_registry,
            ));
            app.manage(ticket_watch_registry);

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
            commands::settings::get_user_settings,
            commands::settings::update_user_settings,
            commands::orchestrator::start_task,
            commands::orchestrator::stop_task,
            commands::orchestrator::open_task_terminal,
            commands::orchestrator::send_input_to_task,
            commands::orchestrator::read_task_log,
            commands::orchestrator::resize_task,
            commands::orchestrator::interrupt_task,
            commands::board::start_decomposition,
            commands::board::get_board,
            commands::board::publish_contract,
            commands::board::integrate_parent,
            commands::board::ship_epic,
            commands::board::start_ticket,
            commands::autopilot::set_require_human_approval,
            commands::tickets::read_epic_brief,
            commands::tickets::write_epic_section,
            commands::workspaces::archive_epic,
            commands::board::board_integration_diff,
            commands::board::board_integration_file_diff,
            commands::validate::validate_ticket,
            commands::validate::get_validate_result,
            commands::review::request_review,
            commands::review::resolve_review,
            commands::review::get_review,
            commands::review::get_board_gates,
            commands::autopilot::set_autopilot,
            commands::autopilot::set_autopilot_kill_switch,
            commands::autopilot::get_autopilot_state,
            commands::tickets::read_ticket_brief,
            commands::tickets::write_ticket_section,
            commands::tickets::list_ticket_assets,
            commands::tickets::add_ticket_asset,
            commands::tickets::remove_ticket_asset,
            commands::tickets::add_ticket_figma_link,
            commands::tickets::remove_ticket_figma_link,
            commands::tickets::list_ticket_comments,
            commands::tickets::add_ticket_comment,
            commands::tickets::watch_ticket,
            commands::tickets::unwatch_ticket,
            commands::worklist::list_worklist,
            commands::planner::plan_decomposition,
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
            commands::git::git_repo_merge_in_progress,
            commands::git::git_repo_abort_merge,
            commands::git::git_push_default_branch,
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
            commands::run_commands::upsert_run_command_from_cloud,
            commands::run_commands::start_run_command,
            commands::run_commands::stop_run_command,
            commands::run_commands::send_run_command_input,
            commands::run_commands::resize_run_command,
            commands::session_terminal::start_session_terminal,
            commands::session_terminal::attach_session_terminal,
            commands::session_terminal::send_session_input,
            commands::session_terminal::resize_session,
            commands::session_terminal::stop_session_terminal,
            commands::files::read_text_file,
        ])
        // `.build().run(..)` rather than `.run(..)` so we get a `RunEvent` loop:
        // on quit we remove the CLI socket file (§R4) so the NEXT launch binds
        // cleanly (the pre-bind `remove_file` is the belt to this suspenders,
        // covering a crash that never reaches `Exit`).
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            #[cfg(unix)]
            if let tauri::RunEvent::Exit = event {
                let _ = std::fs::remove_file(orchestrator::ipc_server::socket_path());
            }
        });
}

async fn initialize_database_state(
    handle: &tauri::AppHandle,
    db_path: &Path,
    task_runtime: Arc<TaskRuntime>,
) -> Result<(), store::StoreError> {
    let pool = init_pool(db_path).await?;

    let repository_repo = RepositoryRepo::new(pool.clone());
    let workspace_repo = WorkspaceRepo::new(pool.clone());
    recover_startup_state(&workspace_repo, &repository_repo).await;
    // Reclaim abandoned worktrees (E4) BEFORE the orchestrator spawns —
    // nothing else touches repos yet, so the sweep needs no repo locks. The
    // production base path is injected here so recovery tests (and the GC's
    // own suite) never go near the real ~/.phasr/worktrees.
    let gc = worktree_gc::sweep_orphaned_worktrees(
        &workspace_repo,
        &repository_repo,
        &git::default_worktree_base_path(),
    )
    .await;
    if gc.removed > 0 {
        log::info!(
            "worktree GC: reclaimed {} abandoned worktree(s), kept {}",
            gc.removed,
            gc.kept
        );
    }

    // One registry shared between the orchestrator (guards `git worktree
    // add` in start_task) and the command layer (guards create_workspace /
    // merge_to_main / delete_workspace) so every shared-`.git` mutation for
    // a repo serializes against the same lock.
    let repo_locks = Arc::new(RepoLockRegistry::new());

    // CLI seam (Story CLI1 / §R5): ONE shared in-memory token registry — the
    // scheduler mints a per-subtask token into it (`with_cli`), the IPC server
    // resolves from it. Never persisted, so a restart starts empty and re-mints
    // on the next spawn. `CliSpawnConfig` carries the two runtime paths injected
    // into a spawned agent's env so it can reach us over the socket (§J3/§J4).
    let cli_tokens = Arc::new(orchestrator::CliTokenRegistry::new());
    let cli_config = orchestrator::CliSpawnConfig {
        bin_path: resolve_phasr_cli_bin(),
        socket_path: orchestrator::ipc_server::socket_path(),
    };

    let orchestrator = TaskOrchestrator::new(
        workspace_repo.clone(),
        repository_repo.clone(),
        task_runtime,
        repo_locks.clone(),
    )
    .with_cli(cli_tokens.clone(), cli_config);
    commands::orchestrator::spawn_status_bridge(Arc::new(orchestrator.clone()), handle.clone());
    // Board-refresh seam (architect §R1/§R2): a board/gate mutation calls
    // `notify(parent_id)` on this bus; the bridge re-emits `phasr://board-changed`
    // so an open board moves live — even when the mutation was driven from
    // elsewhere (a gate writer, or the future `phasr` CLI IPC server, which gets a
    // clone of this same bus).
    let board_events = Arc::new(BoardEventBus::new());
    commands::board::spawn_board_event_bridge(board_events.clone(), handle.clone());
    // Honest status (E0-T3): one background poller derives Working/Idle/Wedged
    // from each running agent's in-memory activity stamp and pushes only
    // transitions onto the same `phasr://task-status` bridge above.
    orchestrator.spawn_liveness_poller();
    // Dependency-aware scheduler (E2-T2): the fan-out counterpart to the
    // liveness poller. One background poller that bridges published contract
    // files into the DB and spawns each decomposition subtask whose incoming
    // edges are satisfied — the initial ready set (the root `backend`) fans out
    // within one interval of `start_decomposition` writing the DAG.
    orchestrator.spawn_scheduler(BoardRepo::new(pool.clone()));
    // Autopilot driver (Phase 5a S4): the full-gate-ladder counterpart to the
    // scheduler. Auto-advances Validate → Request-review and auto-integrates a
    // fully-approved, clean epic — parking hard at every human-judgment / outward
    // edge — over ALL `autopilot_enabled` parents (event + 3s backstop UNGATED by
    // `has_work` + a boot sweep). Kill-gated by the persisted switch, no
    // auto-resume. Shares the SAME `board_events` bus + `TicketWriteRegistry` +
    // `AutopilotStateRepo` the commands use, so a driver-fired gate is one code
    // path with the buttons/CLI (invariant I5).
    orchestrator.spawn_autopilot_driver(
        BoardRepo::new(pool.clone()),
        RunCommandRepo::new(pool.clone()),
        handle
            .state::<Arc<tickets::TicketWriteRegistry>>()
            .inner()
            .clone(),
        board_events.clone(),
        AutopilotStateRepo::new(pool.clone()),
    );

    // The `phasr` CLI ↔ app IPC server (Story CLI1 / §R4), unix-only. One
    // listener on ~/.phasr/phasr.sock; each connection is its own task so a slow
    // `validate` never blocks a `comment`. A bind failure is NON-FATAL — the app
    // runs fine, agents just can't self-advance the board this session (D6). Built
    // BEFORE the `handle.manage` block below since it clones the same repos/pool.
    #[cfg(unix)]
    {
        let socket = orchestrator::ipc_server::socket_path();
        match orchestrator::ipc_server::bind(&socket) {
            Ok(listener) => {
                // Shares the SAME managed TicketWriteRegistry (registered in
                // `setup` before this runs) so CLI gate writes suppress the
                // watcher echo exactly like the command-driven writes.
                let ticket_write_registry = handle
                    .state::<Arc<tickets::TicketWriteRegistry>>()
                    .inner()
                    .clone();
                let cli_server = Arc::new(orchestrator::ipc_server::CliServer {
                    workspaces: workspace_repo.clone(),
                    board: BoardRepo::new(pool.clone()),
                    repositories: repository_repo.clone(),
                    run_commands: RunCommandRepo::new(pool.clone()),
                    write_registry: ticket_write_registry,
                    board_events: board_events.clone(),
                    tokens: cli_tokens.clone(),
                    scheduler_config: orchestrator::SchedulerConfig::default(),
                    validate_config: orchestrator::ValidateConfig::default(),
                });
                tauri::async_runtime::spawn(orchestrator::ipc_server::serve(listener, cli_server));
            }
            Err(err) => log::error!(
                "phasr: failed to bind CLI socket at {} ({err}); agents can't self-advance the board this session",
                socket.display()
            ),
        }
    }

    handle.manage(repository_repo);
    handle.manage(workspace_repo);
    handle.manage(BoardRepo::new(pool.clone()));
    handle.manage(RunCommandRepo::new(pool.clone()));
    handle.manage(SettingsRepo::new(pool.clone()));
    // Autopilot (Phase 5a, §5): the persisted kill-switch repo, managed so the
    // enable/kill-switch commands (and the future driver) can reach it.
    handle.manage(AutopilotStateRepo::new(pool.clone()));
    handle.manage(UserRepo::new(pool.clone()));
    handle.manage(pool);
    handle.manage(repo_locks);
    handle.manage(orchestrator);
    handle.manage(board_events);
    handle.manage(cli_tokens);

    Ok(())
}

/// Resolve the absolute path to the `phasr` agent CLI for `PHASR_BIN` (§J4/§R7).
/// The CLI ships as an externalBin sidecar named `phasr-cli` (#29): Tauri strips
/// the target-triple suffix at bundle time, so `binaries/phasr-cli-<triple>` lands
/// beside the main binary as `Phasr.app/Contents/MacOS/phasr-cli`; in dev /
/// `cargo tauri dev` it's built as `target/<profile>/phasr-cli`. Both reduce to
/// "look for `phasr-cli` next to `current_exe`".
///
/// We deliberately do NOT accept a bare `phasr` sibling: in dev the app binary IS
/// `target/<profile>/phasr` (the Cargo package name), so matching `phasr` would
/// resolve PHASR_BIN to the app itself and an agent's `"$PHASR_BIN" <verb>` would
/// relaunch the app instead of the CLI. (The sidecar can't be named `phasr`
/// anyway — tauri-build rejects a sidecar sharing the `phasr` package name.)
fn resolve_phasr_cli_bin() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Named unconditionally (even if not built yet in dev) so a later
            // `cargo build --bin phasr-cli` makes it resolvable without a restart.
            return dir.join("phasr-cli");
        }
    }
    std::path::PathBuf::from("phasr-cli")
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
                            // Honest status (E0-T4): mark the relaunch-orphan so
                            // it reads Wedged/"was interrupted", not a silent
                            // Stopped or a red Failed. A user `stop_task` leaves
                            // this None (see orchestrator::stop_task), which is
                            // what keeps a deliberate stop calm.
                            interrupted_at: Some(Some(now)),
                            ..Default::default()
                        },
                    )
                    .await
                {
                    log::warn!(
                        "failed to recover orphaned running workspace {}: {err}",
                        workspace.id
                    );
                }
            }
        }
        Err(err) => log::warn!("failed to list running workspaces during startup recovery: {err}"),
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
                    log::warn!(
                        "failed to prune git worktrees for repository {}: {err}",
                        repository.id
                    );
                }
            }
        }
        Err(err) => log::warn!("failed to list repositories during startup recovery: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace, WorkspaceKind};

    async fn fresh() -> (WorkspaceRepo, RepositoryRepo, Repository, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repositories = RepositoryRepo::new(pool);
        // No local_path → recovery's prune_worktrees pass skips it (no git needed).
        let repo = Repository::new("repo".into(), None, None);
        repositories.insert(&repo).await.unwrap();
        (workspaces, repositories, repo, dir)
    }

    // E0-T4: on relaunch, an orphaned `running` row (its in-process child died
    // with the old process) is swept to `stopped` AND stamped
    // `interrupted_at`, so the frontend can render an honest "was interrupted"
    // (Wedged) instead of a silent Stopped or a red Failed.
    #[tokio::test]
    async fn orphaned_running_becomes_stopped_with_interrupted() {
        let (workspaces, repositories, repo, _dir) = fresh().await;
        let mut ws = Workspace::new(repo.id.clone(), "running-at-boot".into(), "cmd".into());
        ws.status = WorkspaceStatus::Running;
        workspaces.insert(&ws).await.unwrap();

        recover_startup_state(&workspaces, &repositories).await;

        let recovered = workspaces.get(&ws.id).await.unwrap();
        assert_eq!(recovered.status, WorkspaceStatus::Stopped);
        assert!(
            recovered.interrupted_at.is_some(),
            "a relaunch-orphan must be marked interrupted, not silently stopped"
        );
        assert!(recovered.finished_at.is_some());
        assert_eq!(recovered.exit_code, None);
    }

    // #29: PHASR_BIN resolves to the `phasr-cli` sidecar sitting beside the
    // running executable — the bundled `Contents/MacOS/phasr-cli` in a packaged
    // app, `target/<profile>/phasr-cli` in dev. Both are a `phasr-cli` sibling of
    // `current_exe`.
    #[test]
    fn phasr_cli_resolves_next_to_the_current_exe() {
        let resolved = resolve_phasr_cli_bin();
        assert_eq!(
            resolved.file_name().and_then(|n| n.to_str()),
            Some("phasr-cli")
        );
        if let Ok(exe) = std::env::current_exe() {
            assert_eq!(resolved.parent(), exe.parent());
        }
    }

    // Regression (#29): the sidecar is `phasr-cli`, never a bare `phasr`. In dev
    // the app binary IS `target/<profile>/phasr` (the Cargo package name), so
    // resolving PHASR_BIN to a `phasr` sibling would point an agent at the app
    // itself — `"$PHASR_BIN" <verb>` would relaunch Phasr instead of the CLI.
    #[test]
    fn phasr_cli_is_never_the_bare_app_binary() {
        let resolved = resolve_phasr_cli_bin();
        assert_ne!(resolved.file_name().and_then(|n| n.to_str()), Some("phasr"));
    }

    // Recovery only touches `running` rows; a row already terminal at boot is
    // left exactly as-is, so its `interrupted_at` stays NULL.
    #[tokio::test]
    async fn recovery_leaves_non_running_rows_untouched() {
        let (workspaces, repositories, repo, _dir) = fresh().await;
        let mut done = Workspace::new(repo.id.clone(), "already-done".into(), "cmd".into());
        done.status = WorkspaceStatus::Completed;
        workspaces.insert(&done).await.unwrap();

        recover_startup_state(&workspaces, &repositories).await;

        let after = workspaces.get(&done.id).await.unwrap();
        assert_eq!(after.status, WorkspaceStatus::Completed);
        assert_eq!(after.interrupted_at, None);
    }

    // E2-T3: recovery handles decomposition (parent/subtask) rows sensibly on
    // relaunch. A `parent` (no PTY, never Running) is NEVER force-stopped — it
    // stays Pending and calm. A `subtask` that was Running is a real orphaned
    // agent, so it is swept to Stopped + interrupted (→ Wedged), exactly like a
    // standalone agent. A blocked/pending subtask stays Pending so the scheduler
    // can resume it. Recovery is kind-agnostic (it sweeps `running` rows and
    // prunes worktrees) and needs no board-specific code — the DAG is re-derived
    // from the DB by the scheduler's first post-boot tick (spec E2-T3, claim #9).
    #[tokio::test]
    async fn recovery_handles_decomposition_rows() {
        let (workspaces, repositories, repo, _dir) = fresh().await;

        // A parent (Pending, kind=Parent) — has no PTY, never Running.
        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert(&parent).await.unwrap();

        // A backend subtask mid-run (Running) when the app died.
        let mut backend = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        backend.workspace_kind = WorkspaceKind::Subtask;
        backend.parent_id = Some(parent.id.clone());
        backend.role = Some("backend".into());
        backend.status = WorkspaceStatus::Running;
        workspaces.insert(&backend).await.unwrap();

        // A blocked frontend subtask still Pending (never spawned).
        let mut frontend = Workspace::new(repo.id.clone(), "frontend".into(), "cmd".into());
        frontend.workspace_kind = WorkspaceKind::Subtask;
        frontend.parent_id = Some(parent.id.clone());
        frontend.role = Some("frontend".into());
        workspaces.insert(&frontend).await.unwrap();

        recover_startup_state(&workspaces, &repositories).await;

        // Parent: untouched — still Pending, never force-stopped, calm.
        let parent_after = workspaces.get(&parent.id).await.unwrap();
        assert_eq!(
            parent_after.status,
            WorkspaceStatus::Pending,
            "a parent must never be force-stopped on relaunch"
        );
        assert_eq!(parent_after.interrupted_at, None);

        // Backend: swept to Stopped + interrupted (honest Wedged), like an agent.
        let backend_after = workspaces.get(&backend.id).await.unwrap();
        assert_eq!(backend_after.status, WorkspaceStatus::Stopped);
        assert!(
            backend_after.interrupted_at.is_some(),
            "a running subtask orphaned by relaunch must read Wedged, not silently Stopped"
        );

        // Frontend: still Pending, resumable by the scheduler's first tick.
        let frontend_after = workspaces.get(&frontend.id).await.unwrap();
        assert_eq!(frontend_after.status, WorkspaceStatus::Pending);
        assert_eq!(frontend_after.interrupted_at, None);
    }
}
