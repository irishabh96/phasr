//! Fallback "needs you" detection from PTY output.
//!
//! Hooks are the primary signal; this exists for agents without them
//! (Gemini, Copilot, OpenCode), for Codex approvals (its `notify` only
//! reports turn ends), and for a Claude whose hooks never fired.
//!
//! The PTY stream is ANSI-stripped into a rolling tail. After the output has
//! been quiet for `QUIET`, the tail's END is matched against the agent's
//! dialog table. Guards against false positives:
//!
//! - A dialog must be what the output *ends with*: the question must sit in
//!   the last `WINDOW` chars, be followed by its answer options within
//!   `OPTIONS_SPAN`, and by little else (`TRAILER_MAX`) — prose that merely
//!   quotes "Do you want to proceed?" has no options after it, and a dialog
//!   that was answered is followed by the tool's output.
//! - Text the user has already reacted to is never re-matched: user input
//!   marks the tail "consumed" up to that point, so only a *re-rendered*
//!   dialog can raise again.
//! - A full clear / alternate-screen switch resets the tail (nothing before
//!   it is on screen any more).
//! - Respond buttons (`can_respond`) only for dialogs whose option layout is
//!   known; anything else is "Waiting for input · Open terminal".
//!
//! #PLAN_UNCERTAINTY: no phasr task log contains an approval dialog yet
//! (every task so far ran skip-all), so the tables are built from each CLI's
//! shipped UI strings (Claude 2.1.319 bundle, codex-cli 0.165 binary,
//! gemini-cli 0.34 dist) rather than captured PTY fixtures. Copilot's
//! strings ship compressed and couldn't be read: its rule never offers
//! respond buttons.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;

use crate::domain::Agent;

use super::state::{AttentionKind, KeyOverrides};

/// Output silence before the tail is evaluated.
pub const QUIET: Duration = Duration::from_millis(1200);
/// Rolling tail size (chars), trimmed back to `TAIL_KEEP` when exceeded.
const TAIL_MAX: usize = 8 * 1024;
const TAIL_KEEP: usize = 6 * 1024;
/// Only the end of the tail is searched for a question.
const WINDOW: usize = 4 * 1024;
/// The options must follow the question within this many chars.
const OPTIONS_SPAN: usize = 600;
/// …and at most this much text may follow the options (footer/hints).
const TRAILER_MAX: usize = 400;

#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub kind: AttentionKind,
    pub title: String,
    pub detail: Option<String>,
    pub can_respond: bool,
    /// Hotkeys printed on the dialog itself, when it shows them.
    pub keys: KeyOverrides,
}

struct Rule {
    agents: &'static [Agent],
    question: Regex,
    options: Option<Regex>,
    kind: AttentionKind,
    title: &'static str,
    /// Option layout matches `Agent::approval_keys` for this agent.
    can_respond: bool,
}

/// `"Do you want"` → `Do\s*you\s*want`: TUIs often move the cursor instead
/// of printing spaces, which the stripper turns into a space — or nothing.
fn phrase(p: &str) -> String {
    p.split(' ').collect::<Vec<_>>().join(r"\s*")
}

