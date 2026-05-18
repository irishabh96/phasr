use serde::Deserialize;
use tauri::State;

use crate::domain::{Task, TaskStatus};
use crate::store::{StoreError, TaskRepo, TaskUpdate};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub workspace_id: String,
    pub name: String,
    pub command: String,
    pub prompt: Option<String>,
    pub preset_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub preset_id: Option<String>,
    pub command: Option<String>,
    pub status: Option<TaskStatus>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
}

#[tauri::command]
pub async fn create_task(
    input: CreateTaskInput,
    repo: State<'_, TaskRepo>,
) -> Result<Task, StoreError> {
    let mut task = Task::new(input.workspace_id, input.name, input.command);
    task.prompt = input.prompt;
    task.preset_id = input.preset_id;
    repo.insert(&task).await?;
    Ok(task)
}

#[tauri::command]
pub async fn list_tasks(
    workspace_id: String,
    repo: State<'_, TaskRepo>,
) -> Result<Vec<Task>, StoreError> {
    repo.list_by_workspace(&workspace_id).await
}

#[tauri::command]
pub async fn get_task(id: String, repo: State<'_, TaskRepo>) -> Result<Task, StoreError> {
    repo.get(&id).await
}

#[tauri::command]
pub async fn update_task(
    id: String,
    input: UpdateTaskInput,
    repo: State<'_, TaskRepo>,
) -> Result<Task, StoreError> {
    let patch = TaskUpdate {
        name: input.name,
        prompt: input.prompt.map(Some),
        preset_id: input.preset_id.map(Some),
        command: input.command,
        status: input.status,
        branch: input.branch.map(Some),
        worktree_path: input.worktree_path.map(Some),
        exit_code: input.exit_code.map(Some),
        ..Default::default()
    };
    repo.update(&id, patch).await
}

#[tauri::command]
pub async fn delete_task(id: String, repo: State<'_, TaskRepo>) -> Result<(), StoreError> {
    repo.delete(&id).await
}
