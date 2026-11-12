//! `repository_config` rows: one per repository, created on first save.
//! Local to this machine (never pushed), so no `dirty` bookkeeping matters
//! beyond keeping the column's default.

use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::repository_config::{globs_from_json, globs_to_json};
use crate::domain::{CleanupAfterMerge, PrMode, PushPolicy, RepositoryConfig};

use super::error::StoreError;
use super::pool::Db;

#[derive(Clone)]
pub struct RepositoryConfigRepo {
    db: Db,
}

impl RepositoryConfigRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The repository's rules; all defaults when it has never been saved.
    /// Callers check repository ownership first (`get_for_user` on the
    /// repository) — the config row is keyed by repository id alone.
    pub async fn get(&self, repository_id: &str) -> Result<RepositoryConfig, StoreError> {
        let row = sqlx::query(
            "SELECT repository_id, default_base_branch, fetch_base_before_task, agents_may_push,
                    pr_mode, protected_paths, copy_untracked_globs, cleanup_after_merge,
                    pre_task_hook, branch_prefix_template, worktree_base_path, updated_at
             FROM repository_config WHERE repository_id = ?",
        )
        .bind(repository_id)
        .fetch_optional(&self.db)
        .await?;
        match row {
            Some(row) => row_to_config(&row),
            None => Ok(RepositoryConfig::defaults(repository_id)),
        }
    }

    /// Insert or replace every user-editable column; returns the stored row.
    pub async fn upsert(
        &self,
        config: &RepositoryConfig,
        user_id: Option<&str>,
    ) -> Result<RepositoryConfig, StoreError> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO repository_config (
                repository_id, default_base_branch, fetch_base_before_task, agents_may_push,
                pr_mode, protected_paths, copy_untracked_globs, cleanup_after_merge,
                pre_task_hook, branch_prefix_template, worktree_base_path,
                updated_at, user_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(repository_id) DO UPDATE SET
                default_base_branch = excluded.default_base_branch,
                fetch_base_before_task = excluded.fetch_base_before_task,
                agents_may_push = excluded.agents_may_push,
                pr_mode = excluded.pr_mode,
                protected_paths = excluded.protected_paths,
                copy_untracked_globs = excluded.copy_untracked_globs,
                cleanup_after_merge = excluded.cleanup_after_merge,
                pre_task_hook = excluded.pre_task_hook,
                branch_prefix_template = excluded.branch_prefix_template,
                worktree_base_path = excluded.worktree_base_path,
                updated_at = excluded.updated_at,
                user_id = COALESCE(repository_config.user_id, excluded.user_id)",
        )
        .bind(&config.repository_id)
        .bind(&config.default_base_branch)
        .bind(config.fetch_base_before_task as i64)
        .bind(config.agents_may_push.as_str())
        .bind(config.pr_mode.as_str())
        .bind(globs_to_json(&config.protected_paths))
        .bind(globs_to_json(&config.copy_untracked_globs))
        .bind(config.cleanup_after_merge.as_str())
        .bind(&config.pre_task_hook)
        .bind(&config.branch_prefix_template)
        .bind(&config.worktree_base_path)
        .bind(now.to_rfc3339())
        .bind(user_id)
        .execute(&self.db)
        .await?;
        self.get(&config.repository_id).await
    }
}

fn row_to_config(row: &sqlx::sqlite::SqliteRow) -> Result<RepositoryConfig, StoreError> {
    let mut config = RepositoryConfig::defaults(row.try_get::<String, _>("repository_id")?);
    config.default_base_branch = row.try_get("default_base_branch")?;
    config.fetch_base_before_task = row.try_get::<i64, _>("fetch_base_before_task")? != 0;
    config.agents_may_push =
        PushPolicy::from_str_lenient(&row.try_get::<String, _>("agents_may_push")?);
    config.pr_mode = PrMode::from_str_lenient(&row.try_get::<String, _>("pr_mode")?);
    config.protected_paths = globs_from_json(&row.try_get::<String, _>("protected_paths")?);
    config.copy_untracked_globs =
        globs_from_json(&row.try_get::<String, _>("copy_untracked_globs")?);
    config.cleanup_after_merge =
        CleanupAfterMerge::from_str_lenient(&row.try_get::<String, _>("cleanup_after_merge")?);
    config.pre_task_hook = row.try_get("pre_task_hook")?;
    config.branch_prefix_template = row.try_get("branch_prefix_template")?;
    config.worktree_base_path = row.try_get("worktree_base_path")?;
    let updated_at: String = row.try_get("updated_at")?;
    config.updated_at = DateTime::parse_from_rfc3339(&updated_at)
        .ok()
        .map(|d| d.with_timezone(&Utc));
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::{init_pool, RepositoryRepo};

    #[tokio::test]
    async fn defaults_until_saved_then_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repo).await.unwrap();
        let configs = RepositoryConfigRepo::new(pool.clone());

        let fresh = configs.get(&repo.id).await.unwrap();
        assert_eq!(fresh, RepositoryConfig::defaults(&repo.id));

        let mut cfg = fresh;
        cfg.default_base_branch = Some("develop".into());
        cfg.fetch_base_before_task = true;
        cfg.agents_may_push = PushPolicy::Deny;
        cfg.pr_mode = PrMode::Ready;
        cfg.protected_paths = vec!["migrations/**".into()];
        cfg.copy_untracked_globs = vec![".env".into()];
        cfg.cleanup_after_merge = CleanupAfterMerge::Always;
        cfg.pre_task_hook = Some("pnpm install".into());
        cfg.branch_prefix_template = Some("rb/{{slug}}".into());
        cfg.worktree_base_path = Some("~/wt".into());
        let saved = configs.upsert(&cfg, None).await.unwrap();
        assert!(saved.updated_at.is_some());
        assert_eq!(RepositoryConfig { updated_at: None, ..saved.clone() }, cfg);

        // Second save updates in place.
        cfg.pr_mode = PrMode::Draft;
        assert_eq!(configs.upsert(&cfg, None).await.unwrap().pr_mode, PrMode::Draft);

        // An unknown value written by a newer build reads as the default.
        sqlx::query("UPDATE repository_config SET agents_may_push = 'later' WHERE repository_id = ?")
            .bind(&repo.id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(configs.get(&repo.id).await.unwrap().agents_may_push, PushPolicy::Ask);
    }
}
