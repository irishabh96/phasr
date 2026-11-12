//! Agent API keys (Settings → Agents & keys).
//!
//! The values live only in the macOS login Keychain, behind `SecretStore`
//! so tests (and non-macOS builds) never touch it. What phasr keeps itself
//! is a 4-character hint per key in `app_meta` (local, never synced) — the
//! settings list reads that, so opening Settings never triggers a Keychain
//! access prompt. A key is read from the Keychain only at agent launch,
//! and only for the agent it belongs to.
//!
//! Values are never logged, never synced, and never written to SQLite.

use std::sync::Arc;

use serde::Serialize;
use thiserror::Error;

use crate::domain::Agent;
use crate::store::{AppMetaRepo, StoreError};

/// The only names phasr stores. Anything else is refused, so this can't be
/// turned into a general Keychain reader/writer.
pub const API_KEY_NAMES: [&str; 3] = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

const KEYCHAIN_SERVICE: &str = "sh.phasr.desktop.api-keys";
const HINT_PREFIX: &str = "api_key_hint:";
/// Longest value accepted; real provider keys are ~100–200 chars.
const MAX_KEY_LEN: usize = 4096;

/// The environment variable an agent's CLI reads its key from. Only that
/// agent's PTY gets it — Codex never sees the Anthropic key.
pub fn env_key_for(agent: Agent) -> Option<&'static str> {
    match agent {
        Agent::Claude => Some("ANTHROPIC_API_KEY"),
        Agent::Codex => Some("OPENAI_API_KEY"),
        Agent::Gemini => Some("GEMINI_API_KEY"),
        _ => None,
    }
}

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("`{0}` is not a key phasr stores")]
    NotAllowed(String),
    #[error("{0}")]
    Invalid(&'static str),
    #[error("the system keychain isn't available on this platform")]
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unavailable,
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl serde::Serialize for SecretError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Where secret values live. Blocking (the Keychain API is synchronous):
/// `ApiKeys` calls it from `spawn_blocking`.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, name: &str, value: &str) -> Result<(), SecretError>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, name: &str) -> Result<(), SecretError>;
}

/// The login Keychain, one generic-password item per key name.
pub struct KeychainStore {
    service: String,
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.to_string(),
        }
    }
}

#[cfg(target_os = "macos")]
impl KeychainStore {
    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, name).map_err(|e| SecretError::Keychain(e.to_string()))
    }
}

#[cfg(target_os = "macos")]
impl SecretStore for KeychainStore {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        match self.entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Keychain(e.to_string())),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        self.entry(name)?
            .set_password(value)
            .map_err(|e| SecretError::Keychain(e.to_string()))
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Keychain(e.to_string())),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore for KeychainStore {
    fn get(&self, _name: &str) -> Result<Option<String>, SecretError> {
        Ok(None)
    }
    fn set(&self, _name: &str, _value: &str) -> Result<(), SecretError> {
        Err(SecretError::Unavailable)
    }
    fn delete(&self, _name: &str) -> Result<(), SecretError> {
        Ok(())
    }
}

/// In-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemorySecretStore {
    values: parking_lot::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        Ok(self.values.lock().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        self.values
            .lock()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        self.values.lock().remove(name);
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub name: String,
    pub is_set: bool,
    /// Last 4 characters, for "sk-…a1b2". `None` when unset (or too short
    /// for a hint to be safe).
    pub hint: Option<String>,
}

/// The signed-in user's Clerk id, re-read on every call (`None` signed
/// out).
pub type CurrentUser = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The API-key service: whitelist, hints, and per-agent env at launch.
///
/// Per phasr ACCOUNT, not per macOS user: the Keychain account is
/// `<clerk user id>/<ENV_NAME>` and the hint row is keyed the same way, so a
/// second account signed in on the same Mac neither sees nor launches with
/// the first one's keys. (Entries from builds that keyed by the env name
/// alone are NOT adopted: nothing records which account stored them, and
/// handing one account's key to another is the leak this prevents. That
/// layout never shipped in a release.)
#[derive(Clone)]
pub struct ApiKeys {
    store: Arc<dyn SecretStore>,
    meta: AppMetaRepo,
    /// Whose keys a launch gets (`env_for`). Unset = nobody's.
    current_user: Option<CurrentUser>,
}

