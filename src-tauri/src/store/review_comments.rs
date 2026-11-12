use chrono::Utc;
use sqlx::Row;

use crate::domain::{CommentSide, CommentStatus, ReviewComment};

use super::check_runs::parse_ts;
use super::error::StoreError;
use super::pool::Db;

macro_rules! comment_columns {
    () => {
        "id, workspace_id, path, line, side, anchor_text, body, status,
         created_at, updated_at, sent_at, resolved_at"
    };
}

/// Edits to a comment. `None` = unchanged.
#[derive(Debug, Default, Clone)]
pub struct ReviewCommentUpdate {
    pub body: Option<String>,
    pub status: Option<CommentStatus>,
}

/// `review_comments` — local-only (no sync), soft-deleted, owner-scoped.
#[derive(Clone)]
pub struct ReviewCommentRepo {
    db: Db,
}

impl ReviewCommentRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert_for_user(
        &self,
        comment: &ReviewComment,
        user_id: &str,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO review_comments (
                id, workspace_id, user_id, path, line, side, anchor_text, body, status,
                created_at, updated_at, sent_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&comment.id)
        .bind(&comment.workspace_id)
        .bind(user_id)
        .bind(&comment.path)
        .bind(comment.line)
        .bind(comment.side.as_str())
        .bind(&comment.anchor_text)
        .bind(&comment.body)
        .bind(comment.status.as_str())
        .bind(comment.created_at.to_rfc3339())
        .bind(comment.updated_at.to_rfc3339())
        .bind(comment.sent_at.map(|t| t.to_rfc3339()))
        .bind(comment.resolved_at.map(|t| t.to_rfc3339()))
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// A workspace's live comments, oldest first (the order they're sent).
    pub async fn list_for_workspace_for_user(
        &self,
        workspace_id: &str,
        user_id: &str,
    ) -> Result<Vec<ReviewComment>, StoreError> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            comment_columns!(),
            " FROM review_comments
              WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL
              ORDER BY created_at ASC, path ASC, line ASC"
        ))
        .bind(workspace_id)
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_comment).collect()
    }

    pub async fn get_for_user(&self, id: &str, user_id: &str) -> Result<ReviewComment, StoreError> {
        let row = sqlx::query(concat!(
            "SELECT ",
            comment_columns!(),
            " FROM review_comments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
        ))
        .bind(id)
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;
        row.as_ref().map(row_to_comment).transpose()?.ok_or(StoreError::NotFound)
    }

    /// Apply `patch` to the user's comment. A status change stamps
    /// `sent_at` / `resolved_at`; reopening (`pending`) clears `resolved_at`.
    pub async fn update_for_user(
        &self,
        id: &str,
        user_id: &str,
        patch: ReviewCommentUpdate,
    ) -> Result<ReviewComment, StoreError> {
        let mut current = self.get_for_user(id, user_id).await?;
        let now = Utc::now();
        if let Some(body) = patch.body {
            current.body = body;
        }
        if let Some(status) = patch.status {
            if status != current.status {
                match status {
                    CommentStatus::Sent => current.sent_at = Some(now),
                    CommentStatus::Resolved => current.resolved_at = Some(now),
                    CommentStatus::Pending => current.resolved_at = None,
                }
            }
            current.status = status;
        }
        current.updated_at = now;
        sqlx::query(
            "UPDATE review_comments SET body = ?, status = ?, updated_at = ?, sent_at = ?,
                resolved_at = ?
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(&current.body)
        .bind(current.status.as_str())
        .bind(current.updated_at.to_rfc3339())
        .bind(current.sent_at.map(|t| t.to_rfc3339()))
        .bind(current.resolved_at.map(|t| t.to_rfc3339()))
        .bind(id)
        .bind(user_id)
        .execute(&self.db)
        .await?;
        Ok(current)
    }

    /// Mark these comments sent (after the agent received them).
    pub async fn mark_sent(&self, ids: &[String], user_id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        for id in ids {
            sqlx::query(
                "UPDATE review_comments SET status = 'sent', sent_at = ?, updated_at = ?
                 WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
            )
            .bind(&now)
            .bind(&now)
            .bind(id)
            .bind(user_id)
            .execute(&self.db)
            .await?;
        }
        Ok(())
    }

    pub async fn delete_for_user(&self, id: &str, user_id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query(
            "UPDATE review_comments SET deleted_at = ?, updated_at = ?
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
}

fn row_to_comment(row: &sqlx::sqlite::SqliteRow) -> Result<ReviewComment, StoreError> {
    Ok(ReviewComment {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        path: row.try_get("path")?,
        line: row.try_get("line")?,
        side: CommentSide::parse_lenient(&row.try_get::<String, _>("side")?),
        anchor_text: row.try_get("anchor_text")?,
        body: row.try_get("body")?,
        status: CommentStatus::parse_lenient(&row.try_get::<String, _>("status")?),
        created_at: parse_ts(row.try_get("created_at")?, "created_at")?,
        updated_at: parse_ts(row.try_get("updated_at")?, "updated_at")?,
        sent_at: row
            .try_get::<Option<String>, _>("sent_at")?
            .map(|v| parse_ts(v, "sent_at"))
            .transpose()?,
        resolved_at: row
            .try_get::<Option<String>, _>("resolved_at")?
            .map(|v| parse_ts(v, "resolved_at"))
            .transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace};
    use crate::store::{init_pool, RepositoryRepo, WorkspaceRepo};

    #[tokio::test]
    async fn crud_is_owner_scoped_and_soft_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repository = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repository).await.unwrap();
        let ws = Workspace::new(repository.id, "t".into(), "c".into());
        WorkspaceRepo::new(pool.clone()).insert(&ws).await.unwrap();
        let repo = ReviewCommentRepo::new(pool);

        let mut c = ReviewComment::new(ws.id.clone(), "a.rs".into(), 3, CommentSide::New, "fix".into());
        c.anchor_text = Some("let x = 1;".into());
        repo.insert_for_user(&c, "user-a").await.unwrap();
        assert_eq!(repo.list_for_workspace_for_user(&ws.id, "user-a").await.unwrap(), vec![c.clone()]);
        assert!(repo.list_for_workspace_for_user(&ws.id, "user-b").await.unwrap().is_empty());
        assert!(matches!(repo.get_for_user(&c.id, "user-b").await, Err(StoreError::NotFound)));

        let resolved = repo
            .update_for_user(
                &c.id,
                "user-a",
                ReviewCommentUpdate {
                    body: Some("fixed?".into()),
                    status: Some(CommentStatus::Resolved),
                },
            )
            .await
            .unwrap();
        assert_eq!(resolved.body, "fixed?");
        assert!(resolved.resolved_at.is_some());
        assert_eq!(repo.get_for_user(&c.id, "user-a").await.unwrap(), resolved);

        repo.mark_sent(std::slice::from_ref(&c.id), "user-a").await.unwrap();
        let sent = repo.get_for_user(&c.id, "user-a").await.unwrap();
        assert_eq!(sent.status, CommentStatus::Sent);
        assert!(sent.sent_at.is_some());

        assert!(matches!(repo.delete_for_user(&c.id, "user-b").await, Err(StoreError::NotFound)));
        repo.delete_for_user(&c.id, "user-a").await.unwrap();
        assert!(repo.list_for_workspace_for_user(&ws.id, "user-a").await.unwrap().is_empty());
    }
}
