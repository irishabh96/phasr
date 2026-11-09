use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::UserSettings;
use crate::store::{AppMetaRepo, SettingsRepo, StoreError};
use crate::settings_trust::UnconfirmedSetting;
use crate::sync::CloudSyncState;

/// Wraps `StoreError` so we can carry an auth-rejection variant on the
/// command surface. Same string envelope as before.
#[derive(Debug)]
pub enum SettingsCmdError {
    Store(StoreError),
    Auth(AuthError),
}

impl From<StoreError> for SettingsCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for SettingsCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for SettingsCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for SettingsCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub async fn get_user_settings(
    repo: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<UserSettings, SettingsCmdError> {
    session.require()?;
    Ok(repo.get_or_init().await?)
}

/// `UserSettings` as sent by the frontend, remembering which of the
/// fields added after the first release were actually present.
///
/// `serde(default)` alone would let a payload that predates them (a stale
/// bundle, a hand-built settings object) deserialize — but then *save* the
/// defaults over the user's real choice, silently flipping e.g. their
/// permission mode. Absent fields keep their stored values instead.
#[derive(Debug)]
pub struct UserSettingsInput {
    settings: UserSettings,
    has_default_permission_mode: bool,
    has_agent_commands: bool,
    has_notification_prefs: bool,
    has_terminal_shell: bool,
    has_copy_on_select: bool,
}

impl<'de> serde::Deserialize<'de> for UserSettingsInput {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        let has = |key: &str| value.get(key).is_some_and(|v| !v.is_null());
        let has_default_permission_mode = has("defaultPermissionMode");
        let has_agent_commands = has("agentCommands");
        let has_notification_prefs = has("notificationPrefs");
        let has_terminal_shell = has("terminalShell");
        let has_copy_on_select = has("copyOnSelect");
        let settings = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self {
            settings,
            has_default_permission_mode,
            has_agent_commands,
            has_notification_prefs,
            has_terminal_shell,
            has_copy_on_select,
        })
    }
}

impl UserSettingsInput {
    fn merged_over(self, stored: &UserSettings) -> UserSettings {
        let mut settings = self.settings;
        if !self.has_default_permission_mode {
            settings.default_permission_mode = stored.default_permission_mode;
        }
        if !self.has_agent_commands {
            settings.agent_commands = stored.agent_commands.clone();
        }
        if !self.has_notification_prefs {
            settings.notification_prefs = stored.notification_prefs.clone();
        }
        if !self.has_terminal_shell {
            settings.terminal_shell = stored.terminal_shell.clone();
        }
        if !self.has_copy_on_select {
            settings.copy_on_select = stored.copy_on_select;
        }
        settings
    }
}

#[tauri::command]
pub async fn update_user_settings(
    settings: UserSettingsInput,
    repo: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<UserSettings, SettingsCmdError> {
    session.require()?;
    let stored = repo.get_or_init().await?;
    let updated = repo.update(&settings.merged_over(&stored)).await?;
    // An agent template / shell the user CHANGED here was typed on this
    // machine: trusted to run here. Unchanged (possibly synced) values keep
    // their status — see `settings_trust::trust_edits`.
    crate::settings_trust::trust_edits(&meta, &stored, &updated).await?;
    sync_state.request_sync();
    Ok(updated)
}

/// Synced settings that would take effect here but haven't been confirmed
/// on this machine, each with its value: `agentCommands.<agent>` /
/// `terminalShell` / `defaultPermissionMode` (only when `skip-all`). Until
/// confirmed, launches use the default template / login shell / asking
/// permission mode.
#[tauri::command]
pub async fn list_unconfirmed_settings(
    repo: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<UnconfirmedSetting>, SettingsCmdError> {
    session.require()?;
    let settings = repo.get_or_init().await?;
    Ok(crate::settings_trust::unconfirmed(&meta, &settings).await?)
}

/// "Allow on this Mac" for exactly `keys` (as `list_unconfirmed_settings`
/// names them), each at its current value — never every synced setting at
/// once. Returns the keys that were confirmed.
#[tauri::command]
pub async fn confirm_settings_on_this_machine(
    keys: Vec<String>,
    repo: State<'_, SettingsRepo>,
    meta: State<'_, AppMetaRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<String>, SettingsCmdError> {
    session.require()?;
    let settings = repo.get_or_init().await?;
    Ok(crate::settings_trust::confirm_keys(&meta, &settings, &keys).await?)
}

/// Shells from `/etc/shells` that exist here (Settings → Terminal → Shell).
/// `""` in `terminalShell` means the account's login shell, which the UI
/// offers separately.
#[tauri::command]
pub async fn list_shells(session: State<'_, Arc<SessionState>>) -> Result<Vec<String>, SettingsCmdError> {
    session.require()?;
    Ok(tokio::task::spawn_blocking(crate::pty::list_shells)
        .await
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::PermissionMode;

    fn stored() -> UserSettings {
        let mut s = UserSettings::default();
        s.default_permission_mode = PermissionMode::SkipAll;
        s.agent_commands.insert("claude".into(), "claude --x {{permissions}}".into());
        s.notification_prefs.background_only = false;
        s.terminal_shell = "/bin/zsh".into();
        s.copy_on_select = true;
        s
    }

    #[test]
    fn a_payload_without_the_new_fields_keeps_the_stored_values() {
        let mut json = serde_json::to_value(UserSettings::default()).unwrap();
        json["theme"] = "light".into();
        let obj = json.as_object_mut().unwrap();
        obj.remove("defaultPermissionMode");
        obj.remove("agentCommands");
        obj.remove("notificationPrefs");
        obj.remove("terminalShell");
        obj.remove("copyOnSelect");

        let input: UserSettingsInput = serde_json::from_value(json).unwrap();
        let merged = input.merged_over(&stored());
        assert_eq!(merged.terminal_shell, "/bin/zsh");
        assert!(merged.copy_on_select);
        assert_eq!(merged.theme, "light");
        assert_eq!(merged.default_permission_mode, PermissionMode::SkipAll);
        assert_eq!(merged.agent_commands, stored().agent_commands);
        assert_eq!(merged.notification_prefs, stored().notification_prefs);
    }

    #[test]
    fn a_payload_with_the_new_fields_wins() {
        let mut json = serde_json::to_value(UserSettings::default()).unwrap();
        json["defaultPermissionMode"] = "ask-edits".into();
        json["agentCommands"] = serde_json::json!({});
        let input: UserSettingsInput = serde_json::from_value(json).unwrap();
        let merged = input.merged_over(&stored());
        assert_eq!(merged.default_permission_mode, PermissionMode::AskEdits);
        assert!(merged.agent_commands.is_empty(), "an explicit {{}} clears overrides");
        // Present prefs win (here: the defaults, over the stored `false`).
        assert!(merged.notification_prefs.background_only);
    }

    #[test]
    fn an_unknown_permission_mode_is_rejected() {
        let mut json = serde_json::to_value(UserSettings::default()).unwrap();
        json["defaultPermissionMode"] = "yolo".into();
        assert!(serde_json::from_value::<UserSettingsInput>(json).is_err());
    }
}
