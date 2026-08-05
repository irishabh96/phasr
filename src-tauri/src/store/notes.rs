use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{Note, NoteOriginKind};

use super::error::StoreError;
use super::pool::Db;

/// Patch for `update_for_user`. Only the body is user-mutable —
/// provenance and `created_at` are immutable by design.
#[derive(Debug, Default, Clone)]
pub struct NoteUpdate {
    pub body: Option<String>,
    /// Optimistic-concurrency guard: when set, the UPDATE only applies
    /// if the row's `updated_at` still matches. A miss on an otherwise
    /// live row surfaces as `StoreError::Conflict` so the UI can offer
    /// reload-and-retry instead of silently clobbering the other edit.
    pub expected_updated_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct NoteRepo {
    db: Db,
}

const NOTE_COLUMNS: &str = "id, repository_id, body, origin_kind, origin_workspace_id,
        origin_workspace_name, origin_terminal_id, origin_label, created_at, updated_at";

impl NoteRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert_for_user(&self, note: &Note, user_id: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO repository_notes (
                id, user_id, repository_id, body, origin_kind, origin_workspace_id,
                origin_workspace_name, origin_terminal_id, origin_label,
                created_at, updated_at, deleted_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)",
        )
        .bind(&note.id)
        .bind(user_id)
        .bind(&note.repository_id)
        .bind(&note.body)
        .bind(note.origin_kind.as_str())
        .bind(&note.origin_workspace_id)
        .bind(&note.origin_workspace_name)
        .bind(&note.origin_terminal_id)
        .bind(&note.origin_label)
        .bind(note.created_at.to_rfc3339())
        .bind(note.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Owner-scoped list — newest first, stable `id` tiebreak so two
    /// notes written in the same second never swap between fetches.
    pub async fn list_by_repository_for_user(
        &self,
        repository_id: &str,
        user_id: &str,
    ) -> Result<Vec<Note>, StoreError> {
        let rows = sqlx::query(&format!(
            "SELECT {NOTE_COLUMNS}
             FROM repository_notes
             WHERE repository_id = ? AND user_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC, id DESC",
        ))
        .bind(repository_id)
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_note).collect()
    }

    pub async fn get_for_user(&self, id: &str, user_id: &str) -> Result<Note, StoreError> {
        let row = sqlx::query(&format!(
            "SELECT {NOTE_COLUMNS}
             FROM repository_notes
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        ))
        .bind(id)
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;
        row.as_ref().map(row_to_note).transpose()?.ok_or(StoreError::NotFound)
    }

    /// Body-only update. Provenance and `created_at` are never in the
    /// SET list. Returns the updated row.
    pub async fn update_for_user(
        &self,
        id: &str,
        user_id: &str,
        patch: NoteUpdate,
    ) -> Result<Note, StoreError> {
        let mut current = self.get_for_user(id, user_id).await?;
        let guarded = patch.expected_updated_at.is_some();
        if let Some(body) = patch.body {
            current.body = body;
        }
        current.updated_at = Utc::now();

        let mut sql = String::from(
            "UPDATE repository_notes SET body = ?, updated_at = ?, dirty = 1
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        );
        if guarded {
            sql.push_str(" AND updated_at = ?");
        }
        let mut query = sqlx::query(&sql)
            .bind(&current.body)
            .bind(current.updated_at.to_rfc3339())
            .bind(id)
            .bind(user_id);
        if let Some(expected) = patch.expected_updated_at {
            query = query.bind(expected.to_rfc3339());
        }
        let res = query.execute(&self.db).await?;
        if res.rows_affected() == 0 {
            // The row existed above (get_for_user succeeded), so a
            // guarded zero-row update means another writer got there
            // first; unguarded, the row was deleted in between.
            return Err(if guarded {
                StoreError::Conflict
            } else {
                StoreError::NotFound
            });
        }
        Ok(current)
    }

