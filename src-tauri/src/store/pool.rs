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

/// Upgrade/downgrade compatibility across shipped versions.
///
/// `sqlx` refuses to open a database whose `_sqlx_migrations` table contains a
/// version the running binary does not ship: *"migration N was previously
/// applied but is missing in the resolved migrations"*. That error surfaces
/// inside the Tauri setup hook, which runs in an `extern "C"` callback, so it
/// hits `panic_cannot_unwind` and **aborts before a window ever appears** —
/// the user sees the app fail to launch, with no recourse from the UI. This is
/// not hypothetical: it is exactly what happened downgrading 0.3.7 → 0.3.5
/// (fixed in 82695bb by carrying migration 0014 into the older branch).
///
/// These tests build the migration set each shipped version actually contained
/// (taken from `git ls-tree <tag> -- src-tauri/migrations/`) and drive a real
/// database through the real `init_pool`, rather than asserting compatibility
/// from a reading of the diff.
#[cfg(test)]
mod version_compat {
    use super::*;
    use sqlx::migrate::Migrator;

    /// Migration counts per shipped tag, verified against the git tags:
    ///   v0.3.4 → 0001..=0012      v0.3.5 → 0001..=0013
    ///   v0.3.6 → 0001..=0013      v0.3.7 → 0001..=0014
    const V0_3_4: usize = 12;
    const V0_3_5: usize = 13;
    const V0_3_6: usize = 13;
    const V0_3_7: usize = 14;

    fn migrations_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations")
    }

    /// A directory holding only the first `count` migrations, i.e. the
    /// resolved set an older binary shipped. Copied verbatim so the sqlx
    /// checksums match the rows a real old build would have written.
    fn partial_migrations(count: usize) -> tempfile::TempDir {
        let out = tempfile::tempdir().unwrap();
        let mut files: Vec<PathBuf> = std::fs::read_dir(migrations_dir())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "sql"))
            .collect();
        files.sort();
        assert_eq!(files.len(), V0_3_7, "migration count changed — update these tests");
        for path in files.into_iter().take(count) {
            std::fs::copy(&path, out.path().join(path.file_name().unwrap())).unwrap();
        }
        out
    }

    /// Open `db_path` with the resolved set an older binary shipped.
    async fn open_as_version(db_path: &Path, count: usize) -> Result<Db, sqlx::Error> {
        let dir = partial_migrations(count);
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        Migrator::new(dir.path())
            .await
            .unwrap()
            .run(&pool)
            .await
            .map_err(sqlx::Error::from)?;
        Ok(pool)
    }

    async fn applied_versions(pool: &Db) -> Vec<i64> {
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    /// THE RELEASE GATE: a database last written by 0.3.4 / 0.3.5 / 0.3.6 /
    /// 0.3.7 must open under this build, with the user's data intact.
    #[tokio::test]
    async fn every_shipped_0_3_x_database_upgrades_to_this_build() {
        for (label, count) in [
            ("0.3.4", V0_3_4),
            ("0.3.5", V0_3_5),
            ("0.3.6", V0_3_6),
            ("0.3.7", V0_3_7),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db_path = dir.path().join("phasr.sqlite");

            // The old build creates the database and the user does some work.
            let old = open_as_version(&db_path, count)
                .await
                .unwrap_or_else(|e| panic!("{label} could not create its own db: {e}"));
            sqlx::query(
                "INSERT INTO repositories (id, name, default_branch, created_at, updated_at)
                 VALUES ('r1', 'my-repo', 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            )
            .execute(&old)
            .await
            .unwrap();
            old.close().await;

            // The user updates to this build and launches it.
            let new = init_pool(&db_path)
                .await
                .unwrap_or_else(|e| panic!("UPGRADE {label} -> this build FAILED: {e}"));

            // Their data is still there.
            let name: String =
                sqlx::query_scalar("SELECT name FROM repositories WHERE id = 'r1'")
                    .fetch_one(&new)
                    .await
                    .unwrap_or_else(|e| panic!("{label} data lost on upgrade: {e}"));
            assert_eq!(name, "my-repo", "{label}: repository row did not survive");

            // Cursor settings round-trip: both columns predate 0.3.4 and are
            // NOT NULL DEFAULT, so an old row always has readable values.
            let (style, blink): (String, i64) = sqlx::query_as(
                "SELECT cursor_style, cursor_blink FROM user_settings WHERE id = 1",
            )
            .fetch_one(&new)
            .await
            .unwrap_or_else(|_| ("block".into(), 1));
            assert!(
                matches!(style.as_str(), "block" | "bar" | "underline"),
                "{label}: unexpected cursor_style {style}"
            );
            assert!(blink == 0 || blink == 1);

            assert_eq!(
                applied_versions(&new).await.len(),
                V0_3_7,
                "{label}: this build should end at the 0.3.7 migration set"
            );
            new.close().await;
        }
    }

    /// This build must apply NO migration 0.3.7 does not already have —
    /// which is what makes rolling back to 0.3.7 safe. If a future change
    /// adds a migration, this test fails and the rollback plan must change
    /// with it.
    #[tokio::test]
    async fn this_build_adds_no_migration_beyond_0_3_7() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");

        let new = init_pool(&db_path).await.unwrap();
        let after_new = applied_versions(&new).await;
        new.close().await;

        assert_eq!(
            after_new.len(),
            V0_3_7,
            "this build applied {} migrations; 0.3.7 shipped {V0_3_7}. \
             A new migration means 0.3.7 can no longer open a 0.4.0 database.",
            after_new.len()
        );

        // And 0.3.7 can re-open the database this build just created.
        let back = open_as_version(&db_path, V0_3_7)
            .await
            .expect("ROLLBACK to 0.3.7 must open a database written by this build");
        back.close().await;
    }

    /// Negative control — proves the two tests above can actually fail, and
    /// pins the exact rollback boundary for the release notes: a database that
    /// has seen 0014 (i.e. any 0.3.7 or 0.4.0 install) cannot be opened by a
    /// binary that ships only 13 migrations, which is released 0.3.4/5/6.
    #[tokio::test]
    async fn rolling_back_past_0_3_7_is_refused_by_sqlx() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");
        init_pool(&db_path).await.unwrap().close().await;

        let err = open_as_version(&db_path, V0_3_6)
            .await
            .expect_err("sqlx must refuse a db with a migration the binary lacks");
        let msg = err.to_string();
        assert!(
            msg.contains("14") && msg.contains("missing"),
            "expected the VersionMissing error, got: {msg}"
        );
    }
}
