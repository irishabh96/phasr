use serde::{Deserialize, Serialize};

/// An AI tool/CLI that can be run as a workspace's command.
///
/// Agents are a fixed, built-in set. The selected agent is stored directly
/// on the workspace (`workspaces.agent`) as a lowercase string — there is
/// no `agents` table. What IS user-editable is the launch command template
/// (`user_settings.agent_commands`, see `orchestrator::launch`); every
/// variant carries the default one here.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Copilot,
    Gemini,
    OpenCode,
}

/// How much an agent may do without asking. Persisted on the workspace
/// (`workspaces.permission_mode`, NULL = legacy skip-all) and as the user's
/// default (`user_settings.default_permission_mode`).
///
/// Ordered strictest → most permissive; `Agent::clamp_permission_mode`
/// relies on that order.
#[derive(
    Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord,
)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// Ask before editing files and before running shell commands.
    AskEdits,
    /// Edit files freely; ask before running shell commands. The default
    /// for new tasks (user decision, applies to existing users too).
    #[default]
    AskShell,
    /// Never ask. What every agent ran with before permission modes existed.
    SkipAll,
}

impl PermissionMode {
    pub const ALL: [PermissionMode; 3] = [
        PermissionMode::AskEdits,
        PermissionMode::AskShell,
        PermissionMode::SkipAll,
    ];

    /// Stable identifier persisted in SQLite / Supabase. Matches serde.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AskEdits => "ask-edits",
            Self::AskShell => "ask-shell",
            Self::SkipAll => "skip-all",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "ask-edits" => Self::AskEdits,
            "ask-shell" => Self::AskShell,
            "skip-all" => Self::SkipAll,
            _ => return None,
        })
    }
}

/// Keystrokes that answer an agent's own approval dialog, for in-app
/// Allow/Deny (M6). Written into the PTY verbatim.
///
/// #PLAN_UNCERTAINTY: these mirror each TUI's current numbered-choice
/// dialog; they are not machine-checkable from `--help` and drift between
/// CLI versions, so M6 must confirm them against captured PTY fixtures.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalKeys {
    pub allow_once: &'static str,
    // No static "allow for this task" key: what option 2 grants varies per
    // dialog (often a persistent rule), so it is only ever the
    // session-scoped option read off the screen (`agent_signals::heuristics`).
    pub deny: &'static str,
}

