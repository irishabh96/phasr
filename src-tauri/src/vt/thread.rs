//! The per-PTY VT thread: one OS thread that owns one engine, for its whole
//! life, and never lets it out.
//!
//! ```text
//! Thread A  "phasr-pty-{id}"   read() -> mpsc -> coalescer  (unchanged)
//!                              \-------------> vt_tx        (the tap)
//! Thread B  "phasr-vt-{id}"    owns the engine. Speaks VtMsg, which is Send.
//!                              The engine is not, and never crosses.
//! ```
//!
//! The engine is built by a closure **inside** thread B, so an engine that is
//! `!Send`/`!Sync` is confined by construction. No `unsafe impl Send`, and no
//! way for a later change to accidentally move one: there is no value to move.
//! Keeping this shape even for a `Send` engine is what makes swapping engines
//! a trait impl and nothing else.

use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::engine::{VtCursor, VtEngine, VtModes};

/// A `Send` snapshot of engine state. Everything that leaves thread B is one
/// of these — plain data, no engine references.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VtSnapshot {
    pub modes: VtModes,
    pub cursor: VtCursor,
    pub rows: u16,
    pub cols: u16,
    /// Bottom rows of the screen, top-most first.
    pub tail: Vec<String>,
}

/// Messages into the VT thread. `Send` by construction — reply channels
/// rather than shared state, so no lock is ever held across the boundary.
pub enum VtMsg {
    /// Raw PTY bytes, exactly as thread A read them.
    Feed(Vec<u8>),
    Resize {
        rows: u16,
        cols: u16,
    },
    /// Snapshot the bottom `rows` rows and send it back.
    Inspect {
        rows: u16,
        reply: mpsc::Sender<VtSnapshot>,
    },
    Shutdown,
}

/// Handle to a running VT thread. Cloneable; dropping every clone lets the
/// thread finish on channel close.
#[derive(Clone)]
pub struct VtHandle {
    tx: mpsc::Sender<VtMsg>,
}

impl VtHandle {
    /// Tap point for thread A. Errors only once the thread is gone, which is
    /// not worth propagating — the VT engine is an observer, and losing it
    /// must never disturb the terminal.
    pub fn feed(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(VtMsg::Feed(bytes));
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        let _ = self.tx.send(VtMsg::Resize { rows, cols });
    }

    /// Ask for a snapshot. `None` if the thread is gone or too busy to answer
    /// within `timeout` — callers are status polls, and a status poll must
    /// never block the caller on a wedged engine.
    pub fn inspect(&self, rows: u16, timeout: Duration) -> Option<VtSnapshot> {
        let (reply, rx) = mpsc::channel();
        self.tx.send(VtMsg::Inspect { rows, reply }).ok()?;
        rx.recv_timeout(timeout).ok()
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(VtMsg::Shutdown);
    }
}

/// PTY writer, shared with `PtyHandle`. The VT thread needs it to answer
/// device queries — see `VtEngine::take_replies`.
pub type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// How long the thread will sit idle before looping (so `Shutdown` and a
/// dropped channel are both noticed promptly even with no PTY traffic).
const IDLE_TICK: Duration = Duration::from_millis(250);

/// Spawn the VT thread.
///
/// `make_engine` runs **on the new thread**, which is what confines a
/// non-`Send` engine. That is why this takes a constructor and not an engine.
pub fn spawn_vt_thread<F, E>(
    task_id: &str,
    make_engine: F,
    writer: Option<PtyWriter>,
) -> std::io::Result<VtHandle>
where
    F: FnOnce() -> E + Send + 'static,
    E: VtEngine,
{
    let (tx, rx) = mpsc::channel::<VtMsg>();
    std::thread::Builder::new()
        .name(format!("phasr-vt-{task_id}"))
        .spawn(move || run(make_engine(), rx, writer))?;
    Ok(VtHandle { tx })
}

fn run<E: VtEngine>(
    mut engine: E,
    rx: mpsc::Receiver<VtMsg>,
    writer: Option<PtyWriter>,
) {
    loop {
        match rx.recv_timeout(IDLE_TICK) {
            Ok(VtMsg::Feed(bytes)) => {
                engine.advance(&bytes);
                flush_replies(&mut engine, writer.as_ref());
            }
            Ok(VtMsg::Resize { rows, cols }) => {
                engine.resize(rows, cols);
                flush_replies(&mut engine, writer.as_ref());
            }
            Ok(VtMsg::Inspect { rows, reply }) => {
                let (r, c) = engine.size();
                let _ = reply.send(VtSnapshot {
                    modes: engine.modes(),
                    cursor: engine.cursor(),
                    rows: r,
                    cols: c,
                    tail: engine.tail(rows),
                });
            }
            Ok(VtMsg::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// Write back whatever the emulator owes the PTY. Silence here is how a TUI
/// waiting on a Device Attributes reply hangs forever with nothing in any log.
fn flush_replies<E: VtEngine>(engine: &mut E, writer: Option<&PtyWriter>) {
    let replies = engine.take_replies();
    if replies.is_empty() {
        return;
    }
    let Some(writer) = writer else {
        // No writer wired (replay/conformance runs). Dropping is correct
        // there — there is no PTY on the other end to answer.
        return;
    };
    let mut guard = writer.lock();
    let _ = guard.write_all(&replies);
    let _ = guard.flush();
}
