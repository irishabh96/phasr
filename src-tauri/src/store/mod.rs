//! SQLite-backed storage. Owns all SQL; everything outside this module
//! talks via the repository structs.

mod app_meta;
mod check_runs;
mod error;
mod notes;
mod notifications;
mod pool;
mod repositories;
mod repository_config;
mod review_comments;
mod run_commands;
mod settings;
mod task_usage;
mod users;
mod workspaces;

pub use app_meta::AppMetaRepo;
pub use check_runs::{CheckRunFinish, CheckRunRepo};
pub use error::StoreError;
pub use notes::{NoteRepo, NoteUpdate};
pub use notifications::NotificationRepo;
pub use pool::{
    backup_rotate, checkpoint, checkpoint_and_close, default_backups_dir, default_db_path,
    init_pool, Db,
};
pub use repositories::{RepositoryRepo, RepositoryUpdate};
pub use repository_config::RepositoryConfigRepo;
pub use review_comments::{ReviewCommentRepo, ReviewCommentUpdate};
pub use run_commands::{RunCommandRepo, RunCommandUpdate};
pub use settings::SettingsRepo;
pub use task_usage::TaskUsageRepo;
pub use users::UserRepo;
pub use workspaces::{LocalTaskClaim, WorkspaceRepo, WorkspaceUpdate};
