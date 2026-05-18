//! SQLite-backed storage. Owns all SQL; everything outside this module
//! talks via the repository structs (`WorkspaceRepo`, `TaskRepo`, ...).

mod error;
mod pool;
mod presets;
mod settings;
mod tasks;
mod workspaces;

pub use error::StoreError;
pub use pool::{default_db_path, init_pool, Db};
pub use presets::PresetRepo;
pub use settings::SettingsRepo;
pub use tasks::{TaskRepo, TaskUpdate};
pub use workspaces::{WorkspaceRepo, WorkspaceUpdate};
