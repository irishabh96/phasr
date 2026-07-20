//! Tauri command surface. Each handler is a thin wrapper around a
//! repository call.

pub mod agents;
pub mod board;
pub mod files;
pub mod git;
pub mod notifications;
pub mod orchestrator;
pub mod planner;
pub mod repositories;
pub mod review;
pub mod run_commands;
pub mod session_terminal;
pub mod settings;
pub mod tickets;
pub mod validate;
pub mod worklist;
pub mod workspaces;
