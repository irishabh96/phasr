use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::UserSettings;

use super::error::StoreError;
use super::pool::Db;

#[derive(Clone)]
pub struct SettingsRepo {
    db: Db,
}

impl SettingsRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Returns the settings row, inserting defaults on first use.
    pub async fn get_or_init(&self) -> Result<UserSettings, StoreError> {
        if let Some(settings) = self.try_get().await? {
            return Ok(settings);
        }
        let defaults = UserSettings::default();
        self.insert_defaults(&defaults).await?;
        Ok(defaults)
    }

    pub async fn update(&self, settings: &UserSettings) -> Result<UserSettings, StoreError> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE user_settings SET
                theme = ?, accent_color = ?, sans_font = ?, mono_font = ?,
                base_font_size = ?, cursor_style = ?, cursor_blink = ?,
                terminal_scrollback = ?, default_editor = ?, default_terminal = ?,
                default_agent_id = ?, disabled_agent_ids = ?, keyboard_shortcuts = ?,
                branch_prefix_template = ?, worktree_base_path = ?,
                default_merge_strategy = ?, auto_fetch_seconds = ?,
                honor_gpg_sign = ?, auto_push_on_commit = ?,
                updated_at = ?, dirty = 1
             WHERE id = 1",
        )
        .bind(&settings.theme)
        .bind(&settings.accent_color)
        .bind(&settings.sans_font)
        .bind(&settings.mono_font)
        .bind(settings.base_font_size)
        .bind(&settings.cursor_style)
        .bind(settings.cursor_blink as i64)
        .bind(settings.terminal_scrollback)
        .bind(&settings.default_editor)
        .bind(&settings.default_terminal)
        .bind(&settings.default_agent_id)
        .bind(&settings.disabled_agent_ids)
        .bind(&settings.keyboard_shortcuts)
        .bind(&settings.branch_prefix_template)
        .bind(&settings.worktree_base_path)
        .bind(&settings.default_merge_strategy)
        .bind(settings.auto_fetch_seconds)
        .bind(settings.honor_gpg_sign as i64)
        .bind(settings.auto_push_on_commit as i64)
        .bind(now.to_rfc3339())
        .execute(&self.db)
        .await?;

        let mut updated = settings.clone();
        updated.updated_at = now;
        Ok(updated)
    }

    async fn try_get(&self) -> Result<Option<UserSettings>, StoreError> {
        let row = sqlx::query(
            "SELECT theme, accent_color, sans_font, mono_font, base_font_size,
                    cursor_style, cursor_blink, terminal_scrollback,
                    default_editor, default_terminal, default_agent_id,
                    disabled_agent_ids,
                    keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                    default_merge_strategy, auto_fetch_seconds,
                    honor_gpg_sign, auto_push_on_commit, updated_at
             FROM user_settings WHERE id = 1",
        )
        .fetch_optional(&self.db)
        .await?;

        row.as_ref().map(row_to_settings).transpose()
    }

    async fn insert_defaults(&self, settings: &UserSettings) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO user_settings (
                id, theme, accent_color, sans_font, mono_font, base_font_size,
                cursor_style, cursor_blink, terminal_scrollback,
                default_editor, default_terminal, default_agent_id,
                disabled_agent_ids,
                keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                default_merge_strategy, auto_fetch_seconds,
                honor_gpg_sign, auto_push_on_commit, updated_at, synced_at, dirty
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&settings.theme)
        .bind(&settings.accent_color)
        .bind(&settings.sans_font)
        .bind(&settings.mono_font)
        .bind(settings.base_font_size)
        .bind(&settings.cursor_style)
        .bind(settings.cursor_blink as i64)
        .bind(settings.terminal_scrollback)
        .bind(&settings.default_editor)
        .bind(&settings.default_terminal)
        .bind(&settings.default_agent_id)
        .bind(&settings.disabled_agent_ids)
        .bind(&settings.keyboard_shortcuts)
        .bind(&settings.branch_prefix_template)
        .bind(&settings.worktree_base_path)
        .bind(&settings.default_merge_strategy)
        .bind(settings.auto_fetch_seconds)
        .bind(settings.honor_gpg_sign as i64)
        .bind(settings.auto_push_on_commit as i64)
        .bind(settings.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }
}

fn row_to_settings(row: &sqlx::sqlite::SqliteRow) -> Result<UserSettings, StoreError> {
    Ok(UserSettings {
        theme: row.try_get("theme")?,
        accent_color: row.try_get("accent_color")?,
        sans_font: row.try_get("sans_font")?,
        mono_font: row.try_get("mono_font")?,
        base_font_size: row.try_get("base_font_size")?,
        cursor_style: row.try_get("cursor_style")?,
        cursor_blink: row.try_get::<i64, _>("cursor_blink")? != 0,
        terminal_scrollback: row.try_get("terminal_scrollback")?,
        default_editor: row.try_get("default_editor")?,
        default_terminal: row.try_get("default_terminal")?,
        default_agent_id: row.try_get("default_agent_id")?,
        disabled_agent_ids: row.try_get("disabled_agent_ids")?,
        keyboard_shortcuts: row.try_get("keyboard_shortcuts")?,
        branch_prefix_template: row.try_get("branch_prefix_template")?,
        worktree_base_path: row.try_get("worktree_base_path")?,
        default_merge_strategy: row.try_get("default_merge_strategy")?,
        auto_fetch_seconds: row.try_get("auto_fetch_seconds")?,
        honor_gpg_sign: row.try_get::<i64, _>("honor_gpg_sign")? != 0,
        auto_push_on_commit: row.try_get::<i64, _>("auto_push_on_commit")? != 0,
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

    async fn fresh() -> SettingsRepo {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        SettingsRepo::new(pool)
    }

    #[tokio::test]
    async fn get_or_init_returns_defaults() {
        let repo = fresh().await;
        let settings = repo.get_or_init().await.unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.accent_color, "indigo");
        assert!(settings.cursor_blink);
        assert!(!settings.auto_push_on_commit);
    }

    #[tokio::test]
    async fn get_or_init_is_idempotent() {
        let repo = fresh().await;
        let first = repo.get_or_init().await.unwrap();
        let second = repo.get_or_init().await.unwrap();
        assert_eq!(first.updated_at, second.updated_at);
    }

    #[tokio::test]
    async fn update_persists_theme() {
        let repo = fresh().await;
        let mut settings = repo.get_or_init().await.unwrap();
        settings.theme = "light".into();
        settings.auto_push_on_commit = true;
        repo.update(&settings).await.unwrap();

        let reread = repo.get_or_init().await.unwrap();
        assert_eq!(reread.theme, "light");
        assert!(reread.auto_push_on_commit);
    }
}
