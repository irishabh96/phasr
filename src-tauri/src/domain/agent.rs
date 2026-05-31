use serde::{Deserialize, Serialize};

/// An AI tool/CLI that can be run as a workspace's command.
///
/// Agents are a fixed, built-in set. Each variant carries a hardcoded
/// launch command. The selected agent is stored directly on the
/// workspace (`workspaces.agent`) as a lowercase string — there is no
/// `agents` table and no per-user customization.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Copilot,
    Gemini,
    OpenCode,
}

impl Agent {
    /// Every agent, in display order. The first entry is the default.
    pub const ALL: [Agent; 5] = [
        Agent::Claude,
        Agent::Codex,
        Agent::Copilot,
        Agent::Gemini,
        Agent::OpenCode,
    ];

    /// The agent selected when the user hasn't chosen one.
    pub fn default() -> Self {
        Agent::Claude
    }

    /// Stable lowercase identifier persisted in SQLite and sent to the
    /// frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Copilot => "copilot",
            Agent::Gemini => "gemini",
            Agent::OpenCode => "opencode",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "claude" => Agent::Claude,
            "codex" => Agent::Codex,
            "copilot" => Agent::Copilot,
            "gemini" => Agent::Gemini,
            "opencode" => Agent::OpenCode,
            _ => return None,
        })
    }

    /// Human-friendly name shown in the UI.
    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude",
            Agent::Codex => "Codex",
            Agent::Copilot => "Copilot",
            Agent::Gemini => "Gemini",
            Agent::OpenCode => "OpenCode",
        }
    }

    /// The hardcoded shell command used to launch the agent.
    pub fn command(self) -> &'static str {
        match self {
            Agent::Claude => "claude --dangerously-skip-permissions",
            Agent::Codex => {
                r#"codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true"#
            }
            Agent::Copilot => "copilot --allow-all",
            Agent::Gemini => "gemini --yolo",
            Agent::OpenCode => "opencode",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_str() {
        for agent in Agent::ALL {
            assert_eq!(Agent::from_str(agent.as_str()), Some(agent));
        }
    }

    #[test]
    fn unknown_string_returns_none() {
        assert_eq!(Agent::from_str("nonsense"), None);
    }

    #[test]
    fn default_is_claude() {
        assert_eq!(Agent::default(), Agent::Claude);
        assert_eq!(Agent::ALL[0], Agent::Claude);
    }

    #[test]
    fn every_agent_has_a_command() {
        for agent in Agent::ALL {
            assert!(!agent.command().is_empty());
        }
    }
}
