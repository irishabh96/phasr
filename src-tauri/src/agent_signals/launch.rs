//! Spawn-time rewrites of an agent's launch command: the hook-bridge flags
//! and, on resume, the CLI's own resume syntax.
//!
//! The stored `workspaces.command` is never changed; this only shapes the
//! line typed into the PTY. Extras go right after the agent's binary token
//! — before any positional prompt a user template may carry, and before
//! Codex's `resume` subcommand options.

use crate::domain::Agent;

use super::hook_bridge::shell_quote;

/// How to (re)start the agent's conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resume {
    /// A fresh session; the initial prompt is typed after boot.
    Fresh,
    /// `claude --resume <session-id>`.
    ClaudeSession(String),
    /// `claude --continue`: the most recent session in this cwd. Used for
    /// tasks whose session id predates M6.
    ClaudeContinue,
    /// `codex resume --last`: the most recent session in this cwd (Codex
    /// filters `--last` by cwd).
    CodexLast,
}

impl Resume {
    /// A resumed conversation already has its prompt.
    pub fn sends_prompt(&self) -> bool {
        matches!(self, Resume::Fresh)
    }
}

/// Session ids are interpolated into a shell command: accept only the
/// UUID-ish shape the CLIs produce.
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Split into shell words, keeping each word's original text (quotes and
/// all) and its byte range.
fn words(command: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in command.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\\' => {
                escaped = true;
                start.get_or_insert(i);
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                start.get_or_insert(i);
            }
            None if c.is_whitespace() => {
                if let Some(s) = start.take() {
                    out.push((s, i));
                }
            }
            None => {
                start.get_or_insert(i);
            }
        }
    }
    if let Some(s) = start {
        out.push((s, command.len()));
    }
    out
}

/// Insert `extra` after the first word whose basename is `binary`
/// (`claude`, `/opt/bin/claude`, `env X=1 claude …`). `None` when the
/// command doesn't visibly run the agent (a wrapper script, an alias) —
/// then nothing is injected and heuristics are the only signal.
pub fn inject_after_binary(command: &str, binary: &str, extra: &str) -> Option<String> {
    if extra.is_empty() {
        return Some(command.to_string());
    }
    let (_, end) = words(command).into_iter().find(|(s, e)| {
        // `'/path with space/claude'` is still the binary.
        let word = command[*s..*e].trim_matches(|c| c == '\'' || c == '"');
        word.rsplit('/').next() == Some(binary)
    })?;
    Some(format!("{} {}{}", &command[..end], extra, &command[end..]))
}

/// The line to type for `agent`: `command` plus resume syntax plus the hook
/// flags. Falls back to `command` unchanged if the binary can't be found.
#[cfg(test)]
pub fn compose(agent: Agent, command: &str, hook_args: Option<&str>, resume: &Resume) -> String {
    try_compose(agent, command, hook_args, resume).unwrap_or_else(|| command.to_string())
}

/// `None` when the agent's binary isn't visible in `command`, so nothing —
/// including the resume syntax — could be added.
pub fn try_compose(
    agent: Agent,
    command: &str,
    hook_args: Option<&str>,
    resume: &Resume,
) -> Option<String> {
    let mut extra: Vec<String> = Vec::new();
    match resume {
        // A subcommand must come first.
        Resume::CodexLast if agent == Agent::Codex => extra.push("resume --last".into()),
        Resume::ClaudeSession(id) if agent == Agent::Claude && is_valid_session_id(id) => {
            extra.push(format!("--resume {}", shell_quote(id)))
        }
        Resume::ClaudeContinue if agent == Agent::Claude => extra.push("--continue".into()),
        _ => {}
    }
    if let Some(args) = hook_args {
        extra.push(args.to_string());
    }
    inject_after_binary(command, agent.binary(), &extra.join(" "))
}

