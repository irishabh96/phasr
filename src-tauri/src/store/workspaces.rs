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
    pub interrupted_at: Option<Option<DateTime<Utc>>>,
    /// Autopilot per-epic toggle (migration 0015). Local-only; set by
    /// `set_autopilot`.
    pub autopilot_enabled: Option<bool>,
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
        // Delegate to the shared row-insert helper so the 22-column list lives
        // in exactly ONE place. The helper is generic over the executor, which
        // lets `BoardRepo::create_decomposition` reuse the SAME insert inside a
        // transaction (the decomposition gate writes a parent + its subtasks +
        // edges atomically, spec E2-T1).
        insert_workspace_row(&self.db, workspace, user_id).await
    }

    /// The flat, top-level workspace list that backs the repository sidebar.
    /// Excludes parented rows (`parent_id IS NULL`): a `subtask` belongs to its
    /// parent's board, not the loose top-level list, so it must never leak in
    /// as a stray card (spec B6). Existing standalone `agent`/`local` rows and
    /// `parent` rows all have `parent_id = NULL`, so they are unaffected. For
    /// an ALL-rows enumeration (e.g. repository teardown, which must reach every
    /// subtask's PTY/worktree) use `list_all_by_repository`.
    ///
    /// Test-only today: the live sidebar reads the owner-scoped
    /// `list_by_repository_for_user`; this unscoped variant is a test
    /// convenience, so gate it to test builds.
    #[cfg(test)]
    pub async fn list_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE repository_id = ? AND parent_id IS NULL AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(repository_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Owner-scoped variant so a different signed-in account never sees
    /// another user's workspaces. Also excludes parented (`subtask`) rows —
    /// same top-level-only semantics as `list_by_repository`.
    pub async fn list_by_repository_for_user(
        &self,
        repository_id: &str,
        user_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE repository_id = ? AND user_id = ? AND parent_id IS NULL AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(repository_id)
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// EVERY non-deleted workspace in the repo, including parented `subtask`
    /// rows. Unlike `list_by_repository` (top-level only, for the sidebar) this
    /// is the internal enumeration used by repository teardown, which must reach
    /// every subtask's live PTY + worktree to tear them down — silently
    /// skipping subtasks here would orphan their worktrees on disk.
    pub async fn list_all_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE repository_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(repository_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// The subtasks of one `parent`, oldest first. Backs `BoardRepo::get_board`
    /// and the scheduler's per-parent ready/blocked evaluation.
    pub async fn list_by_parent(&self, parent_id: &str) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE parent_id = ? AND deleted_at IS NULL
             ORDER BY created_at ASC",
        )
        .bind(parent_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Owner-scoped variant of `list_by_parent`.
    pub async fn list_by_parent_for_user(
        &self,
        parent_id: &str,
        user_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL
             ORDER BY created_at ASC",
        )
        .bind(parent_id)
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
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE status = ? AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .bind(status.as_str())
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Every non-deleted `parent` (decomposition-container) workspace on this
    /// machine — the scheduler's per-tick enumeration entry point (E2-T2).
    /// Deliberately UNSCOPED by user, exactly like `list_by_status` backs the
    /// liveness poller: the scheduler is a machine-wide background consumer, not
    /// a command, and each parent's subtasks already carry their owner's
    /// `user_id` (so a spawned subtask stays owned via the row UPDATE). A
    /// `parent` never runs a PTY and stays `pending`, so there is no status to
    /// filter on here.
    pub async fn list_parents(&self) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE workspace_kind = 'parent' AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Workspace, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
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
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
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

    /// The owning `user_id` of a workspace row, if any. The `Workspace` domain
    /// struct deliberately does NOT carry `user_id` (it is a store-layer sync
    /// column), so the scheduler reads it here to mint a CLI token scoped to the
    /// subtask's owner (CLI1 / §R5). `None` for a local/sessionless row (the
    /// test path) — the caller then skips CLI env injection entirely.
    pub async fn owner_id(&self, id: &str) -> Result<Option<String>, StoreError> {
        let row = sqlx::query("SELECT user_id FROM workspaces WHERE id = ? AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&self.db)
            .await?;
        Ok(row.and_then(|r| r.try_get::<Option<String>, _>("user_id").ok().flatten()))
    }

    pub async fn get_local_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
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
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
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
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
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

    /// Subtask idempotency guard — the sibling of `find_active_by_name` (spec
    /// claim #2), keyed on `(parent_id, role)` and NEVER on `name`. Two
    /// different parents can each own a `backend`-role subtask without one
    /// deduping against the other. Only ACTIVE (`pending`/`running`, not
    /// soft-deleted) `subtask`-kind rows count, so once a subtask
    /// stops/completes a deliberate re-run mints fresh state — the exact same
    /// active/deleted predicate `find_active_by_name` uses. Backs the
    /// scheduler's "don't double-spawn on a duplicate tick" guard.
    pub async fn find_active_subtask(
        &self,
        parent_id: &str,
        role: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE parent_id = ? AND role = ? AND workspace_kind = 'subtask'
               AND status IN ('pending', 'running') AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(parent_id)
        .bind(role)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref().map(row_to_workspace).transpose()
    }

    /// Owner-scoped variant of `find_active_subtask`. No caller yet — the
    /// scheduler dedups (parent, role) via the unscoped `find_active_subtask`;
    /// kept ready (allow-dead) for a future owner-scoped dedup site.
    #[allow(dead_code)]
    pub async fn find_active_subtask_for_user(
        &self,
        parent_id: &str,
        role: &str,
        user_id: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(
            "SELECT id, repository_id, workspace_kind, name, prompt, agent, command, status,
                    branch, worktree_path, exit_code, parent_id, role,
                    created_at, started_at, finished_at, archived_at, interrupted_at,
                    autopilot_enabled, updated_at
             FROM workspaces
             WHERE parent_id = ? AND role = ? AND user_id = ? AND workspace_kind = 'subtask'
               AND status IN ('pending', 'running') AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(parent_id)
        .bind(role)
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
        if let Some(interrupted_at) = patch.interrupted_at {
            current.interrupted_at = interrupted_at;
        }
        if let Some(autopilot_enabled) = patch.autopilot_enabled {
            current.autopilot_enabled = autopilot_enabled;
        }
        current.updated_at = Utc::now();

        sqlx::query(
            "UPDATE workspaces SET
                name = ?, prompt = ?, agent = ?, command = ?, status = ?,
                branch = ?, worktree_path = ?, exit_code = ?,
                started_at = ?, finished_at = ?, archived_at = ?, interrupted_at = ?,
                autopilot_enabled = ?, updated_at = ?,
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
        .bind(current.interrupted_at.map(|dt| dt.to_rfc3339()))
        .bind(current.autopilot_enabled as i64)
        .bind(current.updated_at.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;

        Ok(current)
    }

    /// Atomically flip a `running` row to a terminal status in a single
    /// conditional statement (`UPDATE … WHERE status = 'running'`). Returns
    /// the updated row, or `None` when the row was no longer `running` — e.g.
    /// a concurrent `stop_task` already moved it to `stopped`. The caller
    /// (the exit-watcher) then emits nothing, leaving the user-visible status
    /// exactly as it was set.
    ///
    /// This closes the read-then-write TOCTOU the exit-watcher would have if
    /// it did `get()` + transition-checked `update()`: between the read and
    /// the write a `stop_task` could commit `stopped`, and the watcher would
    /// clobber it with `failed` (the SIGINT'd child exits nonzero). The
    /// single conditional statement makes that impossible.
    pub async fn finish_if_running(
        &self,
        id: &str,
        status: WorkspaceStatus,
        exit_code: Option<i64>,
    ) -> Result<Option<Workspace>, StoreError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query(
            "UPDATE workspaces
                SET status = ?, exit_code = ?, finished_at = ?, updated_at = ?,
                    dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
              WHERE id = ? AND status = 'running' AND deleted_at IS NULL",
        )
        .bind(status.as_str())
        .bind(exit_code)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Ok(None);
        }
        Ok(Some(self.get(id).await?))
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

/// Bind + execute a single `workspaces` INSERT against any executor — the
/// pool for the normal `insert`/`insert_for_user` path, or a
/// `&mut Transaction` when the insert must take part in a larger atomic write.
/// `BoardRepo::create_decomposition` uses the transaction form to persist a
/// parent + its subtasks + edges in one shot, so a partial failure leaves no
/// orphan rows. Keeping the column list here (not copied per caller) stops it
/// from drifting against the SELECT lists.
pub(super) async fn insert_workspace_row<'e, E>(
    executor: E,
    workspace: &Workspace,
    user_id: Option<&str>,
) -> Result<(), StoreError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // Board rows (`parent`/`subtask`) are non-local, so they follow the same
    // `dirty = 1` rule as agents; the `workspace_kind = 'agent'` sync PUSH
    // filter is what actually keeps them machine-local (spec claim #11).
    let dirty = if workspace.workspace_kind.is_local() {
        0
    } else {
        1
    };
    sqlx::query(
        "INSERT INTO workspaces (
            id, user_id, repository_id, workspace_kind, name, prompt, agent, command, status,
            branch, worktree_path, exit_code, parent_id, role,
            created_at, started_at, finished_at, archived_at, interrupted_at,
            autopilot_enabled, updated_at,
            synced_at, dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
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
    .bind(&workspace.parent_id)
    .bind(&workspace.role)
    .bind(workspace.created_at.to_rfc3339())
    .bind(workspace.started_at.map(|dt| dt.to_rfc3339()))
    .bind(workspace.finished_at.map(|dt| dt.to_rfc3339()))
    .bind(workspace.archived_at.map(|dt| dt.to_rfc3339()))
    .bind(workspace.interrupted_at.map(|dt| dt.to_rfc3339()))
    .bind(workspace.autopilot_enabled as i64)
    .bind(workspace.updated_at.to_rfc3339())
    .bind(dirty)
    .execute(executor)
    .await?;
    Ok(())
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
        parent_id: row.try_get("parent_id")?,
        role: row.try_get("role")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
        started_at: parse_optional_timestamp(row.try_get("started_at")?, "started_at")?,
        finished_at: parse_optional_timestamp(row.try_get("finished_at")?, "finished_at")?,
        archived_at: parse_optional_timestamp(row.try_get("archived_at")?, "archived_at")?,
        interrupted_at: parse_optional_timestamp(row.try_get("interrupted_at")?, "interrupted_at")?,
        autopilot_enabled: row.try_get::<i64, _>("autopilot_enabled")? != 0,
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

    // CLI1 (§R5): `owner_id` reads back the syncable owner column the domain
    // struct doesn't carry, so the scheduler can mint a token scoped to the
    // subtask's owner. An owned row returns its owner; a sessionless row → None.
    #[tokio::test]
    async fn owner_id_reads_the_syncable_owner_column() {
        let (_repos, workspaces, repo) = fresh().await;
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .bind("user-a")
        .bind("user-a")
        .bind("user-a@example.com")
        .execute(&workspaces.db)
        .await
        .unwrap();

        let owned = Workspace::new(repo.id.clone(), "owned".into(), "cmd".into());
        workspaces.insert_for_user(&owned, "user-a").await.unwrap();
        assert_eq!(
            workspaces.owner_id(&owned.id).await.unwrap().as_deref(),
            Some("user-a"),
            "an owned row reports its owner so the CLI token is user-scoped"
        );

        let local = Workspace::new(repo.id.clone(), "local".into(), "cmd".into());
        workspaces.insert(&local).await.unwrap();
        assert_eq!(
            workspaces.owner_id(&local.id).await.unwrap(),
            None,
            "a sessionless row has no owner → the scheduler skips CLI injection"
        );

        assert_eq!(
            workspaces.owner_id("does-not-exist").await.unwrap(),
            None,
            "a missing row is None, never an error"
        );
    }

    // TOCTOU fix: `finish_if_running` is an atomic conditional — it flips a
    // `running` row to a terminal status and returns it, but is a strict
    // no-op (returns None, changes nothing) once the row has left `running`.
    // This is what stops a late exit-watcher from clobbering a user `stop`.
    #[tokio::test]
    async fn finish_if_running_only_flips_a_running_row() {
        let (_repos, workspaces, repo) = fresh().await;

        // A genuinely running row flips and comes back with the terminal state.
        let mut alive = Workspace::new(repo.id.clone(), "alive".into(), "cmd".into());
        alive.status = WorkspaceStatus::Running;
        workspaces.insert(&alive).await.unwrap();
        let flipped = workspaces
            .finish_if_running(&alive.id, WorkspaceStatus::Completed, Some(0))
            .await
            .unwrap()
            .expect("a running row must flip");
        assert_eq!(flipped.status, WorkspaceStatus::Completed);
        assert_eq!(flipped.exit_code, Some(0));
        assert!(flipped.finished_at.is_some());

        // A row already moved off `running` (as a concurrent stop would leave
        // it) is untouched — the flip is a no-op.
        let mut stopped = Workspace::new(repo.id.clone(), "stopped".into(), "cmd".into());
        stopped.status = WorkspaceStatus::Running;
        workspaces.insert(&stopped).await.unwrap();
        workspaces
            .update(
                &stopped.id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Stopped),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let noop = workspaces
            .finish_if_running(&stopped.id, WorkspaceStatus::Failed, Some(130))
            .await
            .unwrap();
        assert!(noop.is_none(), "a non-running row must not be flipped");
        assert_eq!(
            workspaces.get(&stopped.id).await.unwrap().status,
            WorkspaceStatus::Stopped
        );
    }

    // E0-T4: the new `interrupted_at` column round-trips through
    // insert/get, defaults NULL on a fresh row, and is settable via
    // `WorkspaceUpdate` (the path recovery uses). This locks the column
    // wiring across every SELECT/INSERT/UPDATE list.
    #[tokio::test]
    async fn interrupted_at_column_round_trips() {
        let (_repos, workspaces, repo) = fresh().await;
        let ws = Workspace::new(repo.id.clone(), "orphan".into(), "claude".into());
        workspaces.insert(&ws).await.unwrap();

        // Fresh rows have no interrupted marker.
        let fetched = workspaces.get(&ws.id).await.unwrap();
        assert_eq!(fetched.interrupted_at, None);

        // Setting it via update persists and reads back to ~the same ms.
        let stamp = Utc::now();
        let updated = workspaces
            .update(
                &ws.id,
                WorkspaceUpdate {
                    interrupted_at: Some(Some(stamp)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(updated.interrupted_at.is_some());

        let reloaded = workspaces.get(&ws.id).await.unwrap();
        assert_eq!(
            reloaded.interrupted_at.map(|dt| dt.timestamp_millis()),
            Some(stamp.timestamp_millis()),
            "interrupted_at must survive the SELECT/INSERT/UPDATE column lists"
        );

        // Clearing it back to NULL also round-trips (a resumed row is calm again).
        let cleared = workspaces
            .update(
                &ws.id,
                WorkspaceUpdate {
                    interrupted_at: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(cleared.interrupted_at, None);
    }

    // S3 (Phase 5a): the additive `autopilot_enabled` column (migration 0015)
    // round-trips through insert/get, defaults `false` on a fresh row, and is
    // settable via `WorkspaceUpdate` (the `set_autopilot` command path). Locks
    // the column across every SELECT/INSERT/UPDATE list, mirroring
    // `interrupted_at_column_round_trips`.
    #[tokio::test]
    async fn autopilot_enabled_column_round_trips() {
        let (_repos, workspaces, repo) = fresh().await;
        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert(&parent).await.unwrap();

        // Fresh rows default OFF (opt-in per epic).
        assert!(!workspaces.get(&parent.id).await.unwrap().autopilot_enabled);

        // Flip it on via update → persists through the SELECT/UPDATE lists.
        let on = workspaces
            .update(
                &parent.id,
                WorkspaceUpdate {
                    autopilot_enabled: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(on.autopilot_enabled);
        assert!(workspaces.get(&parent.id).await.unwrap().autopilot_enabled);

        // And back off again.
        workspaces
            .update(
                &parent.id,
                WorkspaceUpdate {
                    autopilot_enabled: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!workspaces.get(&parent.id).await.unwrap().autopilot_enabled);
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

    // E1-T1: the new `parent_id`/`role` columns round-trip through the
    // insert/get SELECT lists, default NULL on a standalone agent, and persist
    // on a subtask. Locks the column wiring, mirroring
    // `interrupted_at_column_round_trips`.
    #[tokio::test]
    async fn parent_id_and_role_round_trip() {
        let (_repos, workspaces, repo) = fresh().await;

        // A standalone agent leaves both NULL.
        let agent = Workspace::new(repo.id.clone(), "solo".into(), "cmd".into());
        workspaces.insert(&agent).await.unwrap();
        let got = workspaces.get(&agent.id).await.unwrap();
        assert_eq!(got.parent_id, None);
        assert_eq!(got.role, None);

        // A subtask persists parent_id + role through the SELECT/INSERT lists.
        let mut sub = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        sub.workspace_kind = WorkspaceKind::Subtask;
        sub.parent_id = Some("parent-1".into());
        sub.role = Some("backend".into());
        workspaces.insert(&sub).await.unwrap();
        let got = workspaces.get(&sub.id).await.unwrap();
        assert_eq!(got.workspace_kind, WorkspaceKind::Subtask);
        assert_eq!(got.parent_id.as_deref(), Some("parent-1"));
        assert_eq!(got.role.as_deref(), Some("backend"));
    }

    // LANDMINE #2 regression (spec claim #2): the name-dedup guard hard-filters
    // `workspace_kind='agent'`, so a `subtask` row auto-excludes exactly like a
    // `local` row. Subtasks dedup on (parent_id, role) via `find_active_subtask`
    // — NEVER by name — so an active subtask must never be returned by
    // `find_active_by_name`, even sharing a repo + name with a real agent.
    #[tokio::test]
    async fn find_active_by_name_excludes_subtask_rows() {
        let (_repos, workspaces, repo) = fresh().await;

        let mut sub = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        sub.workspace_kind = WorkspaceKind::Subtask;
        sub.parent_id = Some("parent-1".into());
        sub.role = Some("backend".into());
        sub.status = WorkspaceStatus::Running;
        workspaces.insert(&sub).await.unwrap();

        assert!(
            workspaces
                .find_active_by_name(&repo.id, "backend")
                .await
                .unwrap()
                .is_none(),
            "a subtask row must never be matched by the agent name-dedup guard"
        );
    }

    // E1-T2: subtask idempotency keys on (parent_id, role), never name. Two
    // parents each owning a `backend`-role subtask must not hijack each other
    // (the parent-spec #3 landmine), a different role is a different key, and a
    // stopped subtask is no longer active so a re-run mints fresh state.
    #[tokio::test]
    async fn find_active_subtask_keys_on_parent_and_role() {
        let (_repos, workspaces, repo) = fresh().await;

        // Two DIFFERENT parents, each with a `backend`-role subtask.
        let mut a = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        a.workspace_kind = WorkspaceKind::Subtask;
        a.parent_id = Some("parent-a".into());
        a.role = Some("backend".into());
        workspaces.insert(&a).await.unwrap();

        let mut b = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        b.workspace_kind = WorkspaceKind::Subtask;
        b.parent_id = Some("parent-b".into());
        b.role = Some("backend".into());
        workspaces.insert(&b).await.unwrap();

        // Each parent finds only its own backend — neither hijacks the other.
        assert_eq!(
            workspaces
                .find_active_subtask("parent-a", "backend")
                .await
                .unwrap()
                .map(|w| w.id),
            Some(a.id.clone()),
        );
        assert_eq!(
            workspaces
                .find_active_subtask("parent-b", "backend")
                .await
                .unwrap()
                .map(|w| w.id),
            Some(b.id.clone()),
        );

        // A different role under the same parent is a different key → no match.
        assert!(workspaces
            .find_active_subtask("parent-a", "frontend")
            .await
            .unwrap()
            .is_none());

        // A stopped subtask (inserted terminal) is not active → re-run allowed.
        let mut done = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        done.workspace_kind = WorkspaceKind::Subtask;
        done.parent_id = Some("parent-c".into());
        done.role = Some("backend".into());
        done.status = WorkspaceStatus::Stopped;
        workspaces.insert(&done).await.unwrap();
        assert!(
            workspaces
                .find_active_subtask("parent-c", "backend")
                .await
                .unwrap()
                .is_none(),
            "a stopped subtask must not be treated as active"
        );

        // An agent-kind row with a matching name is NOT a subtask → excluded by
        // the kind filter, so it can't masquerade as a subtask dedup hit.
        let agent = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        workspaces.insert(&agent).await.unwrap();
        assert!(workspaces
            .find_active_subtask("parent-a", "backend")
            .await
            .unwrap()
            .map(|w| w.id)
            .is_some_and(|id| id == a.id));
    }

    // E1-T2 leakage guard: the top-level sidebar list excludes parented rows so
    // a `subtask` never shows up as a loose top-level card (spec B6). A
    // standalone agent (parent_id NULL) still lists; a subtask (parent_id set)
    // does not — but `list_all_by_repository` still returns it for teardown.
    #[tokio::test]
    async fn list_by_repository_excludes_parented_rows() {
        let (_repos, workspaces, repo) = fresh().await;

        let agent = Workspace::new(repo.id.clone(), "solo".into(), "cmd".into());
        workspaces.insert(&agent).await.unwrap();

        let mut sub = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        sub.workspace_kind = WorkspaceKind::Subtask;
        sub.parent_id = Some("parent-1".into());
        sub.role = Some("backend".into());
        workspaces.insert(&sub).await.unwrap();

        // Top-level list: agent yes, subtask no.
        let top: Vec<_> = workspaces
            .list_by_repository(&repo.id)
            .await
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert!(top.contains(&agent.id), "a standalone agent still lists");
        assert!(
            !top.contains(&sub.id),
            "a parented subtask must not leak into the flat top-level list"
        );

        // All-rows enumeration (teardown): both are present, so subtask
        // worktrees/PTYs are reachable for cleanup.
        let all: Vec<_> = workspaces
            .list_all_by_repository(&repo.id)
            .await
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert!(all.contains(&agent.id) && all.contains(&sub.id));

        // list_by_parent returns only the given parent's subtasks.
        let kids = workspaces.list_by_parent("parent-1").await.unwrap();
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].id, sub.id);
    }

    // E2-T2: `list_parents` returns ONLY `parent`-kind rows (the scheduler's
    // enumeration), never standalone agents, locals, or subtasks — otherwise
    // the scheduler would try to fan-out a repo it has no DAG for.
    #[tokio::test]
    async fn list_parents_returns_only_parent_kind_rows() {
        let (_repos, workspaces, repo) = fresh().await;

        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert(&parent).await.unwrap();

        let agent = Workspace::new(repo.id.clone(), "solo".into(), "cmd".into());
        workspaces.insert(&agent).await.unwrap();

        let mut local = Workspace::new(repo.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        workspaces.insert(&local).await.unwrap();

        let mut sub = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        sub.workspace_kind = WorkspaceKind::Subtask;
        sub.parent_id = Some(parent.id.clone());
        sub.role = Some("backend".into());
        workspaces.insert(&sub).await.unwrap();

        let parents = workspaces.list_parents().await.unwrap();
        assert_eq!(parents.len(), 1, "only the one parent row is enumerated");
        assert_eq!(parents[0].id, parent.id);
        assert_eq!(parents[0].workspace_kind, WorkspaceKind::Parent);

        // A soft-deleted parent drops out of the enumeration.
        workspaces.delete(&parent.id).await.unwrap();
        assert!(
            workspaces.list_parents().await.unwrap().is_empty(),
            "a soft-deleted parent must not be scheduled"
        );
    }
}
