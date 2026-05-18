use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{Task, TaskStatus};

use super::error::StoreError;
use super::pool::Db;

#[derive(Debug, Default, Clone)]
pub struct TaskUpdate {
    pub name: Option<String>,
    pub prompt: Option<Option<String>>,
    pub preset_id: Option<Option<String>>,
    pub command: Option<String>,
    pub status: Option<TaskStatus>,
    pub branch: Option<Option<String>>,
    pub worktree_path: Option<Option<String>>,
    pub exit_code: Option<Option<i64>>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub finished_at: Option<Option<DateTime<Utc>>>,
    pub archived_at: Option<Option<DateTime<Utc>>>,
}

#[derive(Clone)]
pub struct TaskRepo {
    db: Db,
}

impl TaskRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, task: &Task) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO tasks (
                id, workspace_id, name, prompt, preset_id, command, status,
                branch, worktree_path, exit_code,
                created_at, started_at, finished_at, archived_at, updated_at,
                synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&task.id)
        .bind(&task.workspace_id)
        .bind(&task.name)
        .bind(&task.prompt)
        .bind(&task.preset_id)
        .bind(&task.command)
        .bind(task.status.as_str())
        .bind(&task.branch)
        .bind(&task.worktree_path)
        .bind(task.exit_code)
        .bind(task.created_at.to_rfc3339())
        .bind(task.started_at.map(|dt| dt.to_rfc3339()))
        .bind(task.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(task.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(task.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn list_by_workspace(&self, workspace_id: &str) -> Result<Vec<Task>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, workspace_id, name, prompt, preset_id, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM tasks
             WHERE workspace_id = ?
             ORDER BY created_at DESC",
        )
        .bind(workspace_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_task).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Task, StoreError> {
        let row = sqlx::query(
            "SELECT id, workspace_id, name, prompt, preset_id, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM tasks
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_task)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    pub async fn update(&self, id: &str, patch: TaskUpdate) -> Result<Task, StoreError> {
        let mut current = self.get(id).await?;

        if let Some(name) = patch.name {
            current.name = name;
        }
        if let Some(prompt) = patch.prompt {
            current.prompt = prompt;
        }
        if let Some(preset_id) = patch.preset_id {
            current.preset_id = preset_id;
        }
        if let Some(command) = patch.command {
            current.command = command;
        }
        if let Some(status) = patch.status {
            if !current.status.can_transition_to(status) {
                return Err(StoreError::InvalidValue {
                    field: "status",
                    message: format!(
                        "illegal transition {} → {}",
                        current.status.as_str(),
                        status.as_str()
                    ),
                });
            }
            current.status = status;
        }
        if let Some(branch) = patch.branch {
            current.branch = branch;
        }
        if let Some(worktree_path) = patch.worktree_path {
            current.worktree_path = worktree_path;
        }
        if let Some(exit_code) = patch.exit_code {
            current.exit_code = exit_code;
        }
        if let Some(started_at) = patch.started_at {
            current.started_at = started_at;
        }
        if let Some(finished_at) = patch.finished_at {
            current.finished_at = finished_at;
        }
        if let Some(archived_at) = patch.archived_at {
            current.archived_at = archived_at;
        }
        current.updated_at = Utc::now();

        sqlx::query(
            "UPDATE tasks SET
                name = ?, prompt = ?, preset_id = ?, command = ?, status = ?,
                branch = ?, worktree_path = ?, exit_code = ?,
                started_at = ?, finished_at = ?, archived_at = ?, updated_at = ?,
                dirty = 1
             WHERE id = ?",
        )
        .bind(&current.name)
        .bind(&current.prompt)
        .bind(&current.preset_id)
        .bind(&current.command)
        .bind(current.status.as_str())
        .bind(&current.branch)
        .bind(&current.worktree_path)
        .bind(current.exit_code)
        .bind(current.started_at.map(|dt| dt.to_rfc3339()))
        .bind(current.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(current.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(current.updated_at.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;

        Ok(current)
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let res = sqlx::query("DELETE FROM tasks WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

fn row_to_task(row: &sqlx::sqlite::SqliteRow) -> Result<Task, StoreError> {
    let status_str: String = row.try_get("status")?;
    let status = TaskStatus::from_str(&status_str).ok_or_else(|| StoreError::InvalidValue {
        field: "status",
        message: format!("unknown status `{status_str}`"),
    })?;

    Ok(Task {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        name: row.try_get("name")?,
        prompt: row.try_get("prompt")?,
        preset_id: row.try_get("preset_id")?,
        command: row.try_get("command")?,
        status,
        branch: row.try_get("branch")?,
        worktree_path: row.try_get("worktree_path")?,
        exit_code: row.try_get("exit_code")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
        started_at: parse_optional_timestamp(row.try_get("started_at")?, "started_at")?,
        finished_at: parse_optional_timestamp(row.try_get("finished_at")?, "finished_at")?,
        archived_at: parse_optional_timestamp(row.try_get("archived_at")?, "archived_at")?,
        updated_at: parse_timestamp(row.try_get::<String, _>("updated_at")?, "updated_at")?,
    })
}

fn parse_timestamp(value: String, field: &'static str) -> Result<DateTime<Utc>, StoreError> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| StoreError::InvalidValue {
            field,
            message: err.to_string(),
        })
}

fn parse_optional_timestamp(
    value: Option<String>,
    field: &'static str,
) -> Result<Option<DateTime<Utc>>, StoreError> {
    value.map(|v| parse_timestamp(v, field)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Workspace;
    use crate::store::{init_pool, WorkspaceRepo};
    use std::path::PathBuf;

    async fn fresh() -> (WorkspaceRepo, TaskRepo, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        let workspace_repo = WorkspaceRepo::new(pool.clone());
        let task_repo = TaskRepo::new(pool);
        let ws = Workspace::new("ws".into(), None, None);
        workspace_repo.insert(&ws).await.unwrap();
        (workspace_repo, task_repo, ws)
    }

    #[tokio::test]
    async fn insert_and_list_by_workspace() {
        let (_w, tasks, ws) = fresh().await;
        let task = Task::new(ws.id.clone(), "fix bug".into(), "claude -p foo".into());
        tasks.insert(&task).await.unwrap();
        let list = tasks.list_by_workspace(&ws.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "fix bug");
    }

    #[tokio::test]
    async fn legal_status_transition() {
        let (_w, tasks, ws) = fresh().await;
        let task = Task::new(ws.id.clone(), "t".into(), "c".into());
        tasks.insert(&task).await.unwrap();
        let updated = tasks
            .update(
                &task.id,
                TaskUpdate {
                    status: Some(TaskStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn illegal_status_transition_rejected() {
        let (_w, tasks, ws) = fresh().await;
        let task = Task::new(ws.id.clone(), "t".into(), "c".into());
        tasks.insert(&task).await.unwrap();
        let err = tasks
            .update(
                &task.id,
                TaskUpdate {
                    status: Some(TaskStatus::Completed),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::InvalidValue { field: "status", .. }));
    }

    #[tokio::test]
    async fn deleting_workspace_cascades_to_tasks() {
        let (workspaces, tasks, ws) = fresh().await;
        let task = Task::new(ws.id.clone(), "t".into(), "c".into());
        tasks.insert(&task).await.unwrap();
        workspaces.delete(&ws.id).await.unwrap();
        let list = tasks.list_by_workspace(&ws.id).await.unwrap();
        assert!(list.is_empty());
    }
}
