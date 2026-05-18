//! Domain entities. Pure data and invariants — no I/O, no SQL, no Tauri.
//!
//! Per the clean-architecture rule: this module has zero dependencies on
//! outer layers. Storage adapters (`store`) and command handlers (`commands`)
//! depend on us, never the other way around.

pub mod preset;
pub mod settings;
pub mod task;
pub mod workspace;

pub use preset::Preset;
pub use settings::UserSettings;
pub use task::{Task, TaskStatus};
pub use workspace::Workspace;