/// The placeholder in a command template that receives
/// `Agent::permission_args`.
#[allow(dead_code)] // production fills it via `orchestrator::launch`
pub const PERMISSIONS_PLACEHOLDER: &str = "{{permissions}}";

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

    /// The executable name looked up on the user's login PATH.
    pub fn binary(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Copilot => "copilot",
            Agent::Gemini => "gemini",
            Agent::OpenCode => "opencode",
        }
    }

    /// Shown next to a missing agent in detection/first-run.
    pub fn install_hint(self) -> &'static str {
        match self {
            Agent::Claude => "npm install -g @anthropic-ai/claude-code",
            Agent::Codex => "npm install -g @openai/codex",
            Agent::Copilot => "npm install -g @github/copilot",
            Agent::Gemini => "npm install -g @google/gemini-cli",
            Agent::OpenCode => "npm install -g opencode-ai",
        }
    }

    /// The built-in launch template. `{{permissions}}` receives
    /// `permission_args(mode)`; `{{prompt}}` (if a user template adds it)
    /// is filled later by the orchestrator.
    pub fn default_template(self) -> &'static str {
        match self {
            Agent::Claude => "claude {{permissions}}",
            // The reasoning `-c` overrides predate permission modes and are
            // kept verbatim; only the bypass flag between them became the
            // placeholder.
            Agent::Codex => {
                r#"codex -c model_reasoning_effort="high" {{permissions}} -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true"#
            }
            Agent::Copilot => "copilot {{permissions}}",
            Agent::Gemini => "gemini {{permissions}}",
            Agent::OpenCode => "opencode {{permissions}}",
        }
    }

    /// The CLI flags that put this agent in `mode`. `Some("")` = the CLI's
    /// own default already is that mode; `None` = the CLI has no way to
    /// express it, so the mode isn't offered for this agent.
    ///
    /// Verified against the installed CLIs' own help/source (2026-11-09):
    /// claude 2.1.319 `--help` (`--permission-mode` choices include
    /// `acceptEdits`; default mode prompts for edits and commands), codex-cli
    /// 0.165.0 `--help` (`-s read-only|workspace-write|danger-full-access`,
    /// `-a on-request|never`), gemini-cli 0.34.0 yargs config
    /// (`--approval-mode default|auto_edit|yolo|plan`, `--yolo`; its
    /// `--help` hangs, hence reading the source), Copilot CLI 1.0.79
    /// `--help` + `help permissions` (`--allow-tool=write` auto-approves
    /// file writes but not shell; `--allow-all`). OpenCode isn't installed
    /// here: it has no permission flags at all (permissions live in its
    /// config), so only skip-all — i.e. "run it as configured" — is offered.
    pub fn permission_args(self, mode: PermissionMode) -> Option<&'static str> {
        use PermissionMode::*;
        match (self, mode) {
            (Agent::Claude, AskEdits) => Some(""),
            (Agent::Claude, AskShell) => Some("--permission-mode acceptEdits"),
            (Agent::Claude, SkipAll) => Some("--dangerously-skip-permissions"),

            (Agent::Codex, AskEdits) => Some("-s read-only -a on-request"),
            (Agent::Codex, AskShell) => Some("-s workspace-write -a on-request"),
            (Agent::Codex, SkipAll) => Some("--dangerously-bypass-approvals-and-sandbox"),

            (Agent::Copilot, AskEdits) => Some(""),
            (Agent::Copilot, AskShell) => Some("--allow-tool=write"),
            (Agent::Copilot, SkipAll) => Some("--allow-all"),

            (Agent::Gemini, AskEdits) => Some("--approval-mode default"),
            (Agent::Gemini, AskShell) => Some("--approval-mode auto_edit"),
            (Agent::Gemini, SkipAll) => Some("--yolo"),

            (Agent::OpenCode, SkipAll) => Some(""),
            (Agent::OpenCode, AskEdits | AskShell) => None,
        }
    }

    /// The modes `permission_args` can express, strictest first.
    pub fn permission_modes(self) -> Vec<PermissionMode> {
        PermissionMode::ALL
            .into_iter()
            .filter(|mode| self.permission_args(*mode).is_some())
            .collect()
    }

    /// The supported mode closest to `requested`: `requested` itself when
    /// supported, else the strictest supported mode that is more
    /// permissive, else the most permissive one below it. Used only for a
    /// mode that came from the user's *default* — an explicitly chosen
    /// unsupported mode is an error, never silently changed.
    pub fn clamp_permission_mode(self, requested: PermissionMode) -> PermissionMode {
        let supported = self.permission_modes();
        if supported.contains(&requested) {
            return requested;
        }
        supported
            .iter()
            .copied()
            .find(|mode| *mode > requested)
            .or_else(|| {
                supported
                    .iter()
                    .copied()
                    .rev()
                    .find(|mode| *mode < requested)
            })
            // Every agent supports at least one mode (table above).
            .unwrap_or(PermissionMode::SkipAll)
    }

    /// Answers for the agent's own approval dialog. `None` for agents with
    /// no ask mode (nothing would ever prompt).
    pub fn approval_keys(self) -> Option<ApprovalKeys> {
        match self {
            // "1. Yes / 2. Yes, and … / 3. No (esc)"
            Agent::Claude | Agent::Copilot | Agent::Gemini => Some(ApprovalKeys {
                allow_once: "1",
                deny: "\x1b",
            }),
            // Codex labels its choices with letter hotkeys. Verified live on
            // codex-cli 0.165: "1. Yes, proceed (y) / 2. Yes, and don't ask
            // again for commands that start with `…` (p) / 3. No … (esc)",
            // and `y` ran the command.
            Agent::Codex => Some(ApprovalKeys {
                allow_once: "y",
                deny: "\x1b",
            }),
            Agent::OpenCode => None,
        }
    }

    /// Whether phasr can learn "needs you" from the agent's own hooks
    /// (Claude `--settings` hooks, Codex `notify`) rather than heuristics.
    pub fn supports_hooks(self) -> bool {
        matches!(self, Agent::Claude | Agent::Codex)
    }

    /// Whether token/cost usage can be read for this agent.
    pub fn usage_supported(self) -> bool {
        matches!(self, Agent::Claude | Agent::Codex)
    }

    /// `default_template()` rendered for `mode`; `None` when the agent
    /// doesn't support `mode`. Production goes through
    /// `orchestrator::launch::resolve_command`, which also honors the
    /// user's template override.
    #[allow(dead_code)] // compat surface, exercised by tests
    pub fn render_default(self, mode: PermissionMode) -> Option<String> {
        let args = self.permission_args(mode)?;
        Some(collapse_whitespace(
            &self
                .default_template()
                .replace(PERMISSIONS_PLACEHOLDER, args),
        ))
    }

    /// Compat shim for callers that predate permission modes: the
    /// skip-all render, byte-identical to the old hardcoded commands.
    #[allow(dead_code)] // compat surface, exercised by tests
    pub fn command(self) -> String {
        self.render_default(PermissionMode::SkipAll)
            .unwrap_or_else(|| self.binary().to_string())
    }
}

