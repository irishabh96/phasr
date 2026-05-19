//! SQLite-backed storage. Owns all SQL; everything outside this module
//! talks via the repository structs.

mod error;
mod pool;
mod presets;
mod repositories;
mod settings;
mod workspaces;

pub use error::StoreError;
pub use pool::{default_db_path, init_pool, Db};
pub use presets::PresetRepo;
pub use repositories::{RepositoryRepo, RepositoryUpdate};
pub use settings::SettingsRepo;
pub use workspaces::{WorkspaceRepo, WorkspaceUpdate};