/// The Keychain account for `user_id`'s `name`.
fn account(user_id: &str, name: &str) -> String {
    format!("{user_id}/{name}")
}

fn hint_key(user_id: &str, name: &str) -> String {
    format!("{HINT_PREFIX}{user_id}:{name}")
}

/// A Clerk id is `user_…`; refuse anything that could make two users'
/// accounts collide (an empty id, a separator inside it).
fn ensure_user(user_id: &str) -> Result<&str, SecretError> {
    if user_id.is_empty() || user_id.contains(['/', ':']) || user_id.chars().any(char::is_control) {
        return Err(SecretError::Invalid("no signed-in account"));
    }
    Ok(user_id)
}

fn ensure_allowed(name: &str) -> Result<&'static str, SecretError> {
    API_KEY_NAMES
        .into_iter()
        .find(|n| *n == name)
        .ok_or_else(|| SecretError::NotAllowed(name.to_string()))
}

/// Last 4 characters, only for values long enough that 4 reveal little.
fn hint_of(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    (chars.len() >= 12).then(|| chars[chars.len() - 4..].iter().collect())
}

async fn blocking<T, F>(f: F) -> Result<T, SecretError>
where
    F: FnOnce() -> Result<T, SecretError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| SecretError::Keychain(format!("keychain task failed: {e}")))?
}

impl ApiKeys {
    pub fn new(store: Arc<dyn SecretStore>, meta: AppMetaRepo) -> Self {
        Self {
            store,
            meta,
            current_user: None,
        }
    }

    /// Whose keys launches get: the signed-in account, re-read per launch.
    pub fn with_current_user(mut self, current_user: CurrentUser) -> Self {
        self.current_user = Some(current_user);
        self
    }

    /// `user_id`'s keys: name / is-set / hint, never a value.
    pub async fn list(&self, user_id: &str) -> Result<Vec<ApiKeyStatus>, SecretError> {
        let user_id = ensure_user(user_id)?;
        let mut out = Vec::with_capacity(API_KEY_NAMES.len());
        for name in API_KEY_NAMES {
            // The hint row is the "is set" marker (empty string = set, but
            // too short to hint).
            let hint = self.meta.get(&hint_key(user_id, name)).await?;
            out.push(ApiKeyStatus {
                name: name.to_string(),
                is_set: hint.is_some(),
                hint: hint.filter(|h| !h.is_empty()),
            });
        }
        Ok(out)
    }

    pub async fn set(
        &self,
        user_id: &str,
        name: &str,
        value: &str,
    ) -> Result<ApiKeyStatus, SecretError> {
        let user_id = ensure_user(user_id)?;
        let name = ensure_allowed(name)?;
        let value = value.trim();
        if value.is_empty() {
            return Err(SecretError::Invalid("the key is empty"));
        }
        if value.len() > MAX_KEY_LEN || value.chars().any(char::is_control) {
            return Err(SecretError::Invalid("that doesn't look like an API key"));
        }
        let store = self.store.clone();
        let (owned, entry) = (value.to_string(), account(user_id, name));
        blocking(move || store.set(&entry, &owned)).await?;
        let hint = hint_of(value);
        self.meta
            .set(&hint_key(user_id, name), hint.as_deref().unwrap_or(""))
            .await?;
        Ok(ApiKeyStatus {
            name: name.to_string(),
            is_set: true,
            hint,
        })
    }

    pub async fn delete(&self, user_id: &str, name: &str) -> Result<(), SecretError> {
        let user_id = ensure_user(user_id)?;
        let name = ensure_allowed(name)?;
        let store = self.store.clone();
        let entry = account(user_id, name);
        blocking(move || store.delete(&entry)).await?;
        self.meta.delete(&hint_key(user_id, name)).await?;
        Ok(())
    }

    /// `[(ENV_NAME, value)]` for `agent`'s PTY — the signed-in account's
    /// key — or nothing (signed out, no key). Never fails a launch: a
    /// Keychain error (locked, access denied) is logged — without the
    /// value — and the agent starts with its own auth.
    pub async fn env_for(&self, agent: Agent) -> Vec<(String, String)> {
        match self.current_user.as_ref().and_then(|current| current()) {
            Some(user_id) => self.env_for_user(&user_id, agent).await,
            None => Vec::new(),
        }
    }

