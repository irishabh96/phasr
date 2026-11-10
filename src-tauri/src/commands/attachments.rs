//! Prompt attachments: an image pasted into a prompt (a screenshot on the
//! clipboard) has no path of its own, so it is written to
//! `<app_data>/attachments/<uuid>.<ext>` and the prompt names that path.
//!
//! Files picked or dropped already have a path and never come through here.
//! The command only ever creates new files with a random name in one fixed
//! directory, so the caller chooses nothing about where bytes land: the
//! extension is whitelisted and the size is capped before any IO.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use thiserror::Error;
use uuid::Uuid;

use crate::auth::{AuthError, SessionState};

use super::require_user;

/// A 5K Retina screenshot as PNG is ~15 MB; anything bigger is not a paste.
pub const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

/// Image types an agent CLI can read. Lowercase, no dot.
const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

#[derive(Debug, Error)]
pub enum AttachmentError {
    #[error("unsupported attachment type \"{0}\" (allowed: png, jpg, jpeg, gif, webp)")]
    Unsupported(String),
    #[error("attachment is empty")]
    Empty,
    #[error("attachment is too large ({0} bytes; limit is 20 MB)")]
    TooLarge(usize),
    #[error("couldn't find the app data directory")]
    NoAppData,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Auth(#[from] AuthError),
}

impl serde::Serialize for AttachmentError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Validate, then write `bytes` to `<app_data>/attachments/<uuid>.<ext>`.
/// `create_new` means even a uuid collision can't overwrite a file.
pub fn write_attachment(
    app_data: &Path,
    bytes: &[u8],
    extension: &str,
) -> Result<PathBuf, AttachmentError> {
    let ext = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AttachmentError::Unsupported(ext));
    }
    if bytes.is_empty() {
        return Err(AttachmentError::Empty);
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentError::TooLarge(bytes.len()));
    }
    let dir = app_data.join("attachments");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.{ext}", Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(path)
}

/// Save pasted image bytes and return the file's absolute path.
#[tauri::command]
pub async fn save_attachment(
    bytes: Vec<u8>,
    extension: String,
    app: AppHandle,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, AttachmentError> {
    require_user(&session)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| AttachmentError::NoAppData)?;
    let path = tokio::task::spawn_blocking(move || write_attachment(&app_data, &bytes, &extension))
        .await
        .map_err(|e| AttachmentError::Io(std::io::Error::other(e.to_string())))??;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_under_app_data_attachments() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_attachment(tmp.path(), b"\x89PNG\r\n\x1a\nfake", "png").unwrap();
        assert_eq!(path.parent().unwrap(), tmp.path().join("attachments"));
        assert_eq!(path.extension().unwrap(), "png");
        assert!(path.is_absolute());
        assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG\r\n\x1a\nfake");
    }

    #[test]
    fn every_save_gets_its_own_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = write_attachment(tmp.path(), b"a", "jpg").unwrap();
        let b = write_attachment(tmp.path(), b"b", "jpg").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&a).unwrap(), b"a");
    }

    #[test]
    fn normalises_the_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_attachment(tmp.path(), b"x", ".JPEG").unwrap();
        assert_eq!(path.extension().unwrap(), "jpeg");
    }

    #[test]
    fn rejects_other_extensions() {
        let tmp = tempfile::tempdir().unwrap();
        for ext in ["sh", "svg", "html", "", "png/../x", "../png", "exe"] {
            let err = write_attachment(tmp.path(), b"x", ext).unwrap_err();
            assert!(matches!(err, AttachmentError::Unsupported(_)), "{ext}: {err}");
        }
        // Nothing was created for a refused write.
        assert!(!tmp.path().join("attachments").exists());
    }

    #[test]
    fn rejects_oversized_and_empty_input() {
        let tmp = tempfile::tempdir().unwrap();
        let big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        assert!(matches!(
            write_attachment(tmp.path(), &big, "png"),
            Err(AttachmentError::TooLarge(n)) if n == MAX_ATTACHMENT_BYTES + 1
        ));
        assert!(matches!(
            write_attachment(tmp.path(), &[], "png"),
            Err(AttachmentError::Empty)
        ));
        let exact = vec![0u8; MAX_ATTACHMENT_BYTES];
        assert!(write_attachment(tmp.path(), &exact, "png").is_ok());
    }

    #[test]
    fn errors_serialize_to_plain_strings() {
        let json = serde_json::to_string(&AttachmentError::TooLarge(5)).unwrap();
        assert_eq!(json, "\"attachment is too large (5 bytes; limit is 20 MB)\"");
    }
}
