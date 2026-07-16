use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{Agent, Workspace, WorkspaceKind, WorkspaceStatus};

use super::error::StoreError;
use super::pool::Db;

#[derive(Debug, Default, Clone)]
pub struct WorkspaceUpdate {
    pub name: Option<String>,
    pub prompt: Option<Option<String>>,
    pub agent: Option<Option<Agent>>,
    pub command: Option<String>,
    pub status: Option<WorkspaceStatus>,
    pub branch: Option<Option<String>>,
    pub worktree_path: Option<Option<String>>,
    pub exit_code: Option<Option<i64>>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub finished_at: Option<Option<DateTime<Utc>>>,
    pub archived_at: Option<Option<DateTime<Utc>>>,
}

#[derive(Clone)]
pub struct WorkspaceRepo {
    db: Db,
}

impl WorkspaceRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, workspace: &Workspace) -> Result<(), StoreError> {
        self.insert_with_user(workspace, None).await
    }

    pub async fn insert_for_user(
        &self,
        workspace: &Workspace,
        user_id: &str,
    ) -> Result<(), StoreError> {
        self.insert_with_user(workspace, Some(user_id)).await
    }

    async fn insert_with_user(
        &self,
        workspace: &Workspace,
        user_id: Option<&str>,
    ) -> Result<(), StoreError> {
        let dirty = if workspace.workspace_kind.is_local() {
            0
        } else {
            1
        };
        sqlx::query(
            "INSERT INTO workspaces (
                id, user_id, repository_id, workspace_kind, name, prompt, agent, command, status,
                branch, worktree_path, exit_code,
                created_at, started_at, finished_at, archived_at, updated_at,
                synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .bind(&workspace.id)
        .bind(user_id)
        .bind(&workspace.repository_id)
        .bind(workspace.workspace_kind.as_str())
        .bind(&workspace.name)
        .bind(&workspace.prompt)
        .bind(workspace.agent.map(Agent::as_str))
        .bind(&workspace.command)
        .bind(workspace.status.as_str())
        .bind(&workspace.branch)
        .bind(&workspace.worktree_path)
        .bind(workspace.exit_code)
        .bind(workspace.created_at.to_rfc3339())
        .bind(workspace.started_at.map(|dt| dt.to_rfc3339()))
        .bind(workspace.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(workspace.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(workspace.updated_at.to_rfc3339())
        .bind(dirty)
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn list_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE repository_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(repository_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Owner-scoped variant so a different signed-in account never sees
    /// another user's workspaces.
    pub async fn list_by_repository_for_user(
        &self,
        repository_id: &str,
        user_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE repository_id = ? AND user_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(repository_id)
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    pub async fn list_by_status(
        &self,
        status: WorkspaceStatus,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE status = ? AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .bind(status.as_str())
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Workspace, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_workspace)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    /// Owner-scoped `get`: `NotFound` for a workspace owned by another
    /// account.
    pub async fn get_for_user(&self, id: &str, user_id: &str) -> Result<Workspace, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_workspace)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    pub async fn get_local_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE repository_id = ? AND workspace_kind = 'local' AND deleted_at IS NULL
             LIMIT 1",
        )
        .bind(repository_id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref().map(row_to_workspace).transpose()
    }

    /// Find an ACTIVE (pending/running, not soft-deleted) agent workspace
    /// for `(repository_id, name)`. Backs the orchestrator's `start_task`
    /// idempotency guard: a rapid duplicate / replayed IPC / second window
    /// returns this in-flight task instead of minting a second
    /// worktree/branch/agent. Only `agent`-kind rows count — the always-present
    /// `local` workspace (name `"local"`) must never be mistaken for a
    /// duplicate agent task. A task that has since stopped/completed/failed/
    /// archived or been deleted is NOT active, so a deliberate re-run after
    /// the first ends still creates fresh state.
    pub async fn find_active_by_name(
        &self,
        repository_id: &str,
        name: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE repository_id = ? AND name = ? AND workspace_kind = 'agent'
               AND status IN ('pending', 'running') AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(repository_id)
        .bind(name)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref().map(row_to_workspace).transpose()
    }

    /// Owner-scoped variant of `find_active_by_name` so a second signed-in
    /// account can't collide with another user's active task.
    pub async fn find_active_by_name_for_user(
        &self,
        repository_id: &str,
        name: &str,
        user_id: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code,
                    created_at, started_at, finished_at, archived_at, updated_at
             FROM workspaces
             WHERE repository_id = ? AND name = ? AND user_id = ? AND workspace_kind = 'agent'
               AND status IN ('pending', 'running') AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(repository_id)
        .bind(name)
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref().map(row_to_workspace).transpose()
    }

    pub async fn update(&self, id: &str, patch: WorkspaceUpdate) -> Result<Workspace, StoreError> {
        let mut current = self.get(id).await?;

        if let Some(name) = patch.name {
            current.name = name;
        }
        if let Some(prompt) = patch.prompt {
            current.prompt = prompt;
        }
        if let Some(agent) = patch.agent {
            current.agent = agent;
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
            "UPDATE workspaces SET
                name = ?, prompt = ?, agent = ?, command = ?, status = ?,
                branch = ?, worktree_path = ?, exit_code = ?,
                started_at = ?, finished_at = ?, archived_at = ?, updated_at = ?,
                dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
             WHERE id = ?",
        )
        .bind(&current.name)
        .bind(&current.prompt)
        .bind(current.agent.map(Agent::as_str))
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

    /// Soft-delete: tombstone the row (mirrors `RepositoryRepo::delete`)
    /// and mark it dirty so the deletion pushes to the cloud. Without the
    /// tombstone the next sync pull would re-insert the still-present
    /// cloud row. `local`-kind workspaces aren't synced, so they don't
    /// get marked dirty. The worktree/branch teardown lives in the
    /// `delete_workspace` command.
    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query(
            "UPDATE workspaces
                SET deleted_at = ?, updated_at = ?,
                    dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
              WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

fn row_to_workspace(row: &sqlx::sqlite::SqliteRow) -> Result<Workspace, StoreError> {
    let status_str: String = row.try_get("status")?;
    let status =
        WorkspaceStatus::from_str(&status_str).ok_or_else(|| StoreError::InvalidValue {
            field: "status",
            message: format!("unknown status `{status_str}`"),
        })?;
    let kind_str: String = row.try_get("workspace_kind")?;
    let workspace_kind =
        WorkspaceKind::from_str(&kind_str).ok_or_else(|| StoreError::InvalidValue {
            field: "workspace_kind",
            message: format!("unknown workspace kind `{kind_str}`"),
        })?;
    let agent = row
        .try_get::<Option<String>, _>("agent")?
        .map(|s| {
            Agent::from_str(&s).ok_or_else(|| StoreError::InvalidValue {
                field: "agent",
                message: format!("unknown agent `{s}`"),
            })
        })
        .transpose()?;

    Ok(Workspace {
        id: row.try_get("id")?,
        repository_id: row.try_get("repository_id")?,
        workspace_kind,
        name: row.try_get("name")?,
        prompt: row.try_get("prompt")?,
        agent,
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
    use crate::domain::Repository;
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::PathBuf;

    async fn fresh() -> (RepositoryRepo, WorkspaceRepo, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        let repo_repo = RepositoryRepo::new(pool.clone());
        let ws_repo = WorkspaceRepo::new(pool);
        let r = Repository::new("repo".into(), None, None);
        repo_repo.insert(&r).await.unwrap();
        (repo_repo, ws_repo, r)
    }

    #[tokio::test]
    async fn insert_and_list_by_repository() {
        let (_repos, workspaces, repo) = fresh().await;
        let ws = Workspace::new(repo.id.clone(), "fix bug".into(), "claude".into());
        workspaces.insert(&ws).await.unwrap();
        let list = workspaces.list_by_repository(&repo.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "fix bug");
    }

    #[tokio::test]
    async fn delete_soft_hides_workspace_but_keeps_tombstone() {
        let (_repos, workspaces, repo) = fresh().await;
        let ws = Workspace::new(repo.id.clone(), "doomed".into(), "claude".into());
        workspaces.insert(&ws).await.unwrap();
        workspaces.delete(&ws.id).await.unwrap();

        // Hidden from UI reads…
        assert!(workspaces
            .list_by_repository(&repo.id)
            .await
            .unwrap()
            .is_empty());
        assert!(matches!(
            workspaces.get(&ws.id).await,
            Err(StoreError::NotFound)
        ));

        // …but the row survives as a tombstone (so the delete can sync
        // and the cloud can't resurrect it).
        let deleted_at: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM workspaces WHERE id = ?")
                .bind(&ws.id)
                .fetch_one(&workspaces.db)
                .await
                .unwrap();
        assert!(deleted_at.is_some());
    }

    #[tokio::test]
    async fn illegal_status_transition_rejected() {
        let (_repos, workspaces, repo) = fresh().await;
        let ws = Workspace::new(repo.id.clone(), "t".into(), "c".into());
        workspaces.insert(&ws).await.unwrap();
        let err = workspaces
            .update(
                &ws.id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Completed),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            StoreError::InvalidValue {
                field: "status",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn deleting_repository_cascades_to_workspaces() {
        let (repos, workspaces, repo) = fresh().await;
        let ws = Workspace::new(repo.id.clone(), "t".into(), "c".into());
        workspaces.insert(&ws).await.unwrap();
        repos.delete(&repo.id).await.unwrap();
        let list = workspaces.list_by_repository(&repo.id).await.unwrap();
        assert!(list.is_empty());
    }

    // The dedup lookup that backs start_task idempotency must match ONLY
    // active (pending/running) agent rows — never a terminal/stopped row,
    // never a `local` workspace (even a running one), never a soft-deleted
    // tombstone. This locks the SQL predicate down directly.
    #[tokio::test]
    async fn find_active_by_name_matches_only_active_agent_rows() {
        let (_repos, workspaces, repo) = fresh().await;

        // A pending agent task is ACTIVE → found.
        let alpha = Workspace::new(repo.id.clone(), "alpha".into(), "cmd".into());
        workspaces.insert(&alpha).await.unwrap();
        assert_eq!(
            workspaces
                .find_active_by_name(&repo.id, "alpha")
                .await
                .unwrap()
                .map(|w| w.id),
            Some(alpha.id.clone()),
            "a pending agent task must count as active"
        );

        // Running is still active.
        workspaces
            .update(
                &alpha.id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(workspaces
            .find_active_by_name(&repo.id, "alpha")
            .await
            .unwrap()
            .is_some());

        // Completed is terminal → no longer active (so a re-run is allowed).
        workspaces
            .update(
                &alpha.id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Completed),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(
            workspaces
                .find_active_by_name(&repo.id, "alpha")
                .await
                .unwrap()
                .is_none(),
            "a completed task must not be treated as active"
        );

        // A stopped agent task (inserted directly) is not active.
        let mut beta = Workspace::new(repo.id.clone(), "beta".into(), "cmd".into());
        beta.status = WorkspaceStatus::Stopped;
        workspaces.insert(&beta).await.unwrap();
        assert!(workspaces
            .find_active_by_name(&repo.id, "beta")
            .await
            .unwrap()
            .is_none());

        // A LOCAL workspace, even when running, is excluded (kind filter):
        // every repo carries an ever-present `local` row that must never be
        // mistaken for a duplicate agent task.
        let mut gamma = Workspace::new(repo.id.clone(), "gamma".into(), String::new());
        gamma.workspace_kind = WorkspaceKind::Local;
        gamma.status = WorkspaceStatus::Running;
        workspaces.insert(&gamma).await.unwrap();
        assert!(
            workspaces
                .find_active_by_name(&repo.id, "gamma")
                .await
                .unwrap()
                .is_none(),
            "a local workspace must never match the agent dedup lookup"
        );

        // A soft-deleted agent task is excluded (deleted_at filter).
        let delta = Workspace::new(repo.id.clone(), "delta".into(), "cmd".into());
        workspaces.insert(&delta).await.unwrap();
        workspaces.delete(&delta.id).await.unwrap();
        assert!(
            workspaces
                .find_active_by_name(&repo.id, "delta")
                .await
                .unwrap()
                .is_none(),
            "a soft-deleted task must not be deduped against"
        );
    }

    // Owner-scoping (defense-in-depth): `_for_user` only returns the
    // querying user's active task, never another account's — even for an
    // identical `(repository_id, name)`.
    //
    // NOTE: in production a `repository_id` is owner-unique (create_repository
    // stamps `user_id` and the id is a per-user UUID), so two users sharing
    // one repo isn't a reachable state via the orchestrator. We verify the
    // scoping directly at the store level instead.
    #[tokio::test]
    async fn find_active_by_name_is_scoped_to_owner() {
        let (_repos, workspaces, repo) = fresh().await;

        // workspaces.user_id FKs to users(id); seed two distinct owners.
        for uid in ["user-a", "user-b"] {
            sqlx::query(
                "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
                 VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
            )
            .bind(uid)
            .bind(uid)
            .bind(format!("{uid}@example.com"))
            .execute(&workspaces.db)
            .await
            .unwrap();
        }

        // Identical (repository_id, name), two different owners.
        let a = Workspace::new(repo.id.clone(), "shared".into(), "cmd".into());
        workspaces.insert_for_user(&a, "user-a").await.unwrap();
        let b = Workspace::new(repo.id.clone(), "shared".into(), "cmd".into());
        workspaces.insert_for_user(&b, "user-b").await.unwrap();

        assert_eq!(
            workspaces
                .find_active_by_name_for_user(&repo.id, "shared", "user-a")
                .await
                .unwrap()
                .map(|w| w.id),
            Some(a.id.clone()),
            "owner A must see only A's task"
        );
        assert_eq!(
            workspaces
                .find_active_by_name_for_user(&repo.id, "shared", "user-b")
                .await
                .unwrap()
                .map(|w| w.id),
            Some(b.id.clone()),
            "owner B must see only B's task"
        );
        assert_ne!(a.id, b.id);
    }

    #[tokio::test]
    async fn local_workspace_round_trips_and_stays_clean() {
        let (_repos, workspaces, repo) = fresh().await;
        let mut ws = Workspace::new(repo.id.clone(), "local".into(), String::new());
        ws.workspace_kind = WorkspaceKind::Local;
        ws.status = WorkspaceStatus::Stopped;
        ws.worktree_path = Some("/tmp/repo".into());
        workspaces.insert(&ws).await.unwrap();

        let local = workspaces
            .get_local_by_repository(&repo.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(local.workspace_kind, WorkspaceKind::Local);
        assert_eq!(local.worktree_path.as_deref(), Some("/tmp/repo"));

        workspaces
            .update(
                &ws.id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = ?")
            .bind(&ws.id)
            .fetch_one(&workspaces.db)
            .await
            .unwrap();
        assert_eq!(dirty, 0);
    }
}
