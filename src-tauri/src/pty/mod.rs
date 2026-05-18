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
//!                │   ├── stdout reader task (Tokio)
//!                │   ├── log file writer
//!                │   └── tokio::broadcast channel for output
//!
//! The frontend subscribes via a Tauri Channel; the sync worker (Phase 6)
//! and any future log analyzer can subscribe independently.

pub mod handle;
mod runtime;

pub use handle::{PtyEvent, PtyHandle, PtySpawnOptions};
pub use runtime::TaskRuntime;