fn rule(
    agents: &'static [Agent],
    question: &str,
    options: Option<&str>,
    kind: AttentionKind,
    title: &'static str,
    can_respond: bool,
) -> Rule {
    // The patterns are compile-time constants: a failure is a programming
    // error caught by the tests, not a runtime condition.
    Rule {
        agents,
        question: Regex::new(&phrase(question)).expect("heuristic question regex"),
        options: options.map(|o| Regex::new(&phrase(o)).expect("heuristic options regex")),
        kind,
        title,
        can_respond,
    }
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        use AttentionKind::*;
        const CLAUDE: &[Agent] = &[Agent::Claude];
        const CODEX: &[Agent] = &[Agent::Codex];
        const GEMINI: &[Agent] = &[Agent::Gemini];
        const COPILOT: &[Agent] = &[Agent::Copilot];
        vec![
            // Claude: "<header>\n…\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and
            // don't ask again…\n  3. No, and tell Claude what to do differently (esc)"
            rule(CLAUDE, r"Do you want to make this edit to \S+?\?", Some(r"1\. Yes"), Edit, "Edit a file", true),
            rule(CLAUDE, r"Do you want to create \S+?\?", Some(r"1\. Yes"), Edit, "Create a file", true),
            rule(CLAUDE, r"Do you want to proceed\?", Some(r"1\. Yes"), Tool, "Approve a tool call", true),
            // Workspace trust, shown on the first run in every fresh worktree
            // and BEFORE any hook can fire. 2.1.x focuses "No, exit", so the
            // generic approval keys would quit Claude: the answer keys are
            // read off the option layout instead (`trust_keys`), and the
            // card is detect-only when the layout can't be read.
            rule(CLAUDE, r"one you trust\?", Some(r"Yes, I trust this folder"), Trust, "Trust this folder?", true),
            rule(CLAUDE, r"Do you trust the files in this folder\?", Some(r"Yes, proceed"), Trust, "Trust this folder?", true),
            // Codex (ratatui overlay; y / a / esc hotkeys).
            rule(CODEX, r"Would you like to run the following command\?", Some(r"Yes, proceed"), Shell, "Run a shell command", true),
            rule(CODEX, r"Would you like to make the following edits\?", Some(r"Yes, proceed"), Edit, "Apply file edits", true),
            // Different option set (session/host grants): don't guess keys.
            rule(CODEX, r"Would you like to grant these permissions\?", None, Tool, "Grant permissions", false),
            // Gemini: "Allow once / Allow for this session / … / No, suggest changes (esc)".
            rule(GEMINI, r"Allow execution of MCP tool", Some(r"Allow once"), Tool, "Use an MCP tool", true),
            rule(GEMINI, r"Allow execution of", Some(r"Allow once"), Shell, "Run a shell command", true),
            rule(GEMINI, r"Apply this change\?", Some(r"Allow once"), Edit, "Apply a file change", true),
            rule(GEMINI, r"Do you want to proceed\?", Some(r"Allow once"), Tool, "Approve a tool call", true),
            // Copilot: strings unverified (see module doc) — detect only.
            rule(COPILOT, r"Do you want to (run|allow|use|proceed)", Some(r"\bYes\b"), Tool, "Approve a tool call", false),
        ]
    })
}

/// A shell-style `[y/N]` prompt at the very end, any agent.
fn yes_no_prompt() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(\[y/n\]|\(y/n\)|\[yes/no\])\s*:?\s*$").expect("y/n regex")
    })
}

/// Header lines that tell a generic Claude "Do you want to proceed?" apart.
fn claude_kind_from_context(before: &str) -> Option<(AttentionKind, &'static str)> {
    // The header sits above the command block and two full-width rules
    // (~250 chars on a 120-col terminal, more on wider ones).
    let tail: String = before.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
    if tail.contains("Bash command") {
        Some((AttentionKind::Shell, "Run a shell command"))
    } else if tail.contains("Edit file") || tail.contains("Create file") || tail.contains("Write file") {
        Some((AttentionKind::Edit, "Edit a file"))
    } else if tail.contains("Fetch") {
        Some((AttentionKind::Tool, "Fetch a web page"))
    } else {
        None
    }
}

/// Match the end of `text` (already ANSI-stripped) against `agent`'s dialogs.
pub fn detect(agent: Agent, text: &str) -> Option<Detection> {
    let start = floor_char_boundary(text, text.len().saturating_sub(WINDOW));
    let window = &text[start..];
    let mut best: Option<(usize, Detection)> = None;
    for r in rules().iter().filter(|r| r.agents.contains(&agent)) {
        // The LAST occurrence: an older, answered copy above doesn't count.
        let Some(q) = r.question.find_iter(window).last() else {
            continue;
        };
        let after = &window[q.end()..];
        let trailer_from = match &r.options {
            Some(opts) => {
                let span_end = floor_char_boundary(after, after.len().min(OPTIONS_SPAN));
                match opts.find(&after[..span_end]) {
                    Some(m) => m.end(),
                    None => continue,
                }
            }
            None => 0,
        };
        // Options are rendered as a block; allow the remaining option lines
        // plus a footer, but not a screenful of later output.
        let trailer = after[trailer_from..].trim();
        if trailer.chars().count() > TRAILER_MAX {
            continue;
        }
        let (mut kind, mut title) = (r.kind, r.title.to_string());
        if agent == Agent::Claude && r.title == "Approve a tool call" {
            if let Some((k, t)) = claude_kind_from_context(&window[..q.start()]) {
                kind = k;
                title = t.to_string();
            }
        }
        let mut can_respond = r.can_respond;
        let keys = if r.kind == AttentionKind::Trust {
            match trust_keys(after) {
                Some(keys) => keys,
                None => {
                    can_respond = false;
                    KeyOverrides::default()
                }
            }
        } else if agent == Agent::Codex {
            codex_hotkeys(after)
        } else if agent == Agent::Claude {
            claude_option_keys(after)
        } else {
            KeyOverrides::default()
        };
        let found = Detection {
            kind,
            title,
            detail: None,
            can_respond,
            keys,
        };
        // Rules are ordered specific-first; among matches prefer the latest.
        if best.as_ref().is_none_or(|(at, _)| q.start() > *at) {
            best = Some((q.start(), found));
        }
    }
    if let Some((_, found)) = best {
        return Some(found);
    }
    let end = floor_char_boundary(text, text.len().saturating_sub(120));
    if yes_no_prompt().is_match(text[end..].trim_end()) {
        return Some(Detection {
            kind: AttentionKind::Input,
            title: "Waiting for input".into(),
            detail: None,
            can_respond: false,
            keys: KeyOverrides::default(),
        });
    }
    None
}

