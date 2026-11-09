//! Launch configuration: which command an agent is started with, and
//! where it runs.
//!
//! A launch command is `template` + `{{permissions}}` filled from the
//! agent's flag table (`Agent::permission_args`). The template is the
//! user's override from `user_settings.agent_commands` when they set one,
//! else the agent's built-in default. `{{prompt}}` (if a user template uses
//! it) is left for `interpolate_for_task` at start time, which shell-escapes
//! it — the permission flags are trusted constants and are not.

use std::collections::HashMap;

use serde::Deserialize;

use crate::domain::agent::collapse_whitespace;
use crate::domain::{Agent, PermissionMode, UserSettings};

use super::error::OrchestratorError;
use super::templating::interpolate_command;

/// Where a task's agent runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunIn {
    /// A fresh `phasr/*` worktree per task (the default).
    #[default]
    Worktree,
    /// The repository's own checkout, via its `local` workspace. One at a
    /// time per repository.
    InPlace,
}

/// The command `agent` launches with in `mode`, honoring the user's
/// template override. Errors if the agent has no way to express `mode`.
pub fn resolve_command(
    agent: Agent,
    mode: PermissionMode,
    settings: &UserSettings,
) -> Result<String, OrchestratorError> {
    let args = agent
        .permission_args(mode)
        .ok_or(OrchestratorError::UnsupportedPermissionMode {
            agent: agent.label(),
            mode: mode.as_str(),
        })?;
    let template = settings
        .agent_command_override(agent)
        .unwrap_or_else(|| agent.default_template());
    let mut vars = HashMap::new();
    vars.insert("permissions", args);
    Ok(collapse_whitespace(&interpolate_command(template, &vars)))
}

/// The command (and mode to record) when an existing workspace's agent or
/// mode changes — `update_workspace`. Takes effect the next time the task
/// is started/resumed: a running PTY keeps the flags it launched with.
///
/// - an explicit `requested` mode must be supported (as for a new launch);
/// - otherwise the row's stored mode carries over, clamped to the (possibly
///   new) agent;
/// - a legacy row with no stored mode keeps launching skip-all — what it
///   always ran with — and stays unstamped (`None`).
pub fn relaunch(
    agent: Agent,
    requested: Option<PermissionMode>,
    stored: Option<PermissionMode>,
    settings: &UserSettings,
) -> Result<(Option<PermissionMode>, String), OrchestratorError> {
    match (requested, stored) {
        (Some(mode), _) => Ok((Some(mode), resolve_command(agent, mode, settings)?)),
        (None, Some(stored)) => {
            let mode = agent.clamp_permission_mode(stored);
            Ok((Some(mode), resolve_command(agent, mode, settings)?))
        }
        (None, None) => Ok((
            None,
            resolve_command(agent, PermissionMode::SkipAll, settings)?,
        )),
    }
}

/// Fill `{{prompt}}` (shell-escaped) for a task. A template without the
/// placeholder — every built-in one — comes back verbatim.
pub fn interpolate_for_task(template: &str, prompt: Option<&str>) -> String {
    let mut vars = HashMap::new();
    vars.insert("prompt", prompt.unwrap_or(""));
    interpolate_command(template, &vars)
}

