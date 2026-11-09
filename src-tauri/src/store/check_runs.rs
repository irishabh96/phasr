use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{CheckRun, CheckStatus};

use super::error::StoreError;
use super::pool::Db;

/// How many recent runs per workspace are read to find each check's
/// latest. A task with more runs than this per check is not plausible.
const RECENT_RUNS: i64 = 500;

macro_rules! check_run_columns {
    () => {
        "id, workspace_id, run_command_id, name, command, status, exit_code, fingerprint,
         created_at, started_at, finished_at, duration_ms, output_tail, log_path"
    };
}

/// What a finished run records.
#[derive(Debug, Clone)]
pub struct CheckRunFinish {
    pub status: CheckStatus,
    pub exit_code: Option<i64>,
    pub finished_at: DateTime<Utc>,
    pub duration_ms: Option<i64>,
    pub output_tail: String,
}

/// `check_runs` — local-only, so no `dirty`/sync bookkeeping. Rows carry
/// the owner's `user_id`; the `_for_user` reads filter on it.
#[derive(Clone)]
pub struct CheckRunRepo {
    db: Db,
}

impl CheckRunRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, run: &CheckRun, user_id: Option<&str>) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO check_runs (
                id, workspace_id, run_command_id, name, command, status, exit_code, fingerprint,
                created_at, started_at, finished_at, duration_ms, output_tail, log_path, user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&run.id)
        .bind(&run.workspace_id)
        .bind(&run.run_command_id)
        .bind(&run.name)
        .bind(&run.command)
        .bind(run.status.as_str())
        .bind(run.exit_code)
        .bind(&run.fingerprint)
        .bind(run.created_at.to_rfc3339())
        .bind(run.started_at.map(|t| t.to_rfc3339()))
        .bind(run.finished_at.map(|t| t.to_rfc3339()))
        .bind(run.duration_ms)
        .bind(&run.output_tail)
        .bind(&run.log_path)
        .bind(user_id)
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// `queued → running`. No-op (returns `None`) if the run already left
    /// `queued` — a cancel that won the race.
    pub async fn mark_running(
        &self,
        id: &str,
        started_at: DateTime<Utc>,
    ) -> Result<Option<CheckRun>, StoreError> {
        let res = sqlx::query(
            "UPDATE check_runs SET status = 'running', started_at = ?
             WHERE id = ? AND status = 'queued'",
        )
        .bind(started_at.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Ok(None);
        }
        self.get(id).await.map(Some)
    }

    /// Settle an active run. A run that already settled is left alone.
    pub async fn finish(&self, id: &str, finish: CheckRunFinish) -> Result<CheckRun, StoreError> {
        sqlx::query(
            "UPDATE check_runs SET status = ?, exit_code = ?, finished_at = ?, duration_ms = ?,
                output_tail = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(finish.status.as_str())
        .bind(finish.exit_code)
        .bind(finish.finished_at.to_rfc3339())
        .bind(finish.duration_ms)
        .bind(&finish.output_tail)
        .bind(id)
        .execute(&self.db)
        .await?;
        self.get(id).await
    }

    pub async fn get(&self, id: &str) -> Result<CheckRun, StoreError> {
        let row = sqlx::query(concat!("SELECT ", check_run_columns!(), " FROM check_runs WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.db)
            .await?;
        row.as_ref().map(row_to_check_run).transpose()?.ok_or(StoreError::NotFound)
    }

    /// Owner-scoped `get`: another account's run is `not found`.
    pub async fn get_for_user(&self, id: &str, user_id: &str) -> Result<CheckRun, StoreError> {
        let row = sqlx::query(concat!(
            "SELECT ",
            check_run_columns!(),
            " FROM check_runs WHERE id = ? AND user_id = ?"
        ))
        .bind(id)
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;
        row.as_ref().map(row_to_check_run).transpose()?.ok_or(StoreError::NotFound)
    }

    /// Recent runs for a workspace, newest first. Callers have already
    /// checked the workspace is the user's.
    pub async fn list_for_workspace(&self, workspace_id: &str) -> Result<Vec<CheckRun>, StoreError> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            check_run_columns!(),
            " FROM check_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?"
        ))
        .bind(workspace_id)
        .bind(RECENT_RUNS)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_check_run).collect()
    }

    /// Startup: a run still `queued`/`running` belonged to a process that
    /// is gone. Returns how many were settled as `error`.
    pub async fn settle_interrupted(&self) -> Result<u64, StoreError> {
        let res = sqlx::query(
            "UPDATE check_runs SET status = 'error', finished_at = ?
             WHERE status IN ('queued', 'running')",
        )
        .bind(Utc::now().to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(res.rows_affected())
    }
}

