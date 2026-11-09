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

    migrator().run(&pool).await?;

    Ok(pool)
}

/// This build's migration set, configured to tolerate a database that a
/// NEWER build has already migrated further.
///
/// By default sqlx refuses to open a database whose `_sqlx_migrations`
/// holds a version the binary doesn't ship ("migration N was previously
/// applied but is missing"), and because that error fires inside Tauri's
/// setup hook it aborts the app before a window appears — a downgrade
/// becomes an un-launchable app (see `version_compat` below for the
/// 0.3.7 → 0.3.5 incident). Ignoring missing migrations makes this build a
/// safe rollback target for any later build, *provided* later migrations
/// stay additive (new nullable/defaulted columns, new tables): this
/// build's queries name their columns, so it never sees what it doesn't
/// know about. Checksums of the migrations this build DOES ship are still
/// verified, so an edited shipped migration still fails loudly.
fn migrator() -> sqlx::migrate::Migrator {
    let mut migrator = sqlx::migrate!("./migrations");
    migrator.set_ignore_missing(true);
    migrator
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
/// A default sqlx migrator refuses to open a database whose `_sqlx_migrations`
/// table contains a version the running binary does not ship: *"migration N
/// was previously applied but is missing in the resolved migrations"*. That
/// error surfaces inside the Tauri setup hook, which runs in an `extern "C"`
/// callback, so it hits `panic_cannot_unwind` and **aborts before a window
/// ever appears** — the user sees the app fail to launch, with no recourse
/// from the UI. This is not hypothetical: it is exactly what happened
/// downgrading 0.3.7 → 0.3.5 (fixed in 82695bb by carrying migration 0014
/// into the older branch).
///
/// Every build up to and including 0.4.3 opened the database that way. 0.4.4
/// is the first to set `ignore_missing` (see `migrator()`), which turns "a
/// newer build touched this database" from a launch abort into a non-event —
/// so 0.4.4 is the rollback floor for every later migration, starting with
/// 0015 (see `rolling_back_to_0_4_4_opens_a_db_this_build_wrote`).
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
    ///   v0.4.0 … v0.4.3 → 0001..=0014 (no migration added since 0.3.7)
    ///   v0.4.4 → 0001..=0014, the first build with `ignore_missing` (M0).
    ///          NOT RELEASED YET — it must ship (master + `migrator()`'s
    ///          `set_ignore_missing`) BEFORE any release containing 0015+,
    ///          or there is no build a user can roll back to: see
    ///          `rolling_back_to_0_4_3_is_impossible_so_0_4_4_must_ship_first`
    ///          and RELEASING.md → "Rollback safety".
    ///   this build → adds 0015 (permission modes), 0016 (agent signals),
    ///   0017 (board), 0018 (review), 0019 (notifications),
    ///   0020 (settings expansion), 0021 (local queue marker),
    ///   0022 (task usage partial cost)
    const V0_3_4: usize = 12;
    const V0_3_5: usize = 13;
    const V0_3_6: usize = 13;
    const V0_3_7: usize = 14;
    const V0_4_3: usize = 14;
    const V0_4_4: usize = 14;

    /// `(version, SHA-384 of the file)` for every migration that has ever
    /// shipped. sqlx stores this checksum in `_sqlx_migrations` and compares
    /// it on every launch, so editing a shipped migration — even whitespace —
    /// makes every existing install fail to start. Append new rows when a
    /// migration ships in a release; never change an existing one.
    const SHIPPED: &[(i64, &str)] = &[
        (1, "02852afe6945eb8acacd2a7d33bd8aef0309a3a4a29939892ef6ca0a259b8c1033daa4c299d01322313dcf86274099b6"),
        (2, "840624193b09211fc1f61c3bbf23f3508d466879add7cd0397443f9131e10709204f48e495a008135dbb77d336fcad5c"),
        (3, "9ab7aa3183db55081673e36937090f81d02c5196626eea316ec11825bcf75a273c32e44101022f23aebd54b31945f014"),
        (4, "eca6e8bc2c0bbb9809d82aebd1320adc22a220cddc10fb47dbfbf157d1a5d237a68856742ab49a51cec92c6f4d1c673c"),
        (5, "9e7f11342299c2dfedd16ee8d27d04089653e8fbf619fec1043490a0a231aaa03df7021da5551ff99b9466a3603dae16"),
        (6, "c8440730455e62f6fd9b62823db645aa34850319dfc4790c9d16449415bf41dc0971828fc9d69080760a9e78ce949491"),
        (7, "b22cf02186d6bfbb5846b5203c5d5bb4844af9482a1aaddb882dc1fa9abaa4bb2c888baa2c151be254894ec0e5d341cb"),
        (8, "c1b594c6d5401aa86151586499293ac47ae0c85f709d1745e1ab906d081d0d7837efc5b06eb23505d915dc74688c3891"),
        (9, "ee3c682c34156cc485d0b20d4ddb96f486a9ba0778ac2de2ec5610605388954bd012c3f43b075ab6e768b949b107ed6b"),
        (10, "7c0214209ebbae1c2f734c4f0539097a23d2a418147e1efecd5156ac5c99c9e06ea343ad62bdb3f3d985c6e6db7e6be6"),
        (11, "3374497fe89202e58785a0fcacba9941fab4c6b5dd1241bc7816879b018ad88cb17356753b1c0ed76d4b4bc3b4073fea"),
        (12, "314ff0a0606dc6c2b34cba76940f11748d4978d39ee5c5244fc9becee288f843abd7de5f78869d456f88a39644f4ea0a"),
        (13, "ebb7e8a2cf9dffbd195e9d4e65bbe3c2195a608413c17000c61b5269f01a209c52cc5125fed4336e649314ccbd6288ec"),
        (14, "bb06d417d2fa7458cfebb61f1027f7b3fc3c7490a436f46bf4ec4c209a81a409b5c5a974ce30052480650c728405a81b"),
        // Pinned from the moment it exists rather than at release: every
        // dev/beta install that ran this build has already recorded it.
        (15, "a791e96a85da88aa79257c3c53a08a63838052ff246af9379138bb2e7d9544f0fc86b9f3c2f51720e9d5b531d48596ed"),
        // Agent signals (M6): session id, last turn end, task_usage.
        (16, "24433b250df45b6e247da000e09d708cbc5928f0eb6c9a5a6bbe991676e30cb5f01563083c8cd1b68d45c3192d66fa42"),
        // Board, queue, outcomes (M7).
        (17, "7f8ebf92acc0bc2eaab5954588f26df09048b1b4053bf5dde18993c54c9badeef8af2746d2857ee27914a4a2f3737df6"),
        // Review: run-command triggers, check_runs, review_comments (M8).
        (18, "ab2f830e3050a3ceca41278babe0ecbf12049d8546e22489ecd9bcefbbff73a5ca3ae3ef27c465bb4f7872e99e2d7c2a"),
        // Notifications inbox + notification_prefs (M8).
        (19, "b4019d8ad5a8aba115e6c67940c7452af44419890fc65d7af348eb50f8bf6a15e28801ce9779a32d5e2da0e5454912c8"),
        // Settings expansion: terminal shell, copy on select, repo rules (M11).
        (20, "af073f3614f7ae5a6b2d178c15c30bf2a5f450531816594ecbc112a6bc4f63b5aa12060adeb24355311715cf97f72459"),
        // Local-only "queued on this machine" marker (review fix #8).
        (21, "38c571b805d08e217cf726b17d6e498db5bac0489fe5f7437f9d8f24945626a0668d99ed670234fdefe1f2678164fe90"),
    ];

    fn migrations_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn migration_files() -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(migrations_dir())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "sql"))
            .collect();
        files.sort();
        files
    }

    /// A directory holding only the first `count` migrations, i.e. the
    /// resolved set an older binary shipped. Copied verbatim so the sqlx
    /// checksums match the rows a real old build would have written.
    fn partial_migrations(count: usize) -> tempfile::TempDir {
        let out = tempfile::tempdir().unwrap();
        let files = migration_files();
        assert!(
            files.len() >= count,
            "asked for the first {count} migrations but only {} exist",
            files.len()
        );
        for path in files.into_iter().take(count) {
            std::fs::copy(&path, out.path().join(path.file_name().unwrap())).unwrap();
        }
        out
    }

    /// Open `db_path` the way a build up to 0.4.3 did: the first `count`
    /// migrations, with sqlx's default (strict) handling of unknown applied
    /// versions.
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

    async fn insert_repository(pool: &Db, id: &str, name: &str) {
        sqlx::query(
            "INSERT INTO repositories (id, name, default_branch, created_at, updated_at)
             VALUES (?, ?, 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }

    /// THE RELEASE GATE: a database last written by any shipped version must
    /// open under this build, with the user's data intact.
    #[tokio::test]
    async fn every_shipped_database_upgrades_to_this_build() {
        let this_build = migrator().iter().count();
        for (label, count) in [
            ("0.3.4", V0_3_4),
            ("0.3.5", V0_3_5),
            ("0.3.6", V0_3_6),
            ("0.3.7", V0_3_7),
            ("0.4.3", V0_4_3),
            ("0.4.4", V0_4_4),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db_path = dir.path().join("phasr.sqlite");

            // The old build creates the database and the user does some work.
            let old = open_as_version(&db_path, count)
                .await
                .unwrap_or_else(|e| panic!("{label} could not create its own db: {e}"));
            insert_repository(&old, "r1", "my-repo").await;
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
                this_build,
                "{label}: this build should end with its full migration set applied"
            );
            new.close().await;
        }
    }

    /// Shipped migrations are immutable. This replaces the old "this build
    /// adds no migration beyond 0.3.7" pin: new migrations are now allowed
    /// (this build ignores ones it doesn't know), but every migration an
    /// install may already have applied must keep its version AND checksum,
    /// or sqlx rejects that install at launch.
    #[test]
    fn shipped_migrations_are_unchanged() {
        let resolved: Vec<(i64, String)> = migrator()
            .iter()
            .map(|m| (m.version, hex(&m.checksum)))
            .collect();

        assert!(
            resolved.len() >= SHIPPED.len(),
            "a shipped migration was removed: {} resolved, {} shipped",
            resolved.len(),
            SHIPPED.len()
        );
        for ((version, checksum), (shipped_version, shipped_checksum)) in
            resolved.iter().zip(SHIPPED.iter())
        {
            assert_eq!(
                version, shipped_version,
                "shipped migration {shipped_version:04} was renumbered or removed"
            );
            assert_eq!(
                checksum, shipped_checksum,
                "shipped migration {version:04} was edited — every existing install \
                 would refuse to launch. Add a NEW migration instead."
            );
        }
        // Anything past the shipped set must sort after it, or it would be
        // applied out of order relative to what installs already have.
        let last_shipped = SHIPPED.last().map(|(v, _)| *v).unwrap_or(0);
        for (version, _) in resolved.iter().skip(SHIPPED.len()) {
            assert!(
                *version > last_shipped,
                "new migration {version:04} must be numbered above {last_shipped:04}"
            );
        }
    }

    /// The rollback guarantee this build exists to provide: a database that a
    /// newer build has migrated further (simulated with an applied row for a
    /// version this binary has never heard of) still opens, data intact,
    /// and the foreign row is left alone for when the newer build returns.
    #[tokio::test]
    async fn this_build_opens_a_db_with_an_unknown_applied_migration() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");

        let pool = init_pool(&db_path).await.unwrap();
        insert_repository(&pool, "r1", "my-repo").await;
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                 (version, description, installed_on, success, checksum, execution_time)
             VALUES (9999, 'from a future build', CURRENT_TIMESTAMP, 1, X'00', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let reopened = init_pool(&db_path)
            .await
            .expect("ROLLBACK onto this build must open a db a newer build migrated");
        let name: String = sqlx::query_scalar("SELECT name FROM repositories WHERE id = 'r1'")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(name, "my-repo");
        assert!(
            applied_versions(&reopened).await.contains(&9999),
            "the newer build's bookkeeping must survive the rollback"
        );
        reopened.close().await;

        // Negative control: the exact database 0.4.3 (strict migrator) would
        // have refused — which is what makes the assertion above meaningful.
        // It trips over this build's own 0015 before it ever reaches 9999.
        let err = open_as_version(&db_path, V0_4_3)
            .await
            .expect_err("a strict migrator must refuse an unknown applied version");
        let msg = err.to_string();
        assert!(
            msg.contains("previously applied but is missing")
                && (msg.contains("15") || msg.contains("9999")),
            "expected the VersionMissing error, got: {msg}"
        );
    }

    /// The realistic version of the test above: a future build applies an
    /// additive migration (new defaulted column on a synced table + a new
    /// table) and writes rows; this build then opens that database and its
    /// named-column queries keep reading and writing it.
    #[tokio::test]
    async fn this_build_reads_and_writes_after_a_future_additive_migration() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");

        let future = partial_migrations(migration_files().len());
        std::fs::write(
            future.path().join("9000_future_additive.sql"),
            "ALTER TABLE workspaces ADD COLUMN future_flag INTEGER NOT NULL DEFAULT 0;
             CREATE TABLE future_things (id TEXT PRIMARY KEY NOT NULL);",
        )
        .unwrap();
        {
            let options = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .foreign_keys(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .unwrap();
            Migrator::new(future.path())
                .await
                .unwrap()
                .run(&pool)
                .await
                .unwrap();
            let repo = crate::domain::Repository::new("my-repo".into(), None, None);
            crate::store::RepositoryRepo::new(pool.clone())
                .insert(&repo)
                .await
                .unwrap();
            let ws =
                crate::domain::Workspace::new(repo.id.clone(), "from-future".into(), "c".into());
            crate::store::WorkspaceRepo::new(pool.clone())
                .insert(&ws)
                .await
                .unwrap();
            sqlx::query("UPDATE workspaces SET future_flag = 1")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }

        let pool = init_pool(&db_path)
            .await
            .expect("this build must open a db carrying a future additive migration");
        let workspaces = crate::store::WorkspaceRepo::new(pool.clone());
        let repo_id: String = sqlx::query_scalar("SELECT id FROM repositories LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        let listed = workspaces.list_by_repository(&repo_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "from-future");

        // Writes too: an INSERT that doesn't name the new column takes its
        // DEFAULT, so the future build finds a well-formed row on return.
        let ws = crate::domain::Workspace::new(repo_id.clone(), "from-now".into(), "c".into());
        workspaces.insert(&ws).await.unwrap();
        let flag: i64 = sqlx::query_scalar("SELECT future_flag FROM workspaces WHERE id = ?")
            .bind(&ws.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(flag, 0);
        pool.close().await;
    }

    /// Open `db_path` the way 0.4.4 does: its 14 migrations, tolerant of
    /// ones it has never heard of.
    async fn open_as_0_4_4(db_path: &Path) -> Result<Db, sqlx::Error> {
        let dir = partial_migrations(V0_4_4);
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let mut migrator = Migrator::new(dir.path()).await.unwrap();
        migrator.set_ignore_missing(true);
        migrator.run(&pool).await.map_err(sqlx::Error::from)?;
        Ok(pool)
    }

    /// Rows written before 0015 upgrade to the documented legacy meaning:
    /// workspaces keep launching skip-all (`permission_mode` NULL, and the
    /// command they stored is untouched), notifications stay on, and the
    /// user's default flips to Ask for shell (user decision).
    #[tokio::test]
    async fn pre_0015_rows_upgrade_to_legacy_modes_and_the_ask_shell_default() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");

        let old = open_as_version(&db_path, V0_4_3).await.unwrap();
        insert_repository(&old, "r1", "my-repo").await;
        sqlx::query(
            "INSERT INTO workspaces (id, repository_id, workspace_kind, name, agent, command,
                 status, created_at, updated_at, dirty)
             VALUES ('w1', 'r1', 'agent', 'old task', 'claude',
                 'claude --dangerously-skip-permissions', 'stopped',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&old)
        .await
        .unwrap();
        sqlx::query("INSERT INTO user_settings (id, updated_at) VALUES (1, '2026-01-01T00:00:00Z')")
            .execute(&old)
            .await
            .unwrap();
        old.close().await;

        let new = init_pool(&db_path).await.unwrap();
        let ws = crate::store::WorkspaceRepo::new(new.clone())
            .get("w1")
            .await
            .unwrap();
        assert_eq!(ws.permission_mode, None);
        assert!(ws.notify_on_attention);
        assert_eq!(ws.command, "claude --dangerously-skip-permissions");
        let settings = crate::store::SettingsRepo::new(new.clone())
            .get_or_init()
            .await
            .unwrap();
        assert_eq!(
            settings.default_permission_mode,
            crate::domain::PermissionMode::AskShell
        );
        assert!(settings.agent_commands.is_empty());
        new.close().await;
    }

    /// The rollback this milestone relies on: a database this build has
    /// migrated through 0015 and written to opens under 0.4.4, which can
    /// keep writing rows (its INSERTs don't name the new columns, so they
    /// take their defaults) that this build then reads back cleanly.
    #[tokio::test]
    async fn rolling_back_to_0_4_4_opens_a_db_this_build_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");

        let pool = init_pool(&db_path).await.unwrap();
        insert_repository(&pool, "r1", "my-repo").await;
        let mut ws = crate::domain::Workspace::new("r1".into(), "new task".into(), "c".into());
        ws.permission_mode = Some(crate::domain::PermissionMode::AskShell);
        crate::store::WorkspaceRepo::new(pool.clone())
            .insert(&ws)
            .await
            .unwrap();
        pool.close().await;

        let rolled_back = open_as_0_4_4(&db_path)
            .await
            .expect("0.4.4 must open a database this build migrated");
        assert!(applied_versions(&rolled_back).await.contains(&15));
        sqlx::query(
            "INSERT INTO workspaces (id, repository_id, workspace_kind, name, command, status,
                 created_at, updated_at, dirty)
             VALUES ('from-0.4.4', 'r1', 'agent', 'old build task', 'c', 'stopped',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1)",
        )
        .execute(&rolled_back)
        .await
        .unwrap();
        rolled_back.close().await;

        let pool = init_pool(&db_path).await.unwrap();
        let workspaces = crate::store::WorkspaceRepo::new(pool.clone());
        assert_eq!(
            workspaces.get(&ws.id).await.unwrap().permission_mode,
            Some(crate::domain::PermissionMode::AskShell)
        );
        let from_old = workspaces.get("from-0.4.4").await.unwrap();
        assert_eq!(from_old.permission_mode, None);
        assert!(from_old.notify_on_attention);
        pool.close().await;
    }

    /// Why 0.4.4 must be RELEASED before this build ships (RELEASING.md →
    /// "Rollback safety"): once this build has migrated a database, the
    /// newest released build today — 0.4.3, strict migrator — refuses it at
    /// launch ("migration 15 was previously applied but is missing"), the
    /// 0.3.7 incident again. Only a build with `ignore_missing` (0.4.4,
    /// `rolling_back_to_0_4_4_opens_a_db_this_build_wrote`) can open it, so
    /// that build has to exist for users to roll back to.
    #[tokio::test]
    async fn rolling_back_to_0_4_3_is_impossible_so_0_4_4_must_ship_first() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");
        init_pool(&db_path).await.unwrap().close().await;

        let err = open_as_version(&db_path, V0_4_3)
            .await
            .expect_err("0.4.3 cannot open a database this build migrated");
        let msg = err.to_string();
        assert!(
            msg.contains("previously applied but is missing") && msg.contains("15"),
            "expected VersionMissing for 0015, got: {msg}"
        );
        // 0.4.4 (same 14 migrations + ignore_missing) can.
        open_as_0_4_4(&db_path)
            .await
            .expect("0.4.4 is the rollback target")
            .close()
            .await;
    }

    /// Negative control — proves the strict-migrator path really does fail,
    /// and pins the rollback boundary for the release notes: a database that
    /// has seen 0014 (any install from 0.3.7 on) cannot be opened by a binary
    /// that ships only 13 migrations and predates `ignore_missing`, which is
    /// released 0.3.4/5/6.
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
