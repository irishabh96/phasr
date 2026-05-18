use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::Workspace;

use super::error::StoreError;
use super::pool::Db;

#[derive(Debug, Default, Clone)]
pub struct WorkspaceUpdate {
    pub name: Option<String>,
    pub remote_url: Option<Option<String>>,
    pub local_path: Option<Option<String>>,
    pub default_branch: Option<String>,
}

#[derive(Clone)]
pub struct WorkspaceRepo {
    db: Db,
}

impl WorkspaceRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, workspace: &Workspace) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO workspaces (
                id, name, remote_url, local_path, default_branch,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&workspace.id)
        .bind(&workspace.name)
        .bind(&workspace.remote_url)
        .bind(&workspace.local_path)
        .bind(&workspace.default_branch)
        .bind(workspace.created_at.to_rfc3339())
        .bind(workspace.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM workspaces
             ORDER BY updated_at DESC",
        )
        .fetch_all(&self.db)
        .await?;

        rows.iter().map(row_to_workspace).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Workspace, StoreError> {
        let row = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM workspaces
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_workspace)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    pub async fn update(&self, id: &str, patch: WorkspaceUpdate) -> Result<Workspace, StoreError> {
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
            "UPDATE workspaces SET
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
        let res = sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

fn row_to_workspace(row: &sqlx::sqlite::SqliteRow) -> Result<Workspace, StoreError> {
    Ok(Workspace {
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

    async fn fresh_repo() -> WorkspaceRepo {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        // Leak the tempdir so it outlives the test (deleted on process exit).
        std::mem::forget(dir);
        WorkspaceRepo::new(pool)
    }

    #[tokio::test]
    async fn insert_then_get_round_trips() {
        let repo = fresh_repo().await;
        let ws = Workspace::new("my-app".into(), Some("/tmp/my-app".into()), None);
        repo.insert(&ws).await.unwrap();

        let fetched = repo.get(&ws.id).await.unwrap();
        assert_eq!(fetched.name, "my-app");
        assert_eq!(fetched.local_path, Some("/tmp/my-app".into()));
    }

    #[tokio::test]
    async fn list_returns_in_updated_order() {
        let repo = fresh_repo().await;
        let mut a = Workspace::new("a".into(), None, None);
        let mut b = Workspace::new("b".into(), None, None);
        a.updated_at = chrono::Utc::now() - chrono::Duration::seconds(60);
        b.updated_at = chrono::Utc::now();
        repo.insert(&a).await.unwrap();
        repo.insert(&b).await.unwrap();

        let list = repo.list().await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "b");
        assert_eq!(list[1].name, "a");
    }

    #[tokio::test]
    async fn update_changes_fields_and_bumps_updated_at() {
        let repo = fresh_repo().await;
        let ws = Workspace::new("old".into(), None, None);
        let original_updated_at = ws.updated_at;
        repo.insert(&ws).await.unwrap();

        // Sleep a hair so the timestamp can actually move forward.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        let updated = repo
            .update(
                &ws.id,
                WorkspaceUpdate {
                    name: Some("new".into()),
                    remote_url: Some(Some("git@github.com:foo/bar.git".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(updated.name, "new");
        assert_eq!(
            updated.remote_url.as_deref(),
            Some("git@github.com:foo/bar.git")
        );
        assert!(updated.updated_at > original_updated_at);
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let repo = fresh_repo().await;
        let ws = Workspace::new("doomed".into(), None, None);
        repo.insert(&ws).await.unwrap();
        repo.delete(&ws.id).await.unwrap();
        assert!(matches!(repo.get(&ws.id).await, Err(StoreError::NotFound)));
    }

    #[tokio::test]
    async fn delete_missing_errors() {
        let repo = fresh_repo().await;
        let err = repo.delete("nonexistent").await.unwrap_err();
        assert!(matches!(err, StoreError::NotFound));
    }
}
