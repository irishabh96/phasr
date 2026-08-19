//! `alacritty_terminal` behind the [`VtEngine`] trait.
//!
//! # Why this engine, and what a later swap costs
//!
//! The strategic preference was `libghostty-vt` (crate 0.2.1, MIT), to match
//! the frontend's Ghostty bet. It was not chosen, and the reason is a
//! toolchain one rather than a technical one:
//!
//! - `libghostty-vt` builds Ghostty from source and therefore needs **Zig
//!   0.16.x on PATH for any `cargo check`** — not just for a release build.
//!   `zig` is not installed on this machine and installing a second language
//!   toolchain is not a decision to take unilaterally.
//! - It is `!Send + !Sync` by design, and a third-party wrapper
//!   (`Uzaaft/libghostty-rs`) over an API Ghostty's own docs call unstable.
//! - `alacritty_terminal` 0.26 is Apache-2.0, mature (it is Alacritty's
//!   shipping emulator), `Send`, and needs nothing but cargo.
//!
//! **The swap is a trait impl and nothing else.** `vt/thread.rs` already
//! confines the engine to one OS thread and builds it *on* that thread from a
//! closure, precisely so a `!Send` engine needs no `unsafe impl Send` and no
//! architectural change; `vt/replay.rs` and `vt/frame`-shaped code are written
//! against the trait. Concretely, adding `libghostty-vt` later means: a new
//! `vt/ghostty.rs` implementing the same seven methods, `vt-ghostty =
//! ["dep:libghostty-vt"]` in `Cargo.toml`, a `rust-toolchain.toml`/CI note
//! about Zig, and one `cfg` at the single construction site. No caller of
//! `VtHandle` changes, and the conformance harness re-runs unmodified — which
//! is the entire point of having built the seam first.
//!
//! # Not wired into the live path
//!
//! Nothing here runs in the app. `pty/handle.rs` still does its own byte
//! scanning and there is no `inspect_terminal` command. Those two changes
//! alter live agent-launch behaviour and need their own verification pass.

use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use parking_lot::Mutex;

use super::engine::{VtCursor, VtEngine, VtModes};

/// Sink for everything the emulator wants to write back to the PTY.
///
/// **This is the part that is easy to forget and impossible to notice.**
/// Device Attributes (`CSI c`), DSR (`CSI 6n`), XTVERSION and colour queries
/// are questions the *host* must answer, and some TUIs block on startup until
/// they get one. The webview engine answers them invisibly today, which is
/// why nothing in phasr has ever had to think about it. `alacritty_terminal`
/// surfaces them as `Event::PtyWrite` (and as formatter callbacks for colour
/// / text-area queries) on an `EventListener` — drop the listener and an
/// agent hangs with nothing in any log.
#[derive(Clone, Default)]
pub struct ReplySink(Arc<Mutex<Vec<u8>>>);

impl ReplySink {
    fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *self.0.lock())
    }
}

impl EventListener for ReplySink {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => self.0.lock().extend_from_slice(text.as_bytes()),
            // `OSC 4 ; n ; ?` — "what is palette entry n?". The formatter
            // turns an RGB into the reply the program is waiting for. phasr
            // has no palette on this side, so answer with the terminal's
            // default rather than staying silent: a wrong colour is a
            // cosmetic bug, silence is a hang.
            Event::ColorRequest(_, format) => {
                let rgb = alacritty_terminal::vte::ansi::Rgb { r: 0, g: 0, b: 0 };
                self.0.lock().extend_from_slice(format(rgb).as_bytes());
            }
            // `CSI 14 t` / `CSI 18 t`. Cell pixel size is a renderer fact the
            // observer does not have; report the grid and a plausible cell so
            // the shape of the answer is right.
            Event::TextAreaSizeRequest(format) => {
                let size = WindowSize {
                    num_lines: 0,
                    num_cols: 0,
                    cell_width: 0,
                    cell_height: 0,
                };
                self.0.lock().extend_from_slice(format(size).as_bytes());
            }
            _ => {}
        }
    }
}

