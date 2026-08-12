use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::RunCommand;

use super::error::StoreError;
use super::pool::Db;

#[derive(Debug, Default, Clone)]
pub struct RunCommandUpdate {
    pub name: Option<String>,
    pub command: Option<String>,
    pub shortcut: Option<Option<String>>,
    pub pinned: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Clone)]
pub struct RunCommandRepo {
    db: Db,
}

impl RunCommandRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    #[allow(dead_code)]
    pub async fn insert(&self, rc: &RunCommand) -> Result<(), StoreError> {
        self.insert_with_user(rc, None).await
    }

    pub async fn insert_for_user(&self, rc: &RunCommand, user_id: &str) -> Result<(), StoreError> {
        self.insert_with_user(rc, Some(user_id)).await
    }

    async fn insert_with_user(
        &self,
        rc: &RunCommand,
        user_id: Option<&str>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO run_commands (
                id, user_id, repository_id, name, command, shortcut, pinned, sort_order,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&rc.id)
        .bind(user_id)
        .bind(&rc.repository_id)
        .bind(&rc.name)
        .bind(&rc.command)
        .bind(&rc.shortcut)
        .bind(rc.pinned as i64)
        .bind(rc.sort_order)
        .bind(rc.created_at.to_rfc3339())
        .bind(rc.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Unscoped list — retained for tests only. Production reads go
    /// through `list_by_repository_for_user` for account isolation.
    #[cfg(test)]
    pub async fn list_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Vec<RunCommand>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, name, command, shortcut, pinned, sort_order,
                    created_at, updated_at
             FROM run_commands
             WHERE repository_id = ?
             ORDER BY sort_order ASC, name ASC",
        )
        .bind(repository_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_run_command).collect()
    }

    /// Owner-scoped variant so a different signed-in account never sees
    /// another user's run commands.
    pub async fn list_by_repository_for_user(
        &self,
        repository_id: &str,
        user_id: &str,
    ) -> Result<Vec<RunCommand>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, name, command, shortcut, pinned, sort_order,
                    created_at, updated_at
             FROM run_commands
             WHERE repository_id = ? AND user_id = ?
             ORDER BY sort_order ASC, name ASC",
        )
        .bind(repository_id)
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_run_command).collect()
    }

    pub async fn get(&self, id: &str) -> Result<RunCommand, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, name, command, shortcut, pinned, sort_order,
                    created_at, updated_at
             FROM run_commands
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;
        row.as_ref()
            .map(row_to_run_command)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    pub async fn update(
        &self,
        id: &str,
        patch: RunCommandUpdate,
    ) -> Result<RunCommand, StoreError> {
        let mut current = self.get(id).await?;
        if let Some(name) = patch.name {
            current.name = name;
        }
        if let Some(command) = patch.command {
            current.command = command;
        }
        if let Some(shortcut) = patch.shortcut {
            current.shortcut = shortcut;
        }
        if let Some(pinned) = patch.pinned {
            current.pinned = pinned;
        }
        if let Some(sort_order) = patch.sort_order {
            current.sort_order = sort_order;
        }
        current.updated_at = Utc::now();

        sqlx::query(
            "UPDATE run_commands SET
                name = ?, command = ?, shortcut = ?, pinned = ?, sort_order = ?,
                updated_at = ?, dirty = 1
             WHERE id = ?",
        )
        .bind(&current.name)
        .bind(&current.command)
        .bind(&current.shortcut)
        .bind(current.pinned as i64)
        .bind(current.sort_order)
        .bind(current.updated_at.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        Ok(current)
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let res = sqlx::query("DELETE FROM run_commands WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

fn row_to_run_command(row: &sqlx::sqlite::SqliteRow) -> Result<RunCommand, StoreError> {
    Ok(RunCommand {
        id: row.try_get("id")?,
        repository_id: row.try_get("repository_id")?,
        name: row.try_get("name")?,
        command: row.try_get("command")?,
        shortcut: row.try_get("shortcut")?,
        pinned: row.try_get::<i64, _>("pinned")? != 0,
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
    use crate::domain::Repository;
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::PathBuf;

    async fn fresh() -> (RunCommandRepo, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);

        let repository = Repository::new("repo".into(), None, None);
        RepositoryRepo::new(pool.clone())
            .insert(&repository)
            .await
            .unwrap();
        (RunCommandRepo::new(pool), repository)
    }

    #[tokio::test]
    async fn insert_then_list_round_trips() {
        let (repo, repository) = fresh().await;
        let mut command = RunCommand::new(repository.id, "Dev".into(), "npm run dev".into());
        command.id = "run-command-1".into();

        repo.insert(&command).await.unwrap();

        let listed = repo.list_by_repository(&command.repository_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Dev");
    }
}
