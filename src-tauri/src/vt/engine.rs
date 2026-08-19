//! The engine contract. Deliberately small, and deliberately **not**
//! `Send`/`Sync`: the leading candidate (`libghostty-vt`) is `!Send + !Sync`
//! by design, and the correct answer to that is to confine the engine to one
//! thread by construction (see `vt::thread`) rather than to reach for an
//! `unsafe impl Send`.

/// Terminal modes phasr actually cares about — the ones that answer "has an
/// agent's TUI taken over this terminal?".
///
/// This is what replaces the byte-scanning in `pty/handle.rs`, which looks
/// for the *escape sequences that set these modes* and therefore inherits
/// every false positive they can produce. `\x1b[?25l` in a fancy shell prompt
/// reads as "a TUI booted"; `modes.alt_screen || modes.mouse_any` cannot,
/// because it is the terminal's actual state rather than a substring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VtModes {
    /// DECSET 1049 — full-screen apps (codex, copilot, opencode).
    pub alt_screen: bool,
    /// Any of DECSET 1000/1002/1003 — mouse reporting (claude).
    pub mouse_any: bool,
    /// DECSET 1004 — focus reporting (claude).
    pub focus_report: bool,
    /// DECSET 2004. Every interactive shell sets this while drawing its own
    /// prompt, so it is evidence of a line editor, never of an agent.
    pub bracketed_paste: bool,
    /// DECTCEM. Ink-based TUIs hide the cursor; so do some shell themes.
    pub cursor_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VtCursor {
    /// 0-based, relative to the top of the visible screen.
    pub row: u16,
    pub col: u16,
}

/// A VT emulator phasr can observe. One implementation per candidate engine;
/// everything else in this module is written against this trait so choosing
/// an engine is a new file rather than a refactor.
pub trait VtEngine {
    /// Feed raw PTY bytes. Never lossy, never decoded — this is the same
    /// byte stream the frontend gets.
    fn advance(&mut self, bytes: &[u8]);

    /// Take whatever the emulator owes the PTY in reply, and clear it.
    ///
    /// **Not optional.** Device Attributes (`CSI c`), DSR (`CSI 6n`) and
    /// XTVERSION are questions the host must answer, and some TUIs block on
    /// startup until they get an answer. The webview engine answers them
    /// invisibly today, which is why nobody has had to think about it — an
    /// engine added on the Rust side that stays silent would hang an agent
    /// with no error anywhere.
    fn take_replies(&mut self) -> Vec<u8>;

    fn modes(&self) -> VtModes;
    fn cursor(&self) -> VtCursor;
    /// (rows, cols)
    fn size(&self) -> (u16, u16);
    fn resize(&mut self, rows: u16, cols: u16);

    /// Text of one visible row, 0 = top of the screen. Trailing blanks
    /// trimmed. `None` when out of range.
    fn row_text(&self, row: u16) -> Option<String>;

    /// The bottom `n` visible rows, top-most first.
    ///
    /// The positional part matters: verifying a typed prompt echoed back
    /// becomes "is the needle in the bottom rows", which is exact, instead of
    /// "did the needle appear anywhere in a 4 KB rolling window of bytes",
    /// which is a coincidence detector.
    fn tail(&self, n: u16) -> Vec<String> {
        let (rows, _) = self.size();
        let start = rows.saturating_sub(n);
        (start..rows).filter_map(|r| self.row_text(r)).collect()
    }
}
