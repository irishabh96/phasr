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

/// Where daily DB snapshots live: `~/.phasr/backups`. Deliberately
/// OUTSIDE the app data dir — app-cleaner-style uninstalls delete
/// `~/Library/Application Support/<bundle id>` wholesale (which is how
/// the 2026-08-12 wipe took the live DB), and a backup that lives next
/// to the thing it protects is no backup at all.
pub fn default_backups_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".phasr").join("backups"))
}

/// Take (at most) one snapshot per day and prune to the newest `keep`.
///
/// `VACUUM INTO` writes a compact, self-contained database — no WAL
/// sidecar that a later copy could forget. Runs right after the startup
/// checkpoint+migrations, so it protects against wipes and WAL
/// stranding, not against a bad migration that already ran.
pub async fn backup_rotate(
    pool: &Db,
    backups_dir: &Path,
    keep: usize,
) -> Result<Option<PathBuf>, StoreError> {
    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    backup_rotate_stamped(pool, backups_dir, keep, &stamp).await
}

async fn backup_rotate_stamped(
    pool: &Db,
    backups_dir: &Path,
    keep: usize,
    stamp: &str,
) -> Result<Option<PathBuf>, StoreError> {
    std::fs::create_dir_all(backups_dir)?;
    let target = backups_dir.join(format!("phasr-{stamp}.sqlite"));
    if target.exists() {
        return Ok(None);
    }
    sqlx::query("VACUUM INTO ?")
        .bind(target.to_string_lossy().into_owned())
        .execute(pool)
        .await?;

    // Names embed the date (phasr-YYYY-MM-DD.sqlite), so a plain sort is
    // chronological; drop from the front until only `keep` remain.
    let mut snapshots: Vec<PathBuf> = std::fs::read_dir(backups_dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("phasr-") && n.ends_with(".sqlite"))
        })
        .collect();
    snapshots.sort();
    if snapshots.len() > keep {
        for stale in snapshots.drain(..snapshots.len() - keep) {
            if let Err(err) = std::fs::remove_file(&stale) {
                eprintln!("failed to prune db backup {}: {err}", stale.display());
            }
        }
    }
    Ok(Some(target))
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

    #[tokio::test]
    async fn backup_rotate_snapshots_once_per_day_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("phasr.sqlite")).await.unwrap();
        let backups = dir.path().join("backups");

        let first = backup_rotate_stamped(&pool, &backups, 3, "2026-08-10")
            .await
            .unwrap();
        let snapshot = first.expect("first run of the day must snapshot");
        // A real self-contained database, not a header page.
        assert!(std::fs::metadata(&snapshot).unwrap().len() > 4096);

        // Second run same day → skip.
        assert!(backup_rotate_stamped(&pool, &backups, 3, "2026-08-10")
            .await
            .unwrap()
            .is_none());

        for stamp in ["2026-08-11", "2026-08-12", "2026-08-13"] {
            backup_rotate_stamped(&pool, &backups, 3, stamp).await.unwrap();
        }
        let mut names: Vec<String> = std::fs::read_dir(&backups)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "phasr-2026-08-11.sqlite",
                "phasr-2026-08-12.sqlite",
                "phasr-2026-08-13.sqlite",
            ],
            "oldest snapshot must be pruned once past `keep`"
        );

        pool.close().await;
    }
}
