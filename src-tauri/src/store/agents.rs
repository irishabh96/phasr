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
    pub async fn ensure_seeded(&self) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        for agent in Agent::seeded() {
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

    /// Returns user-defined custom agents only.
    pub async fn list_custom(&self) -> Result<Vec<Agent>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, command, icon, is_default, is_enabled, is_seed, sort_order,
                    created_at, updated_at
             FROM agents
             WHERE is_seed = 0
             ORDER BY sort_order ASC, name ASC",
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
    async fn list_custom_returns_empty_on_fresh_db() {
        let repo = fresh().await;
        assert!(repo.list_custom().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn insert_and_list_custom() {
        let repo = fresh().await;
        let agent = Agent::new_custom("My GPT-4", "chat-cli -m gpt-4");
        repo.insert(&agent).await.unwrap();
        let list = repo.list_custom().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "My GPT-4");
    }
}
