//! Settings → REPOSITORY · name: Worktrees and Branch rules.
//!
//! Per-repository rules (local to this machine, never synced) and the
//! worktree list with sizes and removal. Ownership first everywhere: the
//! repository must be the signed-in user's before its config or disk is
//! touched.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::checks::CheckService;
use crate::domain::repository_config::normalize_glob;
use crate::domain::{CleanupAfterMerge, PrMode, PushPolicy, Repository, RepositoryConfig};
use crate::fswatch::WorktreeWatchRegistry;
use crate::git::{self, GitError};
use crate::orchestrator::worktrees::{self, RepositoryWorktree, WorktreeRemoveError, WorktreeSize};
use crate::orchestrator::{RepoLockRegistry, TaskBoard, TaskSetup};
use crate::pty::TaskRuntime;
use crate::run_commands::RunCommandRuntime;
use crate::store::{RepositoryConfigRepo, RepositoryRepo, SettingsRepo, StoreError, WorkspaceRepo};

use super::board::present;
use super::require_user;

#[derive(Debug)]
pub enum RepositoryConfigCmdError {
    Store(StoreError),
    Auth(AuthError),
    Git(GitError),
    Remove(WorktreeRemoveError),
    Invalid(String),
    NoLocalPath,
}

impl From<StoreError> for RepositoryConfigCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for RepositoryConfigCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<GitError> for RepositoryConfigCmdError {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}

impl From<WorktreeRemoveError> for RepositoryConfigCmdError {
    fn from(e: WorktreeRemoveError) -> Self {
        Self::Remove(e)
    }
}

impl std::fmt::Display for RepositoryConfigCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Remove(e) => write!(f, "{e}"),
            Self::Invalid(msg) => write!(f, "{msg}"),
            Self::NoLocalPath => write!(f, "repository has no local path on this machine"),
        }
    }
}

impl serde::Serialize for RepositoryConfigCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Edits to a repository's rules. Absent = unchanged; for the text fields
/// an explicit `null` (or a blank string) clears back to the default.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRepositoryConfigInput {
    #[serde(default, deserialize_with = "present")]
    pub default_base_branch: Option<Option<String>>,
    #[serde(default)]
    pub fetch_base_before_task: Option<bool>,
    #[serde(default)]
    pub agents_may_push: Option<PushPolicy>,
    #[serde(default)]
    pub pr_mode: Option<PrMode>,
    #[serde(default)]
    pub protected_paths: Option<Vec<String>>,
    #[serde(default)]
    pub copy_untracked_globs: Option<Vec<String>>,
    #[serde(default)]
    pub cleanup_after_merge: Option<CleanupAfterMerge>,
    /// "After creating" hook.
    #[serde(default, deserialize_with = "present")]
    pub pre_task_hook: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub branch_prefix_template: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub worktree_base_path: Option<Option<String>>,
}

