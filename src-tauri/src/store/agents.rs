//! Custom (user-defined) agents. Seeded agents are NOT in this table —
//! they're hardcoded in `domain::agent`. Per-user enabled state lives
//! in `user_settings.disabled_agent_ids`.

use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::Agent;

use super::error::StoreError;
use super::pool::Db;

#[derive(Clone)]
pub struct AgentRepo {
    db: Db,
}

impl AgentRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, agent: &Agent) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO agents (
                id, name, command, icon, is_default, is_enabled, is_seed, sort_order,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&agent.id)
        .bind(&agent.name)
        .bind(&agent.command)
        .bind(&agent.icon)
        .bind(agent.is_default as i64)
        .bind(agent.is_enabled as i64)
        .bind(agent.is_seed as i64)
        .bind(agent.sort_order)
        .bind(agent.created_at.to_rfc3339())
        .bind(agent.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Ensures the hardcoded seed agents are present in the local
    /// `agents` table so the `workspaces.agent_id` FK constraint is
    /// always satisfied when a workspace references a seed. Idempotent:
    /// matches existing rows by deterministic UUID.
    ///
    /// Also removes seed rows that are no longer in the current seed
    /// list (e.g. agents we dropped between app releases) — the
    /// `workspaces.agent_id` FK is `ON DELETE SET NULL`, so any
    /// workspace that referenced a removed seed keeps its row with a
    /// null agent_id (its stored `command` snapshot still runs).
    pub async fn ensure_seeded(&self) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        let seeded = Agent::seeded();

        // Drop stale seed rows whose IDs are no longer in the current
        // seed list. Build a NOT IN (?, ?, ...) clause from the live IDs.
        let live_ids: Vec<String> = seeded.iter().map(|a| a.id.clone()).collect();
        let placeholders = std::iter::repeat("?")
            .take(live_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let delete_sql = format!(
            "DELETE FROM agents WHERE is_seed = 1 AND id NOT IN ({placeholders})"
        );
        let mut q = sqlx::query(&delete_sql);
        for id in &live_ids {
            q = q.bind(id);
        }
        q.execute(&self.db).await?;

        for agent in seeded {
            // Use OR REPLACE so a command-text update in a new app
            // release lands on next boot without manual migration.
            sqlx::query(
                "INSERT OR REPLACE INTO agents (
                    id, name, command, icon, is_default, is_enabled, is_seed, sort_order,
                    created_at, updated_at, synced_at, dirty
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)",
            )
            .bind(&agent.id)
            .bind(&agent.name)
            .bind(&agent.command)
            .bind(&agent.icon)
            .bind(agent.is_default as i64)
            .bind(true as i64)
            .bind(true as i64)
            .bind(agent.sort_order)
            .bind(&now)
            .bind(&now)
            .execute(&self.db)
            .await?;
        }
        Ok(())
    }

    /// Set the command of a seed agent (creates a per-install override
    /// row tied to the deterministic seed UUID) or a custom agent.
    pub async fn set_command(&self, id: &str, command: &str) -> Result<(), StoreError> {
        let res = sqlx::query(
            "UPDATE agents SET command = ?, updated_at = ?, dirty = 1 WHERE id = ?",
        )
        .bind(command)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Mark exactly one agent as the default; clear the flag everywhere
    /// else in one transaction so the invariant always holds.
    pub async fn set_default(&self, id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.db.begin().await?;
        sqlx::query("UPDATE agents SET is_default = 0, updated_at = ?, dirty = 1")
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        let res = sqlx::query(
            "UPDATE agents SET is_default = 1, updated_at = ?, dirty = 1 WHERE id = ?",
        )
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() == 0 {
            tx.rollback().await?;
            return Err(StoreError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let res = sqlx::query("DELETE FROM agents WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Returns every agent row (seeds + customs) ordered for display.
    pub async fn list_all(&self) -> Result<Vec<Agent>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, command, icon, is_default, is_enabled, is_seed, sort_order,
                    created_at, updated_at
             FROM agents
             ORDER BY is_seed DESC, sort_order ASC, name ASC",
        )
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_agent).collect()
    }
}

fn row_to_agent(row: &sqlx::sqlite::SqliteRow) -> Result<Agent, StoreError> {
    Ok(Agent {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        command: row.try_get("command")?,
        icon: row.try_get("icon")?,
        is_default: row.try_get::<i64, _>("is_default")? != 0,
        is_enabled: row.try_get::<i64, _>("is_enabled")? != 0,
        is_seed: row.try_get::<i64, _>("is_seed")? != 0,
        sort_order: row.try_get("sort_order")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
        updated_at: parse_timestamp(row.try_get::<String, _>("updated_at")?, "updated_at")?,
    })
}

fn parse_timestamp(value: String, field: &'static str) -> Result<DateTime<Utc>, StoreError> {
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
    use crate::store::init_pool;
    use std::path::PathBuf;

    async fn fresh() -> AgentRepo {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        AgentRepo::new(pool)
    }

    #[tokio::test]
    async fn list_all_returns_empty_on_fresh_db() {
        let repo = fresh().await;
        assert!(repo.list_all().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn insert_and_list_all() {
        let repo = fresh().await;
        let agent = Agent::new_custom("My GPT-4", "chat-cli -m gpt-4");
        repo.insert(&agent).await.unwrap();
        let list = repo.list_all().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "My GPT-4");
    }
}