    /// Soft delete. The row stays in SQLite; every read filters it out.
    pub async fn soft_delete_for_user(&self, id: &str, user_id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query(
            "UPDATE repository_notes
             SET deleted_at = ?, updated_at = ?, dirty = 1
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(user_id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Tombstone every live note of a repository inside an existing
    /// transaction — shared by BOTH repository-delete paths (local
    /// removal and the cloud-tombstone mirror). Idempotent: the
    /// `deleted_at IS NULL` predicate makes a re-run a no-op.
    pub async fn soft_delete_by_repository(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        repository_id: &str,
        mark_synced: bool,
    ) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        let (dirty, synced_sql) = if mark_synced {
            // Cloud-mirror path: mirror semantics, nothing left to push.
            (0i64, Some(now.clone()))
        } else {
            (1i64, None)
        };
        sqlx::query(
            "UPDATE repository_notes
             SET deleted_at = ?, updated_at = ?, dirty = ?, synced_at = COALESCE(?, synced_at)
             WHERE repository_id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(dirty)
        .bind(synced_sql)
        .bind(repository_id)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    /// Unscoped list including tombstones — tests only.
    #[cfg(test)]
    pub async fn list_all_by_repository_including_deleted(
        &self,
        repository_id: &str,
    ) -> Result<Vec<(String, Option<String>)>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, deleted_at FROM repository_notes WHERE repository_id = ?",
        )
        .bind(repository_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter()
            .map(|r| {
                Ok((
                    r.try_get::<String, _>("id")?,
                    r.try_get::<Option<String>, _>("deleted_at")?,
                ))
            })
            .collect()
    }
}

fn row_to_note(row: &sqlx::sqlite::SqliteRow) -> Result<Note, StoreError> {
    let kind_raw: String = row.try_get("origin_kind")?;
    let origin_kind =
        NoteOriginKind::from_str(&kind_raw).ok_or_else(|| StoreError::InvalidValue {
            field: "origin_kind",
            message: format!("unknown origin kind `{kind_raw}`"),
        })?;
    Ok(Note {
        id: row.try_get("id")?,
        repository_id: row.try_get("repository_id")?,
        body: row.try_get("body")?,
        origin_kind,
        origin_workspace_id: row.try_get("origin_workspace_id")?,
        origin_workspace_name: row.try_get("origin_workspace_name")?,
        origin_terminal_id: row.try_get("origin_terminal_id")?,
        origin_label: row.try_get("origin_label")?,
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

    const USER: &str = "user-a";
    const OTHER_USER: &str = "user-b";

    async fn insert_user(db: &Db, id: &str) {
        let now = chrono::Utc::now().to_rfc3339();
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

    async fn fresh() -> (NoteRepo, Repository, Db) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);

        insert_user(&pool, USER).await;
        insert_user(&pool, OTHER_USER).await;
        let repository = Repository::new("repo".into(), None, None);
        RepositoryRepo::new(pool.clone())
            .insert(&repository)
            .await
            .unwrap();
        (NoteRepo::new(pool.clone()), repository, pool)
    }

    fn note(repository_id: &str, body: &str) -> Note {
        let mut n = Note::new(
            repository_id.to_string(),
            body.to_string(),
            NoteOriginKind::Workspace,
        );
        n.origin_label = "Agent".into();
        n.origin_workspace_name = Some("fix-auth".into());
        n
    }

    #[tokio::test]
    async fn insert_then_list_returns_the_note() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "seed script needs DATABASE_URL");
        repo.insert_for_user(&n, USER).await.unwrap();

        let listed = repo
            .list_by_repository_for_user(&repository.id, USER)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].body, "seed script needs DATABASE_URL");
        assert_eq!(listed[0].origin_kind, NoteOriginKind::Workspace);
        assert_eq!(listed[0].origin_workspace_name.as_deref(), Some("fix-auth"));
    }