/// Grid dimensions, in the shape `Term` wants. `alacritty_terminal` ships an
/// equivalent only under `#[cfg(test)]`, hence the local copy.
#[derive(Debug, Clone, Copy)]
struct TermSize {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

pub struct AlacrittyEngine {
    term: Term<ReplySink>,
    parser: Processor,
    replies: ReplySink,
}

impl AlacrittyEngine {
    pub fn new(rows: u16, cols: u16, scrollback: usize) -> Self {
        let replies = ReplySink::default();
        let size = clamp_size(rows, cols);
        let config = Config {
            scrolling_history: scrollback,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &size, replies.clone()),
            parser: Processor::new(),
            replies,
        }
    }
}

/// `Term::new` panics below its own minimums, and a PTY can legitimately
/// report a 0×0 grid mid-resize.
fn clamp_size(rows: u16, cols: u16) -> TermSize {
    TermSize {
        columns: (cols as usize).max(alacritty_terminal::term::MIN_COLUMNS),
        screen_lines: (rows as usize).max(alacritty_terminal::term::MIN_SCREEN_LINES),
    }
}

impl VtEngine for AlacrittyEngine {
    fn advance(&mut self, bytes: &[u8]) {
        // `Processor` keeps its own partial-sequence state across calls, so an
        // escape split across two PTY reads is handled — the property
        // `replay.rs` stresses by replaying the same log at 1, 3, 7 and 4096
        // byte chunk sizes.
        self.parser.advance(&mut self.term, bytes);
    }

    fn take_replies(&mut self) -> Vec<u8> {
        self.replies.take()
    }

    fn modes(&self) -> VtModes {
        let mode = *self.term.mode();
        VtModes {
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
            // DECSET 1000 / 1002 / 1003 all land in one of these three.
            mouse_any: mode.intersects(
                TermMode::MOUSE_REPORT_CLICK | TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION,
            ),
            focus_report: mode.contains(TermMode::FOCUS_IN_OUT),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            cursor_visible: mode.contains(TermMode::SHOW_CURSOR),
        }
    }

    fn cursor(&self) -> VtCursor {
        let point = self.term.grid().cursor.point;
        VtCursor {
            // `Line` is signed because it indexes scrollback too; the cursor
            // is always on screen, so this is 0..rows.
            row: point.line.0.max(0) as u16,
            col: point.column.0 as u16,
        }
    }

    fn size(&self) -> (u16, u16) {
        (
            self.term.screen_lines() as u16,
            self.term.columns() as u16,
        )
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        self.term.resize(clamp_size(rows, cols));
    }