/// Codex prints each option's hotkey: `1. Yes, proceed (y)  2. Yes, and
/// don't ask again for … (p)  3. No, … (esc)`. Observed on 0.165: the "don't
/// ask again" key is `p` for a command-prefix rule; other variants (session
/// grants) use other letters, so it's read off the screen, not assumed.
fn codex_hotkeys(after_question: &str) -> KeyOverrides {
    static OPTION: OnceLock<Regex> = OnceLock::new();
    static KEY: OnceLock<Regex> = OnceLock::new();
    let option = OPTION.get_or_init(|| {
        Regex::new(r"(?s)([12])\.\s*Yes,(.*?)(?:[23]\.\s*(?:Yes|No),|$)").expect("codex option regex")
    });
    let key = KEY.get_or_init(|| Regex::new(r"\(\s*([a-z])\s*\)").expect("codex key regex"));
    let span = &after_question[..floor_char_boundary(after_question, after_question.len().min(OPTIONS_SPAN))];
    let mut keys = KeyOverrides::default();
    let mut rest = span;
    while let Some(c) = option.captures(rest) {
        let whole = c.get(0).map(|m| m.end()).unwrap_or(rest.len());
        // The option's own label ends at its last `(x)`: a command quoted in
        // the label can't contribute a key that comes before it.
        let found = key
            .captures_iter(&c[2])
            .last()
            .map(|k| k[1].to_string());
        match &c[1] {
            "1" => keys.allow_once = found,
            _ => keys.allow_task = found,
        }
        // Continue from the next option's number (the lookahead consumed it).
        let next = c.get(2).map(|m| m.end()).unwrap_or(whole);
        if next >= rest.len() {
            break;
        }
        rest = &rest[next..];
    }
    keys
}

/// Claude's permission-dialog options, read off the screen:
/// `1. Yes  2. Yes, <grant>  [3. Yes, and switch to auto mode]  N. No`.
/// What option 2 grants varies per dialog — "always allow access to <dir>
/// from this project" and "don't ask again for <cmd> commands in <dir>" are
/// PERSISTENT project rules (written to the user's checkout for in-place
/// tasks), while "allow all edits during this session" is scoped to this
/// session. Only a session-scoped option becomes `allow_task`; with none,
/// "Allow for this task" is unavailable rather than silently saving a rule.
fn claude_option_keys(after_question: &str) -> KeyOverrides {
    static OPTION: OnceLock<Regex> = OnceLock::new();
    let option = OPTION.get_or_init(|| Regex::new(r"([1-9])\.\s*(Yes|No)\b").expect("claude option regex"));
    let starts: Vec<(usize, usize, String)> = option
        .captures_iter(after_question)
        .filter_map(|c| {
            let m = c.get(0)?;
            Some((m.start(), m.end(), c[1].to_string()))
        })
        .collect();
    let mut keys = KeyOverrides::default();
    for (i, (start, label_from, number)) in starts.iter().enumerate() {
        let label_to = starts.get(i + 1).map_or(after_question.len(), |next| next.0);
        let full = &after_question[*start..label_to];
        if !full.contains("Yes") {
            continue;
        }
        let label = &after_question[(*label_from).min(label_to)..label_to];
        // Words may be glued together where the TUI moved the cursor
        // instead of printing a space.
        let squashed: String = label.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
        if number == "1" && squashed.is_empty() {
            keys.allow_once = Some("1".into());
        } else if squashed.contains("session")
            && !squashed.contains("always")
            && !squashed.contains("project")
            && !squashed.contains("automode")
            && keys.allow_task.is_none()
        {
            keys.allow_task = Some(number.clone());
        }
    }
    keys
}

