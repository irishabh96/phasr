//! Command-template interpolation.
//!
//! Agent commands are templates like `claude -p "{{prompt}}"`. The
//! orchestrator substitutes the active task's variables (currently
//! `prompt`, but the format leaves room for more) before handing the
//! resulting string to the PTY.
//!
//! Substitution rules:
//!   * `{{name}}` → the value of `vars["name"]`. Whitespace inside the
//!     braces is tolerated (`{{ prompt }}` works identically).
//!   * Unknown variables are left literally in the output. The PTY
//!     surfaces them, which is the friendliest failure mode for a
//!     user editing their own preset.
//!   * No escape sequence — `{{` always opens a placeholder. We don't
//!     have a use case for emitting literal `{{` today; if one shows
//!     up later, add `{{{{` → `{{` per Liquid/Handlebars convention.
//!
//! Shell-quoting is the *caller's* responsibility. Templates are
//! expected to wrap variable expansions in quotes (`-p "{{prompt}}"`),
//! and prompts containing literal double-quotes are escaped here so
//! the surrounding quotes stay balanced.
//!
//! The interpolation is intentionally minimal — anything more would
//! belong in a real template engine. Resist the urge to add filters,
//! conditionals, or loops here.
//!
//! See seeded presets in `src-tauri/migrations/0004_*` for the variable
//! names currently in use.

use std::collections::HashMap;

/// Interpolate `{{var}}` placeholders in `template` from `vars`.
///
/// Unknown placeholders are left intact. Values are escaped so any
/// embedded `"` characters can't break out of a surrounding shell
/// quote — see module docs.
pub fn interpolate_command(template: &str, vars: &HashMap<&str, &str>) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut cursor = 0;

    while let Some(open) = find_open(&bytes[cursor..]) {
        let open_abs = cursor + open;
        out.push_str(&template[cursor..open_abs]);

        let after_open = open_abs + OPEN_DELIM.len();
        let Some(close_rel) = find_close(&bytes[after_open..]) else {
            // Unterminated `{{` — flush the rest verbatim and stop.
            out.push_str(&template[open_abs..]);
            return out;
        };
        let close_abs = after_open + close_rel;
        let name = template[after_open..close_abs].trim();

        match vars.get(name) {
            Some(value) => out.push_str(&shell_escape_double_quotes(value)),
            None => out.push_str(&template[open_abs..close_abs + CLOSE_DELIM.len()]),
        }

        cursor = close_abs + CLOSE_DELIM.len();
    }

    out.push_str(&template[cursor..]);
    out
}

const OPEN_DELIM: &str = "{{";
const CLOSE_DELIM: &str = "}}";

fn find_open(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(OPEN_DELIM.len())
        .position(|w| w == OPEN_DELIM.as_bytes())
}

fn find_close(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(CLOSE_DELIM.len())
        .position(|w| w == CLOSE_DELIM.as_bytes())
}

/// Escape embedded `"` so a value pasted inside `"…"` in a shell command
/// can't terminate its quote. Also escapes backslashes so an escape
/// chain like `\"` from user input survives intact.
fn shell_escape_double_quotes(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str(r#"\""#),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&'static str, &'static str)]) -> HashMap<&'static str, &'static str> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn substitutes_single_variable() {
        let out = interpolate_command(
            r#"claude -p "{{prompt}}""#,
            &vars(&[("prompt", "hello world")]),
        );
        assert_eq!(out, r#"claude -p "hello world""#);
    }

    #[test]
    fn tolerates_whitespace_inside_braces() {
        let out = interpolate_command("echo {{ prompt }}", &vars(&[("prompt", "ok")]));
        assert_eq!(out, "echo ok");
    }

    #[test]
    fn leaves_unknown_placeholders_intact() {
        let out = interpolate_command("run {{prompt}} {{missing}}", &vars(&[("prompt", "x")]));
        assert_eq!(out, "run x {{missing}}");
    }

    #[test]
    fn returns_template_verbatim_when_no_placeholders() {
        let out = interpolate_command("claude --dangerously-skip-permissions", &vars(&[]));
        assert_eq!(out, "claude --dangerously-skip-permissions");
    }

    #[test]
    fn multiple_placeholders_substituted_in_order() {
        let out = interpolate_command("{{a}}-{{b}}-{{a}}", &vars(&[("a", "1"), ("b", "2")]));
        assert_eq!(out, "1-2-1");
    }

    #[test]
    fn escapes_double_quotes_in_value() {
        // Input prompt contains a `"` — without escaping, it would
        // close the surrounding shell quote and leak the rest as code.
        let out = interpolate_command(
            r#"claude -p "{{prompt}}""#,
            &vars(&[("prompt", r#"say "hi""#)]),
        );
        assert_eq!(out, r#"claude -p "say \"hi\"""#);
    }

    #[test]
    fn escapes_backslashes() {
        let out = interpolate_command(r#"echo "{{p}}""#, &vars(&[("p", r"a\b")]));
        assert_eq!(out, r#"echo "a\\b""#);
    }

    #[test]
    fn unterminated_placeholder_left_intact() {
        // `{{` with no closing `}}` is a typo — flush verbatim so the
        // user sees what they typed and can fix it.
        let out = interpolate_command("oops {{prompt", &vars(&[("prompt", "x")]));
        assert_eq!(out, "oops {{prompt");
    }

    #[test]
    fn empty_value_substitutes_to_empty_string() {
        let out = interpolate_command("a-{{p}}-b", &vars(&[("p", "")]));
        assert_eq!(out, "a--b");
    }
}
