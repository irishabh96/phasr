//! `task_usage`: the latest token/cost snapshot per task. Local-only (never
//! synced); the transcripts it's derived from live on this machine.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row;

use crate::domain::usage::{TaskUsage, UsageSource};

use super::error::StoreError;
use super::pool::Db;

#[derive(Clone)]
pub struct TaskUsageRepo {
    db: Db,
}

impl TaskUsageRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn upsert(&self, workspace_id: &str, usage: &TaskUsage) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO task_usage (
                workspace_id, source, model, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd_micros, cost_partial,
                transcript_path, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
                source = excluded.source, model = excluded.model,
                input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_write_tokens = excluded.cache_write_tokens,
                cost_usd_micros = excluded.cost_usd_micros,
                cost_partial = excluded.cost_partial,
                transcript_path = excluded.transcript_path,
                updated_at = excluded.updated_at",
        )
        .bind(workspace_id)
        .bind(usage.source.as_str())
        .bind(&usage.model)
        .bind(usage.input_tokens)
        .bind(usage.output_tokens)
        .bind(usage.cache_read_tokens)
        .bind(usage.cache_write_tokens)
        .bind(usage.cost_usd_micros)
        .bind(usage.cost_partial)
        .bind(&usage.transcript_path)
        .bind(usage.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn get(&self, workspace_id: &str) -> Result<Option<TaskUsage>, StoreError> {
        let row = sqlx::query(concat!(
            "SELECT ",
            usage_columns!(),
            " FROM task_usage WHERE workspace_id = ?"
        ))
        .bind(workspace_id)
        .fetch_optional(&self.db)
        .await?;
        row.as_ref().map(row_to_usage).transpose()
    }

    /// `get` for many tasks in one query (the Board's cards), keyed by
    /// workspace id; tasks with no snapshot are absent. The ids travel as
    /// one JSON array bind, so the statement doesn't grow with the board.
    pub async fn get_many(
        &self,
        workspace_ids: &[&str],
    ) -> Result<HashMap<String, TaskUsage>, StoreError> {
        if workspace_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let ids = serde_json::to_string(workspace_ids).map_err(|err| StoreError::InvalidValue {
            field: "workspace_id",
            message: err.to_string(),
        })?;
        let rows = sqlx::query(concat!(
            "SELECT workspace_id, ",
            usage_columns!(),
            " FROM task_usage WHERE workspace_id IN (SELECT value FROM json_each(?))"
        ))
        .bind(ids)
        .fetch_all(&self.db)
        .await?;
        rows.iter()
            .map(|row| Ok((row.try_get("workspace_id")?, row_to_usage(row)?)))
            .collect()
    }
}

/// Every column `row_to_usage` reads (a macro so `concat!` keeps each query
/// a `&'static str`).
macro_rules! usage_columns {
    () => {
        "source, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd_micros, cost_partial, transcript_path, updated_at"
    };
}
use usage_columns;