/// The keystrokes that answer Claude's folder-trust dialog, read off its
/// option layout. Two layouts ship:
///
/// - 2.1.x: `❯ No, exit` / `Yes, I trust this folder` — unnumbered, with
///   "No" listed first AND focused (`cancelFirst`, `focus: "cancel"` in the
///   bundle), so a bare Enter quits Claude.
/// - older: `❯ 1. Yes, proceed` / `2. No, exit`, "Yes" focused.
///
/// "Yes" is reached with arrow keys from whichever option the `❯` selector
/// is on, then Enter; arrows work in both layouts, number keys only in the
/// numbered one. Deny is Esc ("Esc to cancel"), which exits WITHOUT
/// depending on where the selector is — a misread layout can then never
/// turn a "deny" into trusting the folder. `None` when the selector or
/// either option can't be found: the card is shown without respond buttons
/// rather than with keys that might pick the wrong option.
fn trust_keys(after_question: &str) -> Option<KeyOverrides> {
    static YES: OnceLock<Regex> = OnceLock::new();
    static NO: OnceLock<Regex> = OnceLock::new();
    let yes_re = YES.get_or_init(|| {
        Regex::new(&phrase(r"Yes, (I trust this folder|proceed)")).expect("trust yes regex")
    });
    let no_re = NO.get_or_init(|| {
        Regex::new(&phrase(r"No, (exit|continue without)")).expect("trust no regex")
    });
    // The selector sits right before its option's label (a cursor move
    // and maybe the option's number in between).
    const SELECTOR_REACH: usize = 12;
    let span = &after_question[..floor_char_boundary(after_question, after_question.len().min(OPTIONS_SPAN))];
    let yes = yes_re.find(span)?.start();
    let no = no_re.find(span)?.start();
    // The LAST selector: an earlier `❯` would be from a previous frame.
    let selector = span.rfind('\u{276f}')?;
    let mut options = [(yes, true), (no, false)];
    options.sort_by_key(|(at, _)| *at);
    let selected = options.iter().position(|(at, _)| *at > selector)?;
    if options[selected].0 - selector > SELECTOR_REACH {
        return None;
    }
    let target = options.iter().position(|(_, is_yes)| *is_yes)?;
    let arrow = if target > selected { "\x1b[B" } else { "\x1b[A" };
    let mut accept = arrow.repeat(target.abs_diff(selected));
    accept.push('\r');
    Some(KeyOverrides {
        allow_once: Some(accept.clone()),
        allow_task: Some(accept),
        deny: Some("\x1b".into()),
    })
}

