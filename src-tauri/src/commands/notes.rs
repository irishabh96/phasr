//! CRUD for repository notes — the user's todos. Repository-scoped (they
//! outlive every workspace/terminal AND the repository itself),
//! soft-deleted only, and checkable: `done_at` carries both whether a
//! note is done and when it was ticked.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use thiserror::Error;

use crate::auth::{AuthError, SessionState};
use crate::domain::{Note, NoteOriginKind};
use crate::store::{NoteRepo, NoteUpdate, RepositoryRepo, StoreError, WorkspaceRepo};

/// Server-side cap. The UI shows a counter past 90% of this.
pub const MAX_NOTE_LEN: usize = 50_000;
/// Client-supplied origin hints ("Terminal 2") are display text only.
const MAX_ORIGIN_HINT_LEN: usize = 100;

#[derive(Debug, Error)]
pub enum NoteError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("note cannot be empty")]
    Empty,
    #[error("note is too long (max {0} characters)")]
    TooLong(usize),
}

impl serde::Serialize for NoteError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn validate_body(body: &str) -> Result<String, NoteError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(NoteError::Empty);
    }
    if trimmed.chars().count() > MAX_NOTE_LEN {
        return Err(NoteError::TooLong(MAX_NOTE_LEN));
    }
    Ok(trimmed.to_string())
}

fn sanitize_hint(hint: Option<String>) -> Option<String> {
    let hint = hint?;
    let cleaned: String = hint
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_ORIGIN_HINT_LEN)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() { None } else { Some(cleaned) }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteInput {
    pub repository_id: String,
    pub body: String,
    pub origin_kind: NoteOriginKind,
    pub origin_workspace_id: Option<String>,
    pub origin_terminal_id: Option<String>,
    /// UI-only origin detail the backend can't know (the inner-tab
    /// title, e.g. "Terminal 2"). Sanitized and used as display text.
    pub origin_label_hint: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteInput {
    pub body: Option<String>,
    /// Optimistic-concurrency guard (see `NoteUpdate`).
    pub expected_updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[tauri::command]
pub async fn create_note(
    input: CreateNoteInput,
    notes: State<'_, NoteRepo>,
    repositories: State<'_, RepositoryRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Note, NoteError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let body = validate_body(&input.body)?;

    // Liveness + ownership: the FK alone would accept a tombstoned
    // repository row, so a note could otherwise attach to a removed repo.
    repositories
        .get_for_user(&input.repository_id, &current.user_id)
        .await?;

    let mut note = Note::new(input.repository_id, body, input.origin_kind);
    note.origin_terminal_id = input.origin_terminal_id;

    // Provenance snapshot, resolved server-side: the workspace NAME
    // comes from the DB (never trusted from the client); the label hint
    // is UI-only detail ("Terminal 2") the backend can't know.
    if let Some(workspace_id) = input.origin_workspace_id {
        if let Ok(ws) = workspaces.get_for_user(&workspace_id, &current.user_id).await {
            note.origin_workspace_name = Some(ws.name);
        }
        note.origin_workspace_id = Some(workspace_id);
    }
    let hint = sanitize_hint(input.origin_label_hint);
    note.origin_label = match note.origin_kind {
        NoteOriginKind::Workspace => hint.unwrap_or_else(|| "Agent".to_string()),
        NoteOriginKind::Terminal => hint.unwrap_or_else(|| "Terminal".to_string()),
        NoteOriginKind::RunCommand => hint.unwrap_or_else(|| "Run command".to_string()),
        NoteOriginKind::Repository => "Repository home".to_string(),
    };

    notes.insert_for_user(&note, &current.user_id).await?;
    // No sync_state.request_sync() — notes are local-only in v1.
    Ok(note)
}

#[tauri::command]
pub async fn list_notes_for_repository(
    repository_id: String,
    notes: State<'_, NoteRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Note>, NoteError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(notes
        .list_by_repository_for_user(&repository_id, &current.user_id)
        .await?)
}

#[tauri::command]
pub async fn update_note(
    id: String,
    input: UpdateNoteInput,
    notes: State<'_, NoteRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Note, NoteError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let body = match input.body {
        Some(body) => Some(validate_body(&body)?),
        None => None,
    };
    Ok(notes
        .update_for_user(
            &id,
            &current.user_id,
            NoteUpdate {
                body,
                expected_updated_at: input.expected_updated_at,
            },
        )
        .await?)
}

#[tauri::command]
pub async fn set_note_done(
    id: String,
    done: bool,
    notes: State<'_, NoteRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Note, NoteError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(notes.set_done_for_user(&id, &current.user_id, done).await?)
}

#[tauri::command]
pub async fn delete_note(
    id: String,
    notes: State<'_, NoteRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), NoteError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    Ok(notes.soft_delete_for_user(&id, &current.user_id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_whitespace_bodies_are_rejected() {
        assert!(matches!(validate_body(""), Err(NoteError::Empty)));
        assert!(matches!(validate_body("   \n\t  "), Err(NoteError::Empty)));
    }

    #[test]
    fn body_is_trimmed_before_storage() {
        assert_eq!(validate_body("  hello  \n").unwrap(), "hello");
    }

    #[test]
    fn max_len_boundary() {
        let at_cap = "x".repeat(MAX_NOTE_LEN);
        assert_eq!(validate_body(&at_cap).unwrap().len(), MAX_NOTE_LEN);
        let over = "x".repeat(MAX_NOTE_LEN + 1);
        assert!(matches!(validate_body(&over), Err(NoteError::TooLong(_))));
    }

    #[test]
    fn hints_are_sanitized() {
        assert_eq!(sanitize_hint(None), None);
        assert_eq!(sanitize_hint(Some("  ".into())), None);
        assert_eq!(
            sanitize_hint(Some("Terminal 2\x1b[31m".into())),
            Some("Terminal 2[31m".into())
        );
        let long = "a".repeat(500);
        assert_eq!(sanitize_hint(Some(long)).unwrap().len(), MAX_ORIGIN_HINT_LEN);
    }
}
