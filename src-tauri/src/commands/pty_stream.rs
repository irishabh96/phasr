//! The one PTY→webview forwarder, and the two commands that steer it.
//!
//! Three command families open terminals — agent tasks
//! (`commands/orchestrator.rs`), ad-hoc shell sessions
//! (`commands/session_terminal.rs`) and run-commands
//! (`commands/run_commands.rs`) — and each used to carry its own byte-for-byte
//! copy of the same forwarding loop. P3 had to edit all three to add lag
//! recovery; P4 would have had to edit all three again. They live here now,
//! once.
//!
//! ## What crosses the IPC (P4, criterion 1)
//!
//! Output is a **raw payload**: `InvokeResponseBody::Raw` of the PTY's bytes
//! and nothing else — no base64, no JSON envelope, no `taskId` repeated on
//! every chunk (the channel already identifies the terminal), no log offset
//! (recovery happens on this side of the wire, before anything is sent). The
//! webview receives an `ArrayBuffer` and hands it straight to the emulator.
//! Measured on the real channel by `ipcbench`, a 32 KiB chunk went from
//! 12.8 MB/s to 80.1 MB/s.
//!
//! Lifecycle events — `Exit`, and P3's `Desync` — stay JSON on the same
//! channel. They are tiny, they are rare, and they carry named fields rather
//! than bytes. The frontend tells the two apart by type: an `ArrayBuffer` is
//! output, an object is control (`src/lib/ptyChunk.ts`).
//!
//! Mixing the two is safe even though tauri routes small payloads through
//! `eval` and large ones through a `fetch` round trip: every message carries
//! a monotonic index and the JS `Channel` reorders on it. That matters more
//! since the leading-edge flush, which deliberately produces small chunks
//! (eval path) interleaved with big ones (fetch path).
//!
//! ## Why a forwarder can be torn down (P4, criterion 7)
//!
//! An LRU-evicted terminal has no surface to write to, but the PTY keeps
//! producing and this loop kept serializing and sending for a webview that
//! throws the result away. `detach_terminal_stream` ends the loop; the next
//! mount re-attaches through `subscribe_with_replay`, which is the same path
//! a cold attach takes. The child process is never touched.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::broadcast::{error::RecvError, Receiver};

use crate::auth::{AuthError, SessionState};
use crate::pty::handle::PtyHandle;
use crate::pty::{LagRecovery, PtyEvent};

#[derive(Debug, thiserror::Error)]
pub enum PtyStreamError {
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("no live terminal stream for channel `{0}`")]
    NoSuchStream(u32),
}

impl serde::Serialize for PtyStreamError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Every live forwarder, keyed by the **JS channel id** the frontend already
/// holds (`Channel.id`). Keying on that rather than on a task/session/run id
/// is what lets one pair of commands serve all three families, and it is also
/// the more precise handle: re-attaching a terminal makes a new channel, and
/// only the new one should survive.
#[derive(Default)]
pub struct PtyStreamRegistry {
    streams: Mutex<HashMap<u32, StreamEntry>>,
}

struct StreamEntry {
    /// Flipped by `detach_terminal_stream`; read by the forwarder after each
    /// event. A detached-but-silent PTY costs nothing while it waits, so
    /// there is no need to interrupt the `recv` itself.
    cancelled: Arc<AtomicBool>,
    handle: Arc<PtyHandle>,
}

impl PtyStreamRegistry {
    fn register(&self, channel_id: u32, handle: Arc<PtyHandle>) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.streams.lock().insert(
            channel_id,
            StreamEntry {
                cancelled: cancelled.clone(),
                handle,
            },
        );
        cancelled
    }

    fn forget(&self, channel_id: u32) {
        self.streams.lock().remove(&channel_id);
    }

    fn cancel(&self, channel_id: u32) -> Option<Arc<PtyHandle>> {
        let entry = self.streams.lock().remove(&channel_id)?;
        entry.cancelled.store(true, Ordering::Relaxed);
        Some(entry.handle)
    }

    fn handle(&self, channel_id: u32) -> Option<Arc<PtyHandle>> {
        self.streams.lock().get(&channel_id).map(|e| e.handle.clone())
    }

    /// How many forwarders are alive. The measurable half of criterion 7:
    /// evicting a terminal must make this go DOWN.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn live_count(&self) -> usize {
        self.streams.lock().len()
    }
}

