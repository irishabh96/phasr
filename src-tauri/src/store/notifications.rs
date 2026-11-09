use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{AppNotification, NotificationKind};

use super::check_runs::parse_ts;
use super::error::StoreError;
use super::pool::Db;

const MAX_LIST: i64 = 500;

/// The inbox (`notifications`) — local-only, owner-scoped. Entries are
/// hard-deleted: nothing syncs them, so there's no tombstone to keep.
#[derive(Clone)]
pub struct NotificationRepo {
    db: Db,
}

impl NotificationRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, n: &AppNotification, user_id: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO notifications (
                id, user_id, workspace_id, repository_id, kind, title, body, payload,
                created_at, read_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&n.id)
        .bind(user_id)
        .bind(&n.workspace_id)
        .bind(&n.repository_id)
        .bind(n.kind.as_str())
        .bind(&n.title)
        .bind(&n.body)
        .bind(n.payload.to_string())
        .bind(n.created_at.to_rfc3339())
        .bind(n.read_at.map(|t| t.to_rfc3339()))
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Newest first. Kinds this build doesn't know (a newer build wrote
    /// them into a shared DB) are skipped rather than failing the list.
    pub async fn list_for_user(
        &self,
        user_id: &str,
        unread_only: bool,
        limit: Option<i64>,
    ) -> Result<Vec<AppNotification>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, workspace_id, repository_id, kind, title, body, payload, created_at, read_at
             FROM notifications
             WHERE user_id = ? AND (? = 0 OR read_at IS NULL)
             ORDER BY created_at DESC
             LIMIT ?",
        )
        .bind(user_id)
        .bind(unread_only as i64)
        .bind(limit.unwrap_or(MAX_LIST).clamp(1, MAX_LIST))
        .fetch_all(&self.db)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            if let Some(n) = row_to_notification(row)? {
                out.push(n);
            }
        }
        Ok(out)
    }

    pub async fn unread_count(&self, user_id: &str) -> Result<i64, StoreError> {
        Ok(sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
        )
        .bind(user_id)
        .fetch_one(&self.db)
        .await?)
    }

    /// Whether the user already has an unread `kind` entry for this task —
    /// the dedupe rule (one unread "needs approval" per task, …).
    pub async fn has_unread(
        &self,
        user_id: &str,
        kind: NotificationKind,
        workspace_id: &str,
    ) -> Result<bool, StoreError> {
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications
             WHERE user_id = ? AND kind = ? AND workspace_id = ? AND read_at IS NULL",
        )
        .bind(user_id)
        .bind(kind.as_str())
        .bind(workspace_id)
        .fetch_one(&self.db)
        .await?;
        Ok(n > 0)
    }

    /// Mark `ids` read, or every unread entry when `ids` is `None`.
    pub async fn mark_read(&self, user_id: &str, ids: Option<&[String]>) -> Result<u64, StoreError> {
        let now = Utc::now().to_rfc3339();
        let Some(ids) = ids else {
            let res = sqlx::query(
                "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
            )
            .bind(&now)
            .bind(user_id)
            .execute(&self.db)
            .await?;
            return Ok(res.rows_affected());
        };
        let mut changed = 0;
        for id in ids {
            changed += sqlx::query(
                "UPDATE notifications SET read_at = ?
                 WHERE id = ? AND user_id = ? AND read_at IS NULL",
            )
            .bind(&now)
            .bind(id)
            .bind(user_id)
            .execute(&self.db)
            .await?
            .rows_affected();
        }
        Ok(changed)
    }

    /// Whether the task already has a "merged — remove its worktree?"
    /// suggestion (read or not): it's asked once per merge, however many
    /// paths (merge, continued merge, PR refresh) report that merge.
    pub async fn has_cleanup_suggestion(&self, user_id: &str, workspace_id: &str) -> Result<bool, StoreError> {
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications
             WHERE user_id = ? AND workspace_id = ? AND kind = 'task_finished'
               AND json_extract(payload, '$.suggestion') = 'cleanup'",
        )
        .bind(user_id)
        .bind(workspace_id)
        .fetch_one(&self.db)
        .await?;
        Ok(n > 0)
    }

    /// Mark the task's unread entries of `kind` read — e.g. the approval
    /// was answered, so its "needs approval" entry is no longer news.
    pub async fn mark_read_for_task(
        &self,
        user_id: &str,
        kind: NotificationKind,
        workspace_id: &str,
    ) -> Result<u64, StoreError> {
        let res = sqlx::query(
            "UPDATE notifications SET read_at = ?
             WHERE user_id = ? AND kind = ? AND workspace_id = ? AND read_at IS NULL",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(user_id)
        .bind(kind.as_str())
        .bind(workspace_id)
        .execute(&self.db)
        .await?;
        Ok(res.rows_affected())
    }

    pub async fn clear(&self, user_id: &str) -> Result<u64, StoreError> {
        let res = sqlx::query("DELETE FROM notifications WHERE user_id = ?")
            .bind(user_id)
            .execute(&self.db)
            .await?;
        Ok(res.rows_affected())
    }

    /// Drop every entry (any owner) created before `cutoff`.
    pub async fn prune_before(&self, cutoff: DateTime<Utc>) -> Result<u64, StoreError> {
        let res = sqlx::query("DELETE FROM notifications WHERE created_at < ?")
            .bind(cutoff.to_rfc3339())
            .execute(&self.db)
            .await?;
        Ok(res.rows_affected())
    }
}

