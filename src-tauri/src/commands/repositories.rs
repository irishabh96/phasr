use serde::Deserialize;
use tauri::State;

use crate::domain::Repository;
use crate::store::{RepositoryRepo, RepositoryUpdate, StoreError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepositoryInput {
    pub name: String,
    pub local_path: Option<String>,
    pub remote_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRepositoryInput {
    pub name: Option<String>,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    pub default_branch: Option<String>,
}

#[tauri::command]
pub async fn create_repository(
    input: CreateRepositoryInput,
    repo: State<'_, RepositoryRepo>,
) -> Result<Repository, StoreError> {
    // Idempotent: same canonical path returns the existing row.
    if let Some(input_path) = input.local_path.as_deref() {
        let candidate = std::fs::canonicalize(input_path)
            .ok()
            .unwrap_or_else(|| std::path::PathBuf::from(input_path));
        for existing in repo.list().await? {
            if let Some(existing_path) = existing.local_path.as_deref() {
                let resolved = std::fs::canonicalize(existing_path)
                    .ok()
                    .unwrap_or_else(|| std::path::PathBuf::from(existing_path));
                if resolved == candidate {
                    return Ok(existing);
                }
            }
        }
    }

    // Auto-detect the origin URL from the local repo if the caller
    // didn't provide one.
    let resolved_remote_url = input.remote_url.or_else(|| {
        input
            .local_path
            .as_deref()
            .and_then(|p| crate::git::get_remote_url(std::path::Path::new(p)))
    });

    let repository = Repository::new(input.name, input.local_path, resolved_remote_url);
    repo.insert(&repository).await?;
    Ok(repository)
}

#[tauri::command]
pub async fn list_repositories(
    repo: State<'_, RepositoryRepo>,
) -> Result<Vec<Repository>, StoreError> {
    repo.list().await
}

#[tauri::command]
pub async fn get_repository(
    id: String,
    repo: State<'_, RepositoryRepo>,
) -> Result<Repository, StoreError> {
    repo.get(&id).await
}

#[tauri::command]
pub async fn update_repository(
    id: String,
    input: UpdateRepositoryInput,
    repo: State<'_, RepositoryRepo>,
) -> Result<Repository, StoreError> {
    let patch = RepositoryUpdate {
        name: input.name,
        remote_url: input.remote_url.map(Some),
        local_path: input.local_path.map(Some),
        default_branch: input.default_branch,
    };
    repo.update(&id, patch).await
}

#[tauri::command]
pub async fn delete_repository(
    id: String,
    repo: State<'_, RepositoryRepo>,
) -> Result<(), StoreError> {
    repo.delete(&id).await
}
