//! SQLite-backed storage. Owns all SQL; everything outside this module
//! talks via the repository structs.

mod error;
mod notes;
mod pool;
mod repositories;
mod run_commands;
mod settings;
mod users;
mod workspaces;

pub use error::StoreError;
pub use notes::{NoteRepo, NoteUpdate};
pub use pool::{default_db_path, init_pool, Db};
pub use repositories::{RepositoryRepo, RepositoryUpdate};
pub use run_commands::{RunCommandRepo, RunCommandUpdate};
pub use settings::SettingsRepo;
pub use users::UserRepo;
pub use workspaces::{WorkspaceRepo, WorkspaceUpdate};
