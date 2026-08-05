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

    #[allow(dead_code)]
    pub async fn insert(&self, repository: &Repository) -> Result<(), StoreError> {
        self.insert_with_user(repository, None).await
    }

    pub async fn insert_for_user(
        &self,
        repository: &Repository,
        user_id: &str,
    ) -> Result<(), StoreError> {
        self.insert_with_user(repository, Some(user_id)).await
    }

    async fn insert_with_user(
        &self,
        repository: &Repository,
        user_id: Option<&str>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO repositories (
                id, user_id, name, remote_url, local_path, default_branch,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&repository.id)
        .bind(user_id)
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
             WHERE deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_repository).collect()
    }

    /// Like `list`, but scoped to a single owner so a different account
    /// signed in on the same machine never sees these rows.
    pub async fn list_for_user(&self, user_id: &str) -> Result<Vec<Repository>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM repositories
             WHERE deleted_at IS NULL AND user_id = ?
             ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_repository).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Repository, StoreError> {
        let row = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM repositories
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_repository)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    /// Owner-scoped `get`: returns `NotFound` for a repo owned by another
    /// account (so stale routes self-heal instead of leaking).
    pub async fn get_for_user(&self, id: &str, user_id: &str) -> Result<Repository, StoreError> {
        let row = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at
             FROM repositories
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .bind(user_id)
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

    /// Soft-delete the repository row and hard-delete all of its
    /// children in one transaction. Soft-delete + dirty=1 means the
    /// row stays in the table (so future cloud-sync pulls can compare
    /// against the local tombstone) while every UI surface filters it
    /// out via `deleted_at IS NULL`. The next cloud-sync push completes
    /// the deletion remotely.
    ///
    /// Children get hard-deleted explicitly because SQLite's FK
    /// cascade only fires on DELETE, not UPDATE. The cloud's own FK
    /// cascade handles the corresponding cloud rows when the parent
    /// delete pushes.
    ///
    /// `repository_notes` is the deliberate exception: notes are
    /// SOFT-deleted (kept forever per the notes spec) so an accidental
    /// removal is recoverable and a future "restore repository" has
    /// data to restore. Never add notes to the hard-delete list.
    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();

        let mut tx = self.db.begin().await?;

        super::notes::NoteRepo::soft_delete_by_repository(&mut tx, id, false).await?;

        sqlx::query("DELETE FROM run_commands WHERE repository_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM repository_config WHERE repository_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM workspaces WHERE repository_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;

        let res = sqlx::query(
            "UPDATE repositories
             SET deleted_at = ?, updated_at = ?, dirty = 1
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    /// Repositories that have been soft-deleted locally but haven't
    /// been pushed to cloud yet. The cloud-sync bootstrap reads this
    /// before pulling so any pending deletions land before we attempt
    /// to reconcile.
    pub async fn list_dirty_soft_deletes(&self) -> Result<Vec<String>, StoreError> {
        let rows = sqlx::query(
            "SELECT id FROM repositories
             WHERE deleted_at IS NOT NULL AND dirty = 1",
        )
        .fetch_all(&self.db)
        .await?;
        rows.iter()
            .map(|r| r.try_get::<String, _>("id").map_err(StoreError::from))
            .collect()
    }

    /// Clear `dirty` on a repository row after its cloud-side mirror
    /// has confirmed (push for live rows, delete for tombstones).
    pub async fn mark_synced(&self, id: &str) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE repositories
             SET synced_at = ?, dirty = 0
             WHERE id = ?",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// `true` when a row with this id is soft-deleted locally. Used by
    /// the cloud-sync pull to skip resurrection of locally-tombstoned
    /// repositories.
    pub async fn exists_soft_deleted(&self, id: &str) -> Result<bool, StoreError> {
        let row = sqlx::query(
            "SELECT 1 AS sentinel FROM repositories
             WHERE id = ? AND deleted_at IS NOT NULL",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;
        Ok(row.is_some())
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
    async fn delete_soft_hides_row_and_marks_dirty() {
        let repo = fresh_repo().await;
        let r = Repository::new("doomed".into(), None, None);
        repo.insert(&r).await.unwrap();
        repo.delete(&r.id).await.unwrap();
        // Visible to UI surfaces? No.
        assert!(matches!(repo.get(&r.id).await, Err(StoreError::NotFound)));
        assert!(repo.list().await.unwrap().is_empty());
        // Tombstone reachable via the soft-delete helpers? Yes.
        assert!(repo.exists_soft_deleted(&r.id).await.unwrap());
        let pending = repo.list_dirty_soft_deletes().await.unwrap();
        assert_eq!(pending, vec![r.id.clone()]);
    }

    #[tokio::test]
    async fn delete_soft_deletes_notes_while_hard_deleting_other_children() {
        use crate::domain::{Note, NoteOriginKind, RunCommand};
        use crate::store::{NoteRepo, RunCommandRepo};

        let repo = fresh_repo().await;
        insert_user(&repo.db, "user-a").await;
        let r = Repository::new("doomed".into(), None, None);
        repo.insert(&r).await.unwrap();

        let notes = NoteRepo::new(repo.db.clone());
        for body in ["one", "two"] {
            let mut n = Note::new(r.id.clone(), body.into(), NoteOriginKind::Repository);
            n.origin_label = "Repository home".into();
            notes.insert_for_user(&n, "user-a").await.unwrap();
        }
        let rc = RunCommand::new(r.id.clone(), "Dev".into(), "npm run dev".into());
        RunCommandRepo::new(repo.db.clone())
            .insert(&rc)
            .await
            .unwrap();

        repo.delete(&r.id).await.unwrap();

        // Notes: rows retained, all tombstoned (the deliberate exception).
        let all = notes
            .list_all_by_repository_including_deleted(&r.id)
            .await
            .unwrap();
        assert_eq!(all.len(), 2, "note rows must survive repository removal");
        assert!(all.iter().all(|(_, deleted)| deleted.is_some()));

        // Run commands: hard-deleted (the existing policy, unchanged).
        let rc_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM run_commands WHERE repository_id = ?")
                .bind(&r.id)
                .fetch_one(&repo.db)
                .await
                .unwrap();
        assert_eq!(rc_count, 0);
    }

    async fn insert_user(db: &Db, id: &str) {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, created_at, updated_at, dirty)
             VALUES (?, ?, ?, ?, 0)",
        )
        .bind(id)
        .bind(id)
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reads_are_scoped_to_the_owner() {
        let repo = fresh_repo().await;
        insert_user(&repo.db, "user-a").await;
        insert_user(&repo.db, "user-b").await;

        let a = Repository::new("a-repo".into(), None, None);
        let b = Repository::new("b-repo".into(), None, None);
        repo.insert_for_user(&a, "user-a").await.unwrap();
        repo.insert_for_user(&b, "user-b").await.unwrap();

        // Each account sees only its own repositories.
        let a_list = repo.list_for_user("user-a").await.unwrap();
        assert_eq!(a_list.len(), 1);
        assert_eq!(a_list[0].id, a.id);

        // And can't fetch another account's repo by id.
        assert_eq!(repo.get_for_user(&a.id, "user-a").await.unwrap().id, a.id);
        assert!(matches!(
            repo.get_for_user(&b.id, "user-a").await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn mark_synced_clears_dirty() {
        let repo = fresh_repo().await;
        let r = Repository::new("doomed".into(), None, None);
        repo.insert(&r).await.unwrap();
        repo.delete(&r.id).await.unwrap();
        repo.mark_synced(&r.id).await.unwrap();
        assert!(repo.list_dirty_soft_deletes().await.unwrap().is_empty());
        // Tombstone is still present — exists_soft_deleted still true.
        assert!(repo.exists_soft_deleted(&r.id).await.unwrap());
    }
}
