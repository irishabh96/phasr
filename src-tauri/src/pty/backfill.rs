//! Turning a dropped broadcast back into a byte-exact stream.
//!
//! `tokio::sync::broadcast` drops the *oldest* value for a lagging receiver
//! and reports `RecvError::Lagged(n)`. Every forwarder in phasr used to
//! answer that with `continue`, which is a hole in a VT stream: the display
//! is silently corrupted until the program happens to repaint in full.
//!
//! A broadcast send never blocks, so no amount of backpressure on the reader
//! side can prevent lag — **this is the half that carries the zero-drop
//! guarantee** (P3 #PATH_DECISION, Q3 corollary). The mechanism:
//!
//! 1. The coalescer writes every byte to the per-task log *before* it frames
//!    anything, and stamps each `PtyEvent::Output` with the log offset of its
//!    first byte (`pty/log.rs`).
//! 2. A forwarder tracks the offset just past the last byte it delivered.
//! 3. When the next event's offset is ahead of that, the difference is
//!    exactly what the broadcast dropped — so it is read back out of the log
//!    and delivered first, in order, as ordinary `Output` events.
//!
//! De-duplication and ordering are by offset, so a backfill can never
//! double-write, and a `Lagged` that was fully backfilled is not a drop.
//!
//! Where the gap cannot be refilled — it was rotated off the end of the log —
//! the subscriber gets a `PtyEvent::Desync` instead, so the frontend can
//! force a full repaint rather than render corruption. That is the honest
//! floor, and it is never silent.
//!
//! ## Why this is synchronous
//!
//! The log read is a blocking `read`, bounded at `BACKFILL_READ_BYTES` per
//! call, and it only happens on a path where the stream is *already* behind.
//! Keeping it sync means the async forwarders and the (plain-thread) load
//! harness drive the identical code, which is the point: one mechanism, one
//! test surface.

use std::sync::Arc;

use super::handle::{PtyEvent, COALESCE_BYTES, COALESCE_WINDOW};
use super::log::LogIndex;

/// What a subscriber's recovery actually did. Counted rather than asserted
/// at zero: lag is allowed, *unrecovered bytes* are not.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryStats {
    /// Events the broadcast reported dropping (`Lagged(n)`, summed).
    pub lag_events: u64,
    /// Bytes re-delivered out of the log.
    pub recovered_bytes: u64,
    /// Bytes that were gone for good — the log had rotated past them.
    pub unrecovered_bytes: u64,
    /// `Desync` events emitted.
    pub desyncs: u64,
}

/// Per-subscriber cursor over one PTY's byte stream.
pub struct LagRecovery {
    task_id: String,
    index: Arc<LogIndex>,
    /// Log offset the subscriber's stream has been delivered through.
    /// Seeded at attach time, so a subscriber that lags before it has
    /// received anything at all is still recoverable — that is exactly the
    /// case a flood produces.
    next_offset: Option<u64>,
    stats: RecoveryStats,
}

impl LagRecovery {
    /// Attach at the log's current end: "everything from here on".
    ///
    /// A forwarder replays the buffered history before the live stream, and
    /// those events carry offsets *below* this seed, so they are passed
    /// through untouched — but anything the replay had already evicted and
    /// the receiver was too late to hear live is refilled, which is the
    /// gap that used to be invisible.
    pub fn new(task_id: impl Into<String>, index: Arc<LogIndex>) -> Self {
        let attached_at = index.flushed_through();
        Self {
            task_id: task_id.into(),
            index,
            next_offset: Some(attached_at),
            stats: RecoveryStats::default(),
        }
    }