/// Removes this stream from the registry however the forwarder ends —
/// exit, close, or detach. Without it the map would only ever grow.
struct Registration {
    registry: Arc<PtyStreamRegistry>,
    channel_id: u32,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.registry.forget(self.channel_id);
    }
}

/// Put one event on the wire in the shape its kind deserves.
///
/// `Bytes` → `Vec<u8>` is the single remaining copy of a chunk in the whole
/// pipeline: `InvokeResponseBody::Raw` owns its payload and tauri gives us no
/// way to lend it one. Everything upstream of here shares.
fn send_event(channel: &Channel<InvokeResponseBody>, event: PtyEvent) -> bool {
    let body = match event {
        PtyEvent::Output { chunk, .. } => InvokeResponseBody::Raw(chunk.to_vec()),
        control => match serde_json::to_string(&control) {
            Ok(json) => InvokeResponseBody::Json(json),
            // A control event that will not serialize is a bug in this
            // process, not a transport failure — dropping it silently would
            // leave the terminal waiting for an exit that never comes.
            Err(err) => {
                eprintln!("[pty] dropping an unserializable control event: {err}");
                return true;
            }
        },
    };
    channel.send(body).is_ok()
}

/// Spawn the forwarder for one attached terminal.
///
/// `on_exit` runs when the child's `Exit` has been delivered — that is where
/// the run-command and session families drop the PTY from the runtime. It
/// deliberately does NOT run on detach: a detached terminal's process is
/// still alive and the next mount expects to find it.
pub fn spawn(
    registry: Arc<PtyStreamRegistry>,
    handle: Arc<PtyHandle>,
    replay: Vec<PtyEvent>,
    mut rx: Receiver<PtyEvent>,
    mut recovery: LagRecovery,
    channel: Channel<InvokeResponseBody>,
    on_exit: impl FnOnce() + Send + 'static,
) {
    let channel_id = channel.id();
    let cancelled = registry.register(channel_id, handle);
    let registration = Registration {
        registry,
        channel_id,
    };

    tauri::async_runtime::spawn(async move {
        // Held for the life of the task: dropping it deregisters, whichever
        // way the loop below ends.
        let _registration = registration;

        for event in replay {
            recovery.recover_before(&event, |missed| {
                send_event(&channel, missed);
            });
            send_event(&channel, event);
        }
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let is_exit = matches!(event, PtyEvent::Exit { .. });
                    // Anything the broadcast dropped is read back out of the
                    // per-task log and delivered first, so the terminal
                    // never sees a hole. Costs one integer compare when
                    // nothing was lost.
                    recovery.recover_before(&event, |missed| {
                        send_event(&channel, missed);
                    });
                    send_event(&channel, event);
                    if is_exit {
                        on_exit();
                        break;
                    }
                    // Checked after delivery, not before: whatever was
                    // already in flight when the surface went away is
                    // cheaper to send than to reason about.
                    if cancelled.load(Ordering::Relaxed) {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => recovery.note_lag(n),
                // Closed with a gap outstanding: the last bytes are still on
                // disk even though no event will ever carry them.
                Err(RecvError::Closed) => {
                    recovery.recover_tail(|missed| {
                        send_event(&channel, missed);
                    });
                    break;
                }
            }
        }
    });
}

/// Stop forwarding this terminal's output without touching its process.
///
/// Called by the frontend when a surface is gone — LRU eviction, or an
/// explicit close. Until P4 the Rust forwarder and the JS channel both stayed
/// alive after an eviction and the whole pipe ran so the webview could
/// discard the result.
///
/// Idempotent: detaching an already-detached (or already-exited) stream is a
/// no-op rather than an error, because the frontend cannot know which
/// happened first.
#[tauri::command]
pub async fn detach_terminal_stream(
    channel_id: u32,
    streams: State<'_, Arc<PtyStreamRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), PtyStreamError> {
    session.require()?;
    if let Some(handle) = streams.cancel(channel_id) {
        // A detached terminal is by definition unwatched. Leaving the hint
        // on "visible" would make the PTY keep flushing on the tight window
        // for the seconds between here and the child noticing nobody reads.
        handle.set_visible(false);
    }
    Ok(())
}

