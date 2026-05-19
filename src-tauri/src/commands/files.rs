//! Filesystem read for the in-app file preview tab. Caps the read so a
//! 4 GB binary doesn't OOM the webview, and rejects non-UTF-8 explicitly
//! so the frontend can render a clean "not text" message.

use std::path::Path;
use thiserror::Error;

const MAX_PREVIEW_BYTES: u64 = 1_048_576; // 1 MB

#[derive(Debug, Error)]
pub enum FilePreviewError {
    #[error("file does not exist")]
    Missing,
    #[error("path is not a regular file")]
    NotAFile,
    #[error("file is too large to preview ({0} bytes; limit is 1 MB)")]
    TooLarge(u64),
    #[error("file is not text (invalid UTF-8)")]
    NotText,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for FilePreviewError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, FilePreviewError> {
    let path_buf = Path::new(&path);
    if !path_buf.exists() {
        return Err(FilePreviewError::Missing);
    }

    let metadata = std::fs::metadata(path_buf)?;
    if !metadata.is_file() {
        return Err(FilePreviewError::NotAFile);
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(FilePreviewError::TooLarge(metadata.len()));
    }

    let bytes = std::fs::read(path_buf)?;
    String::from_utf8(bytes).map_err(|_| FilePreviewError::NotText)
}
