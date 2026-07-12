//! Task orchestrator — the glue between
//! `(agent preset + user prompt) → git worktree → PTY spawn → status
//! transitions`.
//!
//! Public surface kept narrow: `TaskOrchestrator` plus the typed
//! errors and a handful of value types. Tauri command handlers live
//! in `crate::commands::orchestrator` and forward straight through.

mod error;
mod repo_locks;
mod service;
mod templating;

pub use error::OrchestratorError;
pub use repo_locks::RepoLockRegistry;
pub use service::{StartTaskRequest, StartedTask, TaskOrchestrator, TaskStatusEvent};