/// Pick the mode and command for a new launch. An explicitly requested
/// mode must be supported by the agent (never silently changed — it's a
/// safety choice the user made). With no request, the user's default is
/// clamped to the nearest mode the agent supports, so e.g. OpenCode (skip-
/// all only) still starts under an Ask-for-shell default.
pub fn resolve_launch(
    agent: Agent,
    requested: Option<PermissionMode>,
    settings: &UserSettings,
) -> Result<(PermissionMode, String), OrchestratorError> {
    let mode = match requested {
        Some(mode) => mode,
        None => agent.clamp_permission_mode(settings.default_permission_mode),
    };
    Ok((mode, resolve_command(agent, mode, settings)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(overrides: &[(&str, &str)]) -> UserSettings {
        let mut settings = UserSettings::default();
        for (agent, template) in overrides {
            settings
                .agent_commands
                .insert((*agent).into(), (*template).into());
        }
        settings
    }

    #[test]
    fn default_templates_render_per_mode() {
        let s = UserSettings::default();
        assert_eq!(
            resolve_command(Agent::Claude, PermissionMode::AskShell, &s).unwrap(),
            "claude --permission-mode acceptEdits"
        );
        // Empty args leave no double/trailing space behind.
        assert_eq!(
            resolve_command(Agent::Claude, PermissionMode::AskEdits, &s).unwrap(),
            "claude"
        );
        assert_eq!(
            resolve_command(Agent::Codex, PermissionMode::AskEdits, &s).unwrap(),
            r#"codex -c model_reasoning_effort="high" -s read-only -a on-request -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true"#
        );
        assert_eq!(
            resolve_command(Agent::Gemini, PermissionMode::SkipAll, &s).unwrap(),
            "gemini --yolo"
        );
    }

    #[test]
    fn skip_all_matches_the_legacy_command_for_every_agent() {
        let s = UserSettings::default();
        for agent in Agent::ALL {
            assert_eq!(
                resolve_command(agent, PermissionMode::SkipAll, &s).unwrap(),
                agent.command(),
                "{agent:?}"
            );
        }
    }

    #[test]
    fn override_template_is_used_and_filled() {
        let s = settings_with(&[("claude", "claude   --model opus {{ permissions }}  ")]);
        assert_eq!(
            resolve_command(Agent::Claude, PermissionMode::SkipAll, &s).unwrap(),
            "claude --model opus --dangerously-skip-permissions"
        );
        // Other agents are unaffected by Claude's override.
        assert_eq!(
            resolve_command(Agent::Gemini, PermissionMode::AskShell, &s).unwrap(),
            "gemini --approval-mode auto_edit"
        );
    }

    #[test]
    fn override_without_placeholder_runs_verbatim() {
        let s = settings_with(&[("codex", "codex --profile mine")]);
        assert_eq!(
            resolve_command(Agent::Codex, PermissionMode::AskShell, &s).unwrap(),
            "codex --profile mine"
        );
    }

    #[test]
    fn prompt_placeholder_survives_for_start_time_interpolation() {
        let s = settings_with(&[("claude", r#"claude {{permissions}} "{{prompt}}""#)]);
        assert_eq!(
            resolve_command(Agent::Claude, PermissionMode::AskShell, &s).unwrap(),
            r#"claude --permission-mode acceptEdits "{{prompt}}""#
        );
    }

    #[test]
    fn blank_override_falls_back_to_default() {
        let s = settings_with(&[("claude", "   ")]);
        assert_eq!(
            resolve_command(Agent::Claude, PermissionMode::SkipAll, &s).unwrap(),
            "claude --dangerously-skip-permissions"
        );
    }

    #[test]
    fn unsupported_mode_is_an_error() {
        let err = resolve_command(Agent::OpenCode, PermissionMode::AskShell, &UserSettings::default())
            .unwrap_err();
        assert!(matches!(err, OrchestratorError::UnsupportedPermissionMode { .. }));
        assert!(err.to_string().contains("OpenCode"), "{err}");
    }

    #[test]
    fn launch_defaults_from_settings_and_clamps_only_the_default() {
        let mut s = UserSettings::default();
        assert_eq!(
            resolve_launch(Agent::Claude, None, &s).unwrap().0,
            PermissionMode::AskShell
        );
        s.default_permission_mode = PermissionMode::AskEdits;
        assert_eq!(
            resolve_launch(Agent::Codex, None, &s).unwrap(),
            (
                PermissionMode::AskEdits,
                resolve_command(Agent::Codex, PermissionMode::AskEdits, &s).unwrap()
            )
        );
        // Default clamps for an agent that can't express it…
        assert_eq!(
            resolve_launch(Agent::OpenCode, None, &s).unwrap(),
            (PermissionMode::SkipAll, "opencode".to_string())
        );
        // …but an explicit choice is never silently changed.
        assert!(resolve_launch(Agent::OpenCode, Some(PermissionMode::AskEdits), &s).is_err());
    }

    #[test]
    fn relaunch_keeps_legacy_rows_skip_all_and_carries_stored_modes() {
        let s = UserSettings::default();
        // Legacy row: unchanged behavior on an agent switch.
        assert_eq!(
            relaunch(Agent::Gemini, None, None, &s).unwrap(),
            (None, "gemini --yolo".to_string())
        );
        // Stored mode carries over to the new agent…
        assert_eq!(
            relaunch(Agent::Gemini, None, Some(PermissionMode::AskShell), &s).unwrap(),
            (
                Some(PermissionMode::AskShell),
                "gemini --approval-mode auto_edit".to_string()
            )
        );
        // …clamped when the new agent can't express it.
        assert_eq!(
            relaunch(Agent::OpenCode, None, Some(PermissionMode::AskEdits), &s)
                .unwrap()
                .0,
            Some(PermissionMode::SkipAll)
        );
        // An explicit mode wins over the stored one.
        assert_eq!(
            relaunch(Agent::Claude, Some(PermissionMode::AskEdits), Some(PermissionMode::SkipAll), &s)
                .unwrap(),
            (Some(PermissionMode::AskEdits), "claude".to_string())
        );
        assert!(relaunch(Agent::OpenCode, Some(PermissionMode::AskShell), None, &s).is_err());
    }

    #[test]
    fn run_in_deserializes_kebab_case() {
        assert_eq!(serde_json::from_str::<RunIn>(r#""worktree""#).unwrap(), RunIn::Worktree);
        assert_eq!(serde_json::from_str::<RunIn>(r#""in-place""#).unwrap(), RunIn::InPlace);
        assert_eq!(RunIn::default(), RunIn::Worktree);
    }
}
