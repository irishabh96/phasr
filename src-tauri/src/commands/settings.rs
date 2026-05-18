use tauri::State;

use crate::domain::UserSettings;
use crate::store::{SettingsRepo, StoreError};

#[tauri::command]
pub async fn get_user_settings(
    repo: State<'_, SettingsRepo>,
) -> Result<UserSettings, StoreError> {
    repo.get_or_init().await
}

#[tauri::command]
pub async fn update_user_settings(
    settings: UserSettings,
    repo: State<'_, SettingsRepo>,
) -> Result<UserSettings, StoreError> {
    repo.update(&settings).await
}
