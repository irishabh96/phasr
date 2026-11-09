//! Typed errors surfaced by the task orchestrator. Designed so the
//! Tauri command layer can `?` straight through without remapping.

use thiserror::Error;

use crate::agent_signals::AgentSignalError;
use crate::auth::AuthError;
use crate::git::GitError;
use crate::pty::handle::PtyError;
use crate::store::StoreError;

#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Pty(#[from] PtyError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Signals(#[from] AgentSignalError),

    #[error("repository has no local path on this machine; pick or clone one first")]
    RepositoryHasNoLocalPath,
    #[error("repository path `{0}` does not exist on disk")]
    RepositoryPathMissing(String),
    #[error("repository path `{0}` is not a git checkout")]
    RepositoryNotAGitRepo(String),
    #[error("no running task for task id `{0}`")]
    TaskNotRunning(String),
    #[error("task is already finished (status: {0}); create a new one to retry")]
    AlreadyFinished(String),
    #[error(
        "this workspace's worktree isn't available on this machine \
         (no branch or local repository to recreate it from)"
    )]
    WorktreeUnavailable,
    #[error("{agent} can't run in the `{mode}` permission mode; choose another mode")]
    UnsupportedPermissionMode {
        agent: &'static str,
        mode: &'static str,
    },
    /// Draft-only edits on a task that has already started.
    #[error("this task has already started")]
    AlreadyLaunched,
    #[error("this task hasn't started yet; start it first")]
    NotStarted,
    /// Missing, another account's, itself, or a cycle.
    #[error("can't wait on task `{0}`: it doesn't exist or would wait on itself")]
    InvalidDependency(String),
    /// One in-place task per repository: they'd share one checkout.
    #[error("an in-place task is already running in this repository")]
    InPlaceTaskRunning,
    /// A base branch git would parse as an option (or that can't be one).
    #[error("{0}")]
    InvalidBaseBranch(String),
}

impl serde::Serialize for OrchestratorError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