    pub async fn env_for_user(&self, user_id: &str, agent: Agent) -> Vec<(String, String)> {
        let Ok(user_id) = ensure_user(user_id) else {
            return Vec::new();
        };
        let Some(name) = env_key_for(agent) else {
            return Vec::new();
        };
        // Unset → don't touch the Keychain at all (no access prompt).
        match self.meta.get(&hint_key(user_id, name)).await {
            Ok(Some(_)) => {}
            _ => return Vec::new(),
        }
        let store = self.store.clone();
        let entry = account(user_id, name);
        match blocking(move || store.get(&entry)).await {
            Ok(Some(value)) if !value.is_empty() => vec![(name.to_string(), value)],
            Ok(_) => Vec::new(),
            Err(err) => {
                eprintln!("couldn't read {name} from the keychain: {err}");
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;

    async fn keys() -> (ApiKeys, Arc<MemorySecretStore>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let store = Arc::new(MemorySecretStore::default());
        (
            ApiKeys::new(store.clone(), AppMetaRepo::new(pool)),
            store,
            dir,
        )
    }

    const U: &str = "user_a";

    /// Two phasr accounts on one Mac: each sees and launches with only its
    /// own keys (the Keychain account was the env-var name alone, shared by
    /// every account).
    #[tokio::test]
    async fn keys_are_per_account() {
        let (keys, store, _dir) = keys().await;
        keys.set("user_a", "ANTHROPIC_API_KEY", "sk-ant-aaaaaaaaaaaaAAAA")
            .await
            .unwrap();
        assert!(
            keys.list("user_b").await.unwrap().iter().all(|k| !k.is_set),
            "b sees nothing of a's"
        );
        assert!(
            keys.env_for_user("user_b", Agent::Claude).await.is_empty(),
            "b launches without a's key"
        );
        keys.set("user_b", "ANTHROPIC_API_KEY", "sk-ant-bbbbbbbbbbbbBBBB")
            .await
            .unwrap();
        assert_eq!(
            keys.env_for_user("user_a", Agent::Claude).await[0].1,
            "sk-ant-aaaaaaaaaaaaAAAA"
        );
        assert_eq!(
            keys.env_for_user("user_b", Agent::Claude).await[0].1,
            "sk-ant-bbbbbbbbbbbbBBBB"
        );
        assert_eq!(
            store.get("user_a/ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("sk-ant-aaaaaaaaaaaaAAAA")
        );
        // b deleting its key leaves a's alone.
        keys.delete("user_b", "ANTHROPIC_API_KEY").await.unwrap();
        assert!(keys.list("user_a").await.unwrap().iter().any(|k| k.is_set));
        assert!(store.get("user_a/ANTHROPIC_API_KEY").unwrap().is_some());

        // A pre-namespacing entry (keyed by the env name only) belongs to
        // nobody we can name: never handed to an account.
        store.set("OPENAI_API_KEY", "sk-legacy-0123456789").unwrap();
        keys.meta
            .set(&format!("{HINT_PREFIX}OPENAI_API_KEY"), "6789")
            .await
            .unwrap();
        assert!(keys.env_for_user("user_a", Agent::Codex).await.is_empty());
        assert!(!keys
            .list("user_a")
            .await
            .unwrap()
            .iter()
            .any(|k| k.name == "OPENAI_API_KEY" && k.is_set));

        // Launches use the signed-in account; signed out = no key.
        let who = Arc::new(parking_lot::Mutex::new(Some("user_a".to_string())));
        let current = who.clone();
        let keys = keys.with_current_user(Arc::new(move || current.lock().clone()));
        assert_eq!(
            keys.env_for(Agent::Claude).await[0].1,
            "sk-ant-aaaaaaaaaaaaAAAA"
        );
        *who.lock() = Some("user_b".into());
        assert!(keys.env_for(Agent::Claude).await.is_empty());
        *who.lock() = None;
        assert!(keys.env_for(Agent::Claude).await.is_empty());
        // No account → refused, not stored under an empty prefix.
        assert!(keys
            .set("", "ANTHROPIC_API_KEY", "sk-ant-cccccccccccc")
            .await
            .is_err());
        assert!(keys
            .set("a/b", "ANTHROPIC_API_KEY", "sk-ant-cccccccccccc")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn set_list_delete_round_trip_with_hint_only_in_app_meta() {
        let (keys, store, _dir) = keys().await;
        let listed = keys.list(U).await.unwrap();
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().all(|k| !k.is_set && k.hint.is_none()));

        let status = keys
            .set(U, "ANTHROPIC_API_KEY", "  sk-ant-0123456789abcd \n")
            .await
            .unwrap();
        assert_eq!(status.hint.as_deref(), Some("abcd"));
        assert_eq!(
            store.get("user_a/ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("sk-ant-0123456789abcd")
        );
        let listed = keys.list(U).await.unwrap();
        let anthropic = listed
            .iter()
            .find(|k| k.name == "ANTHROPIC_API_KEY")
            .unwrap();
        assert!(anthropic.is_set);
        assert_eq!(anthropic.hint.as_deref(), Some("abcd"));
        // The list carries no value.
        assert!(!serde_json::to_string(&listed).unwrap().contains("sk-ant"));

        keys.delete(U, "ANTHROPIC_API_KEY").await.unwrap();
        assert!(store.get("user_a/ANTHROPIC_API_KEY").unwrap().is_none());
        assert!(!keys.list(U).await.unwrap().iter().any(|k| k.is_set));
        // Deleting again is fine.
        keys.delete(U, "ANTHROPIC_API_KEY").await.unwrap();
    }

    #[tokio::test]
    async fn only_whitelisted_names_and_sane_values_are_accepted() {
        let (keys, store, _dir) = keys().await;
        let err = keys
            .set(U, "AWS_SECRET_ACCESS_KEY", "x".repeat(20).as_str())
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            "`AWS_SECRET_ACCESS_KEY` is not a key phasr stores"
        );
        assert!(keys.delete(U, "PATH").await.is_err());
        assert!(keys.set(U, "OPENAI_API_KEY", "   ").await.is_err());
        assert!(keys
            .set(U, "OPENAI_API_KEY", "sk-abc\ndef-ghijklmnop")
            .await
            .is_err());
        assert!(store.get("user_a/OPENAI_API_KEY").unwrap().is_none());
        // A short value is stored but not hinted.
        let status = keys.set(U, "GEMINI_API_KEY", "short").await.unwrap();
        assert!(status.is_set && status.hint.is_none());
        assert!(keys
            .list(U)
            .await
            .unwrap()
            .iter()
            .any(|k| k.name == "GEMINI_API_KEY" && k.is_set));
    }

    #[tokio::test]
    async fn env_goes_only_to_the_matching_agent() {
        let (keys, _store, _dir) = keys().await;
        keys.set(U, "ANTHROPIC_API_KEY", "sk-ant-0123456789abcd")
            .await
            .unwrap();
        keys.set(U, "OPENAI_API_KEY", "sk-openai-0123456789")
            .await
            .unwrap();
        assert_eq!(
            keys.env_for_user(U, Agent::Claude).await,
            vec![(
                "ANTHROPIC_API_KEY".to_string(),
                "sk-ant-0123456789abcd".to_string()
            )]
        );
        assert_eq!(
            keys.env_for_user(U, Agent::Codex).await,
            vec![(
                "OPENAI_API_KEY".to_string(),
                "sk-openai-0123456789".to_string()
            )]
        );
        // Gemini's key isn't set; Copilot/OpenCode have none.
        assert!(keys.env_for_user(U, Agent::Gemini).await.is_empty());
        assert!(keys.env_for_user(U, Agent::Copilot).await.is_empty());
        assert!(keys.env_for_user(U, Agent::OpenCode).await.is_empty());
    }

    /// Talks to the real login Keychain (may prompt). Run by hand:
    /// `cargo test real_keychain -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_keychain_round_trip() {
        let store = KeychainStore {
            service: "sh.phasr.desktop.api-keys.test".into(),
        };
        store.delete("ANTHROPIC_API_KEY").unwrap();
        assert_eq!(store.get("ANTHROPIC_API_KEY").unwrap(), None);
        store.set("ANTHROPIC_API_KEY", "sk-test-value").unwrap();
        assert_eq!(
            store.get("ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("sk-test-value")
        );
        store.delete("ANTHROPIC_API_KEY").unwrap();
        assert_eq!(store.get("ANTHROPIC_API_KEY").unwrap(), None);
    }
}
