//! SQLite-backed storage. Owns all SQL; everything outside this module
//! talks via the repository structs.

mod autopilot;
mod board;
mod error;
mod pool;
mod repositories;
mod run_commands;
mod settings;
mod users;
mod workspaces;

pub use autopilot::AutopilotStateRepo;
pub use board::{Board, BoardRepo};
pub use error::StoreError;
pub use pool::{default_db_path, init_pool, Db};
pub use repositories::{RepositoryRepo, RepositoryUpdate};
pub use run_commands::{RunCommandRepo, RunCommandUpdate};
pub use settings::SettingsRepo;
pub use users::UserRepo;
pub use workspaces::{WorkspaceRepo, WorkspaceUpdate};
