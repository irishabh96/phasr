use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::auth::{AuthError, SessionState};
use crate::domain::{Agent, Workspace, WorkspaceKind, WorkspaceStatus};
use crate::fswatch::WorktreeWatchRegistry;
use crate::git;
use crate::orchestrator::{BoardEventBus, CliTokenRegistry, RepoLockRegistry};
use crate::pty::TaskRuntime;
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo, WorkspaceUpdate};
use crate::sync::CloudSyncState;

/// Kill the PTY, stop the watcher, and tear down ONE workspace row's git
/// artifacts: the worktree always; the branch only when `delete_branch`
/// (Delete removes refs; Archive preserves them — REFS, not worktrees, are
/// what protect work). Holds the per-repo lock across the git mutations (F6).
/// `runtime`/`watchers` ride as Options so the `_inner` flows stay testable
/// without a Tauri AppHandle.
async fn teardown_workspace_git(
    runtime: Option<&TaskRuntime>,
    watchers: Option<&WorktreeWatchRegistry>,
    repositories: &RepositoryRepo,
    repo_locks: &RepoLockRegistry,
    workspace: &Workspace,
    delete_branch: bool,
) {
    if let Some(watchers) = watchers {
        watchers.stop(&workspace.id);
    }
    if let Some(runtime) = runtime {
        if let Some(handle) = runtime.get(&workspace.id) {
            let _ = handle.kill();
            runtime.drop_task(&workspace.id);
        }
    }
    // A `local` row owns no git artifacts (it IS the user's checkout).
    if workspace.workspace_kind.is_local() {
        return;
    }
    if let Ok(repository) = repositories.get(&workspace.repository_id).await {
        if let Some(repo_path) = repository.local_path.as_deref() {
            let repo_path = PathBuf::from(repo_path);
            let lock = repo_locks.for_repository(&workspace.repository_id);
            let _guard = lock.lock().await;
            if let Some(worktree_path) = workspace.worktree_path.as_deref() {
                let _ = git::remove_worktree(&repo_path, &PathBuf::from(worktree_path));
            }
            if delete_branch {
                if let Some(branch) = workspace.branch.as_deref() {
                    let _ = git::branch_delete(&repo_path, branch);
                }
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub repository_id: String,
    pub name: String,
    pub prompt: Option<String>,
    pub agent: Option<Agent>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub agent: Option<Agent>,
    pub command: Option<String>,
    pub status: Option<WorkspaceStatus>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
}

#[derive(Debug)]
pub enum WorkspaceCmdError {
    Store(StoreError),
    Git(git::GitError),
    Auth(AuthError),
}

impl From<StoreError> for WorkspaceCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<git::GitError> for WorkspaceCmdError {
    fn from(e: git::GitError) -> Self {
        Self::Git(e)
    }
}

impl From<AuthError> for WorkspaceCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for WorkspaceCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for WorkspaceCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Start watching the active workspace's worktree for fs changes.
/// The frontend calls this when a user opens the workspace view and
/// pairs it with `unwatch_workspace` on unmount, so we only ever
/// hold one OS-level watcher at a time.
#[tauri::command]
pub async fn watch_workspace(
    id: String,
    workspaces: State<'_, WorkspaceRepo>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), WorkspaceCmdError> {
    session.require()?;
    let workspace = workspaces.get(&id).await?;
    if let Some(path) = workspace.worktree_path {
        watchers.start(id, PathBuf::from(path));
    }
    Ok(())
}

#[tauri::command]
pub fn unwatch_workspace(
    id: String,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), WorkspaceCmdError> {
    session.require()?;
    watchers.stop(&id);
    Ok(())
}

#[tauri::command]
pub async fn create_workspace(
    input: CreateWorkspaceInput,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    let current_session = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let repository = repositories.get(&input.repository_id).await?;

    // The launch command is derived from the selected agent (defaulting
    // to Claude); agents are a fixed enum with hardcoded commands.
    let agent = input.agent.unwrap_or_else(Agent::default);
    let mut workspace =
        Workspace::new(input.repository_id.clone(), input.name, agent.command().to_string());
    workspace.prompt = input.prompt;
    workspace.agent = Some(agent);

    if let Some(repo_path_str) = repository.local_path.as_deref() {
        let repo_path = PathBuf::from(repo_path_str);
        if repo_path.exists() && repo_path.join(".git").exists() {
            let branch = format!("phasr/{}", git::short_id(&workspace.id));
            let worktree_path = git::default_worktree_base_path().join(&workspace.id);
            // F6: `git worktree add` writes `.git/worktrees/` and refs in the
            // SHARED repo; serialize against every other worktree-add,
            // merge-to-main, and branch-delete on this repo via the shared
            // per-repo lock so a concurrent create/start/delete can't corrupt
            // `index.lock`/refs.
            let lock = repo_locks.for_repository(&input.repository_id);
            let _guard = lock.lock().await;
            git::create_worktree(
                &repo_path,
                &worktree_path,
                &branch,
                &repository.default_branch,
            )?;
            workspace.branch = Some(branch);
            workspace.worktree_path = Some(worktree_path.to_string_lossy().into_owned());
        }
    }

    workspaces
        .insert_for_user(&workspace, &current_session.user_id)
        .await?;
    sync_state.request_sync();
    Ok(workspace)
}

#[tauri::command]
pub async fn list_workspaces(
    repository_id: String,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Workspace>, WorkspaceCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(repo
        .list_by_repository_for_user(&repository_id, &current.user_id)
        .await?)
}

#[tauri::command]
pub async fn get_workspace(
    id: String,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(repo.get_for_user(&id, &current.user_id).await?)
}

#[tauri::command]
pub async fn update_workspace(
    id: String,
    input: UpdateWorkspaceInput,
    repo: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    session.require()?;
    let patch = WorkspaceUpdate {
        name: input.name,
        prompt: input.prompt.map(Some),
        agent: input.agent.map(Some),
        // Switching agent updates the stored command to match, unless the
        // caller explicitly provided one.
        command: input
            .command
            .or_else(|| input.agent.map(|a| a.command().to_string())),
        status: input.status,
        branch: input.branch.map(Some),
        worktree_path: input.worktree_path.map(Some),
        exit_code: input.exit_code.map(Some),
        ..Default::default()
    };
    let workspace = repo.update(&id, patch).await?;
    sync_state.request_sync();
    Ok(workspace)
}

#[tauri::command]
pub async fn archive_workspace(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<crate::domain::Workspace, WorkspaceCmdError> {
    session.require()?;
    // Stop the PTY if it's running so the status flip doesn't race
    // against a still-alive shell.
    if let Some(runtime) = app.try_state::<Arc<TaskRuntime>>() {
        if let Some(handle) = runtime.get(&id) {
            let _ = handle.kill();
            runtime.drop_task(&id);
        }
    }
    // Archived workspaces no longer need the watcher (the UI won't
    // be showing live git_status for them).
    watchers.stop(&id);

    let now = chrono::Utc::now();
    let patch = WorkspaceUpdate {
        status: Some(WorkspaceStatus::Archived),
        archived_at: Some(Some(now)),
        ..Default::default()
    };
    let workspace = repo.update(&id, patch).await?;
    sync_state.request_sync();
    Ok(workspace)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPullRequestOutcome {
    pub url: String,
    pub provider: String,
    pub head_branch: String,
    pub base_branch: String,
}

/// Pushes the workspace's branch to `origin`, then builds the
/// provider-specific "create PR/MR" URL. The frontend opens the URL
/// in the user's default browser via tauri-plugin-opener.
#[tauri::command]
pub async fn open_pull_request(
    id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<OpenPullRequestOutcome, WorkspaceCmdError> {
    session.require()?;
    let workspace = workspaces.get(&id).await?;
    let branch = workspace.branch.clone().ok_or_else(|| {
        WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(
            "workspace has no branch yet".into(),
        ))
    })?;

    let repository = repositories.get(&workspace.repository_id).await?;
    let remote_url = repository.remote_url.clone().ok_or_else(|| {
        WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(
            "repository has no `origin` remote configured".into(),
        ))
    })?;

    // Push from the worktree (where the branch is checked out). Setting
    // upstream so the user can `git push` afterwards without flags.
    let cwd = workspace
        .worktree_path
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(repository.local_path.clone().unwrap_or_default())
        });
    crate::git::push(&cwd, "origin", &branch)?;

    let base_branch = crate::git::resolve_base_branch(
        repository.local_path.as_deref(),
        &repository.default_branch,
    );

    let target = crate::git::build_pull_request_target(&remote_url, &base_branch, &branch)
        .ok_or_else(|| {
            WorkspaceCmdError::Git(crate::git::GitError::CommandFailed(format!(
                "couldn't derive a pull-request URL from remote `{remote_url}`"
            )))
        })?;
    Ok(OpenPullRequestOutcome {
        url: target.url,
        provider: target.provider.into(),
        head_branch: branch,
        base_branch,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeleteCheck {
    pub has_unpushed_commits: bool,
}

/// Pre-flight check so the UI can show a stronger confirmation when
/// the workspace has unmerged work. The actual delete still happens
/// via `delete_workspace`.
#[tauri::command]
pub async fn check_workspace_delete(
    id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WorkspaceDeleteCheck, WorkspaceCmdError> {
    session.require()?;
    let workspace = workspaces.get(&id).await?;
    if workspace.workspace_kind.is_local() {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    }
    let Some(branch) = workspace.branch.as_deref() else {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    };
    let repository = repositories.get(&workspace.repository_id).await?;
    let Some(repo_path) = repository.local_path.as_deref() else {
        return Ok(WorkspaceDeleteCheck {
            has_unpushed_commits: false,
        });
    };
    let has =
        crate::git::has_unpushed_commits(std::path::Path::new(repo_path), branch).unwrap_or(false);
    Ok(WorkspaceDeleteCheck {
        has_unpushed_commits: has,
    })
}

#[tauri::command]
pub async fn delete_workspace(
    id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    cli_tokens: State<'_, Arc<CliTokenRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<(), WorkspaceCmdError> {
    session.require()?;
    let runtime = app.try_state::<Arc<TaskRuntime>>();
    delete_workspace_inner(
        &id,
        runtime.as_deref().map(Arc::as_ref),
        Some(watchers.inner().as_ref()),
        &repo,
        &repositories,
        &repo_locks,
        &cli_tokens,
    )
    .await?;
    sync_state.request_sync();
    Ok(())
}

/// Delete core, split for testability (no AppHandle). A `parent` CASCADES:
/// every child subtask's PTY/worktree/branch/row/token goes first — before
/// this, deleting a workflow left N orphaned children whose `parent_id`
/// dangled, unreachable by any UI, their worktrees leaking forever.
pub(crate) async fn delete_workspace_inner(
    id: &str,
    runtime: Option<&TaskRuntime>,
    watchers: Option<&WorktreeWatchRegistry>,
    repo: &WorkspaceRepo,
    repositories: &RepositoryRepo,
    repo_locks: &RepoLockRegistry,
    cli_tokens: &CliTokenRegistry,
) -> Result<(), WorkspaceCmdError> {
    let workspace = repo.get(id).await.ok();

    if let Some(workspace) = workspace.as_ref() {
        if workspace.workspace_kind == WorkspaceKind::Parent {
            if let Ok(children) = repo.list_by_parent(id).await {
                for child in &children {
                    teardown_workspace_git(
                        runtime,
                        watchers,
                        repositories,
                        repo_locks,
                        child,
                        true,
                    )
                    .await;
                    cli_tokens.invalidate_subtask(&child.id);
                    let _ = repo.delete(&child.id).await;
                }
            }
        }
        teardown_workspace_git(runtime, watchers, repositories, repo_locks, workspace, true)
            .await;
        cli_tokens.invalidate_subtask(id);
    } else if let Some(watchers) = watchers {
        // Row already gone — still drop any stale watcher keyed on the id.
        watchers.stop(id);
    }

    repo.delete(id).await?;
    Ok(())
}

/// Archive a whole workflow: every child ticket + the parent, worktrees
/// removed, BRANCHES KEPT (refs preserve the work; removing refs is Delete's
/// job), CLI grants invalidated, rows stamped `archived`. The sidebar and
/// worklist retire archived rows, and the boot GC never has to guess about
/// them again. Owner-scoped.
#[tauri::command]
pub async fn archive_epic(
    parent_id: String,
    app: tauri::AppHandle,
    repo: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    cli_tokens: State<'_, Arc<CliTokenRegistry>>,
    board_events: State<'_, Arc<BoardEventBus>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<Workspace, WorkspaceCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let runtime = app.try_state::<Arc<TaskRuntime>>();
    let archived = archive_epic_inner(
        &parent_id,
        &current.user_id,
        runtime.as_deref().map(Arc::as_ref),
        Some(watchers.inner().as_ref()),
        &repo,
        &repositories,
        &repo_locks,
        &cli_tokens,
    )
    .await?;
    board_events.notify(&parent_id);
    sync_state.request_sync();
    Ok(archived)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn archive_epic_inner(
    parent_id: &str,
    user_id: &str,
    runtime: Option<&TaskRuntime>,
    watchers: Option<&WorktreeWatchRegistry>,
    repo: &WorkspaceRepo,
    repositories: &RepositoryRepo,
    repo_locks: &RepoLockRegistry,
    cli_tokens: &CliTokenRegistry,
) -> Result<Workspace, WorkspaceCmdError> {
    let parent = repo.get_for_user(parent_id, user_id).await?;
    if parent.workspace_kind != WorkspaceKind::Parent {
        return Err(WorkspaceCmdError::Git(git::GitError::CommandFailed(
            "only a workflow (parent) can be archived".into(),
        )));
    }

    let now = chrono::Utc::now();
    let archive_patch = || WorkspaceUpdate {
        status: Some(WorkspaceStatus::Archived),
        archived_at: Some(Some(now)),
        // The worktree is gone — the row must not point at a dead path (the
        // relaunch self-heal only recreates worktrees for RUNNING rows, and
        // the GC keys off truthful rows).
        worktree_path: Some(None),
        ..Default::default()
    };

    let children = repo.list_by_parent_for_user(parent_id, user_id).await?;
    for child in &children {
        teardown_workspace_git(runtime, watchers, repositories, repo_locks, child, false).await;
        cli_tokens.invalidate_subtask(&child.id);
        // Archived is legal from every status (the PTY was killed above); an
        // already-archived child is a no-op re-stamp.
        repo.update(&child.id, archive_patch()).await?;
    }

    // The parent's integration worktree goes too; its integration BRANCH
    // stays (it may be shipped, or the user may still want the ref).
    teardown_workspace_git(runtime, watchers, repositories, repo_locks, &parent, false).await;
    Ok(repo.update(parent_id, archive_patch()).await?)
}
