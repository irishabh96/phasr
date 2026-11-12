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
//! Values are made shell-INERT here, whatever the template does around
//! the placeholder: the value always lands in single quotes, the only
//! shell quoting with no expansion at all (`$(…)`, backticks, `$VAR` and
//! bash's `!` history expansion all survive double quotes). Templates are
//! user-editable and the prompt is user/agent text, so the old "escape `"`
//! and `\` inside the template's own double quotes" left command
//! substitution wide open. See `quote_for_context`.
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
    interpolate(template, vars, true)
}

/// `interpolate_command` for TRUSTED constant values (phasr's own
/// permission flags) that must be spliced in verbatim — quoting them would
/// turn `--permission-mode acceptEdits` into one bogus argument. Never use
/// this for user or agent text.
pub fn interpolate_trusted(template: &str, vars: &HashMap<&str, &str>) -> String {
    interpolate(template, vars, false)
}

fn interpolate(template: &str, vars: &HashMap<&str, &str>, quote_values: bool) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut cursor = 0;
    let mut quote = QuoteState::Ground;

    while let Some(open) = find_open(&bytes[cursor..]) {
        let open_abs = cursor + open;
        quote = quote.advance(&template[cursor..open_abs]);
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
            Some(value) if quote_values => out.push_str(&quote_for_context(value, quote)),
            Some(value) => {
                quote = quote.advance(value);
                out.push_str(value);
            }
            None => {
                let literal = &template[open_abs..close_abs + CLOSE_DELIM.len()];
                quote = quote.advance(literal);
                out.push_str(literal);
            }
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

/// The shell quoting in effect at a point of the template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuoteState {
    Ground,
    Single,
    Double,
}

impl QuoteState {
    /// The state after the shell reads `text` (backslash escapes outside
    /// single quotes skip the next char, as in sh).
    fn advance(self, text: &str) -> Self {
        let mut state = self;
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            state = match (state, c) {
                (Self::Ground, '\'') => Self::Single,
                (Self::Ground, '"') => Self::Double,
                (Self::Single, '\'') => Self::Ground,
                (Self::Double, '"') => Self::Ground,
                (Self::Ground | Self::Double, '\\') => {
                    chars.next();
                    state
                }
                (s, _) => s,
            };
        }
        state
    }
}

/// The value's text as it goes INSIDE single quotes: control characters
/// dropped (the command is TYPED into a shell — Ctrl-C/Ctrl-U/ESC would
/// act as keys; tabs and newlines stay), each `'` written as `'\''`
/// (close, escaped quote, reopen). Char-local, so the escaped form of a
/// prefix is a prefix of the escaped whole (`command_embeds_prompt`).
pub fn single_quote_inner(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\'' => out.push_str("'\\''"),
            '\t' | '\n' => out.push(c),
            '\u{00}'..='\u{1f}' | '\u{7f}' | '\u{80}'..='\u{9f}' => {}
            other => out.push(other),
        }
    }
    out
}

/// The value as one single-quoted shell word, spliced into whatever quoting
/// the template has open at the placeholder:
/// - bare `{{p}}` → `'v'`;
/// - inside `"…{{p}}…"` → `"'v'"`: close the double quote, the single-
///   quoted value, reopen (adjacent words concatenate, so `"{{p}}"` is
///   still exactly one argument, `""'v'""`);
/// - inside `'…{{p}}…'` → the escaped text alone (already in single quotes).
fn quote_for_context(value: &str, quote: QuoteState) -> String {
    let inner = single_quote_inner(value);
    match quote {
        QuoteState::Ground => format!("'{inner}'"),
        QuoteState::Double => format!("\"'{inner}'\""),
        QuoteState::Single => inner,
    }
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
        assert_eq!(out, r#"claude -p ""'hello world'"""#);
    }

    #[test]
    fn tolerates_whitespace_inside_braces() {
        let out = interpolate_command("echo {{ prompt }}", &vars(&[("prompt", "ok")]));
        assert_eq!(out, "echo 'ok'");
    }

    #[test]
    fn leaves_unknown_placeholders_intact() {
        let out = interpolate_command("run {{prompt}} {{missing}}", &vars(&[("prompt", "x")]));
        assert_eq!(out, "run 'x' {{missing}}");
    }

    /// Run `command` through a real `sh` and return the argv it built
    /// (one arg per line) — the ground truth for "is this shell-inert".
    fn argv_of(command: &str) -> Vec<String> {
        let script = format!("set -- {command}; for a in \"$@\"; do printf '%s\\0' \"$a\"; done");
        let out = std::process::Command::new("sh").arg("-c").arg(&script).output().unwrap();
        assert!(out.status.success(), "{command}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout)
            .unwrap()
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// `$(…)`, backticks, `$VAR`, `'` and `"` all arrive as literal text,
    /// as ONE argument, whichever quoting the template put around the
    /// placeholder.
    #[test]
    fn values_are_shell_inert_in_every_quoting_context() {
        let nasty = r#"it's $(touch /tmp/phasr-x) `id` $HOME "q" \ !! end"#;
        for template in ["x {{p}}", r#"x "{{p}}""#, "x '{{p}}'", r#"x "pre {{p}} post""#] {
            let out = interpolate_command(template, &vars(&[("p", nasty)]));
            let argv = argv_of(&out);
            let expected = match template {
                r#"x "pre {{p}} post""# => format!("pre {nasty} post"),
                _ => nasty.to_string(),
            };
            assert_eq!(argv, vec!["x".to_string(), expected], "{template} → {out}");
        }
        // A literal `'` / `"` earlier in the template is tracked.
        let out = interpolate_command(r#"echo "it's" {{p}}"#, &vars(&[("p", "$(id)")]));
        assert_eq!(argv_of(&out), vec!["echo", "it's", "$(id)"]);
    }

    #[test]
    fn control_characters_are_dropped_from_values() {
        let out = interpolate_command("x {{p}}", &vars(&[("p", "a\x03b\x1b[Ac\nd")]));
        assert_eq!(out, "x 'ab[Ac\nd'");
    }

    #[test]
    fn returns_template_verbatim_when_no_placeholders() {
        let out = interpolate_command("claude --dangerously-skip-permissions", &vars(&[]));
        assert_eq!(out, "claude --dangerously-skip-permissions");
    }

    #[test]
    fn multiple_placeholders_substituted_in_order() {
        let out = interpolate_command("{{a}}-{{b}}-{{a}}", &vars(&[("a", "1"), ("b", "2")]));
        assert_eq!(out, "'1'-'2'-'1'");
    }

    #[test]
    fn double_quotes_in_value_stay_literal() {
        let out = interpolate_command(
            r#"claude -p "{{prompt}}""#,
            &vars(&[("prompt", r#"say "hi""#)]),
        );
        assert_eq!(argv_of(&out), vec!["claude", "-p", r#"say "hi""#]);
    }

    #[test]
    fn backslashes_stay_literal() {
        let out = interpolate_command(r#"echo "{{p}}""#, &vars(&[("p", r"a\b")]));
        assert_eq!(argv_of(&out), vec!["echo", r"a\b"]);
    }

    #[test]
    fn unterminated_placeholder_left_intact() {
        // `{{` with no closing `}}` is a typo — flush verbatim so the
        // user sees what they typed and can fix it.
        let out = interpolate_command("oops {{prompt", &vars(&[("prompt", "x")]));
        assert_eq!(out, "oops {{prompt");
    }

    #[test]
    fn empty_value_substitutes_to_an_empty_quoted_string() {
        let out = interpolate_command("a-{{p}}-b", &vars(&[("p", "")]));
        assert_eq!(out, "a-''-b");
    }
}
