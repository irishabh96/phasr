//! Domain entities. Pure data and invariants — no I/O, no SQL, no Tauri.
//!
//! Naming model (Phase 7):
//!   - `Repository` — a connection to one local git repository.
//!   - `Workspace`  — one agent run inside a repository, with its own
//!     git worktree, branch, and PTY session.
//!   - `Agent`      — an AI tool/CLI that can be run as a workspace's
//!     command (Claude, Codex, Copilot, …).
//!   - `Note`       — a repository-scoped note with an origin snapshot;
//!     outlives every workspace/terminal of its repository.
//!   - `UserSettings` — per-user app settings.
//!   - `TaskUsage`  — token/cost totals read from an agent's transcript.
//!   - `Lane`       — a task's Board column, derived (`board::derive_lane`).
//!   - `CheckRun` / `ReviewComment` — review of a task's diff (M8).
//!   - `AppNotification` — an inbox entry; `NotificationPrefs` its delivery.
//!   - `RepositoryConfig` — per-repository rules (local to this machine).

pub mod agent;
pub mod board;
pub mod note;
pub mod notification;
pub mod repository;
pub mod repository_config;
pub mod review;
pub mod run_command;
pub mod settings;
pub mod usage;
pub mod user;
pub mod workspace;

pub use agent::{Agent, PermissionMode};
pub use note::{Note, NoteOriginKind};
pub use repository::Repository;
pub use repository_config::{CleanupAfterMerge, PrMode, PushPolicy, RepositoryConfig};
pub use notification::{AppNotification, NotificationKind, NotificationPrefs};
pub use review::{CheckRun, CheckStatus, CheckSummary, CommentSide, CommentStatus, ReviewComment};
pub use run_command::{RunCommand, RunWhen};
pub use settings::{agent_commands_from_json, agent_commands_to_json, UserSettings};
pub use user::User;
pub use workspace::{AgentView, TaskOutcome, Workspace, WorkspaceKind, WorkspaceStatus};