/// Whether `agent` can show a dialog of kind `Trust` (and so whether its
/// initial prompt needs `AgentSignals::prompt_gate`).
pub fn has_trust_dialog(agent: Agent) -> bool {
    rules()
        .iter()
        .any(|r| r.kind == AttentionKind::Trust && r.agents.contains(&agent))
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// ANSI-stripping rolling tail of one PTY's output.
#[derive(Debug, Default)]
pub struct TailBuffer {
    text: String,
    /// Byte offset into `text`: everything before it has been seen by the
    /// user (they typed after it was printed) and is never matched again.
    consumed: usize,
    stripper: AnsiStripper,
    /// When output last arrived — the prompt gate waits for the screen to
    /// settle (and, after an answer, for it to change) before judging it.
    last_push: Option<Instant>,
}

impl TailBuffer {
    pub fn push(&mut self, bytes: &[u8]) {
        self.last_push = Some(Instant::now());
        for piece in self.stripper.feed(bytes) {
            match piece {
                Piece::Text(t) => self.text.push_str(&t),
                Piece::Reset => {
                    self.text.clear();
                    self.consumed = 0;
                }
            }
        }
        if self.text.len() > TAIL_MAX {
            let cut = floor_char_boundary(&self.text, self.text.len() - TAIL_KEEP);
            self.text.drain(..cut);
            self.consumed = self.consumed.saturating_sub(cut);
        }
    }

    pub fn last_push(&self) -> Option<Instant> {
        self.last_push
    }

    /// The user reacted to what's on screen now.
    pub fn mark_consumed(&mut self) {
        self.consumed = self.text.len();
    }

    pub fn detect(&self, agent: Agent) -> Option<Detection> {
        detect(agent, &self.text[self.consumed..])
    }

    #[cfg(test)]
    pub fn text(&self) -> &str {
        &self.text
    }
}

enum Piece {
    Text(String),
    Reset,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
enum StripState {
    #[default]
    Ground,
    Esc,
    Csi,
    /// OSC/DCS/APC/PM string, until BEL or ST.
    Str,
    StrEsc,
    /// One more byte after `ESC (` / `ESC )` etc.
    Charset,
}

/// Streaming ANSI stripper. Escape sequences and incomplete UTF-8 may span
/// chunk boundaries, so both carry over between `feed` calls. Also used by
/// run-command port detection (`run_commands::ports`).
#[derive(Debug, Default)]
pub(crate) struct AnsiStripper {
    state: StripState,
    csi: Vec<u8>,
    utf8: Vec<u8>,
}

impl AnsiStripper {
    /// The visible text in `bytes`, screen resets dropped — for scanners
    /// that only care about what was printed, not where.
    pub(crate) fn feed_text(&mut self, bytes: &[u8]) -> String {
        let mut out = String::new();
        for piece in self.feed(bytes) {
            if let Piece::Text(t) = piece {
                out.push_str(&t);
            } else {
                out.push('\n');
            }
        }
        out
    }

    fn feed(&mut self, bytes: &[u8]) -> Vec<Piece> {
        let mut out: Vec<Piece> = Vec::new();
        let mut text: Vec<u8> = std::mem::take(&mut self.utf8);
        let flush = |text: &mut Vec<u8>, out: &mut Vec<Piece>| {
            if !text.is_empty() {
                out.push(Piece::Text(String::from_utf8_lossy(text).into_owned()));
                text.clear();
            }
        };
        for &b in bytes {
            match self.state {
                StripState::Ground => match b {
                    0x1b => self.state = StripState::Esc,
                    b'\r' | b'\n' => text.push(b'\n'),
                    b'\t' => text.push(b' '),
                    0x00..=0x1f | 0x7f => {}
                    _ => text.push(b),
                },
                StripState::Esc => {
                    self.state = match b {
                        b'[' => {
                            self.csi.clear();
                            StripState::Csi
                        }
                        b']' | b'P' | b'_' | b'^' | b'X' => StripState::Str,
                        b'(' | b')' | b'*' | b'+' | b'#' | b'%' => StripState::Charset,
                        // RIS (full reset) clears the screen.
                        b'c' => {
                            flush(&mut text, &mut out);
                            out.push(Piece::Reset);
                            StripState::Ground
                        }
                        _ => StripState::Ground,
                    };
                }
                StripState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.state = StripState::Ground;
                        let params = std::mem::take(&mut self.csi);
                        match b {
                            // Cursor movement: a visual gap → a space.
                            b'A' | b'B' | b'C' | b'D' | b'E' | b'F' | b'G' | b'H' | b'f'
                            | b'd' | b'`' => text.push(b' '),
                            // Erase display 2/3 = everything is gone.
                            b'J' if params == b"2" || params == b"3" => {
                                flush(&mut text, &mut out);
                                out.push(Piece::Reset);
                            }
                            // Alternate screen on/off: a different screen.
                            b'h' | b'l'
                                if params == b"?1049" || params == b"?47" || params == b"?1047" =>
                            {
                                flush(&mut text, &mut out);
                                out.push(Piece::Reset);
                            }
                            _ => {}
                        }
                    } else if self.csi.len() < 64 {
                        self.csi.push(b);
                    } else {
                        // Not a CSI anyone sends; give up on it.
                        self.state = StripState::Ground;
                    }
                }
                StripState::Str => match b {
                    0x07 => self.state = StripState::Ground,
                    0x1b => self.state = StripState::StrEsc,
                    _ => {}
                },
                StripState::StrEsc => {
                    self.state = if b == b'\\' {
                        StripState::Ground
                    } else {
                        StripState::Str
                    };
                }
                StripState::Charset => self.state = StripState::Ground,
            }
        }
        // Hold back a trailing partial UTF-8 sequence for the next chunk.
        let keep = incomplete_utf8_suffix(&text);
        self.utf8 = text.split_off(text.len() - keep);
        flush(&mut text, &mut out);
        out
    }
}

