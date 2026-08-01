use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

pub const AUTH_CALLBACK_EVENT: &str = "phasr://auth-callback";
const AUTH_CALLBACK_PREFIX: &str = "phasr://auth/callback";

#[derive(Default)]
pub struct AuthDeepLinkState {
    pending_callback_url: Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
struct AuthCallbackPayload {
    url: String,
}

pub fn configure_auth_deeplink(app: &tauri::App) -> anyhow::Result<()> {
    let app_handle = app.handle().clone();

    if let Some(urls) = app.deep_link().get_current()? {
        emit_auth_callback_urls(&app_handle, urls);
    }

    app.deep_link().on_open_url(move |event| {
        emit_auth_callback_urls(&app_handle, event.urls());
    });

    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link().register_all()?;

    Ok(())
}

fn emit_auth_callback_urls<I, U>(app: &AppHandle, urls: I)
where
    I: IntoIterator<Item = U>,
    U: ToString,
{
    for url in urls {
        let url = url.to_string();
        if !is_auth_callback_url(&url) {
            continue;
        }

        log::info!("received Clerk auth callback deep link");

        if let Some(state) = app.try_state::<AuthDeepLinkState>() {
            *state
                .pending_callback_url
                .lock()
                .expect("auth deep link state poisoned") = Some(url.clone());
        }

        if let Err(err) = app.emit(AUTH_CALLBACK_EVENT, AuthCallbackPayload { url }) {
            log::error!("failed to emit auth callback event: {err}");
        }
    }
}

#[tauri::command]
pub fn consume_pending_auth_callback(
    state: State<'_, AuthDeepLinkState>,
) -> Result<Option<String>, String> {
    state
        .pending_callback_url
        .lock()
        .map(|mut pending| pending.take())
        .map_err(|_| "auth deep link state poisoned".to_string())
}

fn is_auth_callback_url(url: &str) -> bool {
    url == AUTH_CALLBACK_PREFIX || url.starts_with(&format!("{AUTH_CALLBACK_PREFIX}?"))
}

#[cfg(test)]
mod tests {
    use super::{is_auth_callback_url, AuthDeepLinkState};

    #[test]
    fn accepts_auth_callback_urls() {
        assert!(is_auth_callback_url("phasr://auth/callback"));
        assert!(is_auth_callback_url(
            "phasr://auth/callback?code=abc&state=xyz"
        ));
    }

    #[test]
    fn rejects_other_deep_links() {
        assert!(!is_auth_callback_url("phasr://workspace/open?id=abc"));
        assert!(!is_auth_callback_url("https://phasr.sh/auth/callback"));
        assert!(!is_auth_callback_url("phasr://auth/callback-extra"));
    }

    #[test]
    fn pending_callback_can_be_consumed_once() {
        let state = AuthDeepLinkState::default();
        *state
            .pending_callback_url
            .lock()
            .expect("auth deep link state poisoned") =
            Some("phasr://auth/callback?code=abc".to_string());

        assert_eq!(
            state
                .pending_callback_url
                .lock()
                .expect("auth deep link state poisoned")
                .take(),
            Some("phasr://auth/callback?code=abc".to_string())
        );
        assert_eq!(
            state
                .pending_callback_url
                .lock()
                .expect("auth deep link state poisoned")
                .take(),
            None
        );
    }
}
