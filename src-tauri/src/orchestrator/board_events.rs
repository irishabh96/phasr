//! The board-refresh event bus (architect §R1/§R2 — the #1-risk fix).
//!
//! Before Phase 3, a board mutation (`publish_contract`, `integrate_parent`)
//! refreshed the UI ONLY via its return value — no `phasr://` event was emitted.
//! So a mutation driven from OUTSIDE the calling window (a gate writer, or the
//! future `phasr` CLI IPC server) updated the DB/files but never moved an open
//! board, and a brand-NEW ticket (an id the FE's `useBoardTaskEvents` has never
//! seen) could not surface live at all.
//!
//! This bus closes that gap. After each successful board/gate mutation the writer
//! calls `notify(parent_id)`; a bridge in the command layer
//! (`commands::board::spawn_board_event_bridge`) re-emits it as
//! `phasr://board-changed { parentId }` so the FE invalidates that board's query —
//! including for a new sibling, since it keys on the PARENT, not the subtask id.
//!
//! Modelled 1:1 on the orchestrator's `TaskStatusEvent` +
//! `spawn_status_bridge` (`orchestrator/service.rs`): a Tauri-agnostic
//! `tokio::broadcast` channel here, the AppHandle bridge in the command layer. It
//! is shared managed state, so BOTH the Tauri commands and the future CLI IPC
//! server get a clone and emit through the same seam (architect §R1: "wire the
//! IPC server with a clone").

use tokio::sync::broadcast;

/// Capacity for the board-changed broadcast. Board mutations are rare (a handful
/// per gate action), and the sole subscriber re-emits onto the Tauri bus, so a
/// small buffer is ample — matches `STATUS_BROADCAST_CAPACITY`.
const BOARD_EVENT_CAPACITY: usize = 256;

/// Fired after a board/gate mutation lands. Carries only the PARENT id: the FE
/// re-fetches the whole board for that parent (which is what surfaces a new
/// sibling), so no per-subtask granularity is needed here.
#[derive(Debug, Clone)]
pub struct BoardChangedEvent {
    pub parent_id: String,
}

/// The board-refresh event seam. Hand a clone to every writer that mutates a
/// board/gate; hand another to the bridge that owns the `AppHandle`.
pub struct BoardEventBus {
    tx: broadcast::Sender<BoardChangedEvent>,
}

impl BoardEventBus {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(BOARD_EVENT_CAPACITY);
        Self { tx }
    }

    /// Subscribe — the command-layer bridge (and, later, any independent
    /// consumer) drives `phasr://board-changed` off this receiver.
    pub fn subscribe(&self) -> broadcast::Receiver<BoardChangedEvent> {
        self.tx.subscribe()
    }

    /// Announce that the board under `parent_id` changed. A no-op when there are
    /// no subscribers (e.g. under `cargo test` with no bridge), exactly like
    /// `TaskOrchestrator::broadcast_status`.
    pub fn notify(&self, parent_id: impl Into<String>) {
        let _ = self.tx.send(BoardChangedEvent {
            parent_id: parent_id.into(),
        });
    }
}

impl Default for BoardEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A `notify` reaches a live subscriber with the parent id intact — the
    // foundational guarantee every gate mutation relies on to move the board live.
    #[tokio::test]
    async fn notify_reaches_a_subscriber() {
        let bus = BoardEventBus::new();
        let mut rx = bus.subscribe();
        bus.notify("parent-42");
        let event = rx.recv().await.expect("a board-changed event is delivered");
        assert_eq!(event.parent_id, "parent-42");
    }

    // With no subscribers, `notify` is a silent no-op (never panics / blocks) —
    // the `cargo test` and headless paths depend on this.
    #[tokio::test]
    async fn notify_without_subscribers_is_a_noop() {
        let bus = BoardEventBus::new();
        bus.notify("nobody-listening");
    }
}