/// Collapse runs of whitespace to one space and trim — an empty
/// `{{permissions}}` would otherwise leave a double space (visible in the
/// plan preview and in the typed command). Whitespace inside quotes is
/// left alone, so a template like `-c x="a  b"` keeps its meaning.
pub fn collapse_whitespace(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let mut quote: Option<char> = None;
    let mut pending_space = false;
    for ch in command.chars() {
        match quote {
            Some(q) => {
                out.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None if ch.is_whitespace() => pending_space = true,
            None => {
                if pending_space && !out.is_empty() {
                    out.push(' ');
                }
                pending_space = false;
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                }
                out.push(ch);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionMode::*;

    #[test]
    fn round_trips_str() {
        for agent in Agent::ALL {
            assert_eq!(Agent::from_str(agent.as_str()), Some(agent));
        }
        for mode in PermissionMode::ALL {
            assert_eq!(PermissionMode::from_str(mode.as_str()), Some(mode));
        }
    }

    #[test]
    fn unknown_string_returns_none() {
        assert_eq!(Agent::from_str("nonsense"), None);
        assert_eq!(PermissionMode::from_str("ask"), None);
    }

    #[test]
    fn default_is_claude() {
        assert_eq!(Agent::default(), Agent::Claude);
        assert_eq!(Agent::ALL[0], Agent::Claude);
    }

    #[test]
    fn default_permission_mode_is_ask_shell() {
        assert_eq!(PermissionMode::default(), AskShell);
    }

    #[test]
    fn permission_mode_serde_is_kebab_case_and_matches_as_str() {
        for mode in PermissionMode::ALL {
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, format!("\"{}\"", mode.as_str()));
            assert_eq!(serde_json::from_str::<PermissionMode>(&json).unwrap(), mode);
        }
    }

    /// THE flag table, agent × mode. A change here changes what an agent
    /// is allowed to do without asking — keep it deliberate.
    #[test]
    fn permission_args_table() {
        let table: &[(Agent, PermissionMode, Option<&str>)] = &[
            (Agent::Claude, AskEdits, Some("")),
            (
                Agent::Claude,
                AskShell,
                Some("--permission-mode acceptEdits"),
            ),
            (
                Agent::Claude,
                SkipAll,
                Some("--dangerously-skip-permissions"),
            ),
            (Agent::Codex, AskEdits, Some("-s read-only -a on-request")),
            (
                Agent::Codex,
                AskShell,
                Some("-s workspace-write -a on-request"),
            ),
            (
                Agent::Codex,
                SkipAll,
                Some("--dangerously-bypass-approvals-and-sandbox"),
            ),
            (Agent::Copilot, AskEdits, Some("")),
            (Agent::Copilot, AskShell, Some("--allow-tool=write")),
            (Agent::Copilot, SkipAll, Some("--allow-all")),
            (Agent::Gemini, AskEdits, Some("--approval-mode default")),
            (Agent::Gemini, AskShell, Some("--approval-mode auto_edit")),
            (Agent::Gemini, SkipAll, Some("--yolo")),
            (Agent::OpenCode, AskEdits, None),
            (Agent::OpenCode, AskShell, None),
            (Agent::OpenCode, SkipAll, Some("")),
        ];
        assert_eq!(table.len(), Agent::ALL.len() * PermissionMode::ALL.len());
        for (agent, mode, expected) in table {
            assert_eq!(
                agent.permission_args(*mode),
                *expected,
                "{agent:?} × {mode:?}"
            );
        }
    }

    #[test]
    fn rendered_defaults_per_agent_and_mode() {
        let table: &[(Agent, PermissionMode, Option<&str>)] = &[
            (Agent::Claude, AskEdits, Some("claude")),
            (
                Agent::Claude,
                AskShell,
                Some("claude --permission-mode acceptEdits"),
            ),
            (
                Agent::Codex,
                AskShell,
                Some(
                    r#"codex -c model_reasoning_effort="high" -s workspace-write -a on-request -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true"#,
                ),
            ),
            (Agent::Copilot, AskEdits, Some("copilot")),
            (
                Agent::Gemini,
                AskShell,
                Some("gemini --approval-mode auto_edit"),
            ),
            (Agent::OpenCode, SkipAll, Some("opencode")),
            (Agent::OpenCode, AskShell, None),
        ];
        for (agent, mode, expected) in table {
            assert_eq!(
                agent.render_default(*mode).as_deref(),
                *expected,
                "{agent:?} × {mode:?}"
            );
        }
    }

    /// The shim must keep producing exactly what shipped before permission
    /// modes, so legacy rows/callers launch identically.
    #[test]
    fn command_shim_is_the_legacy_skip_all_command() {
        assert_eq!(
            Agent::Claude.command(),
            "claude --dangerously-skip-permissions"
        );
        assert_eq!(
            Agent::Codex.command(),
            r#"codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true"#
        );
        assert_eq!(Agent::Copilot.command(), "copilot --allow-all");
        assert_eq!(Agent::Gemini.command(), "gemini --yolo");
        assert_eq!(Agent::OpenCode.command(), "opencode");
    }

    #[test]
    fn every_template_has_the_permissions_placeholder() {
        for agent in Agent::ALL {
            assert!(agent.default_template().contains(PERMISSIONS_PLACEHOLDER));
            assert!(!agent.permission_modes().is_empty(), "{agent:?}");
        }
    }

    #[test]
    fn clamp_prefers_requested_then_next_more_permissive() {
        assert_eq!(Agent::Claude.clamp_permission_mode(AskShell), AskShell);
        assert_eq!(Agent::OpenCode.clamp_permission_mode(AskShell), SkipAll);
        assert_eq!(Agent::OpenCode.clamp_permission_mode(AskEdits), SkipAll);
    }

    #[test]
    fn hooks_usage_and_approval_capabilities() {
        assert!(Agent::Claude.supports_hooks() && Agent::Codex.supports_hooks());
        assert!(!Agent::Gemini.supports_hooks());
        assert!(Agent::Codex.usage_supported() && !Agent::Copilot.usage_supported());
        assert_eq!(Agent::Claude.approval_keys().unwrap().allow_once, "1");
        assert_eq!(Agent::Claude.approval_keys().unwrap().deny, "\x1b");
        assert!(Agent::OpenCode.approval_keys().is_none());
    }

    #[test]
    fn collapse_whitespace_keeps_quoted_runs() {
        assert_eq!(collapse_whitespace("  claude   --x  "), "claude --x");
        assert_eq!(
            collapse_whitespace(r#"a -c x="p  q"  b"#),
            r#"a -c x="p  q" b"#
        );
        assert_eq!(collapse_whitespace("a 'x  y' b"), "a 'x  y' b");
        assert_eq!(collapse_whitespace(""), "");
    }
}
