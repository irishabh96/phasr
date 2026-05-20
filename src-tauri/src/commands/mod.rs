//! Tauri command surface. Each handler is a thin wrapper around a
//! repository call.

pub mod agents;
pub mod files;
pub mod git;
pub mod repositories;
pub mod run_commands;
pub mod runtime;
pub mod session_terminal;
pub mod settings;
pub mod workspaces;
