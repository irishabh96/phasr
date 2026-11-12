//! Voice input (`crate::voice`): Whisper models in Settings → Voice, and
//! dictation from the composer / New task prompt. Levels and download
//! progress arrive as `phasr://voice-level` / `phasr://voice-model`.

use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::voice::fn_key::GlobeKeyAction;
use crate::voice::polish::{Polisher, PolisherInfo};
use crate::voice::{MicAccess, VoiceError, VoiceModel, VoiceService};

use super::require_user;

#[derive(Debug)]
pub enum VoiceCmdError {
    Auth(AuthError),
    Voice(VoiceError),
}

impl From<AuthError> for VoiceCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<VoiceError> for VoiceCmdError {
    fn from(e: VoiceError) -> Self {
        Self::Voice(e)
    }
}

impl std::fmt::Display for VoiceCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auth(e) => write!(f, "{e}"),
            Self::Voice(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for VoiceCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type Voice<'a> = State<'a, Arc<VoiceService>>;
type Session<'a> = State<'a, Arc<SessionState>>;

#[tauri::command]
pub async fn list_voice_models(voice: Voice<'_>, session: Session<'_>) -> Result<Vec<VoiceModel>, VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.list())
}

/// Starts the download and returns; progress arrives as `phasr://voice-model`.
#[tauri::command]
pub async fn download_voice_model(model_id: String, voice: Voice<'_>, session: Session<'_>) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.download(&model_id)?)
}

#[tauri::command]
pub async fn cancel_voice_model_download(
    model_id: String,
    voice: Voice<'_>,
    session: Session<'_>,
) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.cancel_download(&model_id)?)
}

#[tauri::command]
pub async fn delete_voice_model(model_id: String, voice: Voice<'_>, session: Session<'_>) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.delete(&model_id)?)
}

#[tauri::command]
pub async fn microphone_access(voice: Voice<'_>, session: Session<'_>) -> Result<MicAccess, VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.mic_access())
}

/// Live text arrives as `phasr://voice-partial` while it runs.
#[tauri::command]
pub async fn start_dictation(
    model_id: String,
    language: Option<String>,
    voice: Voice<'_>,
    session: Session<'_>,
) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.start(&model_id, language).await?)
}

/// Close the microphone and return the final text ("" when nothing was said).
#[tauri::command]
pub async fn stop_dictation(voice: Voice<'_>, session: Session<'_>) -> Result<String, VoiceCmdError> {
    require_user(&session)?;
    Ok(voice.stop().await?)
}

/// The CLIs that can clean up a dictation, and whether each is installed.
#[tauri::command]
pub async fn list_dictation_polishers(session: Session<'_>) -> Result<Vec<PolisherInfo>, VoiceCmdError> {
    require_user(&session)?;
    Ok(crate::voice::polish::polishers().await)
}

/// Clean up `text` with a fast model through the user's Claude or Codex
/// CLI. An error means: keep the raw text.
#[tauri::command]
pub async fn polish_dictation(
    text: String,
    polisher: Polisher,
    session: Session<'_>,
) -> Result<String, VoiceCmdError> {
    require_user(&session)?;
    crate::voice::polish::polish(polisher, &text)
        .await
        .map_err(|e| VoiceCmdError::Voice(VoiceError::Failed(e)))
}

#[tauri::command]
pub async fn cancel_dictation(voice: Voice<'_>, session: Session<'_>) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    voice.cancel().await;
    Ok(())
}

/// System Settings → Privacy & Security → Microphone, for when access was
/// refused. (The opener plugin only opens web links.)
#[tauri::command]
pub async fn open_microphone_settings(session: Session<'_>) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    #[cfg(target_os = "macos")]
    tokio::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .status()
        .await
        .map_err(|e| VoiceCmdError::Voice(VoiceError::Failed(e.to_string())))?;
    Ok(())
}

/// What macOS does on a press of fn (🌐) alone, which also fires when you
/// let go after holding it to dictate.
#[tauri::command]
pub async fn globe_key_action(session: Session<'_>) -> Result<GlobeKeyAction, VoiceCmdError> {
    require_user(&session)?;
    Ok(crate::voice::fn_key::globe_key_action().await)
}

/// System Settings → Keyboard (where "Press 🌐 key to" lives).
#[tauri::command]
pub async fn open_keyboard_settings(session: Session<'_>) -> Result<(), VoiceCmdError> {
    require_user(&session)?;
    #[cfg(target_os = "macos")]
    tokio::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Keyboard-Settings.extension")
        .status()
        .await
        .map_err(|e| VoiceCmdError::Voice(VoiceError::Failed(e.to_string())))?;
    Ok(())
}
