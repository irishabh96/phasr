mod auth;

use std::sync::Arc;

use auth::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_state = Arc::new(SessionState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(session_state)
        .invoke_handler(tauri::generate_handler![
            auth::set_session,
            auth::clear_session,
            auth::current_user_id,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
