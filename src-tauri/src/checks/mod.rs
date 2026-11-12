//! Checks: run commands executed non-interactively against a task's
//! worktree, recorded per worktree state (fingerprint), and gating
//! "Approve & create PR".
//!
//! Tauri-agnostic like the orchestrator: runs and output go out on a
//! `tokio::broadcast`; `commands::events` re-emits them as
//! `phasr://check-run` / `phasr://check-output`.

pub mod runner;
mod service;

pub use service::{CheckError, CheckEvent, CheckService};
