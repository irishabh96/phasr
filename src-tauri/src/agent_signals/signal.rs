//! `AgentSignal`: one agent hook event, parsed from the JSON the agent hands
//! its hook (Claude) or notify program (Codex).
//!
//! Field names verified against Claude Code 2.1.319's own bundle (the
//! objects it builds before running a hook), not just the docs:
//!   common:           session_id, transcript_path, cwd, hook_event_name
//!   PreToolUse:       tool_name, tool_input, tool_use_id
//!   PermissionRequest tool_name, tool_input, permission_suggestions
//!   PostToolUse:      tool_name, tool_input, tool_response, tool_use_id
//!   PermissionDenied: tool_name, tool_input, tool_use_id, reason
//!   Notification:     message, title?, notification_type
//!   Stop:             stop_hook_active, last_assistant_message
//!   SessionStart:     source, model, agent_type, session_title
//!   SessionEnd:       reason
//! and Codex 0.165's legacy `notify` payload (kebab-case keys):
//!   {"type":"agent-turn-complete","thread-id","turn-id","cwd",
//!    "input-messages","last-assistant-message"}
//!
//! Parsing is deliberately lenient: unknown events and missing optional
//! fields are dropped or `None`, never an error — a newer CLI adding fields
//! must not break phasr.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum AgentSignal {
    SessionStart {
        session_id: Option<String>,
        transcript_path: Option<String>,
        source: Option<String>,
    },
    UserPromptSubmit {
        session_id: Option<String>,
    },
    PreToolUse {
        tool_name: String,
        tool_input: Value,
    },
    /// Claude is about to show its permission dialog for this tool. Fires
    /// immediately, unlike `Notification(permission_prompt)` which Claude
    /// delays by 6s (and skips if the dialog was answered by then).
    PermissionRequest {
        tool_name: String,
        tool_input: Value,
    },
    /// `tool_input` identifies WHICH call finished: with parallel tool
    /// calls or subagents, an unrelated call finishing must not resolve
    /// the card for the one awaiting approval.
    PostToolUse {
        tool_name: String,
        tool_input: Value,
    },
    PermissionDenied {
        tool_name: String,
        tool_input: Value,
    },
    Notification {
        notification_type: Option<String>,
        message: String,
    },
    Stop {
        last_assistant_message: Option<String>,
    },
    SessionEnd {
        reason: Option<String>,
    },
    /// Codex finished a turn (its only `notify` event).
    CodexTurnComplete {
        last_assistant_message: Option<String>,
    },
}

/// The session id / transcript path carried on every Claude hook payload,
/// whatever the event. Recorded from any event, not just SessionStart: a
/// resumed or `/clear`ed session can surface a new id mid-task.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionInfo {
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// Parse one hook file. `agent` is the tag the hook script put in the file
/// name (`claude` | `codex`); the payload shape decides when it's missing.
pub fn parse_hook_payload(agent: &str, raw: &str) -> Option<(AgentSignal, SessionInfo)> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    if agent == "codex" || v.get("type").and_then(Value::as_str) == Some("agent-turn-complete") {
        return parse_codex(&v).map(|s| (s, SessionInfo::default()));
    }
    let session = SessionInfo {
        session_id: str_field(&v, "session_id"),
        transcript_path: str_field(&v, "transcript_path"),
    };
    let tool_name = || str_field(&v, "tool_name").unwrap_or_default();
    let tool_input = || v.get("tool_input").cloned().unwrap_or(Value::Null);
    let signal = match v.get("hook_event_name").and_then(Value::as_str)? {
        "SessionStart" => AgentSignal::SessionStart {
            session_id: session.session_id.clone(),
            transcript_path: session.transcript_path.clone(),
            source: str_field(&v, "source"),
        },
        "UserPromptSubmit" => AgentSignal::UserPromptSubmit {
            session_id: session.session_id.clone(),
        },
        "PreToolUse" => AgentSignal::PreToolUse {
            tool_name: tool_name(),
            tool_input: tool_input(),
        },
        "PermissionRequest" => AgentSignal::PermissionRequest {
            tool_name: tool_name(),
            tool_input: tool_input(),
        },
        "PostToolUse" => AgentSignal::PostToolUse {
            tool_name: tool_name(),
            tool_input: tool_input(),
        },
        "PermissionDenied" => AgentSignal::PermissionDenied {
            tool_name: tool_name(),
            tool_input: tool_input(),
        },
        "Notification" => AgentSignal::Notification {
            notification_type: str_field(&v, "notification_type"),
            message: str_field(&v, "message").unwrap_or_default(),
        },
        "Stop" => AgentSignal::Stop {
            last_assistant_message: str_field(&v, "last_assistant_message"),
        },
        "SessionEnd" => AgentSignal::SessionEnd {
            reason: str_field(&v, "reason"),
        },
        _ => return None,
    };
    Some((signal, session))
}

/// Codex 0.165 runs a side turn on its own thread to title the session and
/// fires `notify` for it too (observed live: same cwd and client, different
/// `thread-id`). It isn't the user's turn ending, so it's dropped.
const CODEX_TITLE_TURN_PREFIX: &str = "Generate a concise, single-line task title";

