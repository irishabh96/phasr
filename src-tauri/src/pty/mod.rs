//! PTY-backed task runtime. Owns the lifecycle of agent processes:
//! spawn, stream stdout/stderr to subscribers, write logs to disk,
//! and notify when the child exits.
//!
//! Architecture:
//!
//!   TaskRuntime  ┐
//!   (per app)    │   manages a map of TaskId → PtyHandle
//!                │
//!   PtyHandle    ┐   one running task
//!                │   ├── PTY child process (portable-pty)
//!                │   ├── reader thread ──[bounded, blocking]──> coalescer
//!                │   ├── TaskLog (`log.rs`): buffered, size-capped, and
//!                │   │     readable by offset
//!                │   └── tokio::broadcast channel for output
//!
//! The frontend subscribes via a Tauri Channel; the sync worker (Phase 6)
//! and any future log analyzer can subscribe independently.
//!
//! **The broadcast drops the oldest value for a lagging receiver, and a
//! broadcast send never blocks — so no subscriber may treat `Lagged` as
//! nothing.** Every one of them pairs its receiver with a `LagRecovery`
//! (`backfill.rs`), which refills the missed range out of the log before the
//! subscriber can see a hole. That, not the bounded reader queue, is what
//! makes the stream a subscriber reconstructs byte-identical to the log.

pub mod backfill;
pub mod handle;
pub mod log;
mod runtime;
mod shell;

pub use backfill::LagRecovery;
pub use handle::PtyEvent;
pub use runtime::TaskRuntime;
