//! Local filesystem checks the UI uses to validate user-supplied paths
//! (e.g. when adding a workspace). No I/O outside read-only fs metadata
//! and the existence of a `.git` directory.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::auth::{AuthError, SessionState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    pub path: String,
    pub absolute_path: Option<String>,
    pub exists: bool,
    pub is_dir: bool,
    pub is_git_repo: bool,
    /// Present only when `exists && is_dir && !is_git_repo`. Suggests the
    /// user run `git init` or pick a different folder (mockup 4 of the plan).
    pub message: Option<String>,
}

pub fn validate(path: &str) -> PathValidation {
    let expanded = expand_tilde(path);
    let absolute = std::fs::canonicalize(&expanded)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    let exists = expanded.exists();
    let is_dir = exists && expanded.is_dir();
    let is_git_repo = is_dir && expanded.join(".git").exists();

    let message = match (exists, is_dir, is_git_repo) {
        (false, _, _) => Some("Path does not exist".into()),
        (true, false, _) => Some("Path is a file, not a directory".into()),
        (true, true, false) => Some("Folder is not a git repository".into()),
        (true, true, true) => None,
    };

    PathValidation {
        path: path.into(),
        absolute_path: absolute,
        exists,
        is_dir,
        is_git_repo,
        message,
    }
}

/// Expands a leading `~` to the user's home directory. Does not handle
/// `~user/...` style — Phasr never spawns paths as another user.
fn expand_tilde(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    if input == "~" {
        if let Some(home) = home_dir() {
            return home;
        }
    }
    PathBuf::from(input)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

#[tauri::command]
pub fn validate_workspace_path(
    path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<PathValidation, AuthError> {
    session.require()?;
    Ok(validate(&path))
}

/// Returns the default folder where Phasr creates new projects.
/// `<home>/PhasrProjects`. Doesn't create the directory; that happens on
/// first project creation via `ensure_dir`.
#[tauri::command]
pub fn default_projects_dir(session: State<'_, Arc<SessionState>>) -> Result<String, String> {
    // Auth errors collapse into the existing `String` envelope so the TS
    // signature stays unchanged.
    session.require().map_err(|e| e.to_string())?;
    home_dir()
        .map(|h| h.join("PhasrProjects").to_string_lossy().into_owned())
        .ok_or_else(|| "could not resolve home directory".into())
}

/// `mkdir -p` for an arbitrary path. Returns the canonical absolute path
/// on success. Used by the new-project wizard before invoking `git init`
/// / `git clone`.
#[tauri::command]
pub fn ensure_dir(path: String, session: State<'_, Arc<SessionState>>) -> Result<String, String> {
    session.require().map_err(|e| e.to_string())?;
    let expanded = expand_tilde(&path);
    std::fs::create_dir_all(&expanded).map_err(|e| e.to_string())?;
    let canonical = std::fs::canonicalize(&expanded).map_err(|e| e.to_string())?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_path_is_invalid() {
        let result = validate("/this/almost/certainly/does/not/exist/qq");
        assert!(!result.exists);
        assert!(!result.is_dir);
        assert!(!result.is_git_repo);
        assert_eq!(result.message.as_deref(), Some("Path does not exist"));
    }

    #[test]
    fn file_path_is_not_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hello.txt");
        fs::write(&file, "hi").unwrap();
        let result = validate(file.to_str().unwrap());
        assert!(result.exists);
        assert!(!result.is_dir);
        assert_eq!(
            result.message.as_deref(),
            Some("Path is a file, not a directory")
        );
    }

    #[test]
    fn dir_without_git_warns() {
        let dir = tempfile::tempdir().unwrap();
        let result = validate(dir.path().to_str().unwrap());
        assert!(result.exists);
        assert!(result.is_dir);
        assert!(!result.is_git_repo);
        assert_eq!(
            result.message.as_deref(),
            Some("Folder is not a git repository")
        );
    }

    #[test]
    fn dir_with_git_subfolder_is_valid() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let result = validate(dir.path().to_str().unwrap());
        assert!(result.exists);
        assert!(result.is_dir);
        assert!(result.is_git_repo);
        assert!(result.message.is_none());
    }

    #[test]
    fn tilde_expansion() {
        let result = expand_tilde("~/somewhere");
        assert!(result.is_absolute());
        assert!(!result.starts_with("~"));
    }
}
