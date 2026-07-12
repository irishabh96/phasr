//! Tauri command surface. Each handler is a thin wrapper around a
//! repository call.

pub mod agents;
pub mod files;
pub mod git;
pub mod notifications;
pub mod orchestrator;
pub mod repositories;
pub mod run_commands;
pub mod session_terminal;
pub mod settings;
pub mod workspaces;