/// Tell a PTY whether anyone can see it (P4, criterion 8).
///
/// Drives `PtyHandle::set_visible`: a hidden terminal coalesces on a 50 ms
/// window instead of 8 ms — the same bytes in ~6× fewer messages, which is
/// what makes eight background agents cheap. Errors if the channel has no
/// live stream, because a silently-ignored hint is a performance bug nobody
/// would ever find.
#[tauri::command]
pub async fn set_terminal_visible(
    channel_id: u32,
    visible: bool,
    streams: State<'_, Arc<PtyStreamRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), PtyStreamError> {
    session.require()?;
    let handle = streams
        .handle(channel_id)
        .ok_or(PtyStreamError::NoSuchStream(channel_id))?;
    handle.set_visible(visible);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A registry entry needs a real `PtyHandle`, and a real handle needs a
    /// real PTY — cheap enough (a shell that exits at once) and it keeps the
    /// test honest about what `set_visible` is actually reaching.
    fn spawn_handle(dir: &tempfile::TempDir, id: &str) -> Arc<PtyHandle> {
        crate::pty::handle::PtyHandle::spawn(crate::pty::handle::PtySpawnOptions {
            task_id: id.into(),
            initial_command: None,
            initial_prompt: None,
            cwd: dir.path().to_path_buf(),
            log_path: dir.path().join(format!("{id}.log")),
            rows: 24,
            cols: 80,
        })
        .expect("spawn a pty for the test")
    }

    #[test]
    fn cancelling_a_stream_deregisters_it_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PtyStreamRegistry::default();
        let handle = spawn_handle(&dir, "t");

        let cancelled = registry.register(7, handle.clone());
        assert_eq!(registry.live_count(), 1);

        assert!(registry.cancel(7).is_some());
        assert!(cancelled.load(Ordering::Relaxed), "the forwarder was not told to stop");
        assert_eq!(registry.live_count(), 0, "a cancelled stream must not linger");

        // The frontend cannot know whether the process exited first, so a
        // second detach has to be a no-op rather than a panic or an error.
        assert!(registry.cancel(7).is_none());
        assert!(registry.handle(7).is_none());
        let _ = handle.kill();
    }

    #[test]
    fn the_registry_keeps_streams_apart_by_channel() {
        // Two terminals, two channels: a detach must reach exactly one of
        // them. Keying on the channel (not the task id) is what makes
        // re-attach safe — the old stream can be dropped while the new one
        // for the same PTY keeps running.
        let dir = tempfile::tempdir().unwrap();
        let registry = PtyStreamRegistry::default();
        let first = spawn_handle(&dir, "first");
        let second = spawn_handle(&dir, "second");

        let first_cancelled = registry.register(1, first.clone());
        let second_cancelled = registry.register(2, second.clone());
        registry.cancel(1);

        assert!(first_cancelled.load(Ordering::Relaxed));
        assert!(
            !second_cancelled.load(Ordering::Relaxed),
            "detaching one terminal stopped another"
        );
        assert_eq!(registry.live_count(), 1);
        let _ = first.kill();
        let _ = second.kill();
    }

    #[test]
    fn output_goes_out_raw_and_control_events_go_out_as_json() {
        // The wire contract of criterion 1, pinned in one place. A chunk is
        // its bytes verbatim — no envelope, nothing to decode — and an exit
        // is still a named JSON object.
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel: Channel<InvokeResponseBody> = Channel::new(move |body| {
            sink.lock().push(body);
            Ok(())
        });

        let raw = vec![0x1b, b'[', b'2', b'K', 0xff, 0x80];
        send_event(
            &channel,
            PtyEvent::Output {
                task_id: "t".into(),
                log_offset: 4096,
                chunk: bytes::Bytes::from(raw.clone()),
            },
        );
        send_event(
            &channel,
            PtyEvent::Exit {
                task_id: "t".into(),
                exit_code: Some(0),
            },
        );
        send_event(
            &channel,
            PtyEvent::Desync {
                task_id: "t".into(),
                missed_bytes: 4096,
            },
        );

        let bodies = seen.lock();
        match &bodies[0] {
            // Byte-identical to the PTY's output, including the bytes that
            // are not valid UTF-8 — which is why this is not a string.
            InvokeResponseBody::Raw(bytes) => assert_eq!(bytes, &raw),
            other => panic!("output must go out raw, got {other:?}"),
        }
        match &bodies[1] {
            InvokeResponseBody::Json(json) => {
                assert_eq!(json, r#"{"type":"exit","taskId":"t","exitCode":0}"#)
            }
            other => panic!("exit must go out as JSON, got {other:?}"),
        }
        match &bodies[2] {
            InvokeResponseBody::Json(json) => {
                assert_eq!(json, r#"{"type":"desync","taskId":"t","missedBytes":4096}"#)
            }
            other => panic!("desync must go out as JSON, got {other:?}"),
        }
    }
}
