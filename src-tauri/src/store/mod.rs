//! SQLite-backed storage. Owns all SQL; everything outside this module
//! talks via the repository structs.

mod agents;
mod error;
mod pool;
mod repositories;
mod run_commands;
mod settings;
mod workspaces;

pub use agents::AgentRepo;
pub use error::StoreError;
pub use pool::{default_db_path, init_pool};
pub use repositories::{RepositoryRepo, RepositoryUpdate};
pub use run_commands::{RunCommandRepo, RunCommandUpdate};
pub use settings::SettingsRepo;
pub use workspaces::{WorkspaceRepo, WorkspaceUpdate};
