//! The wire format of `claude -p --input-format stream-json
//! --output-format stream-json`, as probed on 2.1.322 (see
//! `fixtures/PROTOCOL.md`): the flags a stream launch adds, and every line
//! Phasr writes to the CLI's stdin.
//!
//! Every stdin line is built with `serde_json` — the CLI exits on the first
//! line it can't parse, so nothing here is ever string-formatted JSON.

use serde_json::{json, Value};

use crate::agent_signals::hook_bridge::shell_quote;
use crate::agent_signals::launch::{inject_after_binary, is_valid_session_id};

/// What the stream process resumes, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionArg {
    /// A new conversation under this id (`--session-id`).
    New(String),
    /// `--resume <id>`: the conversation the task already has.
    Resume(String),
    /// `--continue`: the latest conversation in the cwd — for a task that
    /// ran before but never recorded a session id.
    Continue,
}

impl SessionArg {
    fn args(&self) -> Option<String> {
        match self {
            Self::New(id) if is_valid_session_id(id) => Some(format!("--session-id {}", shell_quote(id))),
            Self::Resume(id) if is_valid_session_id(id) => Some(format!("--resume {}", shell_quote(id))),
            Self::Continue => Some("--continue".into()),
            // Interpolated into a shell line: an id of any other shape is
            // refused, never quoted-and-hoped.
            _ => None,
        }
    }
}

/// Headless stream mode, partial messages on, permission prompts answered
/// by the host over stdio. `--permission-prompts host` (the spec's flag) is
/// already the default and on its own auto-DENIES every prompt; the stdio
/// prompt tool is what routes them to us. `AskUserQuestion` is turned off:
/// answering it needs the CLI's own picker, so the model asks in plain text
/// instead and the user replies in the composer.
///
/// `--thinking-display summarized` (hidden from `--help`; the Agent SDK
/// passes it the same way): without it, `-p` streams every thinking block
/// with empty text (the API default, `omitted`), and the
/// `showThinkingSummaries` setting doesn't apply outside the TUI.
/// `--forward-subagent-text`: a subagent's own text and thinking come
/// through as lines tagged `parent_tool_use_id`, not just its tool calls.
const STREAM_FLAGS: &str = "-p --input-format stream-json --output-format stream-json \
     --verbose --include-partial-messages --permission-prompt-tool stdio \
     --disallowed-tools AskUserQuestion --thinking-display summarized --forward-subagent-text";

/// `command` (the task's resolved launch line, permission flags included)
/// with the stream flags, the session and `extra` (e.g. `--settings`)
/// added right after the `claude` binary word. `None` when the command
/// doesn't visibly run `claude` (a wrapper or alias): such a task stays in
/// the terminal.
pub fn stream_command(command: &str, session: &SessionArg, extra: Option<&str>) -> Option<String> {
    let mut args = vec![STREAM_FLAGS.to_string(), session.args()?];
    if let Some(extra) = extra.filter(|e| !e.trim().is_empty()) {
        args.push(extra.to_string());
    }
    inject_after_binary(command, "claude", &args.join(" "))
}

fn line(value: Value) -> String {
    // A `Value` always serializes; the fallback only satisfies the type.
    serde_json::to_string(&value).unwrap_or_default()
}

pub fn user_message(text: &str) -> String {
    line(json!({
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }))
}

pub fn interrupt_request(request_id: &str) -> String {
    line(json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": "interrupt"},
    }))
}

/// Stop one of the CLI's tasks (a backgrounded command) by ITS task id,
/// the one `task_started` reported, not the tool_use id.
pub fn stop_task_request(request_id: &str, task_id: &str) -> String {
    line(json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": "stop_task", "task_id": task_id},
    }))
}

fn success(request_id: &str, response: Value) -> String {
    line(json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": response},
    }))
}

/// Allow a `can_use_tool` request as asked (`updatedInput` is required:
/// the request's own input). `rules` = session-scoped rules to add with it
/// ("allow for this task").
pub fn allow_response(request_id: &str, input: &Value, rules: &[Value]) -> String {
    let mut response = json!({"behavior": "allow", "updatedInput": input});
    if !rules.is_empty() {
        response["updatedPermissions"] = Value::Array(rules.to_vec());
    }
    success(request_id, response)
}

pub const DENY_MESSAGE: &str = "The user denied this in Phasr.";

pub fn deny_response(request_id: &str) -> String {
    success(request_id, json!({"behavior": "deny", "message": DENY_MESSAGE}))
}

/// The answer to a control request Phasr doesn't handle, so the CLI
/// doesn't wait on it forever.
pub fn error_response(request_id: &str, error: &str) -> String {
    line(json!({
        "type": "control_response",
        "response": {"subtype": "error", "request_id": request_id, "error": error},
    }))
}

