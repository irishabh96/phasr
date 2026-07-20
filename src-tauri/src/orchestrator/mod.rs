//! Task orchestrator — the glue between
//! `(agent preset + user prompt) → git worktree → PTY spawn → status
//! transitions`.
//!
//! Public surface kept narrow: `TaskOrchestrator` plus the typed
//! errors and a handful of value types. Tauri command handlers live
//! in `crate::commands::orchestrator` and forward straight through.

mod board_events;
mod cli_tokens;
mod error;
pub mod ipc_server;
mod liveness;
mod personas;
mod planner;
mod repo_locks;
mod scheduler;
mod service;
mod templating;
mod validate;

// The board-refresh seam (architect §R1/§R2): a Tauri-agnostic broadcast a board
// mutation calls `notify(parent_id)` on; the command layer bridges it to
// `phasr://board-changed`. Shared so the future CLI IPC server emits through the
// same channel. `BoardChangedEvent` is re-exported so `BoardEventBus::subscribe`'s
// return type stays publicly nameable (not yet named internally).
#[allow(unused_imports)]
pub use board_events::{BoardChangedEvent, BoardEventBus};
// The `phasr` CLI token registry (§R5): the scheduler mints per-subtask tokens
// into it, the IPC server resolves them. `CliSpawnConfig` carries the two runtime
// paths (`PHASR_BIN`/`PHASR_SOCK`) injected at spawn. `CliGrant` is re-exported so
// `CliTokenRegistry::resolve`'s return type stays publicly nameable.
#[allow(unused_imports)]
pub use cli_tokens::{CliGrant, CliSpawnConfig, CliTokenRegistry};
pub use error::OrchestratorError;
// Role personas (Phase 4): the fuzzy `role -> persona` matcher that seeds a
// subtask's spawn prompt, plus the canonical role table the planner presents.
// Re-exported so the seam is discoverable alongside the other orchestrator
// surface; `service`/`planner` reach it directly via `super::personas`.
#[allow(unused_imports)]
pub use personas::{persona_for_role, CANONICAL_ROLES};
// The captured, per-worktree Validate runner (V1) + its DTOs. Reused by
// `commands::validate`; the DTOs round-trip through `validate.json`. `ValidateCheck`
// is re-exported so `ValidateResult.checks`'s element type stays publicly nameable.
#[allow(unused_imports)]
pub use validate::{run_validate, ValidateCheck, ValidateConfig, ValidateResult};
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
