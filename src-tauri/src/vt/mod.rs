//! A VT engine on the Rust side, as a **passive observer** of the PTY.
//!
//! No renderer changes and no frontend changes: the webview engine keeps
//! drawing the terminal. This exists to answer two questions phasr currently answers
//! badly or not at all.
//!
//! 1. **"Has the agent's TUI taken over?"** `pty/handle.rs` answers this by
//!    scanning bytes for the escape sequences that *set* terminal modes, and
//!    its own comments admit the failure modes (`\x1b[?25l` false-positives
//!    on a shell prompt theme; a `Lagged` broadcast silently drops the
//!    marker). Real terminal state — `modes.alt_screen || modes.mouse_any` —
//!    is the same question asked of the thing that actually knows.
//! 2. **"Which of my six agents needs me?"** A multi-agent orchestrator has
//!    to be able to tell a spinner from an "esc to interrupt" from a y/n
//!    permission prompt from a stalled screen. That needs a grid, not a byte
//!    stream.
//!
//! **Status: not wired in.** The engine-agnostic parts are here and tested,
//! and `vt-alacritty` now provides a real engine (`alacritty.rs`) that the
//! conformance harness (`conformance.rs`, `replay.rs`) exercises against the
//! real on-disk PTY log corpus. Nothing is wired into `PtyHandle::spawn` and
//! no command is exposed: replacing the byte-scanning in `pty/handle.rs` and
//! adding `inspect_terminal` both change live agent-launch behaviour and need
//! their own verification pass.

// Scaffolding: every item here is exercised by this module's own tests but
// nothing calls it from the app yet, which is exactly the intended state.
// Blanket-allowed rather than sprinkled per item so that the day this IS
// wired up, deleting one line restores dead-code coverage over the whole
// module instead of leaving stale allows behind.
#![allow(dead_code)]

