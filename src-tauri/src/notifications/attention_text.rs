//! The words on a "needs you" notification: one short title, one short
//! line of body. The full command / path / question is on the approval
//! card in the app; a banner that wraps over eight lines is noise.
//!
//! The single source for this text: the inbox entry (and therefore the
//! toast and the non-macOS banner, which reuse its title/body) and the
//! native macOS notification both come through here.
//!
//! Pure: no I/O, so every case is a unit test.

use serde_json::Value;

use crate::agent_signals::state::AttentionKind;
use crate::domain::Agent;

/// Body budget, in characters: one line in a macOS banner.
pub const MAX_BODY_CHARS: usize = 70;
/// Task-name budget inside the title, so "· Claude needs you" stays visible.
pub const MAX_TASK_NAME_CHARS: usize = 32;

/// `"<task> · <Agent> needs you"`, the task name ellipsised.
pub fn title(task_name: &str, agent: Option<Agent>) -> String {
    let who = agent.map(Agent::label).unwrap_or("The agent");
    let name = ellipsize(&one_line(task_name), MAX_TASK_NAME_CHARS);
    if name.is_empty() {
        format!("{who} needs you")
    } else {
        format!("{name} · {who} needs you")
    }
}

/// One line, at most `MAX_BODY_CHARS`:
/// - shell: `Run: <first command segment>`
/// - edit: `Edit: <file name>` (`Write:` for a new file)
/// - other tools: `<Tool>: <short arg>`
/// - questions, input, trust: the dialog's own title.
pub fn body(kind: AttentionKind, title: &str, detail: Option<&str>) -> String {
    let detail = detail.map(str::trim).filter(|d| !d.is_empty());
    let text = match kind {
        AttentionKind::Shell => match detail.and_then(first_command) {
            Some(cmd) => format!("Run: {cmd}"),
            None => fallback(title, "Run a shell command"),
        },
        AttentionKind::Edit => {
            let verb = if title.trim_start().starts_with("Write") {
                "Write"
            } else {
                "Edit"
            };
            match detail.and_then(file_name) {
                Some(name) => format!("{verb}: {name}"),
                None => fallback(title, "Edit a file"),
            }
        }
        AttentionKind::Tool => {
            let tool = tool_label(title);
            match detail.and_then(short_arg) {
                Some(arg) if !tool.is_empty() => format!("{tool}: {arg}"),
                Some(arg) => arg,
                None => fallback(title, "Use a tool"),
            }
        }
        AttentionKind::Question | AttentionKind::Input | AttentionKind::Trust => {
            match one_line(title) {
                t if !t.is_empty() => t,
                _ => detail.map(one_line).unwrap_or_else(|| "Waiting for you".into()),
            }
        }
    };
    ellipsize(&one_line(&text), MAX_BODY_CHARS)
}

fn fallback(title: &str, default: &str) -> String {
    match one_line(title) {
        t if t.is_empty() => default.to_string(),
        t => t,
    }
}

/// The first segment of a shell command line: up to the first `;`, `&&`,
/// `|` (so also `||`) or newline that isn't inside quotes. Leading bare
/// assignments (`F=/some/path; ls $F`) are skipped when a command follows
/// them — "Run: F=/some/path" says nothing about what will run.
pub fn first_command(command: &str) -> Option<String> {
    let segments = split_segments(command);
    let mut fallback = None;
    for segment in segments {
        let segment = one_line(&segment);
        if segment.is_empty() {
            continue;
        }
        if is_bare_assignment(&segment) {
            fallback.get_or_insert(segment);
            continue;
        }
        return Some(segment);
    }
    fallback
}

/// Split at unquoted `;`, `|`, `&&` and line breaks. Quotes and backslash
/// escapes are honoured so `grep "a|b"` stays one segment.
fn split_segments(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let (mut single, mut double, mut escaped) = (false, false, false);
    while let Some(c) = chars.next() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' if !single => {
                current.push(c);
                escaped = true;
            }
            '\'' if !double => {
                single = !single;
                current.push(c);
            }
            '"' if !single => {
                double = !double;
                current.push(c);
            }
            ';' | '|' | '\n' | '\r' if !single && !double => {
                out.push(std::mem::take(&mut current));
            }
            '&' if !single && !double && chars.peek() == Some(&'&') => {
                chars.next();
                out.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    out.push(current);
    out
}

