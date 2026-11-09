//! Settings → Agents & keys → API keys. Values go to the macOS Keychain
//! (`secrets::ApiKeys`); the frontend only ever sees name / is-set / hint.
//!
//! The Keychain is per macOS user, not per phasr account: two accounts
//! signed in on one machine share these keys (like the CLIs themselves,
//! which read them from the environment).

use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::secrets::{ApiKeyStatus, ApiKeys, SecretError};

use super::require_user;

#[derive(Debug)]
pub enum ApiKeyCmdError {
    Auth(AuthError),
    Secret(SecretError),
}

impl From<AuthError> for ApiKeyCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<SecretError> for ApiKeyCmdError {
    fn from(e: SecretError) -> Self {
        Self::Secret(e)
    }
}

impl std::fmt::Display for ApiKeyCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auth(e) => write!(f, "{e}"),
            Self::Secret(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for ApiKeyCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, in that order.
#[tauri::command]
pub async fn list_api_keys(
    keys: State<'_, ApiKeys>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<ApiKeyStatus>, ApiKeyCmdError> {
    require_user(&session)?;
    Ok(keys.list().await?)
}

/// Store a key (trimmed). Only the three names above are accepted.
#[tauri::command]
pub async fn set_api_key(
    name: String,
    value: String,
    keys: State<'_, ApiKeys>,
    session: State<'_, Arc<SessionState>>,
) -> Result<ApiKeyStatus, ApiKeyCmdError> {
    require_user(&session)?;
    Ok(keys.set(&name, &value).await?)
}

#[tauri::command]
pub async fn delete_api_key(
    name: String,
    keys: State<'_, ApiKeys>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), ApiKeyCmdError> {
    require_user(&session)?;
    Ok(keys.delete(&name).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_as_plain_strings() {
        let err = ApiKeyCmdError::from(SecretError::NotAllowed("PATH".into()));
        assert_eq!(serde_json::to_value(&err).unwrap(), "`PATH` is not a key phasr stores");
    }
}
