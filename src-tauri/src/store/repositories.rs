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

    /// Every row `create_repository`'s dedupe must consider: the caller's
    /// rows plus legacy `user_id IS NULL` rows, INCLUDING tombstones (the
    /// second element is `true` when the row is soft-deleted). Deliberately
    /// not a UI surface — everything user-facing keeps going through
    /// `list_for_user`.
    pub async fn list_for_dedupe(
        &self,
        user_id: &str,
    ) -> Result<Vec<(Repository, bool)>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, remote_url, local_path, default_branch,
                    created_at, updated_at, deleted_at
             FROM repositories
             WHERE user_id = ? OR user_id IS NULL
             ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter()
            .map(|row| {
                let deleted: Option<String> = row.try_get("deleted_at")?;
                Ok((row_to_repository(row)?, deleted.is_some()))
            })
            .collect()
    }

    /// Bring a tombstoned row back to life for `user_id`, applying `patch`
    /// in the same write. Used when the user re-adds a folder whose row was
    /// previously removed: reusing the id keeps cloud children (and any
    /// notes referencing the row) attached to the same repository instead
    /// of stranding them under a dead id. `dirty = 1` makes the next push
    /// clear the cloud-side tombstone too.
    pub async fn revive_for_user(
        &self,
        id: &str,
        user_id: &str,
        patch: RepositoryUpdate,
    ) -> Result<Repository, StoreError> {
        let now = Utc::now();
        let res = sqlx::query(
            "UPDATE repositories SET
                deleted_at = NULL,
                user_id = ?,
                name = COALESCE(?, name),
                remote_url = COALESCE(?, remote_url),
                local_path = COALESCE(?, local_path),
                default_branch = COALESCE(?, default_branch),
                updated_at = ?, dirty = 1
             WHERE id = ? AND deleted_at IS NOT NULL",
        )
        .bind(user_id)
        .bind(patch.name)
        .bind(patch.remote_url.flatten())
        .bind(patch.local_path.flatten())
        .bind(patch.default_branch)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        self.get(id).await
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
    /// `repository_notes` is the deliberate exception and is not touched
    /// at all — not deleted, not tombstoned. Notes are the user's todos;
    /// disconnecting a repository from phasr is not a reason to destroy
    /// them. They keep referencing this row, which survives as a
    /// tombstone, so their provenance still resolves.
    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();

        let mut tx = self.db.begin().await?;

        // `repository_notes` is deliberately NOT touched here. Notes are
        // todos the user keeps; removing a repository from phasr must not
        // destroy them (nor hide them — they aren't tombstoned either).
        // They keep pointing at this repository row, which survives as a
        // soft-deleted tombstone, so their provenance still resolves.

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

    /// Repositories soft-deleted locally but not yet pushed. Retained for
    /// tests only — the sync worker queries this state with its own SQL.
    #[cfg(test)]
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

    /// Clear `dirty` after the cloud-side mirror confirms. Retained for
    /// tests only — the sync worker has its own `mark_synced`.
    #[cfg(test)]
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

    /// `true` when a row with this id is soft-deleted locally. Retained
    /// for tests only — the sync worker checks tombstones with its own SQL.
    #[cfg(test)]
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
    async fn delete_leaves_notes_untouched_while_hard_deleting_other_children() {
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

        // Notes are todos the user keeps: removing the repository must
        // neither delete NOR hide them.
        let all = notes
            .list_all_by_repository_including_deleted(&r.id)
            .await
            .unwrap();
        assert_eq!(all.len(), 2, "note rows must survive repository removal");
        assert!(
            all.iter().all(|(_, deleted)| deleted.is_none()),
            "notes must stay live — a removed repository is not a reason to tombstone a todo"
        );

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
    async fn revive_for_user_brings_tombstone_back_with_patch() {
        let repo = fresh_repo().await;
        insert_user(&repo.db, "user-a").await;
        let r = Repository::new("old-name".into(), Some("/tmp/app".into()), None);
        repo.insert_for_user(&r, "user-a").await.unwrap();
        repo.delete(&r.id).await.unwrap();

        let revived = repo
            .revive_for_user(
                &r.id,
                "user-a",
                RepositoryUpdate {
                    name: Some("new-name".into()),
                    remote_url: Some(Some("https://example.com/app.git".into())),
                    local_path: Some(Some("/tmp/app".into())),
                    default_branch: Some("develop".into()),
                },
            )
            .await
            .unwrap();

        assert_eq!(revived.id, r.id, "revive must keep the original id");
        assert_eq!(revived.name, "new-name");
        assert_eq!(revived.local_path.as_deref(), Some("/tmp/app"));
        assert_eq!(revived.default_branch, "develop");
        // Live again, tombstone gone.
        assert!(repo.get(&r.id).await.is_ok());
        assert!(!repo.exists_soft_deleted(&r.id).await.unwrap());
        // Reviving a LIVE row is NotFound — the guard is deleted_at IS NOT NULL.
        assert!(matches!(
            repo.revive_for_user(&r.id, "user-a", RepositoryUpdate::default())
                .await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn list_for_dedupe_sees_tombstones_and_legacy_rows_but_not_other_users() {
        let repo = fresh_repo().await;
        insert_user(&repo.db, "user-a").await;
        insert_user(&repo.db, "user-b").await;

        let mine = Repository::new("mine".into(), Some("/tmp/mine".into()), None);
        repo.insert_for_user(&mine, "user-a").await.unwrap();
        let legacy = Repository::new("legacy".into(), Some("/tmp/legacy".into()), None);
        repo.insert(&legacy).await.unwrap(); // user_id IS NULL
        let dead = Repository::new("dead".into(), Some("/tmp/dead".into()), None);
        repo.insert_for_user(&dead, "user-a").await.unwrap();
        repo.delete(&dead.id).await.unwrap();
        let theirs = Repository::new("theirs".into(), Some("/tmp/theirs".into()), None);
        repo.insert_for_user(&theirs, "user-b").await.unwrap();

        let rows = repo.list_for_dedupe("user-a").await.unwrap();
        let seen: Vec<(String, bool)> = rows
            .iter()
            .map(|(r, deleted)| (r.name.clone(), *deleted))
            .collect();
        assert!(seen.contains(&("mine".into(), false)));
        assert!(seen.contains(&("legacy".into(), false)));
        assert!(seen.contains(&("dead".into(), true)));
        assert!(!seen.iter().any(|(name, _)| name == "theirs"));
    }

    #[tokio::test]
    async fn unique_index_rejects_second_active_row_on_same_path() {
        let repo = fresh_repo().await;
        let a = Repository::new("a".into(), Some("/tmp/same-folder".into()), None);
        repo.insert(&a).await.unwrap();

        // A second ACTIVE row on the same path violates the partial index…
        let b = Repository::new("b".into(), Some("/tmp/same-folder".into()), None);
        assert!(repo.insert(&b).await.is_err());

        // …but tombstones don't count against it.
        repo.delete(&a.id).await.unwrap();
        repo.insert(&b).await.unwrap();
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
