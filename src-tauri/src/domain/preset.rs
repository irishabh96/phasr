use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
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

impl Preset {
    pub fn new(name: impl Into<String>, command: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
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

    /// The shipped seed presets per the rebuild plan (Concepts: Templates).
    pub fn seeded() -> Vec<Self> {
        let now = Utc::now();
        let entries = [
            ("Claude", r#"claude -p "{{prompt}}""#, true),
            (
                "Claude Code",
                r#"claude --dangerously-skip-permissions -p "{{prompt}}""#,
                false,
            ),
            ("Codex", r#"codex --prompt "{{prompt}}""#, false),
            ("Cursor", r#"cursor-agent --prompt "{{prompt}}""#, false),
            ("OpenCode", r#"opencode run "{{prompt}}""#, false),
            ("Copilot", r#"gh copilot suggest "{{prompt}}""#, false),
            ("Gemini", r#"gemini -p "{{prompt}}""#, false),
        ];
        entries
            .into_iter()
            .enumerate()
            .map(|(idx, (name, command, is_default))| Self {
                id: uuid::Uuid::new_v4().to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_includes_all_seven_agents() {
        let seeded = Preset::seeded();
        let names: Vec<_> = seeded.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            ["Claude", "Claude Code", "Codex", "Cursor", "OpenCode", "Copilot", "Gemini"]
        );
        assert!(seeded.iter().all(|p| p.is_seed));
        assert_eq!(seeded.iter().filter(|p| p.is_default).count(), 1);
    }
}
