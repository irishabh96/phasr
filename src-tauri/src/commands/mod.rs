//! Tauri command surface. Each handler is a thin wrapper around a
//! repository call. Keep them small — if you find yourself writing
//! business logic here, push it into the application/use-case layer
//! instead (introduced in later phases).

pub mod git;
pub mod presets;
pub mod runtime;
pub mod settings;
pub mod tasks;
pub mod workspaces;
