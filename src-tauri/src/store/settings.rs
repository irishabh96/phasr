use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{
    agent_commands_from_json, agent_commands_to_json, NotificationPrefs, PermissionMode, UserSettings,
};

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

    /// The stored settings, or the defaults when no row exists yet —
    /// without inserting one (for background readers like sync pull and
    /// task launch, which mustn't create a dirty row as a side effect).
    pub async fn get_or_default(&self) -> Result<UserSettings, StoreError> {
        Ok(self.try_get().await?.unwrap_or_default())
    }

    pub async fn update(&self, settings: &UserSettings) -> Result<UserSettings, StoreError> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE user_settings SET
                theme = ?, accent_color = ?, sans_font = ?, mono_font = ?,
                base_font_size = ?, cursor_style = ?, cursor_blink = ?,
                terminal_scrollback = ?, default_editor = ?, default_terminal = ?,
                keyboard_shortcuts = ?,
                branch_prefix_template = ?, worktree_base_path = ?,
                default_merge_strategy = ?, auto_fetch_seconds = ?,
                honor_gpg_sign = ?, auto_push_on_commit = ?,
                default_permission_mode = ?, agent_commands = ?, notification_prefs = ?,
                terminal_shell = ?, copy_on_select = ?,
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
        .bind(&settings.keyboard_shortcuts)
        .bind(&settings.branch_prefix_template)
        .bind(&settings.worktree_base_path)
        .bind(&settings.default_merge_strategy)
        .bind(settings.auto_fetch_seconds)
        .bind(settings.honor_gpg_sign as i64)
        .bind(settings.auto_push_on_commit as i64)
        .bind(settings.default_permission_mode.as_str())
        .bind(agent_commands_to_json(&settings.agent_commands))
        .bind(settings.notification_prefs.to_json())
        .bind(&settings.terminal_shell)
        .bind(settings.copy_on_select as i64)
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
                    default_editor, default_terminal,
                    keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                    default_merge_strategy, auto_fetch_seconds,
                    honor_gpg_sign, auto_push_on_commit,
                    default_permission_mode, agent_commands, notification_prefs,
                    terminal_shell, copy_on_select, updated_at
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
                default_editor, default_terminal,
                keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                default_merge_strategy, auto_fetch_seconds,
                honor_gpg_sign, auto_push_on_commit,
                default_permission_mode, agent_commands, notification_prefs,
                terminal_shell, copy_on_select, updated_at,
                synced_at, dirty
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
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
        .bind(&settings.keyboard_shortcuts)
        .bind(&settings.branch_prefix_template)
        .bind(&settings.worktree_base_path)
        .bind(&settings.default_merge_strategy)
        .bind(settings.auto_fetch_seconds)
        .bind(settings.honor_gpg_sign as i64)
        .bind(settings.auto_push_on_commit as i64)
        .bind(settings.default_permission_mode.as_str())
        .bind(agent_commands_to_json(&settings.agent_commands))
        .bind(settings.notification_prefs.to_json())
        .bind(&settings.terminal_shell)
        .bind(settings.copy_on_select as i64)
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
        keyboard_shortcuts: row.try_get("keyboard_shortcuts")?,
        branch_prefix_template: row.try_get("branch_prefix_template")?,
        worktree_base_path: row.try_get("worktree_base_path")?,
        default_merge_strategy: row.try_get("default_merge_strategy")?,
        auto_fetch_seconds: row.try_get("auto_fetch_seconds")?,
        honor_gpg_sign: row.try_get::<i64, _>("honor_gpg_sign")? != 0,
        auto_push_on_commit: row.try_get::<i64, _>("auto_push_on_commit")? != 0,
        // Lenient: a mode string from a newer build falls back to the
        // default instead of making settings unreadable.
        default_permission_mode: PermissionMode::from_str(
            &row.try_get::<String, _>("default_permission_mode")?,
        )
        .unwrap_or_default(),
        agent_commands: agent_commands_from_json(&row.try_get::<String, _>("agent_commands")?),
        notification_prefs: NotificationPrefs::from_json(
            &row.try_get::<String, _>("notification_prefs")?,
        ),
        terminal_shell: row.try_get("terminal_shell")?,
        copy_on_select: row.try_get::<i64, _>("copy_on_select")? != 0,
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

    #[tokio::test]
    async fn new_installs_default_to_ask_shell_with_no_overrides() {
        let repo = fresh().await;
        let settings = repo.get_or_init().await.unwrap();
        assert_eq!(settings.default_permission_mode, PermissionMode::AskShell);
        assert!(settings.agent_commands.is_empty());
    }

    #[tokio::test]
    async fn update_persists_permission_mode_and_agent_commands() {
        let repo = fresh().await;
        let mut settings = repo.get_or_init().await.unwrap();
        settings.default_permission_mode = PermissionMode::AskEdits;
        settings
            .agent_commands
            .insert("codex".into(), "codex --profile work {{permissions}}".into());
        repo.update(&settings).await.unwrap();

        let reread = repo.get_or_init().await.unwrap();
        assert_eq!(reread.default_permission_mode, PermissionMode::AskEdits);
        assert_eq!(
            reread.agent_commands.get("codex").map(String::as_str),
            Some("codex --profile work {{permissions}}")
        );
    }

    #[tokio::test]
    async fn terminal_shell_and_copy_on_select_default_and_round_trip() {
        let repo = fresh().await;
        assert_eq!(repo.get_or_default().await.unwrap().terminal_shell, "");
        let mut settings = repo.get_or_init().await.unwrap();
        assert_eq!(settings.terminal_shell, "");
        assert!(!settings.copy_on_select);
        settings.terminal_shell = "/bin/zsh".into();
        settings.copy_on_select = true;
        repo.update(&settings).await.unwrap();
        let reread = repo.get_or_init().await.unwrap();
        assert_eq!(reread.terminal_shell, "/bin/zsh");
        assert!(reread.copy_on_select);
    }

    #[tokio::test]
    async fn notification_prefs_default_and_round_trip() {
        let repo = fresh().await;
        let mut settings = repo.get_or_init().await.unwrap();
        assert_eq!(settings.notification_prefs, NotificationPrefs::default());
        settings.notification_prefs.background_only = false;
        settings.notification_prefs.quiet_hours.enabled = true;
        if let Some(c) = settings.notification_prefs.matrix.get_mut("task_failed") {
            c.sound = true;
        }
        repo.update(&settings).await.unwrap();
        let reread = repo.get_or_init().await.unwrap();
        assert_eq!(reread.notification_prefs, settings.notification_prefs);
    }
}
