use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::{Agent, PermissionMode};
use super::notification::NotificationPrefs;

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
    /// Permission mode for new tasks that don't pick one. `serde(default)`
    /// on this and `agent_commands` so a payload from a frontend that
    /// predates them still deserializes (`update_user_settings` then keeps
    /// the stored values rather than resetting them — see that command).
    #[serde(default)]
    pub default_permission_mode: PermissionMode,
    /// Per-agent launch template overrides, keyed by `Agent::as_str()`
    /// (`{"claude": "claude --model opus {{permissions}}"}`). Stored as a
    /// JSON object string. Keys are plain strings, not `Agent`, so a key a
    /// newer build added doesn't make this build fail to read settings.
    #[serde(default)]
    pub agent_commands: BTreeMap<String, String>,
    /// Inbox delivery matrix, background-only, quiet hours. Stored as a
    /// JSON object string, read leniently (`NotificationPrefs::from_json`).
    /// `serde(default)` + the same keep-if-absent rule as the fields above.
    #[serde(default)]
    pub notification_prefs: NotificationPrefs,
    /// Shell for session terminals and task PTYs; blank = the account's
    /// login shell. Synced, so it may name a shell this machine lacks —
    /// `pty::shell::usable_shell_override` falls back then. Same
    /// keep-if-absent rule as the fields above.
    #[serde(default)]
    pub terminal_shell: String,
    /// Copy a terminal selection to the clipboard on mouse-up (frontend).
    #[serde(default)]
    pub copy_on_select: bool,
    pub updated_at: DateTime<Utc>,
}

impl UserSettings {
    /// The user's template for `agent`, if they've set a non-blank one.
    pub fn agent_command_override(&self, agent: Agent) -> Option<&str> {
        self.agent_commands
            .get(agent.as_str())
            .map(|template| template.trim())
            .filter(|template| !template.is_empty())
    }
}

/// `agent_commands` as stored (JSON object text). Never fails: an object
/// always serializes.
pub fn agent_commands_to_json(commands: &BTreeMap<String, String>) -> String {
    serde_json::to_string(commands).unwrap_or_else(|_| "{}".into())
}

/// Read the stored JSON leniently: a malformed or non-object value (a hand
/// edit, a future shape) means "no overrides", not "settings unreadable" —
/// every agent still has its built-in template.
pub fn agent_commands_from_json(raw: &str) -> BTreeMap<String, String> {
    serde_json::from_str(raw).unwrap_or_default()
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
            default_permission_mode: PermissionMode::default(),
            agent_commands: BTreeMap::new(),
            notification_prefs: NotificationPrefs::default(),
            terminal_shell: String::new(),
            copy_on_select: false,
            updated_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A payload from a frontend that predates permission modes (no
    /// `defaultPermissionMode` / `agentCommands`) must still deserialize.
    #[test]
    fn deserializes_a_payload_without_the_new_fields() {
        let mut json = serde_json::to_value(UserSettings::default()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.remove("defaultPermissionMode");
        obj.remove("agentCommands");
        obj.remove("notificationPrefs");
        obj.remove("terminalShell");
        obj.remove("copyOnSelect");
        let parsed: UserSettings = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.terminal_shell, "");
        assert!(!parsed.copy_on_select);
        assert_eq!(parsed.default_permission_mode, PermissionMode::AskShell);
        assert!(parsed.agent_commands.is_empty());
        assert_eq!(parsed.notification_prefs, NotificationPrefs::default());
    }

    #[test]
    fn round_trips_the_new_fields_in_camel_case() {
        let mut settings = UserSettings::default();
        settings.default_permission_mode = PermissionMode::SkipAll;
        settings
            .agent_commands
            .insert("claude".into(), "claude --model opus {{permissions}}".into());
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["defaultPermissionMode"], "skip-all");
        assert_eq!(
            json["agentCommands"]["claude"],
            "claude --model opus {{permissions}}"
        );
        let back: UserSettings = serde_json::from_value(json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn override_lookup_ignores_blank_templates() {
        let mut settings = UserSettings::default();
        settings.agent_commands.insert("claude".into(), "   ".into());
        settings.agent_commands.insert("codex".into(), " codex {{permissions}} ".into());
        assert_eq!(settings.agent_command_override(Agent::Claude), None);
        assert_eq!(
            settings.agent_command_override(Agent::Codex),
            Some("codex {{permissions}}")
        );
        assert_eq!(settings.agent_command_override(Agent::Gemini), None);
    }

    #[test]
    fn agent_commands_json_is_lenient() {
        assert!(agent_commands_from_json("not json").is_empty());
        assert!(agent_commands_from_json("[1,2]").is_empty());
        let map = agent_commands_from_json(r#"{"gemini":"gemini {{permissions}}"}"#);
        assert_eq!(map.get("gemini").map(String::as_str), Some("gemini {{permissions}}"));
        assert_eq!(agent_commands_to_json(&map), r#"{"gemini":"gemini {{permissions}}"}"#);
    }
}
