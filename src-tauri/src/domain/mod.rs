//! Domain entities. Pure data and invariants — no I/O, no SQL, no Tauri.
//!
//! Naming model (Phase 7):
//!   - `Repository` — a connection to one local git repository.
//!   - `Workspace`  — one agent run inside a repository, with its own
//!     git worktree, branch, and PTY session.
//!   - `Preset`     — a saved agent command template.
//!   - `UserSettings` — per-user app settings.

pub mod preset;
pub mod repository;
pub mod settings;
pub mod workspace;

pub use preset::Preset;
pub use repository::Repository;
pub use settings::UserSettings;
pub use workspace::{Workspace, WorkspaceStatus};
