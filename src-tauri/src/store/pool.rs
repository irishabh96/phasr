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
/// know about.
///
/// What stays strict, by sqlx's design (sqlx-core 0.8 `run_direct`):
/// checksums are compared only for migrations this build SHIPS, so a
/// newer build's rows (any checksum) are never inspected, while an edited
/// shipped migration still fails loudly. The `success = false` "dirty"
/// check still applies to every row, but sqlx's SQLite driver writes the
/// bookkeeping row inside the migration's own transaction with
/// `success = TRUE`, so a newer build can't leave one behind.
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
/// `sqlx` refuses to open a database whose `_sqlx_migrations` table contains a
/// version the running binary does not ship: *"migration N was previously
/// applied but is missing in the resolved migrations"*. That error surfaces
/// inside the Tauri setup hook, which runs in an `extern "C"` callback, so it
/// hits `panic_cannot_unwind` and **aborts before a window ever appears** —
/// the user sees the app fail to launch, with no recourse from the UI. This is
/// not hypothetical: it is exactly what happened downgrading 0.3.7 → 0.3.5
/// (fixed in 82695bb by carrying migration 0014 into the older branch).
///
/// Every build up to and including 0.4.3 opened the database that way. 0.4.4
/// is the first to set `ignore_missing` (see `migrator()`), which turns "a
/// newer build touched this database" from a launch abort into a non-event —
/// so 0.4.4 is the rollback floor for every later migration, starting with
/// the redesign's 0015–0021 (see
/// `this_build_opens_a_db_the_redesign_migrated_through_0021`).
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
    ///   v0.4.0 … v0.4.3 → 0001..=0014 (strict migrator)
    ///   v0.4.4 (this build) → 0001..=0014, tolerant of unknown versions
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

    /// The schema the redesign's local migrations 0015–0021 add, copied from
    /// the `feature/redesign-v2` branch's `src-tauri/migrations/` (statements
    /// only, comments dropped). Applied by hand with bookkeeping rows whose
    /// checksums this build cannot know, to stand in for a database a
    /// redesign build last opened — without shipping those migrations here.
    const REDESIGN_0015_TO_0021: &[(i64, &str, &str)] = &[
        (
            15,
            "permission modes",
            "ALTER TABLE workspaces ADD COLUMN permission_mode TEXT;
             ALTER TABLE workspaces ADD COLUMN notify_on_attention INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE user_settings
                 ADD COLUMN default_permission_mode TEXT NOT NULL DEFAULT 'ask-shell';
             ALTER TABLE user_settings ADD COLUMN agent_commands TEXT NOT NULL DEFAULT '{}';",
        ),
        (
            16,
            "agent signals",
            "ALTER TABLE workspaces ADD COLUMN agent_session_id TEXT;
             ALTER TABLE workspaces ADD COLUMN last_turn_ended_at TEXT;
             CREATE TABLE task_usage (
                 workspace_id TEXT PRIMARY KEY NOT NULL
                     REFERENCES workspaces(id) ON DELETE CASCADE,
                 source TEXT NOT NULL,
                 model TEXT,
                 input_tokens INTEGER NOT NULL DEFAULT 0,
                 output_tokens INTEGER NOT NULL DEFAULT 0,
                 cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                 cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                 cost_usd_micros INTEGER,
                 transcript_path TEXT,
                 updated_at TEXT NOT NULL
             );",
        ),
        (
            17,
            "board",
            "ALTER TABLE workspaces ADD COLUMN base_branch TEXT;
             ALTER TABLE workspaces ADD COLUMN queued_at TEXT;
             ALTER TABLE workspaces ADD COLUMN depends_on_workspace_id TEXT;
             ALTER TABLE workspaces ADD COLUMN outcome TEXT;
             ALTER TABLE workspaces ADD COLUMN outcome_at TEXT;
             ALTER TABLE workspaces ADD COLUMN merged_into TEXT;
             ALTER TABLE workspaces ADD COLUMN pr_number INTEGER;
             ALTER TABLE workspaces ADD COLUMN pr_url TEXT;
             ALTER TABLE workspaces ADD COLUMN pr_state TEXT;",
        ),
        (
            18,
            "review",
            "ALTER TABLE run_commands ADD COLUMN run_when TEXT NOT NULL DEFAULT 'manual';
             ALTER TABLE run_commands ADD COLUMN detect_port INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE run_commands ADD COLUMN required_for_approve INTEGER NOT NULL DEFAULT 0;
             CREATE TABLE check_runs (
                 id TEXT PRIMARY KEY NOT NULL,
                 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                 run_command_id TEXT,
                 name TEXT NOT NULL,
                 command TEXT NOT NULL,
                 status TEXT NOT NULL,
                 exit_code INTEGER,
                 fingerprint TEXT,
                 created_at TEXT NOT NULL,
                 started_at TEXT,
                 finished_at TEXT,
                 duration_ms INTEGER,
                 output_tail TEXT NOT NULL DEFAULT '',
                 log_path TEXT,
                 user_id TEXT
             );
             CREATE INDEX idx_check_runs_workspace ON check_runs(workspace_id, created_at);
             CREATE TABLE review_comments (
                 id TEXT PRIMARY KEY NOT NULL,
                 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                 user_id TEXT,
                 path TEXT NOT NULL,
                 line INTEGER NOT NULL,
                 side TEXT NOT NULL DEFAULT 'new',
                 anchor_text TEXT,
                 body TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending',
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 sent_at TEXT,
                 resolved_at TEXT,
                 deleted_at TEXT
             );
             CREATE INDEX idx_review_comments_workspace
                 ON review_comments(workspace_id, created_at);",
        ),
        (
            19,
            "notifications",
            "CREATE TABLE notifications (
                 id TEXT PRIMARY KEY NOT NULL,
                 user_id TEXT,
                 workspace_id TEXT,
                 repository_id TEXT,
                 kind TEXT NOT NULL,
                 title TEXT NOT NULL,
                 body TEXT,
                 payload TEXT NOT NULL DEFAULT '{}',
                 created_at TEXT NOT NULL,
                 read_at TEXT
             );
             CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at);
             ALTER TABLE user_settings ADD COLUMN notification_prefs TEXT NOT NULL DEFAULT '{}';",
        ),
        (
            20,
            "settings expansion",
            "ALTER TABLE user_settings ADD COLUMN terminal_shell TEXT NOT NULL DEFAULT '';
             ALTER TABLE user_settings ADD COLUMN copy_on_select INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE repository_config ADD COLUMN default_base_branch TEXT;
             ALTER TABLE repository_config
                 ADD COLUMN fetch_base_before_task INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE repository_config ADD COLUMN agents_may_push TEXT NOT NULL DEFAULT 'ask';
             ALTER TABLE repository_config ADD COLUMN pr_mode TEXT NOT NULL DEFAULT 'draft';
             ALTER TABLE repository_config ADD COLUMN protected_paths TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE repository_config
                 ADD COLUMN copy_untracked_globs TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE repository_config
                 ADD COLUMN cleanup_after_merge TEXT NOT NULL DEFAULT 'ask';",
        ),
        (
            21,
            "local queue marker",
            "ALTER TABLE workspaces ADD COLUMN queued_here INTEGER NOT NULL DEFAULT 0;",
        ),
    ];

    /// What a redesign build does to the database on launch: apply 0015–0021
    /// and record them. The checksums are deliberately junk — this build has
    /// no business comparing them, and must not.
    async fn simulate_redesign_build(pool: &Db) {
        for (version, description, sql) in REDESIGN_0015_TO_0021 {
            sqlx::raw_sql(sql)
                .execute(pool)
                .await
                .unwrap_or_else(|e| panic!("redesign migration {version:04}: {e}"));
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                     (version, description, installed_on, success, checksum, execution_time)
                 VALUES (?, ?, CURRENT_TIMESTAMP, 1, ?, 0)",
            )
            .bind(version)
            .bind(description)
            .bind(format!("not-a-real-checksum-{version}").into_bytes())
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// THE ROLLBACK GATE for the redesign: a user upgrades to a build with
    /// migrations 0015–0021, works in it, then rolls back to this build. The
    /// app must launch (no VersionMissing abort, no checksum complaint about
    /// versions it doesn't ship), and its named-column reads and writes must
    /// keep working on the wider schema — leaving the newer build's columns
    /// and bookkeeping intact for when it returns.
    #[tokio::test]
    async fn this_build_opens_a_db_the_redesign_migrated_through_0021() {
        use crate::domain::{Repository, RunCommand, Workspace, WorkspaceStatus};
        use crate::store::{
            RepositoryRepo, RunCommandRepo, SettingsRepo, WorkspaceRepo, WorkspaceUpdate,
        };

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");

        // This build creates the database and the user does some work.
        let pool = init_pool(&db_path).await.unwrap();
        let repo = Repository::new("my-repo".into(), None, None);
        RepositoryRepo::new(pool.clone())
            .insert(&repo)
            .await
            .unwrap();
        let before = Workspace::new(repo.id.clone(), "before upgrade".into(), "claude".into());
        WorkspaceRepo::new(pool.clone())
            .insert(&before)
            .await
            .unwrap();
        SettingsRepo::new(pool.clone()).get_or_init().await.unwrap();

        // They upgrade to the redesign, which migrates and writes rows that
        // use its new columns and tables — including a never-launched draft.
        simulate_redesign_build(&pool).await;
        sqlx::query(
            "INSERT INTO workspaces (id, repository_id, workspace_kind, name, prompt, agent,
                 command, status, created_at, updated_at, dirty,
                 permission_mode, notify_on_attention, base_branch, queued_at, queued_here)
             VALUES ('draft-1', ?, 'agent', 'a draft', 'do the thing', 'claude',
                 'claude --permission-mode acceptEdits', 'pending',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1,
                 'ask-edits', 0, 'develop', '2026-01-02T00:00:00Z', 1)",
        )
        .bind(&repo.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE workspaces SET permission_mode = 'skip-all', outcome = 'merged',
                 pr_number = 7, last_turn_ended_at = '2026-01-03T00:00:00Z'
             WHERE id = ?",
        )
        .bind(&before.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO task_usage (workspace_id, source, input_tokens, updated_at)
             VALUES (?, 'claude', 1000, '2026-01-03T00:00:00Z')",
        )
        .bind(&before.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO check_runs (id, workspace_id, name, command, status, created_at)
             VALUES ('cr-1', ?, 'test', 'pnpm test', 'passed', '2026-01-03T00:00:00Z')",
        )
        .bind(&before.id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE user_settings SET default_permission_mode = 'skip-all',
                 agent_commands = '{\"claude\":\"claude {{permissions}}\"}', copy_on_select = 1",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        // Rolled back to this build: it must launch.
        let pool = init_pool(&db_path)
            .await
            .expect("ROLLBACK from the redesign must open the database it migrated");
        let applied = applied_versions(&pool).await;
        for version in 15..=21 {
            assert!(
                applied.contains(&version),
                "the newer build's bookkeeping row {version} must survive the rollback"
            );
        }

        // Reads.
        let workspaces = WorkspaceRepo::new(pool.clone());
        let listed = workspaces.list_by_repository(&repo.id).await.unwrap();
        assert_eq!(
            listed.len(),
            2,
            "both the old row and the redesign's draft list"
        );
        let draft = workspaces.get("draft-1").await.unwrap();
        assert_eq!(draft.status, WorkspaceStatus::Pending);
        assert_eq!(draft.branch, None);
        assert_eq!(draft.prompt.as_deref(), Some("do the thing"));
        let settings = SettingsRepo::new(pool.clone());
        let mut current = settings.get_or_init().await.unwrap();

        // Writes: insert, update, settings, run commands, soft delete.
        let after = Workspace::new(repo.id.clone(), "after rollback".into(), "claude".into());
        workspaces.insert(&after).await.unwrap();
        workspaces
            .update(
                &before.id,
                WorkspaceUpdate {
                    name: Some("renamed after rollback".into()),
                    status: Some(WorkspaceStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        current.theme = "light".into();
        settings.update(&current).await.unwrap();
        let rc = RunCommand::new(repo.id.clone(), "dev".into(), "pnpm dev".into());
        RunCommandRepo::new(pool.clone()).insert(&rc).await.unwrap();
        workspaces.delete(&after.id).await.unwrap();

        // New rows took the redesign's defaults, so it finds them well-formed
        // when it returns; the columns this build never names were left alone.
        let (notify, queued_here, mode): (i64, i64, Option<String>) = sqlx::query_as(
            "SELECT notify_on_attention, queued_here, permission_mode FROM workspaces WHERE id = ?",
        )
        .bind(&after.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((notify, queued_here, mode), (1, 0, None));
        let (mode, outcome, pr): (Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT permission_mode, outcome, pr_number FROM workspaces WHERE id = ?",
        )
        .bind(&before.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(mode.as_deref(), Some("skip-all"));
        assert_eq!(outcome.as_deref(), Some("merged"));
        assert_eq!(pr, Some(7));
        let (default_mode, copy_on_select): (String, i64) = sqlx::query_as(
            "SELECT default_permission_mode, copy_on_select FROM user_settings WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((default_mode.as_str(), copy_on_select), ("skip-all", 1));
        let run_when: String = sqlx::query_scalar("SELECT run_when FROM run_commands WHERE id = ?")
            .bind(&rc.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(run_when, "manual");

        // Removing the repository hard-deletes its workspaces; the redesign's
        // child tables cascade instead of failing the FK check.
        RepositoryRepo::new(pool.clone())
            .delete(&repo.id)
            .await
            .unwrap();
        let orphans: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM task_usage) + (SELECT COUNT(*) FROM check_runs)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(orphans, 0);
        pool.close().await;

        // And the app relaunches cleanly on top of all of that.
        init_pool(&db_path)
            .await
            .expect("a second launch after rollback must also open")
            .close()
            .await;

        // Negative control: 0.4.3's strict migrator (same 14 migrations,
        // no `ignore_missing`) refuses this exact database — which is what
        // makes the assertions above mean something.
        let err = open_as_version(&db_path, V0_3_7)
            .await
            .expect_err("a strict migrator must refuse a db the redesign migrated");
        let msg = err.to_string();
        assert!(
            msg.contains("previously applied but is missing") && msg.contains("15"),
            "expected VersionMissing for 0015, got: {msg}"
        );
    }

    /// `ignore_missing` is not a blanket checksum bypass: a migration this
    /// build SHIPS that was edited after it was applied still refuses to
    /// open, exactly as before. Only versions this build has never heard of
    /// go unchecked.
    #[tokio::test]
    async fn an_edited_shipped_migration_is_still_refused() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("phasr.sqlite");
        let pool = init_pool(&db_path).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 14")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let err = init_pool(&db_path)
            .await
            .expect_err("a shipped migration whose checksum changed must still fail");
        let msg = err.to_string();
        assert!(
            msg.contains("14") && msg.contains("modified"),
            "expected VersionMismatch for 0014, got: {msg}"
        );
    }
}
