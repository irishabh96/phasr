use tauri::State;

use crate::domain::Preset;
use crate::store::{PresetRepo, StoreError};

#[tauri::command]
pub async fn list_presets(repo: State<'_, PresetRepo>) -> Result<Vec<Preset>, StoreError> {
    repo.list().await
}

#[tauri::command]
pub async fn set_preset_enabled(
    id: String,
    enabled: bool,
    repo: State<'_, PresetRepo>,
) -> Result<(), StoreError> {
    repo.set_enabled(&id, enabled).await
}