fn row_to_check_run(row: &sqlx::sqlite::SqliteRow) -> Result<CheckRun, StoreError> {
    let status: String = row.try_get("status")?;
    Ok(CheckRun {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        run_command_id: row.try_get("run_command_id")?,
        name: row.try_get("name")?,
        command: row.try_get("command")?,
        // Lenient: a status from a newer build reads as `error` (settled,
        // not satisfying anything) instead of failing the whole list.
        status: CheckStatus::from_str(&status).unwrap_or(CheckStatus::Error),
        exit_code: row.try_get("exit_code")?,
        fingerprint: row.try_get("fingerprint")?,
        created_at: parse_ts(row.try_get("created_at")?, "created_at")?,
        started_at: row
            .try_get::<Option<String>, _>("started_at")?
            .map(|v| parse_ts(v, "started_at"))
            .transpose()?,
        finished_at: row
            .try_get::<Option<String>, _>("finished_at")?
            .map(|v| parse_ts(v, "finished_at"))
            .transpose()?,
        duration_ms: row.try_get("duration_ms")?,
        output_tail: row.try_get("output_tail")?,
        log_path: row.try_get("log_path")?,
    })
}

pub(super) fn parse_ts(value: String, field: &'static str) -> Result<DateTime<Utc>, StoreError> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| StoreError::InvalidValue {
            field,
            message: err.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace};
    use crate::store::{init_pool, RepositoryRepo, WorkspaceRepo};

    pub(crate) async fn fresh() -> (CheckRunRepo, Workspace, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repository = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repository).await.unwrap();
        let ws = Workspace::new(repository.id, "t".into(), "c".into());
        WorkspaceRepo::new(pool.clone()).insert(&ws).await.unwrap();
        (CheckRunRepo::new(pool), ws, dir)
    }

    fn queued(ws: &str) -> CheckRun {
        CheckRun {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: ws.into(),
            run_command_id: Some("rc".into()),
            name: "test".into(),
            command: "true".into(),
            status: CheckStatus::Queued,
            exit_code: None,
            fingerprint: Some("fp".into()),
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            duration_ms: None,
            output_tail: String::new(),
            log_path: Some("/tmp/x.log".into()),
        }
    }

    #[tokio::test]
    async fn lifecycle_and_owner_scoping() {
        let (repo, ws, _dir) = fresh().await;
        let run = queued(&ws.id);
        repo.insert(&run, Some("user-a")).await.unwrap();
        let running = repo.mark_running(&run.id, Utc::now()).await.unwrap().unwrap();
        assert_eq!(running.status, CheckStatus::Running);
        // Only once.
        assert!(repo.mark_running(&run.id, Utc::now()).await.unwrap().is_none());
        let done = repo
            .finish(
                &run.id,
                CheckRunFinish {
                    status: CheckStatus::Passed,
                    exit_code: Some(0),
                    finished_at: Utc::now(),
                    duration_ms: Some(12),
                    output_tail: "ok\n".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!((done.status, done.exit_code, done.output_tail.as_str()), (CheckStatus::Passed, Some(0), "ok\n"));
        // A settled run can't be re-settled (a late cancel).
        let again = repo
            .finish(
                &run.id,
                CheckRunFinish {
                    status: CheckStatus::Cancelled,
                    exit_code: None,
                    finished_at: Utc::now(),
                    duration_ms: None,
                    output_tail: String::new(),
                },
            )
            .await
            .unwrap();
        assert_eq!(again.status, CheckStatus::Passed);

        assert_eq!(repo.get_for_user(&run.id, "user-a").await.unwrap().id, run.id);
        assert!(matches!(repo.get_for_user(&run.id, "user-b").await, Err(StoreError::NotFound)));
        assert_eq!(repo.list_for_workspace(&ws.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn interrupted_runs_settle_as_error_at_startup() {
        let (repo, ws, _dir) = fresh().await;
        let a = queued(&ws.id);
        repo.insert(&a, None).await.unwrap();
        assert_eq!(repo.settle_interrupted().await.unwrap(), 1);
        assert_eq!(repo.get(&a.id).await.unwrap().status, CheckStatus::Error);
    }
}