/// Whether a user template baked the prompt into the command line (via
/// `{{prompt}}`). Resuming such a command would submit the prompt again, so
/// those tasks keep the pre-M6 behaviour instead.
///
/// Also decides whether the prompt is TYPED after launch: a command that
/// already carries it must not get it a second time. The probe is matched
/// both raw and in the escaped form `interpolate_for_task` writes (`'` →
/// `'\''`, control characters dropped).
pub fn command_embeds_prompt(command: &str, prompt: Option<&str>) -> bool {
    match prompt.map(str::trim) {
        Some(p) if !p.is_empty() => {
            let probe: String = p.chars().take(40).collect();
            command.contains(probe.as_str())
                || command.contains(crate::orchestrator::templating::single_quote_inner(&probe).as_str())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_after_the_binary_word() {
        assert_eq!(
            inject_after_binary("claude --permission-mode acceptEdits", "claude", "--settings x"),
            Some("claude --settings x --permission-mode acceptEdits".into())
        );
        assert_eq!(
            inject_after_binary("env A=1 /opt/bin/claude", "claude", "--x"),
            Some("env A=1 /opt/bin/claude --x".into())
        );
        assert_eq!(
            inject_after_binary("'/App Support/claude' -p", "claude", "--x"),
            Some("'/App Support/claude' --x -p".into())
        );
        // An arg that merely mentions the name isn't the binary.
        assert_eq!(inject_after_binary("mywrap --name=claude", "claude", "--x"), None);
        assert_eq!(inject_after_binary("claudex", "claude", "--x"), None);
    }

    #[test]
    fn claude_resume_uses_the_session_without_the_prompt() {
        let cmd = compose(
            Agent::Claude,
            "claude --permission-mode acceptEdits",
            Some("--settings '/A B/s.json'"),
            &Resume::ClaudeSession("8f0c6f3e-1111-4222-8333-944455556666".into()),
        );
        assert_eq!(
            cmd,
            "claude --resume 8f0c6f3e-1111-4222-8333-944455556666 --settings '/A B/s.json' --permission-mode acceptEdits"
        );
        assert!(!Resume::ClaudeSession("x".into()).sends_prompt());
        assert!(Resume::Fresh.sends_prompt());
    }

    #[test]
    fn a_hostile_session_id_is_never_interpolated() {
        let cmd = compose(
            Agent::Claude,
            "claude",
            None,
            &Resume::ClaudeSession("x; rm -rf ~".into()),
        );
        assert_eq!(cmd, "claude");
    }

    #[test]
    fn codex_resume_subcommand_comes_first() {
        let cmd = compose(
            Agent::Codex,
            r#"codex -c model_reasoning_effort="high" -s workspace-write -a on-request"#,
            Some(r#"-c 'notify=["/s","codex"]'"#),
            &Resume::CodexLast,
        );
        assert_eq!(
            cmd,
            r#"codex resume --last -c 'notify=["/s","codex"]' -c model_reasoning_effort="high" -s workspace-write -a on-request"#
        );
    }

    #[test]
    fn fresh_launch_only_adds_hooks_and_unknown_shapes_pass_through() {
        assert_eq!(
            compose(Agent::Claude, "claude", Some("--settings s"), &Resume::Fresh),
            "claude --settings s"
        );
        assert_eq!(
            compose(Agent::Claude, "./run-agent.sh", Some("--settings s"), &Resume::Fresh),
            "./run-agent.sh"
        );
        // Resume syntax for the wrong agent is ignored.
        assert_eq!(compose(Agent::Gemini, "gemini --yolo", None, &Resume::CodexLast), "gemini --yolo");
    }

    #[test]
    fn detects_a_prompt_baked_into_the_command() {
        assert!(command_embeds_prompt("claude 'fix the bug'", Some("fix the bug")));
        // As `interpolate_for_task` writes it (quotes escaped).
        let cmd = crate::orchestrator::launch::interpolate_for_task("claude {{prompt}}", Some("don't break it"));
        assert!(command_embeds_prompt(&cmd, Some("don't break it")), "{cmd}");
        assert!(!command_embeds_prompt("claude", Some("fix the bug")));
        assert!(!command_embeds_prompt("claude", None));
    }
}