/// `NAME=value` with nothing after it (no command word).
fn is_bare_assignment(segment: &str) -> bool {
    let mut words = segment.split_whitespace();
    let all_assignments = words.clone().all(|w| {
        w.split_once('=').is_some_and(|(name, _)| {
            let mut name_chars = name.chars();
            name_chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && name_chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    });
    words.next().is_some() && all_assignments
}

fn file_name(path: &str) -> Option<String> {
    let line = path.lines().next()?.trim().trim_end_matches(['/', '\\']);
    let name = line.rsplit(['/', '\\']).next().unwrap_or(line).trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// "Use github create_issue" → "github create_issue"; "Fetch a web page" →
/// "Fetch"; anything else is used as written.
fn tool_label(title: &str) -> String {
    let title = one_line(title);
    if let Some(rest) = title.strip_prefix("Use ") {
        return rest.trim().to_string();
    }
    if title == "Fetch a web page" {
        return "Fetch".into();
    }
    title
}

/// A tool's argument, briefly: the first string field of a JSON input
/// (`{"query":"rust"}` → `rust`), else the detail's first non-empty line.
fn short_arg(detail: &str) -> Option<String> {
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(detail) {
        let first = map
            .values()
            .find_map(|v| match v {
                Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
                _ => None,
            })
            .or_else(|| {
                map.values().find_map(|v| match v {
                    Value::Null | Value::Object(_) | Value::Array(_) => None,
                    other => Some(other.to_string()),
                })
            });
        return first.map(|s| one_line(&s)).filter(|s| !s.is_empty());
    }
    detail
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(one_line)
}

/// Whitespace runs (newlines and tabs included) collapsed to one space.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `max` characters (not bytes — never splits a code point),
/// ending in `…` when cut.
pub fn ellipsize(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const GST: &str = r#"F=/Library/Frameworks/GStreamer.framework/Versions/1.0; ls $F/include/gstreamer-1.0/gst/webrtc/ | head -40; grep -rn -i "agent\|property\|PROP" $F/include/gstreamer-1.0/gst/webrtc/webrtcbin.h"#;

    fn chars(s: &str) -> usize {
        s.chars().count()
    }

    #[test]
    fn title_names_the_task_and_the_agent() {
        assert_eq!(title("hello sir", Some(Agent::Claude)), "hello sir · Claude needs you");
        assert_eq!(title("fix it", Some(Agent::Codex)), "fix it · Codex needs you");
        assert_eq!(title("fix it", None), "fix it · The agent needs you");
        assert_eq!(title("  ", Some(Agent::Claude)), "Claude needs you");
    }

    #[test]
    fn a_long_task_name_is_ellipsised_but_the_agent_stays() {
        let t = title(
            "Refactor the authentication middleware so sessions survive a restart",
            Some(Agent::Claude),
        );
        assert!(t.ends_with("… · Claude needs you"), "{t}");
        assert!(chars(&t) <= MAX_TASK_NAME_CHARS + " · Claude needs you".len());
    }

    #[test]
    fn the_reported_command_becomes_one_short_line() {
        let b = body(AttentionKind::Shell, "Run a shell command", Some(GST));
        assert_eq!(b, "Run: ls $F/include/gstreamer-1.0/gst/webrtc/");
        assert!(chars(&b) <= MAX_BODY_CHARS);
        assert!(!b.contains('\n'));
    }

    #[test]
    fn shell_takes_the_first_segment_before_each_separator() {
        let run = |cmd: &str| body(AttentionKind::Shell, "Run a shell command", Some(cmd));
        assert_eq!(run("pnpm test; pnpm lint"), "Run: pnpm test");
        assert_eq!(run("cd web && pnpm build"), "Run: cd web");
        assert_eq!(run("cat log.txt | grep error"), "Run: cat log.txt");
        assert_eq!(run("make || echo failed"), "Run: make");
        assert_eq!(run("git status\ngit diff"), "Run: git status");
        assert_eq!(run("  \n  cargo   test  \n"), "Run: cargo test");
        // A single `&` backgrounds, it doesn't chain.
        assert_eq!(run("sleep 1 & wait"), "Run: sleep 1 & wait");
    }

    #[test]
    fn separators_inside_quotes_do_not_split() {
        let run = |cmd: &str| body(AttentionKind::Shell, "Run a shell command", Some(cmd));
        assert_eq!(run(r#"grep -E "a|b;c" src | wc -l"#), r#"Run: grep -E "a|b;c" src"#);
        assert_eq!(run("echo 'x && y'; ls"), "Run: echo 'x && y'");
        assert_eq!(run(r"echo a\;b; ls"), r"Run: echo a\;b");
    }

    #[test]
    fn bare_assignments_are_skipped_unless_that_is_all_there_is() {
        let run = |cmd: &str| body(AttentionKind::Shell, "Run a shell command", Some(cmd));
        assert_eq!(run("A=1 B=2; make"), "Run: make");
        assert_eq!(run("FOO=bar make"), "Run: FOO=bar make");
        assert_eq!(run("FOO=bar"), "Run: FOO=bar");
    }

    #[test]
    fn a_long_command_is_ellipsised_to_one_line() {
        let long = format!("python3 -c '{}'", "print(1);".repeat(30));
        let b = body(AttentionKind::Shell, "Run a shell command", Some(&long));
        assert_eq!(chars(&b), MAX_BODY_CHARS);
        assert!(b.starts_with("Run: python3 -c '"));
        assert!(b.ends_with('…'));
    }

    #[test]
    fn unicode_is_cut_on_characters_not_bytes() {
        let cmd = format!("echo {}", "日本語のテキスト🚀".repeat(12));
        let b = body(AttentionKind::Shell, "Run a shell command", Some(&cmd));
        assert_eq!(chars(&b), MAX_BODY_CHARS);
        assert!(b.ends_with('…'));
        assert_eq!(ellipsize("héllo wörld", 6), "héllo…");
        assert_eq!(ellipsize("🚀🚀🚀", 3), "🚀🚀🚀");
    }

    #[test]
    fn empty_details_fall_back_to_the_title() {
        assert_eq!(body(AttentionKind::Shell, "Run a shell command", Some("")), "Run a shell command");
        assert_eq!(body(AttentionKind::Shell, "Run a shell command", Some(" ; ")), "Run a shell command");
        assert_eq!(body(AttentionKind::Shell, "", None), "Run a shell command");
        assert_eq!(body(AttentionKind::Edit, "Edit a file", None), "Edit a file");
        assert_eq!(body(AttentionKind::Tool, "", None), "Use a tool");
        assert_eq!(body(AttentionKind::Input, "", None), "Waiting for you");
    }

    #[test]
    fn edits_show_the_file_name() {
        assert_eq!(
            body(AttentionKind::Edit, "Edit src/lib/very/deep/store.ts", Some("src/lib/very/deep/store.ts")),
            "Edit: store.ts"
        );
        assert_eq!(body(AttentionKind::Edit, "Write notes.md", Some("notes.md")), "Write: notes.md");
        assert_eq!(body(AttentionKind::Edit, "Edit", Some("C:\\repo\\main.rs")), "Edit: main.rs");
    }

    #[test]
    fn tools_show_their_name_and_a_short_argument() {
        assert_eq!(
            body(AttentionKind::Tool, "Fetch a web page", Some("https://example.com/a")),
            "Fetch: https://example.com/a"
        );
        assert_eq!(
            body(AttentionKind::Tool, "Use github create_issue", Some(r#"{"repo":"phasr","title":"Bug"}"#)),
            "github create_issue: phasr"
        );
        assert_eq!(body(AttentionKind::Tool, "Use Sleep", Some(r#"{"ms":500}"#)), "Sleep: 500");
        assert_eq!(body(AttentionKind::Tool, "Use Thing", Some("{}")), "Use Thing");
        assert_eq!(body(AttentionKind::Tool, "Approve a tool call", None), "Approve a tool call");
    }

    #[test]
    fn questions_and_input_use_their_title_on_one_line() {
        assert_eq!(body(AttentionKind::Question, "Approve the plan", Some("1. do x\n2. do y")), "Approve the plan");
        assert_eq!(body(AttentionKind::Input, "Pick one\nof these", None), "Pick one of these");
        let long = "Claude needs your permission to use a tool that has a very long description indeed";
        assert_eq!(chars(&body(AttentionKind::Input, long, None)), MAX_BODY_CHARS);
    }
}
