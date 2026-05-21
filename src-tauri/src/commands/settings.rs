use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::UserSettings;
use crate::store::{SettingsRepo, StoreError};

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

#[tauri::command]
pub async fn update_user_settings(
    settings: UserSettings,
    repo: State<'_, SettingsRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<UserSettings, SettingsCmdError> {
    session.require()?;
    Ok(repo.update(&settings).await?)
}