    #[tokio::test]
    async fn list_is_scoped_to_the_repository() {
        let (repo, repository, db) = fresh().await;
        let other = Repository::new("other".into(), None, None);
        RepositoryRepo::new(db).insert(&other).await.unwrap();

        repo.insert_for_user(&note(&repository.id, "mine"), USER)
            .await
            .unwrap();
        repo.insert_for_user(&note(&other.id, "theirs"), USER)
            .await
            .unwrap();

        let listed = repo
            .list_by_repository_for_user(&repository.id, USER)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].body, "mine");
    }

    #[tokio::test]
    async fn reads_are_scoped_to_the_owner() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "secret");
        repo.insert_for_user(&n, USER).await.unwrap();

        assert!(repo
            .list_by_repository_for_user(&repository.id, OTHER_USER)
            .await
            .unwrap()
            .is_empty());
        assert!(matches!(
            repo.get_for_user(&n.id, OTHER_USER).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            repo.soft_delete_for_user(&n.id, OTHER_USER).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn soft_delete_sets_tombstone_and_keeps_the_row() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "gone soon");
        repo.insert_for_user(&n, USER).await.unwrap();

        repo.soft_delete_for_user(&n.id, USER).await.unwrap();

        assert!(repo
            .list_by_repository_for_user(&repository.id, USER)
            .await
            .unwrap()
            .is_empty());
        let all = repo
            .list_all_by_repository_including_deleted(&repository.id)
            .await
            .unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].1.is_some(), "row must remain with deleted_at set");
    }

    #[tokio::test]
    async fn soft_delete_twice_returns_not_found() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "x");
        repo.insert_for_user(&n, USER).await.unwrap();
        repo.soft_delete_for_user(&n.id, USER).await.unwrap();
        assert!(matches!(
            repo.soft_delete_for_user(&n.id, USER).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn update_changes_body_and_updated_at_but_not_created_at_or_provenance() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "v1");
        repo.insert_for_user(&n, USER).await.unwrap();

        let updated = repo
            .update_for_user(
                &n.id,
                USER,
                NoteUpdate {
                    body: Some("v2".into()),
                    expected_updated_at: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(updated.body, "v2");
        assert_eq!(updated.created_at, n.created_at);
        assert!(updated.updated_at > n.updated_at);
        assert_eq!(updated.origin_label, "Agent");
        assert_eq!(updated.origin_workspace_name.as_deref(), Some("fix-auth"));
    }

    #[tokio::test]
    async fn update_with_stale_expected_updated_at_conflicts() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "v1");
        repo.insert_for_user(&n, USER).await.unwrap();

        // First writer wins.
        let winner = repo
            .update_for_user(
                &n.id,
                USER,
                NoteUpdate {
                    body: Some("winner".into()),
                    expected_updated_at: Some(n.updated_at),
                },
            )
            .await
            .unwrap();

        // Second writer holds the original updated_at — must conflict.
        let res = repo
            .update_for_user(
                &n.id,
                USER,
                NoteUpdate {
                    body: Some("loser".into()),
                    expected_updated_at: Some(n.updated_at),
                },
            )
            .await;
        assert!(matches!(res, Err(StoreError::Conflict)));

        let listed = repo
            .list_by_repository_for_user(&repository.id, USER)
            .await
            .unwrap();
        assert_eq!(listed[0].body, "winner");
        assert_eq!(listed[0].updated_at, winner.updated_at);
    }

    #[tokio::test]
    async fn update_of_a_soft_deleted_note_returns_not_found() {
        let (repo, repository, _db) = fresh().await;
        let n = note(&repository.id, "x");
        repo.insert_for_user(&n, USER).await.unwrap();
        repo.soft_delete_for_user(&n.id, USER).await.unwrap();
        assert!(matches!(
            repo.update_for_user(
                &n.id,
                USER,
                NoteUpdate {
                    body: Some("y".into()),
                    expected_updated_at: None
                }
            )
            .await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn list_orders_newest_first_with_stable_tiebreak() {
        let (repo, repository, _db) = fresh().await;
        let mut a = note(&repository.id, "a");
        let mut b = note(&repository.id, "b");
        // Same timestamp — the id tiebreak must keep the order stable.
        b.created_at = a.created_at;
        b.updated_at = a.updated_at;
        a.id = "aaaa".into();
        b.id = "bbbb".into();
        repo.insert_for_user(&a, USER).await.unwrap();
        repo.insert_for_user(&b, USER).await.unwrap();

        for _ in 0..3 {
            let listed = repo
                .list_by_repository_for_user(&repository.id, USER)
                .await
                .unwrap();
            assert_eq!(
                listed.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
                vec!["bbbb", "aaaa"]
            );
        }
    }

    #[tokio::test]
    async fn soft_delete_by_repository_tombstones_all_live_notes_and_is_idempotent() {
        let (repo, repository, db) = fresh().await;
        repo.insert_for_user(&note(&repository.id, "one"), USER)
            .await
            .unwrap();
        repo.insert_for_user(&note(&repository.id, "two"), USER)
            .await
            .unwrap();

        let mut tx = db.begin().await.unwrap();
        NoteRepo::soft_delete_by_repository(&mut tx, &repository.id, false)
            .await
            .unwrap();
        // Idempotent inside the same tx.
        NoteRepo::soft_delete_by_repository(&mut tx, &repository.id, false)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert!(repo
            .list_by_repository_for_user(&repository.id, USER)
            .await
            .unwrap()
            .is_empty());
        let all = repo
            .list_all_by_repository_including_deleted(&repository.id)
            .await
            .unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|(_, deleted)| deleted.is_some()));
    }
}
