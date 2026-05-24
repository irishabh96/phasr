//! Domain entities. Pure data and invariants — no I/O, no SQL, no Tauri.
//!
//! Naming model (Phase 7):
//!   - `Repository` — a connection to one local git repository.
//!   - `Workspace`  — one agent run inside a repository, with its own
//!     git worktree, branch, and PTY session.
//!   - `Agent`      — an AI tool/CLI that can be run as a workspace's
//!     command (Claude, Codex, Copilot, …).
//!   - `UserSettings` — per-user app settings.

pub mod agent;
pub mod repository;
pub mod run_command;
pub mod settings;
pub mod user;
pub mod workspace;

pub use agent::Agent;
pub use repository::Repository;
pub use run_command::RunCommand;
pub use settings::UserSettings;
pub use user::User;
pub use workspace::{Workspace, WorkspaceKind, WorkspaceStatus};