    fn row_text(&self, row: u16) -> Option<String> {
        let rows = self.term.screen_lines() as u16;
        if row >= rows {
            return None;
        }
        let grid = self.term.grid();
        let line = &grid[Line(row as i32)];
        let mut out = String::with_capacity(self.term.columns());
        for col in 0..self.term.columns() {
            let cell = &line[Column(col)];
            // The trailing half of a double-width grapheme carries a dummy
            // char; emitting it would double every CJK/emoji character.
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            out.push(cell.c);
        }
        while out.ends_with(' ') {
            out.pop();
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> AlacrittyEngine {
        AlacrittyEngine::new(24, 80, 1000)
    }

    #[test]
    fn device_attributes_query_is_answered() {
        // The regression that hangs an agent with no error anywhere. A real
        // engine, not the stub in `vt/mod.rs`.
        let mut e = engine();
        e.advance(b"\x1b[c");
        let reply = e.take_replies();
        assert!(!reply.is_empty(), "CSI c went unanswered");
        assert!(
            reply.starts_with(b"\x1b[?"),
            "not a Device Attributes reply: {:?}",
            String::from_utf8_lossy(&reply)
        );
        // And exactly once.
        assert!(e.take_replies().is_empty());
    }

    #[test]
    fn dsr_cursor_position_is_answered_with_the_real_position() {
        let mut e = engine();
        e.advance(b"\x1b[5;9H\x1b[6n");
        let reply = String::from_utf8(e.take_replies()).unwrap();
        assert_eq!(reply, "\x1b[5;9R");
    }

    #[test]
    fn a_query_split_across_advance_calls_is_still_answered_once() {
        // Arbitrary PTY read boundaries are the norm, not the exception.
        for split in 1..4 {
            let mut e = engine();
            let query = b"\x1b[6n";
            e.advance(&query[..split]);
            let mid = e.take_replies();
            e.advance(&query[split..]);
            let mut reply = mid;
            reply.extend(e.take_replies());
            assert_eq!(
                String::from_utf8(reply).unwrap(),
                "\x1b[1;1R",
                "split at {split}"
            );
        }
    }

    #[test]
    fn alt_screen_and_mouse_modes_are_real_state_not_substrings() {
        let mut e = engine();
        assert!(!e.modes().alt_screen);
        e.advance(b"\x1b[?1049h");
        assert!(e.modes().alt_screen);
        e.advance(b"\x1b[?1049l");
        assert!(!e.modes().alt_screen, "leaving alt screen must clear it");

        e.advance(b"\x1b[?1003h");
        assert!(e.modes().mouse_any);
        e.advance(b"\x1b[?1004h");
        assert!(e.modes().focus_report);
    }

    /// The false positive `pty/handle.rs` documents at its own call site: a
    /// shell prompt that hides the cursor reads as "a TUI booted" to a byte
    /// scanner. To real terminal state it is just a hidden cursor.
    #[test]
    fn hiding_the_cursor_is_not_a_tui_takeover() {
        let mut e = engine();
        e.advance(b"\x1b[?25l");
        let modes = e.modes();
        assert!(!modes.cursor_visible);
        assert!(!modes.alt_screen);
        assert!(!modes.mouse_any);
        assert!(!modes.focus_report);
    }

    /// Echo verification becomes positional and exact instead of "did these
    /// bytes appear anywhere in a 4 KB rolling window".
    #[test]
    fn tail_reads_the_bottom_rows_of_the_grid() {
        let mut e = engine();
        e.advance(b"first\r\n");
        e.advance(b"\x1b[24;1Hprompt> hello world");
        let tail = e.tail(2);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[1], "prompt> hello world");
        assert!(e.row_text(0).unwrap().starts_with("first"));
        assert_eq!(e.row_text(24), None, "out of range must be None");
    }

    /// Minimal reproduction of what the corpus replay found: a multi-byte
    /// UTF-8 grapheme split across two `advance()` calls.
    #[test]
    fn a_multibyte_grapheme_split_across_advance_calls() {
        let text = "a·b"; // U+00B7 is C2 B7
        let bytes = text.as_bytes();
        for split in 1..bytes.len() {
            let mut e = engine();
            e.advance(&bytes[..split]);
            e.advance(&bytes[split..]);
            assert_eq!(
                e.row_text(0).unwrap(),
                text,
                "split at byte {split} of {bytes:?}"
            );
        }
    }

    #[test]
    fn a_wide_grapheme_occupies_one_char_not_two() {
        let mut e = engine();
        e.advance("hi 世界".as_bytes());
        assert_eq!(e.row_text(0).unwrap(), "hi 世界");
    }

    #[test]
    fn resize_reaches_the_grid_and_clamps_a_degenerate_size() {
        let mut e = engine();
        e.resize(40, 120);
        assert_eq!(e.size(), (40, 120));
        // A PTY can report 0x0 mid-resize; `Term::new`/`resize` panic below
        // their own minimums.
        e.resize(0, 0);
        assert_eq!(e.size(), (1, 2));
    }

    #[test]
    fn cursor_position_is_zero_based_on_screen() {
        let mut e = engine();
        e.advance(b"\x1b[3;7H");
        assert_eq!(e.cursor(), VtCursor { row: 2, col: 6 });
    }
}
