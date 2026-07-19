//! Task orchestrator — the glue between
//! `(agent preset + user prompt) → git worktree → PTY spawn → status
//! transitions`.
//!
//! Public surface kept narrow: `TaskOrchestrator` plus the typed
//! errors and a handful of value types. Tauri command handlers live
//! in `crate::commands::orchestrator` and forward straight through.

mod error;
mod liveness;
mod planner;
mod repo_locks;
mod scheduler;
mod service;
mod templating;

pub use error::OrchestratorError;
// The planner is a captured, read-only `claude` one-shot that drafts a
// decomposition (goal → validated `{subtasks, edges}`); `commands::planner`
// wraps it. It persists nothing — the draft lives in the frontend until the
// `start_decomposition` gate.
pub use planner::{plan, PlannerConfig, PlannerError};
pub use repo_locks::RepoLockRegistry;
// The scheduler owns the single source of truth for a decomposition's contract
// paths (`<root>/<parent>/contracts/<role>.md`). `commands::board::publish_contract`
// (the manual "mark done" override) MUST write to the exact path the scheduler
// polls, so it shares this config rather than duplicating the path logic (drift
// here would silently break the file→DB handoff).
pub use scheduler::{contract_file_is_ready, SchedulerConfig};
pub use service::{StartTaskRequest, StartedTask, TaskOrchestrator, TaskStatusEvent};
