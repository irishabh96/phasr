use serde::Deserialize;
use tauri::State;

use crate::domain::Workspace;
use crate::store::{StoreError, WorkspaceRepo, WorkspaceUpdate};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub name: String,
    pub local_path: Option<String>,
    pub remote_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub name: Option<String>,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    pub default_branch: Option<String>,
}

#[tauri::command]
pub async fn create_workspace(
    input: CreateWorkspaceInput,
    repo: State<'_, WorkspaceRepo>,
) -> Result<Workspace, StoreError> {
    let workspace = Workspace::new(input.name, input.local_path, input.remote_url);
    repo.insert(&workspace).await?;
    Ok(workspace)
}

#[tauri::command]
pub async fn list_workspaces(
    repo: State<'_, WorkspaceRepo>,
) -> Result<Vec<Workspace>, StoreError> {
    repo.list().await
}

#[tauri::command]
pub async fn get_workspace(
    id: String,
    repo: State<'_, WorkspaceRepo>,
) -> Result<Workspace, StoreError> {
    repo.get(&id).await
}

#[tauri::command]
pub async fn update_workspace(
    id: String,
    input: UpdateWorkspaceInput,
    repo: State<'_, WorkspaceRepo>,
) -> Result<Workspace, StoreError> {
    let patch = WorkspaceUpdate {
        name: input.name,
        remote_url: input.remote_url.map(Some),
        local_path: input.local_path.map(Some),
        default_branch: input.default_branch,
    };
    repo.update(&id, patch).await
}

#[tauri::command]
pub async fn delete_workspace(
    id: String,
    repo: State<'_, WorkspaceRepo>,
) -> Result<(), StoreError> {
    repo.delete(&id).await
}
