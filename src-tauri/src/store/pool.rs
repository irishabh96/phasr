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

/// Merge the WAL into the main database file and truncate the sidecar.
///
/// Without this the main .sqlite file can stay a bare 4KB header page
/// forever — every row AND the schema stranded in `-wal` — where any
/// backup, copy, or cleanup that only preserves the .sqlite file loses
/// everything. Run at startup (heals whatever the previous process left
/// behind) and at exit (see `checkpoint_and_close`).
pub async fn checkpoint(pool: &Db) -> Result<(), StoreError> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
        .execute(pool)
        .await?;
    Ok(())
}

/// Exit-time teardown: fold the WAL into the main file, then close the
/// pool so SQLite tears down cleanly. Best-effort — the process is dying
/// either way, so a failed checkpoint only logs.
pub async fn checkpoint_and_close(pool: &Db) {
    if let Err(err) = checkpoint(pool).await {
        eprintln!("wal checkpoint on exit failed: {err}");
    }
    pool.close().await;
}

/// Default DB location under the user's app data directory.
pub fn default_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("phasr.sqlite")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn checkpoint_moves_wal_into_main_file() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");
        let pool = init_pool(&db_path).await.unwrap();

        // Migrations just wrote the whole schema; in WAL mode that can sit
        // entirely in the sidecar with the main file still a header page.
        checkpoint(&pool).await.unwrap();

        let main_len = std::fs::metadata(&db_path).unwrap().len();
        let wal_len = std::fs::metadata(db_path.with_extension("sqlite-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        assert!(
            main_len > 4096,
            "main db file should hold the schema after checkpoint, got {main_len} bytes"
        );
        assert_eq!(wal_len, 0, "wal should be truncated after checkpoint");

        pool.close().await;
    }
}