fn row_to_notification(row: &sqlx::sqlite::SqliteRow) -> Result<Option<AppNotification>, StoreError> {
    let Some(kind) = NotificationKind::from_str(&row.try_get::<String, _>("kind")?) else {
        return Ok(None);
    };
    let payload: String = row.try_get("payload")?;
    Ok(Some(AppNotification {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        repository_id: row.try_get("repository_id")?,
        kind,
        title: row.try_get("title")?,
        body: row.try_get("body")?,
        payload: serde_json::from_str(&payload).unwrap_or_else(|_| serde_json::json!({})),
        created_at: parse_ts(row.try_get("created_at")?, "created_at")?,
        read_at: row
            .try_get::<Option<String>, _>("read_at")?
            .map(|v| parse_ts(v, "read_at"))
            .transpose()?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;

    #[tokio::test]
    async fn list_count_read_clear_prune() {
        let dir = tempfile::tempdir().unwrap();
        let repo = NotificationRepo::new(init_pool(&dir.path().join("t.sqlite")).await.unwrap());

        let mut old = AppNotification::new(NotificationKind::TaskFailed, "old");
        old.created_at = Utc::now() - chrono::Duration::days(31);
        let mut a = AppNotification::new(NotificationKind::NeedsApproval, "a");
        a.workspace_id = Some("ws".into());
        let b = AppNotification::new(NotificationKind::ChecksFinished, "b");
        for n in [&old, &a, &b] {
            repo.insert(n, "user-a").await.unwrap();
        }
        repo.insert(&AppNotification::new(NotificationKind::TaskFinished, "other"), "user-b")
            .await
            .unwrap();

        assert_eq!(repo.unread_count("user-a").await.unwrap(), 3);
        assert!(repo.has_unread("user-a", NotificationKind::NeedsApproval, "ws").await.unwrap());
        assert!(!repo.has_unread("user-b", NotificationKind::NeedsApproval, "ws").await.unwrap());
        let listed = repo.list_for_user("user-a", false, Some(2)).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].created_at >= listed[1].created_at, "newest first");

        assert_eq!(repo.mark_read("user-a", Some(&[a.id.clone()])).await.unwrap(), 1);
        assert!(!repo.has_unread("user-a", NotificationKind::NeedsApproval, "ws").await.unwrap());
        assert_eq!(repo.list_for_user("user-a", true, None).await.unwrap().len(), 2);
        // Another user's ids are untouched.
        assert_eq!(repo.mark_read("user-b", Some(&[b.id.clone()])).await.unwrap(), 0);

        assert_eq!(repo.prune_before(Utc::now() - chrono::Duration::days(30)).await.unwrap(), 1);
        assert_eq!(repo.mark_read("user-a", None).await.unwrap(), 1);
        assert_eq!(repo.unread_count("user-a").await.unwrap(), 0);
        assert_eq!(repo.clear("user-a").await.unwrap(), 2);
        assert_eq!(repo.unread_count("user-b").await.unwrap(), 1);
    }
}