fn clean_text(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn clean_globs(globs: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for glob in globs {
        if let Some(g) = normalize_glob(&glob)? {
            if !out.contains(&g) {
                out.push(g);
            }
        }
    }
    Ok(out)
}

/// Apply `input` over `config`, validating as it goes. Pure.
pub fn apply_update(
    mut config: RepositoryConfig,
    input: UpdateRepositoryConfigInput,
) -> Result<RepositoryConfig, String> {
    if let Some(v) = input.default_base_branch {
        config.default_base_branch = clean_text(v);
        if let Some(b) = &config.default_base_branch {
            if b.contains(char::is_whitespace) || b.starts_with('-') {
                return Err(format!("`{b}` isn't a branch name"));
            }
        }
    }
    if let Some(v) = input.fetch_base_before_task {
        config.fetch_base_before_task = v;
    }
    if let Some(v) = input.agents_may_push {
        config.agents_may_push = v;
    }
    if let Some(v) = input.pr_mode {
        config.pr_mode = v;
    }
    if let Some(v) = input.protected_paths {
        config.protected_paths = clean_globs(v)?;
    }
    if let Some(v) = input.copy_untracked_globs {
        config.copy_untracked_globs = clean_globs(v)?;
    }
    if let Some(v) = input.cleanup_after_merge {
        config.cleanup_after_merge = v;
    }
    if let Some(v) = input.pre_task_hook {
        config.pre_task_hook = clean_text(v);
    }
    if let Some(v) = input.branch_prefix_template {
        config.branch_prefix_template = clean_text(v);
    }
    if let Some(v) = input.worktree_base_path {
        let v = clean_text(v);
        if let Some(p) = &v {
            if !(p.starts_with('/') || p == "~" || p.starts_with("~/")) {
                return Err("the worktree location must be an absolute path or start with ~/".into());
            }
        }
        config.worktree_base_path = v;
    }
    Ok(config)
}

async fn owned_repository(
    repositories: &RepositoryRepo,
    repository_id: &str,
    user_id: &str,
) -> Result<Repository, RepositoryConfigCmdError> {
    Ok(repositories.get_for_user(repository_id, user_id).await?)
}

#[tauri::command]
pub async fn get_repository_config(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    configs: State<'_, RepositoryConfigRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RepositoryConfig, RepositoryConfigCmdError> {
    let current = require_user(&session)?;
    owned_repository(&repositories, &repository_id, &current.user_id).await?;
    Ok(configs.get(&repository_id).await?)
}

/// Local-only: no sync request (repository_config never leaves the machine).
#[tauri::command]
pub async fn update_repository_config(
    repository_id: String,
    input: UpdateRepositoryConfigInput,
    repositories: State<'_, RepositoryRepo>,
    configs: State<'_, RepositoryConfigRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<RepositoryConfig, RepositoryConfigCmdError> {
    let current = require_user(&session)?;
    owned_repository(&repositories, &repository_id, &current.user_id).await?;
    let stored = configs.get(&repository_id).await?;
    let updated = apply_update(stored, input).map_err(RepositoryConfigCmdError::Invalid)?;
    Ok(configs.upsert(&updated, Some(&current.user_id)).await?)
}

/// What the worktree commands share: the checkout, the phasr bases, git's
/// worktree list, and the user's tasks in this repository.
struct WorktreeContext {
    main: PathBuf,
    bases: Vec<PathBuf>,
    refs: Vec<git::WorktreeRef>,
    tasks: Vec<crate::domain::Workspace>,
}

async fn worktree_context(
    repository: &Repository,
    user_id: &str,
    configs: &RepositoryConfigRepo,
    settings: &SettingsRepo,
    workspaces: &WorkspaceRepo,
) -> Result<Option<WorktreeContext>, RepositoryConfigCmdError> {
    let Some(main) = repository.local_path.as_deref().map(PathBuf::from) else {
        return Ok(None);
    };
    if !main.join(".git").exists() {
        return Ok(None);
    }
    let setup = TaskSetup {
        config: configs.get(&repository.id).await?,
        settings: settings.get_or_default().await?,
    };
    let refs = {
        let main = main.clone();
        tokio::task::spawn_blocking(move || git::list_worktrees(&main))
            .await
            .map_err(|e| GitError::CommandFailed(e.to_string()))??
    };
    let tasks = workspaces
        .list_by_repository_for_user(&repository.id, user_id)
        .await?;
    Ok(Some(WorktreeContext {
        main,
        bases: setup.known_worktree_bases(),
        refs,
        tasks,
    }))
}

/// The repository's worktrees (main checkout excluded), each matched to
/// its task and Board lane; `orphaned` = phasr's but no task points at it.
#[tauri::command]
pub async fn list_repository_worktrees(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    configs: State<'_, RepositoryConfigRepo>,
    settings: State<'_, SettingsRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<RepositoryWorktree>, RepositoryConfigCmdError> {
    let current = require_user(&session)?;
    let repository = owned_repository(&repositories, &repository_id, &current.user_id).await?;
    let Some(ctx) = worktree_context(&repository, &current.user_id, &configs, &settings, &workspaces).await?
    else {
        return Ok(Vec::new());
    };
    let mut listed = worktrees::classify(&ctx.main, &ctx.bases, &ctx.refs, &ctx.tasks);
    for entry in &mut listed {
        if let Some(task) = entry
            .workspace_id
            .as_deref()
            .and_then(|id| ctx.tasks.iter().find(|t| t.id == id))
        {
            entry.lane = board.lane_of(task).await;
        }
    }
    Ok(listed)
}

/// Disk usage of each listed worktree (`du -sk`, 20s each, in parallel).
/// `bytes: null` = couldn't measure.
#[tauri::command]
pub async fn compute_worktree_sizes(
    repository_id: String,
    repositories: State<'_, RepositoryRepo>,
    configs: State<'_, RepositoryConfigRepo>,
    settings: State<'_, SettingsRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<WorktreeSize>, RepositoryConfigCmdError> {
    let current = require_user(&session)?;
    let repository = owned_repository(&repositories, &repository_id, &current.user_id).await?;
    let Some(ctx) = worktree_context(&repository, &current.user_id, &configs, &settings, &workspaces).await?
    else {
        return Ok(Vec::new());
    };
    let paths = worktrees::classify(&ctx.main, &ctx.bases, &ctx.refs, &ctx.tasks)
        .into_iter()
        .map(|w| w.path)
        .collect();
    Ok(worktrees::sizes(paths).await)
}

/// Remove worktrees (`git worktree remove --force`). All-or-nothing
/// validation first: only this repository's worktrees, inside a phasr
/// worktree folder, never the main checkout, never under a running agent.
/// Branches are kept, so a task whose worktree was removed is recreated
/// from its branch when reopened. Returns the removed paths.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remove_worktrees(
    repository_id: String,
    paths: Vec<String>,
    repositories: State<'_, RepositoryRepo>,
    configs: State<'_, RepositoryConfigRepo>,
    settings: State<'_, SettingsRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    runtime: State<'_, Arc<TaskRuntime>>,
    runs: State<'_, RunCommandRuntime>,
    checks: State<'_, CheckService>,
    watchers: State<'_, Arc<WorktreeWatchRegistry>>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<String>, RepositoryConfigCmdError> {
    let current = require_user(&session)?;
    let repository = owned_repository(&repositories, &repository_id, &current.user_id).await?;
    // Shared `.git`: the listing and the removals happen under the same
    // lock as every worktree add / merge / branch delete on this repo.
    let lock = repo_locks.for_repository(&repository_id);
    let _guard = lock.lock().await;
    let ctx = worktree_context(&repository, &current.user_id, &configs, &settings, &workspaces)
        .await?
        .ok_or(RepositoryConfigCmdError::NoLocalPath)?;
    let task_at = |path: &Path| {
        ctx.tasks.iter().find(|t| {
            t.worktree_path
                .as_deref()
                .and_then(|p| std::fs::canonicalize(p).ok())
                .is_some_and(|p| p == path)
        })
    };
    let runtime = runtime.inner().clone();
    let running = |path: &Path| task_at(path).is_some_and(|t| runtime.get(&t.id).is_some());
    let targets = worktrees::validate_removal(&paths, &ctx.main, &ctx.bases, &ctx.refs, &running)?;

    let mut removed = Vec::with_capacity(targets.len());
    for path in targets {
        if let Some(task) = task_at(&path) {
            // Processes that run IN the worktree go first.
            watchers.stop(&task.id);
            runs.stop_for_workspace(&task.id);
            checks
                .cancel_and_wait(&task.id, std::time::Duration::from_secs(5))
                .await;
            board.invalidate_diff(&task.id);
        }
        let main = ctx.main.clone();
        let target = path.clone();
        tokio::task::spawn_blocking(move || git::remove_worktree(&main, &target))
            .await
            .map_err(|e| GitError::CommandFailed(e.to_string()))??;
        removed.push(path.to_string_lossy().into_owned());
    }
    board.notify_changed(&repository_id);
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(json: serde_json::Value) -> UpdateRepositoryConfigInput {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn update_applies_only_present_fields_and_null_clears() {
        let mut base = RepositoryConfig::defaults("r");
        base.pre_task_hook = Some("pnpm i".into());
        base.branch_prefix_template = Some("rb/{{slug}}".into());

        let updated = apply_update(
            base.clone(),
            input(serde_json::json!({
                "prMode": "ready",
                "agentsMayPush": "deny",
                "cleanupAfterMerge": "always",
                "fetchBaseBeforeTask": true,
                "protectedPaths": [" ./migrations/** ", "", "migrations/**"],
                "copyUntrackedGlobs": [".env"],
                "preTaskHook": null,
                "defaultBaseBranch": " develop "
            })),
        )
        .unwrap();
        assert_eq!(updated.pr_mode, PrMode::Ready);
        assert_eq!(updated.agents_may_push, PushPolicy::Deny);
        assert_eq!(updated.cleanup_after_merge, CleanupAfterMerge::Always);
        assert!(updated.fetch_base_before_task);
        assert_eq!(updated.protected_paths, vec!["migrations/**".to_string()]);
        assert_eq!(updated.copy_untracked_globs, vec![".env".to_string()]);
        assert_eq!(updated.pre_task_hook, None, "null clears");
        assert_eq!(updated.default_base_branch.as_deref(), Some("develop"));
        assert_eq!(
            updated.branch_prefix_template.as_deref(),
            Some("rb/{{slug}}"),
            "absent = unchanged"
        );
        // A blank string clears too.
        let cleared = apply_update(updated, input(serde_json::json!({ "branchPrefixTemplate": "  " }))).unwrap();
        assert_eq!(cleared.branch_prefix_template, None);
    }

    #[test]
    fn update_rejects_unsafe_globs_paths_and_values() {
        let base = RepositoryConfig::defaults("r");
        assert!(apply_update(base.clone(), input(serde_json::json!({ "protectedPaths": ["../x"] }))).is_err());
        assert!(apply_update(base.clone(), input(serde_json::json!({ "copyUntrackedGlobs": ["/etc/*"] }))).is_err());
        assert!(apply_update(base.clone(), input(serde_json::json!({ "worktreeBasePath": "relative/wt" }))).is_err());
        assert!(apply_update(base.clone(), input(serde_json::json!({ "defaultBaseBranch": "has space" }))).is_err());
        let ok = apply_update(base.clone(), input(serde_json::json!({ "worktreeBasePath": "~/wt" }))).unwrap();
        assert_eq!(ok.worktree_base_path.as_deref(), Some("~/wt"));
        // Unknown enum values are a deserialization error, not a silent default.
        assert!(serde_json::from_value::<UpdateRepositoryConfigInput>(serde_json::json!({ "prMode": "yolo" })).is_err());
    }

    #[test]
    fn errors_serialize_as_plain_strings() {
        let err = RepositoryConfigCmdError::from(WorktreeRemoveError::MainCheckout);
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            "the repository's own checkout can't be removed"
        );
        assert_eq!(
            serde_json::to_value(RepositoryConfigCmdError::from(StoreError::NotFound)).unwrap(),
            "not found"
        );
    }
}
