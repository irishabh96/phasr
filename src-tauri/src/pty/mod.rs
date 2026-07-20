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
mod shell;

pub use handle::PtyEvent;
pub use runtime::TaskRuntime;
// The captured Validate runner (orchestrator::validate) reuses the terminal's
// macOS PATH-augmentation logic so a Finder-launched `.app` — which inherits a
// minimal PATH — can still resolve `pnpm`/`node`/etc. in a `sh -c` check
// (architect §R3). Same shaping the interactive terminal already uses.
pub(crate) use shell::terminal_env;
