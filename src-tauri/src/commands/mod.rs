//! Tauri command surface. Each handler is a thin wrapper around a
//! repository call. Keep them small — if you find yourself writing
//! business logic here, push it into the application layer.

pub mod git;
pub mod presets;
pub mod repositories;
pub mod runtime;
pub mod settings;
pub mod workspaces;