fn parse_codex(v: &Value) -> Option<AgentSignal> {
    match v.get("type").and_then(Value::as_str)? {
        "agent-turn-complete" => {
            let first_input = v
                .get("input-messages")
                .and_then(Value::as_array)
                .and_then(|m| m.first())
                .and_then(Value::as_str)
                .unwrap_or("");
            if first_input.starts_with(CODEX_TITLE_TURN_PREFIX) {
                return None;
            }
            Some(AgentSignal::CodexTurnComplete {
                last_assistant_message: str_field(v, "last-assistant-message"),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shapes copied from what Claude Code 2.1.319 builds (see module doc),
    /// with realistic values.
    const PRE_TOOL_USE: &str = r#"{"session_id":"8f0c6f3e-1111-4222-8333-944455556666","transcript_path":"/Users/me/.claude/projects/-Users-me--phasr-worktrees-t1/8f0c6f3e-1111-4222-8333-944455556666.jsonl","cwd":"/Users/me/.phasr/worktrees/t1","permission_mode":"acceptEdits","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"pnpm test","description":"Run tests"},"tool_use_id":"toolu_01"}"#;
    const NOTIFICATION: &str = r#"{"session_id":"s","transcript_path":"/t.jsonl","cwd":"/w","hook_event_name":"Notification","message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}"#;
    const STOP: &str = r#"{"session_id":"s","transcript_path":"/t.jsonl","cwd":"/w","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"All tests pass."}"#;
    const SESSION_START: &str = r#"{"session_id":"abc-123","transcript_path":"/t.jsonl","cwd":"/w","hook_event_name":"SessionStart","source":"startup","model":"claude-sonnet-5"}"#;
    /// Shape captured live from codex-cli 0.165 through phasr-hook.sh.
    const CODEX_NOTIFY: &str = r#"{"type":"agent-turn-complete","thread-id":"01a1c0af-af58-79b0-a294-79b45fc1329c","turn-id":"01a1c0af-b243-7ef1-b778-de1d6d5e46eb","cwd":"/w","client":"codex-tui","input-messages":["fix it"],"last-assistant-message":"Fixed the bug."}"#;

    #[test]
    fn claude_fixtures_parse_to_signals() {
        let (sig, session) = parse_hook_payload("claude", PRE_TOOL_USE).unwrap();
        assert_eq!(
            sig,
            AgentSignal::PreToolUse {
                tool_name: "Bash".into(),
                tool_input: serde_json::json!({"command":"pnpm test","description":"Run tests"}),
            }
        );
        assert_eq!(
            session.session_id.as_deref(),
            Some("8f0c6f3e-1111-4222-8333-944455556666")
        );
        assert!(session.transcript_path.unwrap().ends_with(".jsonl"));

        assert_eq!(
            parse_hook_payload("claude", NOTIFICATION).unwrap().0,
            AgentSignal::Notification {
                notification_type: Some("permission_prompt".into()),
                message: "Claude needs your permission to use Bash".into(),
            }
        );
        assert_eq!(
            parse_hook_payload("claude", STOP).unwrap().0,
            AgentSignal::Stop {
                last_assistant_message: Some("All tests pass.".into())
            }
        );
        assert_eq!(
            parse_hook_payload("claude", SESSION_START).unwrap().0,
            AgentSignal::SessionStart {
                session_id: Some("abc-123".into()),
                transcript_path: Some("/t.jsonl".into()),
                source: Some("startup".into()),
            }
        );
    }

    #[test]
    fn codex_notify_parses_by_tag_or_shape() {
        let expected = AgentSignal::CodexTurnComplete {
            last_assistant_message: Some("Fixed the bug.".into()),
        };
        assert_eq!(parse_hook_payload("codex", CODEX_NOTIFY).unwrap().0, expected);
        assert_eq!(parse_hook_payload("", CODEX_NOTIFY).unwrap().0, expected);
        // Codex's own session-titling side turn is not a turn end.
        assert!(parse_hook_payload(
            "codex",
            r#"{"type":"agent-turn-complete","thread-id":"other","client":"codex-tui","input-messages":["Generate a concise, single-line task title of at most 36 characters"],"last-assistant-message":"Create check file"}"#
        )
        .is_none());
        // Other Codex notification types are ignored, not errors.
        assert!(parse_hook_payload("codex", r#"{"type":"approval-requested"}"#).is_none());
    }

    #[test]
    fn garbage_and_unknown_events_are_dropped() {
        assert!(parse_hook_payload("claude", "").is_none());
        assert!(parse_hook_payload("claude", "{not json").is_none());
        assert!(parse_hook_payload("claude", r#"{"hook_event_name":"FutureEvent"}"#).is_none());
        // Missing optional fields are tolerated.
        let (sig, session) =
            parse_hook_payload("claude", r#"{"hook_event_name":"Notification"}"#).unwrap();
        assert_eq!(
            sig,
            AgentSignal::Notification {
                notification_type: None,
                message: String::new()
            }
        );
        assert_eq!(session, SessionInfo::default());
    }
}
