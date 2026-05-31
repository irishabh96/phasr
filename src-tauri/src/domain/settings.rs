use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub theme: String,
    pub accent_color: String,
    pub sans_font: String,
    pub mono_font: String,
    pub base_font_size: i64,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub terminal_scrollback: i64,
    pub default_editor: String,
    pub default_terminal: String,
    /// Stored as a JSON-encoded string in the database. Frontend parses it.
    pub keyboard_shortcuts: String,
    pub branch_prefix_template: String,
    pub worktree_base_path: String,
    pub default_merge_strategy: String,
    pub auto_fetch_seconds: i64,
    pub honor_gpg_sign: bool,
    pub auto_push_on_commit: bool,
    pub updated_at: DateTime<Utc>,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent_color: "indigo".into(),
            sans_font: "Inter".into(),
            mono_font: "JetBrains Mono".into(),
            base_font_size: 13,
            cursor_style: "block".into(),
            cursor_blink: true,
            terminal_scrollback: 10_000,
            default_editor: "vscode".into(),
            default_terminal: "iterm".into(),
            keyboard_shortcuts: "{}".into(),
            branch_prefix_template: "phasr/{{slug}}".into(),
            worktree_base_path: "~/.phasr/worktrees".into(),
            default_merge_strategy: "merge".into(),
            auto_fetch_seconds: 60,
            honor_gpg_sign: true,
            auto_push_on_commit: false,
            updated_at: Utc::now(),
        }
    }
}
