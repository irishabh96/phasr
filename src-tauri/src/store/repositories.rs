use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::Repository;

use super::error::StoreError;
use super::pool::Db;

#[derive(Debug, Default, Clone)]
pub struct RepositoryUpdate {
    pub name: Option<String>,
    pub remote_url: Option<Option<String>>,
    pub local_path: Option<Option<String>>,
    pub default_branch: Option<String>,
}

#[derive(Clone)]
pub struct RepositoryRepo {
    db: Db,
}

impl RepositoryRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, repository: &Repository) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO repositories (
                id, name, remote_url, local_path, default_branch,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&repository.id)
        .bind(&repository.name)
        .bind(&repository.remote_url)
        .bind(&repository.local_path)
        .bind(&repository.default_branch)
        .bind(repository.created_at.to_rfc3339())
        .bind(repository.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<Repository>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM repositories
             ORDER BY updated_at DESC",
        )
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_repository).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Repository, StoreError> {
        let row = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM repositories
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_repository)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    pub async fn update(
        &self,
        id: &str,
        patch: RepositoryUpdate,
    ) -> Result<Repository, StoreError> {
        let mut current = self.get(id).await?;

        if let Some(name) = patch.name {
            current.name = name;
        }
        if let Some(remote_url) = patch.remote_url {
            current.remote_url = remote_url;
        }
        if let Some(local_path) = patch.local_path {
            current.local_path = local_path;
        }
        if let Some(default_branch) = patch.default_branch {
            current.default_branch = default_branch;
        }
        current.touch();

        sqlx::query(
            "UPDATE repositories SET
                name = ?, remote_url = ?, local_path = ?, default_branch = ?,
                updated_at = ?, dirty = 1
             WHERE id = ?",
        )
        .bind(&current.name)
        .bind(&current.remote_url)
        .bind(&current.local_path)
        .bind(&current.default_branch)
        .bind(current.updated_at.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;

        Ok(current)
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let res = sqlx::query("DELETE FROM repositories WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

fn row_to_repository(row: &sqlx::sqlite::SqliteRow) -> Result<Repository, StoreError> {
    Ok(Repository {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        remote_url: row.try_get("remote_url")?,
        local_path: row.try_get("local_path")?,
        default_branch: row.try_get("default_branch")?,
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

    async fn fresh_repo() -> RepositoryRepo {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        RepositoryRepo::new(pool)
    }

    #[tokio::test]
    async fn insert_then_get_round_trips() {
        let repo = fresh_repo().await;
        let r = Repository::new("my-app".into(), Some("/tmp/my-app".into()), None);
        repo.insert(&r).await.unwrap();
        let fetched = repo.get(&r.id).await.unwrap();
        assert_eq!(fetched.name, "my-app");
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let repo = fresh_repo().await;
        let r = Repository::new("doomed".into(), None, None);
        repo.insert(&r).await.unwrap();
        repo.delete(&r.id).await.unwrap();
        assert!(matches!(repo.get(&r.id).await, Err(StoreError::NotFound)));
    }
}