pub(crate) fn incomplete_utf8_suffix(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let b = bytes[bytes.len() - back];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte
        }
        let needed = if b & 0b1110_0000 == 0b1100_0000 {
            2
        } else if b & 0b1111_0000 == 0b1110_0000 {
            3
        } else if b & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            1
        };
        return if needed > back { back } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail(chunks: &[&[u8]]) -> TailBuffer {
        let mut t = TailBuffer::default();
        for c in chunks {
            t.push(c);
        }
        t
    }

    /// Claude's Bash permission dialog as Ink renders it: colours, cursor
    /// moves for indentation, box-drawing, the ❯ selector.
    const CLAUDE_BASH_DIALOG: &[u8] = b"\x1b[2K\x1b[1A\x1b[2K\x1b[G\x1b[38;5;174m\xe2\x95\xad\xe2\x94\x80\xe2\x94\x80\x1b[39m\r\n\x1b[1mBash command\x1b[22m\r\n\r\n\x1b[3Gpnpm test\r\n\x1b[3G\x1b[2mRun the test suite\x1b[22m\r\n\r\nDo you want to proceed?\r\n\x1b[36m\xe2\x9d\xaf\x1b[39m 1. Yes\r\n\x1b[3G2. Yes, and don't ask again for \x1b[1mpnpm test\x1b[22m commands in /w\r\n\x1b[3G3. No, and tell Claude what to do differently \x1b[2m(esc)\x1b[22m\r\n";

    #[test]
    fn claude_bash_dialog_is_recognised_as_shell() {
        let t = tail(&[b"Working...\r\n", CLAUDE_BASH_DIALOG]);
        let d = t.detect(Agent::Claude).unwrap();
        assert_eq!(d.kind, AttentionKind::Shell);
        assert_eq!(d.title, "Run a shell command");
        assert!(d.can_respond);
    }

    #[test]
    fn dialog_split_across_chunks_mid_escape_and_mid_utf8() {
        let (a, b) = CLAUDE_BASH_DIALOG.split_at(70);
        let (b1, b2) = b.split_at(200);
        let t = tail(&[a, b1, b2]);
        assert!(t.detect(Agent::Claude).is_some(), "{:?}", t.text());
        // ❯ survived the split as one char.
        assert!(t.text().contains('\u{276f}'));
    }

    #[test]
    fn codex_and_gemini_dialogs() {
        let codex = tail(&[b"\x1b[5;1HWould you like to run the following command?\x1b[6;1H\x1b[7;3H$ cargo test\x1b[9;1H\xe2\x80\xba 1. Yes, proceed (y)\x1b[10;3H2. Yes, and don't ask again for this command in this session (a)\x1b[11;3H3. No, and tell Codex what to do differently (esc)\x1b[13;1HPress enter to confirm or esc to cancel"]);
        let d = codex.detect(Agent::Codex).unwrap();
        assert_eq!((d.kind, d.can_respond), (AttentionKind::Shell, true));

        let gemini = tail(&[b"\x1b[33m?\x1b[39m Shell rm -rf dist\r\n\r\nAllow execution of: 'rm'?\r\n\r\n\x1b[32m\xe2\x97\x8f\x1b[39m 1. Allow once\r\n  2. Allow for this session\r\n  3. No, suggest changes (esc)\r\n"]);
        let d = gemini.detect(Agent::Gemini).unwrap();
        assert_eq!(d.kind, AttentionKind::Shell);
        assert!(d.can_respond);
    }

    #[test]
    fn glued_words_from_cursor_moves_still_match() {
        // Each space drawn as a cursor-forward: stripped to a space; and a
        // renderer that skips unchanged cells can glue words outright.
        let t = tail(&[b"Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?\r\n1.Yes\r\n2. No\r\n"]);
        assert!(t.detect(Agent::Claude).is_some());
        let t = tail(&[b"Doyouwanttoproceed?\n1.Yes\n"]);
        assert!(t.detect(Agent::Claude).is_some());
    }

    /// Captured from a real Claude Code 2.1.319 PTY (path sanitized): the
    /// workspace-trust dialog every fresh worktree shows before any hook
    /// can fire. "No, exit" is listed first AND focused, so "allow" is
    /// Down-then-Enter and "deny" is Esc — never the generic "1"/Enter.
    #[test]
    fn real_claude_trust_dialog_answers_by_layout() {
        let t = tail(&[include_bytes!("fixtures/claude-2.1.319-trust.ansi")]);
        let d = t.detect(Agent::Claude).unwrap();
        assert_eq!(d.kind, AttentionKind::Trust);
        assert_eq!(d.title, "Trust this folder?");
        assert!(d.can_respond);
        assert_eq!(d.keys.allow_once.as_deref(), Some("\x1b[B\r"));
        assert_eq!(d.keys.allow_task.as_deref(), Some("\x1b[B\r"));
        assert_eq!(d.keys.deny.as_deref(), Some("\x1b"));
        assert!(has_trust_dialog(Agent::Claude));
        assert!(!has_trust_dialog(Agent::Codex));
    }

    /// The older numbered layout focuses "Yes, proceed": Enter alone.
    #[test]
    fn older_claude_trust_dialog_with_yes_focused_is_enter() {
        let t = tail(&[b"Do you trust the files in this folder?\r\n\r\n/w/repo\r\n\r\n\x1b[36m\xe2\x9d\xaf\x1b[39m 1. Yes, proceed\r\n  2. No, exit\r\n\r\nEnter to confirm \xc2\xb7 Esc to exit\r\n"]);
        let d = t.detect(Agent::Claude).unwrap();
        assert_eq!(d.kind, AttentionKind::Trust);
        assert!(d.can_respond);
        assert_eq!(d.keys.allow_once.as_deref(), Some("\r"));
        assert_eq!(d.keys.deny.as_deref(), Some("\x1b"));
    }

    /// No selector on screen → which option Enter picks is unknown: the
    /// dialog is still reported (it gates the prompt) but not answerable.
    #[test]
    fn trust_dialog_without_a_readable_selector_is_detect_only() {
        let t = tail(&[b"Quick safety check: Is this a project you created or one you trust?\r\n\r\n No, exit\r\n Yes, I trust this folder\r\n"]);
        let d = t.detect(Agent::Claude).unwrap();
        assert_eq!(d.kind, AttentionKind::Trust);
        assert!(!d.can_respond);
        assert_eq!(d.keys, KeyOverrides::default());
    }

    /// Captured from a real Claude Code 2.1.319 PTY (paths sanitized): the
    /// Bash permission dialog, spaces drawn as cursor moves, 4 options
    /// ("1. Yes … 4. No", "Esc to cancel · Tab to amend").
    #[test]
    fn real_claude_bash_permission_dialog_is_recognised() {
        let t = tail(&[include_bytes!("fixtures/claude-2.1.319-bash-permission.ansi")]);
        let d = t.detect(Agent::Claude).unwrap();
        assert_eq!(d.kind, AttentionKind::Shell);
        assert_eq!(d.title, "Run a shell command");
        assert!(d.can_respond);
        // Option 2 here is "always allow access to <dir> from this
        // project" — a persistent rule, so NOT "allow for this task".
        assert_eq!(d.keys.allow_once.as_deref(), Some("1"));
        assert_eq!(d.keys.allow_task, None);
    }

    #[test]
    fn claude_allow_task_is_only_a_session_scoped_option() {
        let edit = " ❯ 1. Yes  2. Yes, allow all edits during this session (shift+tab)  3. No, and tell Claude what to do differently (esc)";
        let keys = claude_option_keys(edit);
        assert_eq!(keys.allow_once.as_deref(), Some("1"));
        assert_eq!(keys.allow_task.as_deref(), Some("2"));
        // Glued words still read.
        assert_eq!(claude_option_keys("1.Yes 2.Yes,allowalleditsduringthissession 3.No").allow_task.as_deref(), Some("2"));
        for persistent in [
            " ❯ 1. Yes  2. Yes, and always allow access to /w from this project  3. Yes, and switch to auto mode  4. No",
            " ❯ 1. Yes  2. Yes, and don't ask again for git commands in /w  3. No",
            " ❯ 1. Yes  2. Yes, and always allow this session's project  3. No",
        ] {
            assert_eq!(claude_option_keys(persistent).allow_task, None, "{persistent}");
        }
    }

    /// Captured from a real codex-cli 0.165 PTY: the sandbox-escalation
    /// overlay, drawn with cursor positioning (no CR/LF), with its hotkeys.
    #[test]
    fn real_codex_overlay_is_detected_with_its_printed_hotkeys() {
        let t = tail(&[include_bytes!("fixtures/codex-0.165-approval.ansi")]);
        let d = t.detect(Agent::Codex).unwrap();
        assert_eq!(d.kind, AttentionKind::Shell);
        assert!(d.can_respond);
        assert_eq!(d.keys.allow_once.as_deref(), Some("y"));
        assert_eq!(d.keys.allow_task.as_deref(), Some("p"));
    }

    #[test]
    fn codex_hotkeys_follow_the_variant_and_ignore_parens_in_commands() {
        let keys = codex_hotkeys(
            " $ echo (x)\n1. Yes, proceed (y)\n2. Yes, and don't ask again for this command in this session (a)\n3. No, and tell Codex what to do differently (esc)",
        );
        assert_eq!(keys.allow_once.as_deref(), Some("y"));
        assert_eq!(keys.allow_task.as_deref(), Some("a"));
        let keys = codex_hotkeys(" 1. Yes, proceed (y) 2. Yes, and don't ask again for commands that start with `printf (q)` ( p ) 3. No, (esc)");
        assert_eq!(keys.allow_task.as_deref(), Some("p"));
        assert_eq!(codex_hotkeys("no options here"), KeyOverrides::default());
    }

    // ---- false positives ----------------------------------------------

    #[test]
    fn prose_quoting_the_question_without_options_is_ignored() {
        let t = tail(&[b"I'll add a confirm step that asks \"Do you want to proceed?\" before deleting.\r\n> "]);
        assert!(t.detect(Agent::Claude).is_none());
    }

    #[test]
    fn an_answered_dialog_followed_by_output_is_ignored() {
        let mut later = Vec::new();
        for i in 0..40 {
            later.extend_from_slice(format!("PASS src/test_{i}.ts (12 ms)\r\n").as_bytes());
        }
        let t = tail(&[CLAUDE_BASH_DIALOG, b"\x1b[6A\x1b[J", &later]);
        assert!(t.detect(Agent::Claude).is_none());
    }

    #[test]
    fn options_too_far_from_the_question_are_ignored() {
        let mut text = b"Do you want to proceed?\r\n".to_vec();
        text.extend(std::iter::repeat(b'x').take(OPTIONS_SPAN + 10));
        text.extend_from_slice(b"\r\n1. Yes\r\n");
        assert!(tail(&[&text]).detect(Agent::Claude).is_none());
    }

    #[test]
    fn another_agents_dialog_text_is_ignored() {
        let t = tail(&[b"Would you like to run the following command?\r\n1. Yes, proceed (y)\r\n"]);
        assert!(t.detect(Agent::Claude).is_none());
        assert!(t.detect(Agent::Codex).is_some());
    }

    #[test]
    fn consumed_text_is_not_rematched_but_a_redraw_is() {
        let mut t = tail(&[CLAUDE_BASH_DIALOG]);
        assert!(t.detect(Agent::Claude).is_some());
        t.mark_consumed();
        // The user pressed a key; a little unrelated output follows.
        t.push(b"\r\n\x1b[2mRunning\xe2\x80\xa6\x1b[22m\r\n");
        assert!(t.detect(Agent::Claude).is_none());
        // The dialog is drawn again (e.g. the key only moved the selector).
        t.push(CLAUDE_BASH_DIALOG);
        assert!(t.detect(Agent::Claude).is_some());
    }

    #[test]
    fn screen_clear_resets_the_tail() {
        let t = tail(&[CLAUDE_BASH_DIALOG, b"\x1b[2J\x1b[Hfresh screen\r\n"]);
        assert!(t.detect(Agent::Claude).is_none());
        assert_eq!(t.text().trim(), "fresh screen");
        let t = tail(&[CLAUDE_BASH_DIALOG, b"\x1b[?1049h"]);
        assert!(t.text().is_empty());
    }

    #[test]
    fn copilot_and_yes_no_prompts_detect_without_respond_buttons() {
        let t = tail(&[b"Do you want to run this command?\r\n> Yes\r\n  No\r\n"]);
        let d = t.detect(Agent::Copilot).unwrap();
        assert!(!d.can_respond);

        let t = tail(&[b"Overwrite config.json? [y/N] "]);
        let d = t.detect(Agent::OpenCode).unwrap();
        assert_eq!(d.kind, AttentionKind::Input);
        assert!(!d.can_respond);
        // …but not mid-output.
        let t = tail(&[b"Overwrite config.json? [y/N] y\r\nwrote config.json\r\n"]);
        assert!(t.detect(Agent::OpenCode).is_none());
    }

    #[test]
    fn tail_is_bounded() {
        let mut t = TailBuffer::default();
        for _ in 0..100 {
            t.push(&[b'a'; 1000]);
        }
        assert!(t.text().len() <= TAIL_MAX);
        assert!(t.detect(Agent::Claude).is_none());
    }

    #[test]
    fn osc_and_charset_sequences_are_dropped() {
        let t = tail(&[b"\x1b]0;title\x07\x1b(Bhello\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"]);
        assert_eq!(t.text(), "hellolink");
    }
}