fn row_to_usage(row: &SqliteRow) -> Result<TaskUsage, StoreError> {
    let source: String = row.try_get("source")?;
    let source = UsageSource::from_str(&source).ok_or_else(|| StoreError::InvalidValue {
        field: "source",
        message: format!("unknown usage source `{source}`"),
    })?;
    let updated_at: String = row.try_get("updated_at")?;
    let updated_at = DateTime::parse_from_rfc3339(&updated_at)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| StoreError::InvalidValue {
            field: "updated_at",
            message: err.to_string(),
        })?;
    Ok(TaskUsage {
        source,
        model: row.try_get("model")?,
        input_tokens: row.try_get("input_tokens")?,
        output_tokens: row.try_get("output_tokens")?,
        cache_read_tokens: row.try_get("cache_read_tokens")?,
        cache_write_tokens: row.try_get("cache_write_tokens")?,
        cost_usd_micros: row.try_get("cost_usd_micros")?,
        cost_partial: row.try_get("cost_partial")?,
        transcript_path: row.try_get("transcript_path")?,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace};
    use crate::store::{init_pool, RepositoryRepo, WorkspaceRepo};

    #[tokio::test]
    async fn upsert_then_get_round_trips_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repo).await.unwrap();
        let ws = Workspace::new(repo.id.clone(), "w".into(), "claude".into());
        WorkspaceRepo::new(pool.clone()).insert(&ws).await.unwrap();

        let usage_repo = TaskUsageRepo::new(pool.clone());
        assert!(usage_repo.get(&ws.id).await.unwrap().is_none());

        let mut usage = TaskUsage {
            source: UsageSource::Codex,
            model: Some("gpt-5".into()),
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 30,
            cache_write_tokens: 0,
            cost_usd_micros: None,
            cost_partial: false,
            updated_at: Utc::now(),
            transcript_path: Some("/x.jsonl".into()),
        };
        usage_repo.upsert(&ws.id, &usage).await.unwrap();
        let read = usage_repo.get(&ws.id).await.unwrap().unwrap();
        assert!(read.same_totals(&usage));
        assert_eq!(read.transcript_path.as_deref(), Some("/x.jsonl"));

        usage.output_tokens = 99;
        usage.cost_usd_micros = Some(5);
        usage.cost_partial = true;
        usage_repo.upsert(&ws.id, &usage).await.unwrap();
        let read = usage_repo.get(&ws.id).await.unwrap().unwrap();
        assert_eq!(read.output_tokens, 99);
        assert_eq!(read.cost_usd_micros, Some(5));
        assert!(read.cost_partial);
    }

    #[tokio::test]
    async fn get_many_reads_every_requested_snapshot_in_one_query() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repo).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let usage_repo = TaskUsageRepo::new(pool.clone());
        let mut ids = Vec::new();
        for i in 0..4 {
            let ws = Workspace::new(repo.id.clone(), format!("w{i}"), "claude".into());
            workspaces.insert(&ws).await.unwrap();
            // w3 never reported usage.
            if i < 3 {
                let usage = TaskUsage {
                    source: UsageSource::Claude,
                    model: Some("claude-sonnet-5".into()),
                    input_tokens: i,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    cost_usd_micros: Some(i * 10),
                    cost_partial: i == 2,
                    updated_at: Utc::now(),
                    transcript_path: None,
                };
                usage_repo.upsert(&ws.id, &usage).await.unwrap();
            }
            ids.push(ws.id);
        }
        assert!(usage_repo.get_many(&[]).await.unwrap().is_empty());
        // w0 not asked for; w3 and an unknown id have nothing.
        let asked: Vec<&str> = vec![&ids[1], &ids[2], &ids[3], "nope"];
        let got = usage_repo.get_many(&asked).await.unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[&ids[1]].input_tokens, 1);
        assert_eq!(got[&ids[2]].cost_usd_micros, Some(20));
        assert!(got[&ids[2]].cost_partial);
        // Same rows `get` reads.
        assert_eq!(got[&ids[1]], usage_repo.get(&ids[1]).await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn session_id_is_local_and_turn_end_is_synced() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repo).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let ws = Workspace::new(repo.id.clone(), "w".into(), "claude".into());
        workspaces.insert(&ws).await.unwrap();
        sqlx::query("UPDATE workspaces SET dirty = 0")
            .execute(&pool)
            .await
            .unwrap();
        let before = workspaces.get(&ws.id).await.unwrap().updated_at;

        workspaces.set_agent_session_id(&ws.id, "sess-1").await.unwrap();
        assert_eq!(
            workspaces.get_agent_session_id(&ws.id).await.unwrap().as_deref(),
            Some("sess-1")
        );
        let (dirty,): (i64,) = sqlx::query_as("SELECT dirty FROM workspaces WHERE id = ?")
            .bind(&ws.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty, 0, "a session id must never make the row push");
        assert_eq!(workspaces.get(&ws.id).await.unwrap().updated_at, before);

        let at = Utc::now();
        workspaces.set_last_turn_ended_at(&ws.id, at).await.unwrap();
        let read = workspaces.get(&ws.id).await.unwrap();
        assert_eq!(
            read.last_turn_ended_at.map(|t| t.timestamp_millis()),
            Some(at.timestamp_millis())
        );
        let (dirty,): (i64,) = sqlx::query_as("SELECT dirty FROM workspaces WHERE id = ?")
            .bind(&ws.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty, 1, "turn end is synced");

        assert!(matches!(
            workspaces.set_agent_session_id("missing", "s").await,
            Err(StoreError::NotFound)
        ));
    }
}