    /// Read by the load harness, which asserts the reconstructed stream is
    /// byte-identical to the log; P5's counting gates are the other
    /// intended consumer.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stats(&self) -> RecoveryStats {
        self.stats
    }

    /// Log offset the subscriber has been delivered through. Same consumers
    /// as `stats`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn delivered_through(&self) -> Option<u64> {
        self.next_offset
    }

    /// Record a `Lagged(n)`. Recovery itself is driven by offsets, not by
    /// this count — a hole is found by comparing the next event's offset
    /// against what was delivered, which works even if the report is missed.
    pub fn note_lag(&mut self, missed: u64) {
        self.stats.lag_events += missed;
    }

    /// Emit whatever must precede `event` for the subscriber's stream to stay
    /// byte-identical to the log. One integer compare when nothing was lost,
    /// which is the overwhelmingly common case.
    pub fn recover_before<F: FnMut(PtyEvent)>(&mut self, event: &PtyEvent, mut sink: F) {
        match event {
            PtyEvent::Output {
                log_offset, chunk, ..
            } => {
                if let Some(next) = self.next_offset {
                    if *log_offset > next {
                        self.fill(next, *log_offset, &mut sink);
                    }
                }
                self.next_offset = Some(log_offset + chunk.len() as u64);
            }
            // The exit watcher and the output pipeline are separate threads,
            // so `Exit` routinely overtakes the last bytes — and a forwarder
            // stops reading at `Exit`. Flush whatever the log has that the
            // subscriber does not before letting the exit through.
            PtyEvent::Exit { .. } => self.recover_tail(&mut sink),
            PtyEvent::Desync { .. } => {}
        }
    }

    /// Deliver everything the log holds beyond what the subscriber has seen.
    /// Called when the broadcast closes with a gap outstanding, so a lag
    /// immediately before teardown is still recovered.
    pub fn recover_tail<F: FnMut(PtyEvent)>(&mut self, mut sink: F) {
        let Some(next) = self.next_offset else {
            return;
        };
        let end = self.index.flushed_through();
        if end > next {
            self.fill(next, end, &mut sink);
        }
    }

    fn fill(&mut self, from: u64, to: u64, sink: &mut dyn FnMut(PtyEvent)) {
        let mut cursor = from;
        while cursor < to {
            let mut bytes = self.index.read_range(cursor, to);
            if bytes.is_empty() {
                // Either the range rotated away, or the coalescer has not
                // flushed it yet. The flush-before-broadcast ordering makes
                // the second case unreachable for a gap bounded by an event
                // we hold — this retry is the belt to that braces.
                std::thread::sleep(COALESCE_WINDOW);
                bytes = self.index.read_range(cursor, to);
            }
            if bytes.is_empty() {
                let missed = to - cursor;
                self.stats.unrecovered_bytes += missed;
                self.stats.desyncs += 1;
                // Loud on purpose: this is the only path in the pipeline
                // that loses a byte, and it should be findable in a log
                // when a user reports a corrupted screen.
                eprintln!(
                    "[pty] {}: {missed} bytes unrecoverable at offset {cursor} \
                     (the log had rotated past the gap) — emitting desync",
                    self.task_id
                );
                sink(PtyEvent::Desync {
                    task_id: self.task_id.clone(),
                    missed_bytes: missed,
                });
                break;
            }
            self.stats.recovered_bytes += bytes.len() as u64;
            // Re-framed at the coalescer's own ceiling so a backfilled event
            // is indistinguishable from a live one downstream.
            // One `Bytes` over the whole read, sliced per event: `slice` is a
            // refcount bump into the same allocation, so re-framing a 4 MiB
            // backfill into 32 KiB events copies nothing.
            let refilled = bytes::Bytes::from(bytes);
            let mut start = 0usize;
            while start < refilled.len() {
                let end = (start + COALESCE_BYTES).min(refilled.len());
                let chunk = refilled.slice(start..end);
                let len = chunk.len() as u64;
                sink(PtyEvent::Output {
                    task_id: self.task_id.clone(),
                    log_offset: cursor,
                    chunk,
                });
                cursor += len;
                start = end;
            }
        }
        self.next_offset = Some(to);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::log::{TaskLog, BACKFILL_READ_BYTES, LOG_SEGMENTS_KEPT};

    fn output(task: &str, log_offset: u64, chunk: &[u8]) -> PtyEvent {
        PtyEvent::Output {
            task_id: task.into(),
            log_offset,
            chunk: bytes::Bytes::copy_from_slice(chunk),
        }
    }

    /// Drive a recovery over a scripted event sequence, returning everything
    /// a subscriber would have been handed.
    fn deliver(recovery: &mut LagRecovery, events: Vec<PtyEvent>) -> Vec<PtyEvent> {
        let mut out = Vec::new();
        for event in events {
            recovery.recover_before(&event, |e| out.push(e));
            out.push(event);
        }
        out
    }

    fn bytes_of(events: &[PtyEvent]) -> Vec<u8> {
        events
            .iter()
            .filter_map(|e| match e {
                PtyEvent::Output { chunk, .. } => Some(chunk.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn a_contiguous_stream_is_passed_through_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = TaskLog::open(&dir.path().join("t.log")).unwrap();
        log.append(b"onetwo");
        log.flush();

        let mut recovery = LagRecovery::new("t", log.index());
        let delivered = deliver(
            &mut recovery,
            vec![output("t", 0, b"one"), output("t", 3, b"two")],
        );
        assert_eq!(delivered.len(), 2, "nothing should have been inserted");
        assert_eq!(recovery.stats().recovered_bytes, 0);
    }

    #[test]
    fn a_dropped_event_is_refilled_from_the_log_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = TaskLog::open(&dir.path().join("t.log")).unwrap();
        log.append(b"AAABBBCCC");
        log.flush();

        // The broadcast dropped the middle event: the subscriber sees offset
        // 0 and then offset 6, with nothing in between.
        let mut recovery = LagRecovery::new("t", log.index());
        recovery.note_lag(1);
        let delivered = deliver(
            &mut recovery,
            vec![output("t", 0, b"AAA"), output("t", 6, b"CCC")],
        );

        assert_eq!(bytes_of(&delivered), b"AAABBBCCC".to_vec());
        assert_eq!(recovery.stats().recovered_bytes, 3);
        assert_eq!(recovery.stats().unrecovered_bytes, 0);
        assert_eq!(recovery.stats().lag_events, 1);
    }

    #[test]
    fn a_gap_the_log_has_rotated_past_emits_a_desync_not_silence() {
        // The honest floor from the Q3 decision: a hole older than the
        // oldest retained byte is unrecoverable by construction, and the
        // subscriber must be *told* so it can force a repaint.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        let mut log = TaskLog::open(&path).unwrap();
        log.append(b"gone-forever");
        log.flush();
        // Force the segment holding those bytes off the end.
        for _ in 0..(LOG_SEGMENTS_KEPT + 2) {
            log.rotate_for_test();
            log.append(b"x");
            log.flush();
        }
        let live_start = log.index().oldest_offset();
        assert!(live_start > 0);

        let mut recovery = LagRecovery::new("t", log.index());
        let delivered = deliver(
            &mut recovery,
            vec![output("t", 0, b"gone"), output("t", live_start, b"x")],
        );

        let desyncs: Vec<&PtyEvent> = delivered
            .iter()
            .filter(|e| matches!(e, PtyEvent::Desync { .. }))
            .collect();
        assert_eq!(desyncs.len(), 1, "expected exactly one desync marker");
        assert!(matches!(
            desyncs[0],
            PtyEvent::Desync { missed_bytes, .. } if *missed_bytes == live_start - 4
        ));
        assert_eq!(recovery.stats().unrecovered_bytes, live_start - 4);
    }

    #[test]
    fn a_gap_larger_than_one_read_is_refilled_across_several_reads() {
        // The 4 MiB read cap bounds recovery memory; the caller must not
        // notice, so a bigger gap has to come back complete and in order.
        let dir = tempfile::tempdir().unwrap();
        let mut log = TaskLog::open(&dir.path().join("t.log")).unwrap();
        let payload: Vec<u8> = (0..BACKFILL_READ_BYTES * 2 + 1234)
            .map(|i| (i % 251) as u8)
            .collect();
        log.append(&payload);
        log.flush();

        let mut recovery = LagRecovery::new("t", log.index());
        let end = payload.len() as u64;
        let delivered = deliver(
            &mut recovery,
            vec![output("t", 0, &payload[..8]), output("t", end, b"")],
        );
        assert_eq!(bytes_of(&delivered), payload);
    }

    #[test]
    fn the_tail_is_recovered_when_the_broadcast_closes_mid_gap() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = TaskLog::open(&dir.path().join("t.log")).unwrap();
        log.append(b"seen-unseen");
        log.flush();

        let mut recovery = LagRecovery::new("t", log.index());
        let mut delivered = Vec::new();
        recovery.recover_before(&output("t", 0, b"seen-"), |e| delivered.push(e));
        recovery.recover_tail(|e| delivered.push(e));
        assert_eq!(bytes_of(&delivered), b"unseen".to_vec());
    }

    #[test]
    fn attaching_mid_stream_does_not_replay_history() {
        // The seed is "the log's end, now". Bytes written before a
        // subscriber attached are not its business, and inventing them here
        // would paint an agent's whole backlog into a fresh terminal.
        let dir = tempfile::tempdir().unwrap();
        let mut log = TaskLog::open(&dir.path().join("t.log")).unwrap();
        log.append(b"history the subscriber never asked for");
        log.flush();

        let mut recovery = LagRecovery::new("t", log.index());
        let mut delivered = Vec::new();
        recovery.recover_tail(|e| delivered.push(e));
        recovery.recover_before(&output("t", 37, b"!"), |e| delivered.push(e));
        assert!(delivered.is_empty());
    }
}