#[cfg(feature = "vt-alacritty")]
pub mod alacritty;
/// Conformance against the real on-disk PTY log corpus. Tests only, and only
/// with an engine to run them against.
#[cfg(all(test, feature = "vt-alacritty"))]
mod conformance;
pub mod engine;
pub mod replay;
pub mod thread;

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;

    use super::engine::{VtCursor, VtEngine, VtModes};
    use super::thread::{spawn_vt_thread, PtyWriter};

    /// A stand-in engine: enough VT to exercise the plumbing, and nowhere
    /// near enough to be mistaken for an emulator. It recognises exactly the
    /// mode-setting sequences and device queries these tests are about.
    ///
    /// It is `!Send` on purpose (the `Rc`), because the whole point of the
    /// thread design is that such an engine can still be used — and the fact
    /// that this file compiles is the proof.
    #[derive(Default)]
    struct StubEngine {
        _not_send: std::marker::PhantomData<std::rc::Rc<()>>,
        modes: VtModes,
        replies: Vec<u8>,
        rows: u16,
        cols: u16,
        /// Everything fed so far. A real engine keeps a grid; this keeps the
        /// stream so a sequence split across `advance` calls still matches.
        seen: String,
        /// Queries already answered, so re-scanning `seen` cannot answer the
        /// same one twice.
        answered_da: usize,
        answered_dsr: usize,
    }

    impl StubEngine {
        fn new(rows: u16, cols: u16) -> Self {
            Self {
                rows,
                cols,
                ..Default::default()
            }
        }
    }

    impl VtEngine for StubEngine {
        fn advance(&mut self, bytes: &[u8]) {
            // Appending to the whole stream (rather than looking only at this
            // call's bytes) is what makes a sequence split across `advance`
            // calls still match — the property the replay harness stresses at
            // 1-byte chunks.
            self.seen.push_str(&String::from_utf8_lossy(bytes));
            if self.seen.contains("\x1b[?1049h") {
                self.modes.alt_screen = true;
            }
            if self.seen.contains("\x1b[?1000h") || self.seen.contains("\x1b[?1003h") {
                self.modes.mouse_any = true;
            }
            if self.seen.contains("\x1b[?2004h") {
                self.modes.bracketed_paste = true;
            }
            // Device Attributes: the host MUST answer, exactly once per
            // query. A real engine does this too, and forgetting to service
            // it hangs some TUIs on startup.
            let da = self.seen.matches("\x1b[c").count();
            for _ in self.answered_da..da {
                self.replies.extend_from_slice(b"\x1b[?62;c");
            }
            self.answered_da = da;
            // DSR cursor position report.
            let dsr = self.seen.matches("\x1b[6n").count();
            for _ in self.answered_dsr..dsr {
                self.replies.extend_from_slice(b"\x1b[1;1R");
            }
            self.answered_dsr = dsr;
        }

        fn take_replies(&mut self) -> Vec<u8> {
            std::mem::take(&mut self.replies)
        }
        fn modes(&self) -> VtModes {
            self.modes
        }
        fn cursor(&self) -> VtCursor {
            VtCursor::default()
        }
        fn size(&self) -> (u16, u16) {
            (self.rows, self.cols)
        }
        fn resize(&mut self, rows: u16, cols: u16) {
            self.rows = rows;
            self.cols = cols;
        }
        fn row_text(&self, row: u16) -> Option<String> {
            (row < self.rows).then(|| format!("row{row}"))
        }
    }

    /// Captures what the engine wrote back to the "PTY".
    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Recorder {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn writer_pair() -> (PtyWriter, Arc<Mutex<Vec<u8>>>) {
        let recorder = Recorder::default();
        let seen = recorder.0.clone();
        let writer: PtyWriter = Arc::new(Mutex::new(Box::new(recorder)));
        (writer, seen)
    }

    #[test]
    fn thread_owns_a_non_send_engine_and_answers_inspect() {
        // `StubEngine` is !Send. It is constructed by the closure ON the VT
        // thread and never crosses a boundary; only `VtSnapshot` does.
        let vt = spawn_vt_thread("test", || StubEngine::new(24, 80), None).unwrap();
        vt.feed(b"boot noise \x1b[?1049h".to_vec());

        let snap = vt.inspect(3, Duration::from_secs(2)).expect("no snapshot");
        assert!(snap.modes.alt_screen);
        assert_eq!((snap.rows, snap.cols), (24, 80));
        assert_eq!(snap.tail, vec!["row21", "row22", "row23"]);
        vt.shutdown();
    }

    #[test]
    fn device_attributes_query_is_answered_on_the_pty() {
        // THE regression that would otherwise be invisible: a TUI sends
        // `CSI c` at startup and blocks until the host replies. The webview
        // engine answers today, so nothing in phasr has ever had to. An engine on
        // the Rust side that stays silent hangs the agent with no error
        // anywhere — hence a test, not a comment.
        let (writer, seen) = writer_pair();
        let vt = spawn_vt_thread("test", || StubEngine::new(24, 80), Some(writer)).unwrap();

        vt.feed(b"\x1b[c".to_vec());

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while seen.lock().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(&*seen.lock(), b"\x1b[?62;c", "no DA reply reached the PTY");
        vt.shutdown();
    }

    #[test]
    fn dsr_query_is_also_answered() {
        let (writer, seen) = writer_pair();
        let vt = spawn_vt_thread("test", || StubEngine::new(24, 80), Some(writer)).unwrap();
        vt.feed(b"\x1b[6n".to_vec());

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while seen.lock().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(&*seen.lock(), b"\x1b[1;1R");
        vt.shutdown();
    }

    #[test]
    fn inspect_times_out_instead_of_blocking_a_caller() {
        // Status polling must never hang on a wedged engine.
        let (tx, rx) = mpsc::channel::<super::thread::VtMsg>();
        drop(rx); // nothing will ever answer
        drop(tx);
        let vt = spawn_vt_thread("test", || StubEngine::new(2, 2), None).unwrap();
        vt.shutdown();
        std::thread::sleep(Duration::from_millis(50));
        assert!(vt.inspect(1, Duration::from_millis(100)).is_none());
    }

    #[test]
    fn resize_reaches_the_engine() {
        let vt = spawn_vt_thread("test", || StubEngine::new(24, 80), None).unwrap();
        vt.resize(40, 120);
        let snap = vt.inspect(1, Duration::from_secs(2)).unwrap();
        assert_eq!((snap.rows, snap.cols), (40, 120));
        vt.shutdown();
    }

    #[test]
    fn replay_harness_feeds_a_log_at_arbitrary_chunk_sizes() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.log");
        // A device query straddles every plausible read boundary here.
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"hello\x1b[?1049h world \x1b[c tail\n").unwrap();
        drop(f);

        for chunk in [1usize, 3, 7, 4096] {
            let mut engine = StubEngine::new(24, 80);
            let report = super::replay::replay_log(&path, &mut engine, chunk).unwrap();
            assert_eq!(report.bytes_fed, 29, "chunk={chunk}");
            assert!(report.final_modes.alt_screen, "chunk={chunk}");
            // Exactly one reply, whatever the chunking: answering zero
            // hangs a TUI, answering twice corrupts its input stream.
            assert_eq!(
                report.reply_bytes,
                b"\x1b[?62;c".len(),
                "device query answered {} times at chunk={chunk}",
                report.reply_bytes
            );
        }
    }

    #[test]
    fn corpus_lists_logs_largest_first() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        for (name, size) in [("a.log", 10usize), ("b.log", 100), ("c.txt", 50)] {
            let mut f = std::fs::File::create(dir.path().join(name)).unwrap();
            f.write_all(&vec![b'x'; size]).unwrap();
        }
        let found = super::replay::corpus(dir.path()).unwrap();
        let names: Vec<_> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["b.log", "a.log"], ".txt must be ignored");
    }
}
