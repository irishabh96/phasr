use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use super::error::StoreError;

pub type Db = SqlitePool;

/// Open (or create) the SQLite database at `db_path`, run migrations, and
/// return a connection pool ready for use by repositories.
pub async fn init_pool(db_path: &Path) -> Result<Db, StoreError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

/// Default DB location under the user's app data directory.
pub fn default_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("phasr.sqlite")
}
