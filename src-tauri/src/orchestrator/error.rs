//! Typed errors surfaced by the task orchestrator. Designed so the
//! Tauri command layer can `?` straight through without remapping.

use thiserror::Error;

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
}

impl serde::Serialize for OrchestratorError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
