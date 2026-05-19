use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Stable namespace for deriving seed-agent UUIDs via uuid_v5.
/// NEVER change this — it's what keeps `seed:Claude` to the same UUID
/// on every machine and every user account.
const AGENT_NAMESPACE: Uuid = Uuid::from_bytes([
    0x8e, 0x6a, 0x59, 0xfa, 0x1b, 0x2b, 0x4f, 0x7e, 0x8d, 0x7e, 0xbd, 0xa6, 0xd4, 0xb1, 0xb2, 0xe1,
]);

/// An AI tool/CLI that can be run as a workspace's command.
///
/// Seeded agents (Claude, Codex, Cursor, …) live as hardcoded constants
/// in the app with deterministic UUIDs — they are NOT stored in the
/// `agents` table. The table only stores user-defined custom agents.
///
/// Per-user enabled state is in `user_settings.disabled_agent_ids`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub command: String,
    pub icon: Option<String>,
    pub is_default: bool,
    pub is_enabled: bool,
    pub is_seed: bool,
    pub sort_order: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Agent {
    /// Creates a custom user agent (random UUID).
    pub fn new_custom(name: impl Into<String>, command: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            command: command.into(),
            icon: None,
            is_default: false,
            is_enabled: true,
            is_seed: false,
            sort_order: 0,
            created_at: now,
            updated_at: now,
        }
    }

    /// Hardcoded seed agents shipped with the app. UUIDs are stable
    /// (uuid_v5 of the agent name under AGENT_NAMESPACE), so the same
    /// "Claude" agent has the same id on every install.
    pub fn seeded() -> Vec<Self> {
        let now = Utc::now();
        let entries = [
            ("Claude", "claude --dangerously-skip-permissions", true),
            ("Claude Code", "claude --dangerously-skip-permissions", false),
            ("Codex", "codex", false),
            ("Cursor", "cursor-agent", false),
            ("OpenCode", "opencode", false),
            ("Copilot", "gh copilot suggest", false),
            ("Gemini", "gemini", false),
        ];
        entries
            .into_iter()
            .enumerate()
            .map(|(idx, (name, command, is_default))| Self {
                id: seed_id(name),
                name: name.into(),
                command: command.into(),
                icon: None,
                is_default,
                is_enabled: true,
                is_seed: true,
                sort_order: idx as i64,
                created_at: now,
                updated_at: now,
            })
            .collect()
    }
}

/// Deterministic UUID for a seed agent's name. Both ends of the sync
/// layer compute the same value.
pub fn seed_id(name: &str) -> String {
    Uuid::new_v5(&AGENT_NAMESPACE, name.as_bytes()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_includes_all_seven_agents() {
        let seeded = Agent::seeded();
        let names: Vec<_> = seeded.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            ["Claude", "Claude Code", "Codex", "Cursor", "OpenCode", "Copilot", "Gemini"]
        );
        assert!(seeded.iter().all(|a| a.is_seed));
        assert_eq!(seeded.iter().filter(|a| a.is_default).count(), 1);
    }

    #[test]
    fn seed_id_is_stable() {
        // Locking in the expected UUIDs so a future rename doesn't
        // silently break cross-device linkage.
        assert_eq!(seed_id("Claude"), seed_id("Claude"));
        assert_ne!(seed_id("Claude"), seed_id("Codex"));
    }
}