/// The request's own `addRules` suggestions, re-scoped to the session:
/// "allow for this task" adds exactly the rule the CLI proposed ("Bash(touch
/// a.txt)"), for this process only — never its `setMode` (accept-edits
/// for the whole session) and never a persistent destination. Empty = the
/// request offers nothing task-scoped.
pub fn session_rules(suggestions: &[Value]) -> Vec<Value> {
    suggestions
        .iter()
        .filter(|s| s.get("type").and_then(Value::as_str) == Some("addRules"))
        .filter(|s| s.get("behavior").and_then(Value::as_str) == Some("allow"))
        .filter(|s| s.get("rules").and_then(Value::as_array).is_some_and(|r| !r.is_empty()))
        .map(|s| {
            let mut s = s.clone();
            s["destination"] = Value::String("session".into());
            s
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "18973063-efa9-4584-9f03-bd619e5c4e80";

    #[test]
    fn stream_flags_go_right_after_the_binary_and_keep_the_mode() {
        let cmd = stream_command(
            "claude --permission-mode acceptEdits",
            &SessionArg::New(SID.into()),
            Some("--settings '/A B/s.json'"),
        )
        .unwrap();
        assert_eq!(
            cmd,
            format!(
                "claude {STREAM_FLAGS} --session-id {SID} --settings '/A B/s.json' --permission-mode acceptEdits"
            )
        );
        let resumed = stream_command("'/opt/x/claude'", &SessionArg::Resume(SID.into()), None).unwrap();
        assert!(resumed.starts_with("'/opt/x/claude' -p "), "{resumed}");
        assert!(resumed.ends_with(&format!("--resume {SID}")), "{resumed}");
        assert!(stream_command("claude", &SessionArg::Continue, None)
            .unwrap()
            .ends_with("--continue"));
        // Not visibly claude: stays in the terminal.
        assert_eq!(stream_command("my-wrapper", &SessionArg::Continue, None), None);
        // A hostile id is never interpolated.
        assert_eq!(stream_command("claude", &SessionArg::Resume("x; rm -rf ~".into()), None), None);
    }

    /// Byte-for-byte what the probe wrote and the CLI accepted.
    #[test]
    fn stdin_lines_match_the_probed_shapes() {
        let v: Value = serde_json::from_str(&user_message("say \"hi\"\nthen stop")).unwrap();
        assert_eq!(
            v,
            json!({"type": "user", "message": {"role": "user",
                   "content": [{"type": "text", "text": "say \"hi\"\nthen stop"}]}})
        );
        assert!(!user_message("a\nb").contains('\n'), "one line per message");

        let v: Value = serde_json::from_str(&interrupt_request("i-1")).unwrap();
        assert_eq!(v, json!({"type": "control_request", "request_id": "i-1", "request": {"subtype": "interrupt"}}));
        let v: Value = serde_json::from_str(&stop_task_request("s-1", "bfj0yav8j")).unwrap();
        assert_eq!(
            v,
            json!({"type": "control_request", "request_id": "s-1",
                   "request": {"subtype": "stop_task", "task_id": "bfj0yav8j"}})
        );

        let input = json!({"command": "touch a.txt"});
        let v: Value = serde_json::from_str(&allow_response("r-1", &input, &[])).unwrap();
        assert_eq!(
            v,
            json!({"type": "control_response", "response": {"subtype": "success", "request_id": "r-1",
                   "response": {"behavior": "allow", "updatedInput": {"command": "touch a.txt"}}}})
        );
        let v: Value = serde_json::from_str(&deny_response("r-2")).unwrap();
        assert_eq!(v["response"]["response"], json!({"behavior": "deny", "message": DENY_MESSAGE}));
        let v: Value = serde_json::from_str(&error_response("r-3", "unsupported")).unwrap();
        assert_eq!(v["response"]["subtype"], "error");
    }

    #[test]
    fn allow_for_the_task_rescopes_only_the_add_rules_suggestion() {
        let suggestions = vec![
            json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "touch a.txt"}],
                   "behavior": "allow", "destination": "localSettings"}),
            json!({"type": "addDirectories", "directories": ["/work/repo"], "destination": "session"}),
            json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
            json!({"type": "addRules", "rules": [], "behavior": "allow", "destination": "userSettings"}),
        ];
        let rules = session_rules(&suggestions);
        assert_eq!(
            rules,
            vec![json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "touch a.txt"}],
                        "behavior": "allow", "destination": "session"})]
        );
        let v: Value =
            serde_json::from_str(&allow_response("r", &json!({}), &rules)).unwrap();
        assert_eq!(v["response"]["response"]["updatedPermissions"][0]["destination"], "session");
        assert!(session_rules(&suggestions[1..3]).is_empty());
    }
}
