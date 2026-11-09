//! Task orchestrator — the glue between
//! `(agent preset + user prompt) → git worktree → PTY spawn → status
//! transitions`.
//!
//! Public surface kept narrow: `TaskOrchestrator` plus the typed
//! errors and a handful of value types. Tauri command handlers live
//! in `crate::commands::orchestrator` and forward straight through.

pub mod board;
mod error;
pub mod launch;
pub mod queue;
mod repo_locks;
mod service;
pub mod setup;
pub mod worktrees;
mod templating;

pub use board::{TaskBoard, TaskCard};
pub use error::OrchestratorError;
pub use queue::QueueScheduler;
pub use launch::RunIn;
pub use repo_locks::RepoLockRegistry;
pub use setup::{TaskConfig, TaskSetup};
pub use service::{
    StartTaskRequest, StartedTask, TaskOrchestrator, TaskRow, TaskRowPatch, TaskStatusEvent,
};
