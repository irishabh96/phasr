use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{
    Agent, AgentView, PermissionMode, TaskOutcome, Workspace, WorkspaceKind, WorkspaceStatus,
};

use super::error::StoreError;
use super::pool::Db;

/// Every column `row_to_workspace` reads. A macro rather than a `const` so
/// `concat!` keeps each query a `&'static str`.
macro_rules! workspace_columns {
    () => {
        "id, repository_id, workspace_kind, name, prompt, agent, command, status,
         branch, worktree_path, exit_code,
         created_at, started_at, finished_at, archived_at, updated_at,
         permission_mode, notify_on_attention, last_turn_ended_at,
         base_branch, queued_at, depends_on_workspace_id,
         outcome, outcome_at, merged_into, pr_number, pr_url, pr_state, agent_view"
    };
}

/// SQL for "created but never launched" (drafts and queued tasks) — the
/// same predicate as `Workspace::is_unlaunched`.
macro_rules! unlaunched_sql {
    () => {
        "(workspace_kind = 'agent' AND status = 'pending' AND branch IS NULL)"
    };
}

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
    pub permission_mode: Option<Option<PermissionMode>>,
    pub notify_on_attention: Option<bool>,
    pub base_branch: Option<Option<String>>,
    pub queued_at: Option<Option<DateTime<Utc>>>,
    pub depends_on_workspace_id: Option<Option<String>>,
}

/// What an in-place task writes onto the repository's `local` workspace
/// row when it takes it over. See `WorkspaceRepo::claim_local_for_task`.
#[derive(Debug, Clone)]
pub struct LocalTaskClaim {
    pub agent: Agent,
    pub command: String,
    pub prompt: Option<String>,
    pub permission_mode: PermissionMode,
    pub notify_on_attention: bool,
    pub started_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct WorkspaceRepo {
    db: Db,
}

impl WorkspaceRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Raw pool for tests that simulate writes made outside this repo
    /// (e.g. a sync pull).
    #[cfg(test)]
    pub fn pool(&self) -> &Db {
        &self.db
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
                permission_mode, notify_on_attention,
                base_branch, queued_at, depends_on_workspace_id,
                outcome, outcome_at, merged_into, pr_number, pr_url, pr_state,
                synced_at, dirty, queued_here, agent_view
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
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
        .bind(workspace.permission_mode.map(PermissionMode::as_str))
        .bind(workspace.notify_on_attention as i64)
        .bind(&workspace.base_branch)
        .bind(workspace.queued_at.map(|dt| dt.to_rfc3339()))
        .bind(&workspace.depends_on_workspace_id)
        .bind(workspace.outcome.map(TaskOutcome::as_str))
        .bind(workspace.outcome_at.map(|dt| dt.to_rfc3339()))
        .bind(&workspace.merged_into)
        .bind(workspace.pr_number)
        .bind(&workspace.pr_url)
        .bind(&workspace.pr_state)
        .bind(dirty)
        // Created on this machine: if it's queued, it was queued HERE.
        .bind(workspace.queued_at.is_some() as i64)
        .bind(workspace.agent_view.map(AgentView::as_str))
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn list_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE repository_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        ))
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
        let rows = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE repository_id = ? AND user_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        ))
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
        let rows = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE status = ? AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        ))
        .bind(status.as_str())
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Workspace, StoreError> {
        let row = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE id = ? AND deleted_at IS NULL",
        ))
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
        let row = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        ))
        .bind(id)
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_workspace)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }

    /// Every on-disk path the user's live workspaces point at (task
    /// worktrees and `local` checkouts). The allow-list for the absolute-
    /// path file commands, so they can't read outside registered roots.
    pub async fn worktree_paths_for_user(&self, user_id: &str) -> Result<Vec<String>, StoreError> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT worktree_path FROM workspaces
             WHERE user_id = ? AND deleted_at IS NULL AND worktree_path IS NOT NULL",
        )
        .bind(user_id)
        .fetch_all(&self.db)
        .await?)
    }

    pub async fn get_local_by_repository(
        &self,
        repository_id: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE repository_id = ? AND workspace_kind = 'local' AND deleted_at IS NULL
             LIMIT 1",
        ))
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
    /// the first ends still creates fresh state. Drafts and queued tasks
    /// (never launched) don't count either: a same-named draft must not
    /// turn a "Start task" into a no-op that returns the draft.
    pub async fn find_active_by_name(
        &self,
        repository_id: &str,
        name: &str,
    ) -> Result<Option<Workspace>, StoreError> {
        let row = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE repository_id = ? AND name = ? AND workspace_kind = 'agent'
               AND status IN ('pending', 'running') AND deleted_at IS NULL
               AND NOT ",
            unlaunched_sql!(),
            "
             ORDER BY created_at DESC
             LIMIT 1",
        ))
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
        let row = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE repository_id = ? AND name = ? AND user_id = ? AND workspace_kind = 'agent'
               AND status IN ('pending', 'running') AND deleted_at IS NULL
               AND NOT ",
            unlaunched_sql!(),
            "
             ORDER BY created_at DESC
             LIMIT 1",
        ))
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
        if let Some(permission_mode) = patch.permission_mode {
            current.permission_mode = permission_mode;
        }
        if let Some(notify_on_attention) = patch.notify_on_attention {
            current.notify_on_attention = notify_on_attention;
        }
        if let Some(base_branch) = patch.base_branch {
            current.base_branch = base_branch;
        }
        // Queueing / unqueueing through this repo is always this machine
        // acting (sync writes its own SQL), so it moves the local marker.
        let queued_here = patch.queued_at.map(|q| q.is_some() as i64);
        if let Some(queued_at) = patch.queued_at {
            current.queued_at = queued_at;
        }
        if let Some(depends_on) = patch.depends_on_workspace_id {
            current.depends_on_workspace_id = depends_on;
        }
        current.updated_at = Utc::now();

        sqlx::query(
            "UPDATE workspaces SET
                name = ?, prompt = ?, agent = ?, command = ?, status = ?,
                branch = ?, worktree_path = ?, exit_code = ?,
                started_at = ?, finished_at = ?, archived_at = ?, updated_at = ?,
                permission_mode = ?, notify_on_attention = ?,
                base_branch = ?, queued_at = ?, depends_on_workspace_id = ?,
                queued_here = COALESCE(?, queued_here),
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
        .bind(current.permission_mode.map(PermissionMode::as_str))
        .bind(current.notify_on_attention as i64)
        .bind(&current.base_branch)
        .bind(current.queued_at.map(|dt| dt.to_rfc3339()))
        .bind(&current.depends_on_workspace_id)
        .bind(queued_here)
        .bind(id)
        .execute(&self.db)
        .await?;

        Ok(current)
    }

    /// Every agent task (never `local` rows), newest first — one repository
    /// or all of them. Unscoped: the sessionless test/scheduler path. Commands
    /// use `list_tasks_for_user`.
    pub async fn list_tasks(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<Workspace>, StoreError> {
        self.list_tasks_scoped(None, repository_id).await
    }

    /// Owner-scoped `list_tasks`.
    pub async fn list_tasks_for_user(
        &self,
        user_id: &str,
        repository_id: Option<&str>,
    ) -> Result<Vec<Workspace>, StoreError> {
        self.list_tasks_scoped(Some(user_id), repository_id).await
    }

    async fn list_tasks_scoped(
        &self,
        user_id: Option<&str>,
        repository_id: Option<&str>,
    ) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE workspace_kind = 'agent' AND deleted_at IS NULL
               AND (? IS NULL OR user_id = ?)
               AND (? IS NULL OR repository_id = ?)
             ORDER BY created_at DESC",
        ))
        .bind(user_id)
        .bind(user_id)
        .bind(repository_id)
        .bind(repository_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// `list_tasks` for the Board, with finished tasks (an outcome, or
    /// archived) limited to those that finished at or after `since` plus
    /// the `recent` most recently finished. Unfinished tasks always come
    /// back. Every board refetch serializes every row it returns, and a
    /// long-lived install accumulates hundreds of merged/archived tasks
    /// that no lane shows. `user_id: None` = every owner (tests).
    pub async fn list_board_tasks(
        &self,
        user_id: Option<&str>,
        repository_id: Option<&str>,
        since: DateTime<Utc>,
        recent: i64,
    ) -> Result<Vec<Workspace>, StoreError> {
        // Timestamps are RFC 3339 UTC text, so text order is time order.
        let rows = sqlx::query(concat!(
            "SELECT * FROM (
                 SELECT ",
            workspace_columns!(),
            ",
                     CASE WHEN outcome IS NOT NULL OR status = 'archived' THEN
                         ROW_NUMBER() OVER (
                             PARTITION BY (outcome IS NOT NULL OR status = 'archived')
                             ORDER BY COALESCE(outcome_at, archived_at, finished_at, updated_at) DESC)
                     END AS finished_rank,
                     COALESCE(outcome_at, archived_at, finished_at, updated_at) AS finished_key
                 FROM workspaces
                 WHERE workspace_kind = 'agent' AND deleted_at IS NULL
                   AND (? IS NULL OR user_id = ?)
                   AND (? IS NULL OR repository_id = ?)
             )
             WHERE finished_rank IS NULL OR finished_rank <= ? OR finished_key >= ?
             ORDER BY created_at DESC",
        ))
        .bind(user_id)
        .bind(user_id)
        .bind(repository_id)
        .bind(repository_id)
        .bind(recent)
        .bind(since.to_rfc3339())
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Queued (never-launched) tasks QUEUED ON THIS MACHINE, oldest in the
    /// queue first — the scheduler's work list. A row queued on another
    /// machine (synced here) is excluded: it shows as queued on the board
    /// but only its own machine starts it. `user_id: None` = every owner
    /// (tests).
    pub async fn list_queued(&self, user_id: Option<&str>) -> Result<Vec<Workspace>, StoreError> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            workspace_columns!(),
            "
             FROM workspaces
             WHERE ",
            unlaunched_sql!(),
            " AND queued_at IS NOT NULL AND queued_here = 1 AND deleted_at IS NULL
               AND (? IS NULL OR user_id = ?)
             ORDER BY queued_at ASC",
        ))
        .bind(user_id)
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Record how a task ended (`None` reopens it). Synced: bumps
    /// `updated_at` and marks the row dirty.
    pub async fn set_outcome(
        &self,
        id: &str,
        outcome: Option<TaskOutcome>,
        merged_into: Option<&str>,
    ) -> Result<Workspace, StoreError> {
        let now = Utc::now();
        let res = sqlx::query(
            "UPDATE workspaces SET outcome = ?, outcome_at = ?, merged_into = ?, updated_at = ?,
                dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(outcome.map(TaskOutcome::as_str))
        .bind(outcome.map(|_| now.to_rfc3339()))
        .bind(merged_into)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        self.get(id).await
    }

    /// `set_outcome`, but only while the task has NO outcome — for the
    /// paths that infer it in the background (a PR seen merged/closed, a
    /// continued merge). They read the row, then wait on `gh` / git; a
    /// Discard (Closed) or a local merge recorded meanwhile must not be
    /// overwritten. `None` = already had one (nothing changed).
    pub async fn set_outcome_if_unset(
        &self,
        id: &str,
        outcome: TaskOutcome,
        merged_into: Option<&str>,
    ) -> Result<Option<Workspace>, StoreError> {
        let now = Utc::now();
        let res = sqlx::query(
            "UPDATE workspaces SET outcome = ?, outcome_at = ?, merged_into = ?, updated_at = ?,
                dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
             WHERE id = ? AND deleted_at IS NULL AND outcome IS NULL",
        )
        .bind(outcome.as_str())
        .bind(now.to_rfc3339())
        .bind(merged_into)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Ok(None);
        }
        self.get(id).await.map(Some)
    }

    /// Record the task's pull request (`pr_state`: `open` | `draft` |
    /// `merged` | `closed`). `number` is `None` when only a URL is known.
    /// Synced: bumps `updated_at` and marks the row dirty.
    pub async fn set_pull_request(
        &self,
        id: &str,
        number: Option<i64>,
        url: Option<&str>,
        state: Option<&str>,
    ) -> Result<Workspace, StoreError> {
        let res = sqlx::query(
            "UPDATE workspaces SET pr_number = ?, pr_url = ?, pr_state = ?, updated_at = ?,
                dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(number)
        .bind(url)
        .bind(state)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        self.get(id).await
    }

    /// Point the repository's `local` workspace at an in-place agent run:
    /// record the agent/command/prompt/mode and flip it to `running`.
    ///
    /// Deliberately bypasses `WorkspaceStatus::can_transition_to`. That
    /// state machine models a one-shot agent task (`completed` is terminal),
    /// but the local row is a long-lived slot for the repository's own
    /// checkout whose terminal comes and goes — a shell that exited 0 left
    /// it `completed`, and an in-place run must still be able to take it
    /// over. Scoped to `workspace_kind = 'local'` so it can never be used to
    /// resurrect a finished agent task. Stays `dirty = 0`: local rows are
    /// never synced.
    pub async fn claim_local_for_task(
        &self,
        id: &str,
        claim: LocalTaskClaim,
    ) -> Result<Workspace, StoreError> {
        let res = sqlx::query(
            "UPDATE workspaces SET
                agent = ?, command = ?, prompt = ?,
                permission_mode = ?, notify_on_attention = ?,
                status = 'running', exit_code = NULL,
                started_at = ?, finished_at = NULL, updated_at = ?,
                dirty = 0
             WHERE id = ? AND workspace_kind = 'local' AND deleted_at IS NULL",
        )
        .bind(claim.agent.as_str())
        .bind(&claim.command)
        .bind(&claim.prompt)
        .bind(claim.permission_mode.as_str())
        .bind(claim.notify_on_attention as i64)
        .bind(claim.started_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        self.get(id).await
    }

    /// Record the agent CLI's own session id so a later resume continues
    /// that conversation. Local-only on purpose: it touches neither
    /// `updated_at` nor `dirty`, so it never makes the row push — a session
    /// exists only in this machine's agent state.
    pub async fn set_agent_session_id(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<(), StoreError> {
        let res = sqlx::query(
            "UPDATE workspaces SET agent_session_id = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(session_id)
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Switch the task between the transcript and the terminal view on this
    /// machine. Local-only like the session id: no `updated_at`, no `dirty`.
    pub async fn set_agent_view(
        &self,
        id: &str,
        view: Option<AgentView>,
    ) -> Result<(), StoreError> {
        let res = sqlx::query(
            "UPDATE workspaces SET agent_view = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(view.map(AgentView::as_str))
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn get_agent_session_id(&self, id: &str) -> Result<Option<String>, StoreError> {
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT agent_session_id FROM workspaces WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;
        row.map(|(session,)| session).ok_or(StoreError::NotFound)
    }

    /// Stamp the end of an agent turn. Unlike the session id this IS synced,
    /// so it bumps `updated_at` (last-write-wins needs it to travel) and marks
    /// agent rows dirty; `local` rows never sync.
    pub async fn set_last_turn_ended_at(
        &self,
        id: &str,
        at: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        let res = sqlx::query(
            "UPDATE workspaces SET last_turn_ended_at = ?, updated_at = ?,
                dirty = CASE WHEN workspace_kind = 'local' THEN 0 ELSE 1 END
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
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
    // Lenient on purpose: an unknown mode string (written by a newer build
    // or another device) reads as "unknown" rather than making the whole
    // workspace list fail to load. The launch command is already baked
    // into `command`, so nothing here depends on parsing it.
    let permission_mode = row
        .try_get::<Option<String>, _>("permission_mode")?
        .and_then(|s| PermissionMode::from_str(&s));

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
        permission_mode,
        notify_on_attention: row.try_get::<i64, _>("notify_on_attention")? != 0,
        last_turn_ended_at: parse_optional_timestamp(
            row.try_get("last_turn_ended_at")?,
            "last_turn_ended_at",
        )?,
        base_branch: row.try_get("base_branch")?,
        queued_at: parse_optional_timestamp(row.try_get("queued_at")?, "queued_at")?,
        depends_on_workspace_id: row.try_get("depends_on_workspace_id")?,
        // Lenient like `permission_mode`: an outcome a newer build wrote
        // reads as "open" rather than failing the whole list.
        outcome: row
            .try_get::<Option<String>, _>("outcome")?
            .and_then(|s| TaskOutcome::from_str(&s)),
        outcome_at: parse_optional_timestamp(row.try_get("outcome_at")?, "outcome_at")?,
        merged_into: row.try_get("merged_into")?,
        pr_number: row.try_get("pr_number")?,
        pr_url: row.try_get("pr_url")?,
        pr_state: row.try_get("pr_state")?,
        // Lenient: a view a newer build wrote reads as terminal.
        agent_view: row
            .try_get::<Option<String>, _>("agent_view")?
            .and_then(|s| AgentView::from_str(&s)),
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

    /// The view is this machine's: it round-trips through every read, and
    /// switching it neither bumps `updated_at` nor marks the row dirty (so
    /// it never makes the row push).
    #[tokio::test]
    async fn agent_view_is_stored_but_never_marks_the_row_for_sync() {
        let (_, repo, r) = fresh().await;
        let mut ws = Workspace::new(r.id.clone(), "t".into(), "claude".into());
        ws.agent = Some(Agent::Claude);
        ws.agent_view = Some(AgentView::Transcript);
        repo.insert(&ws).await.unwrap();
        assert_eq!(repo.get(&ws.id).await.unwrap().agent_view, Some(AgentView::Transcript));
        sqlx::query("UPDATE workspaces SET dirty = 0 WHERE id = ?")
            .bind(&ws.id)
            .execute(repo.pool())
            .await
            .unwrap();
        let before = repo.get(&ws.id).await.unwrap().updated_at;

        repo.set_agent_view(&ws.id, Some(AgentView::Terminal)).await.unwrap();
        let read = repo.get(&ws.id).await.unwrap();
        assert_eq!(read.agent_view, Some(AgentView::Terminal));
        assert_eq!(read.updated_at, before);
        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = ?")
            .bind(&ws.id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
        assert_eq!(dirty, 0);

        // An unknown value (a newer build) reads as terminal, not an error.
        sqlx::query("UPDATE workspaces SET agent_view = 'hologram' WHERE id = ?")
            .bind(&ws.id)
            .execute(repo.pool())
            .await
            .unwrap();
        assert_eq!(repo.get(&ws.id).await.unwrap().agent_view, None);
        assert!(matches!(
            repo.set_agent_view("missing", None).await,
            Err(StoreError::NotFound)
        ));
    }

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

        // A pending agent task mid-launch is ACTIVE → found. (start_task
        // cuts the branch before inserting; a pending row WITHOUT one is a
        // draft — see `find_active_by_name_ignores_drafts_and_queued_tasks`.)
        let mut alpha = Workspace::new(repo.id.clone(), "alpha".into(), "cmd".into());
        alpha.branch = Some("phasr/alpha".into());
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

    // A draft or queued task (pending, never launched) is not "active": a
    // same-named draft must not turn a start into a no-op returning it.
    #[tokio::test]
    async fn find_active_by_name_ignores_drafts_and_queued_tasks() {
        let (_repos, workspaces, repo) = fresh().await;
        let draft = Workspace::new(repo.id.clone(), "same".into(), "cmd".into());
        workspaces.insert(&draft).await.unwrap();
        let mut queued = Workspace::new(repo.id.clone(), "same".into(), "cmd".into());
        queued.queued_at = Some(Utc::now());
        workspaces.insert(&queued).await.unwrap();
        assert!(workspaces.find_active_by_name(&repo.id, "same").await.unwrap().is_none());

        // A launched (branch cut) pending row still counts.
        let mut launching = Workspace::new(repo.id.clone(), "same".into(), "cmd".into());
        launching.branch = Some("phasr/same".into());
        workspaces.insert(&launching).await.unwrap();
        assert_eq!(
            workspaces
                .find_active_by_name(&repo.id, "same")
                .await
                .unwrap()
                .map(|w| w.id),
            Some(launching.id)
        );

        // The queue's work list: queued only, oldest first.
        let listed = workspaces.list_queued(None).await.unwrap();
        assert_eq!(listed.iter().map(|w| &w.id).collect::<Vec<_>>(), vec![&queued.id]);
    }

    #[tokio::test]
    async fn board_columns_round_trip_and_outcome_is_settable() {
        let (_r, workspaces, repo) = fresh().await;
        let mut ws = Workspace::new(repo.id.clone(), "t".into(), "c".into());
        ws.base_branch = Some("develop".into());
        ws.depends_on_workspace_id = Some("other".into());
        ws.pr_number = Some(142);
        ws.pr_url = Some("https://example.com/pr/142".into());
        ws.pr_state = Some("open".into());
        workspaces.insert(&ws).await.unwrap();
        let read = workspaces.get(&ws.id).await.unwrap();
        assert_eq!(read.base_branch.as_deref(), Some("develop"));
        assert_eq!(read.depends_on_workspace_id.as_deref(), Some("other"));
        assert_eq!((read.pr_number, read.pr_state.as_deref()), (Some(142), Some("open")));
        assert_eq!(read.outcome, None);

        // The conditional variant (PR refresh): a Discard that landed first
        // (Closed) is not overwritten with Merged.
        workspaces.set_outcome(&ws.id, Some(TaskOutcome::Closed), None).await.unwrap();
        assert!(workspaces
            .set_outcome_if_unset(&ws.id, TaskOutcome::Merged, Some("main"))
            .await
            .unwrap()
            .is_none());
        assert_eq!(workspaces.get(&ws.id).await.unwrap().outcome, Some(TaskOutcome::Closed));
        workspaces.set_outcome(&ws.id, None, None).await.unwrap();
        let set = workspaces
            .set_outcome_if_unset(&ws.id, TaskOutcome::Merged, Some("develop"))
            .await
            .unwrap()
            .expect("unset → recorded");
        assert_eq!((set.outcome, set.merged_into.as_deref()), (Some(TaskOutcome::Merged), Some("develop")));

        let merged = workspaces
            .set_outcome(&ws.id, Some(TaskOutcome::Merged), Some("main"))
            .await
            .unwrap();
        assert_eq!(merged.outcome, Some(TaskOutcome::Merged));
        assert_eq!(merged.merged_into.as_deref(), Some("main"));
        assert!(merged.outcome_at.is_some());
        // Unknown outcomes (a newer build) read as open, not as an error.
        sqlx::query("UPDATE workspaces SET outcome = 'shipped' WHERE id = ?")
            .bind(&ws.id)
            .execute(&workspaces.db)
            .await
            .unwrap();
        assert_eq!(workspaces.get(&ws.id).await.unwrap().outcome, None);

        // Updates can set and clear the queue fields.
        let updated = workspaces
            .update(
                &ws.id,
                WorkspaceUpdate {
                    queued_at: Some(Some(Utc::now())),
                    depends_on_workspace_id: Some(None),
                    base_branch: Some(Some("main".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(updated.queued_at.is_some());
        assert_eq!(updated.depends_on_workspace_id, None);
        assert_eq!(updated.base_branch.as_deref(), Some("main"));
        assert_eq!(workspaces.list_tasks(Some(&repo.id)).await.unwrap().len(), 1);
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

        // Identical (repository_id, name), two different owners, both
        // launched (branch cut) so neither is a draft.
        let mut a = Workspace::new(repo.id.clone(), "shared".into(), "cmd".into());
        a.branch = Some("phasr/shared-a".into());
        workspaces.insert_for_user(&a, "user-a").await.unwrap();
        let mut b = Workspace::new(repo.id.clone(), "shared".into(), "cmd".into());
        b.branch = Some("phasr/shared-b".into());
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

    /// The lookup every workspace-keyed command (git, PTY, update, archive,
    /// delete, PR) now goes through: another account's workspace id is
    /// `NotFound`, as is a soft-deleted one.
    #[tokio::test]
    async fn get_for_user_hides_another_owners_workspace() {
        let (_repos, workspaces, repo) = fresh().await;
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
        let a = Workspace::new(repo.id.clone(), "a".into(), "cmd".into());
        workspaces.insert_for_user(&a, "user-a").await.unwrap();

        assert_eq!(
            workspaces.get_for_user(&a.id, "user-a").await.unwrap().id,
            a.id
        );
        assert!(matches!(
            workspaces.get_for_user(&a.id, "user-b").await,
            Err(StoreError::NotFound)
        ));

        workspaces.delete(&a.id).await.unwrap();
        assert!(matches!(
            workspaces.get_for_user(&a.id, "user-a").await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn permission_mode_and_notify_round_trip_and_update() {
        let (_r, workspaces, repo) = fresh().await;
        let legacy = Workspace::new(repo.id.clone(), "legacy".into(), "c".into());
        workspaces.insert(&legacy).await.unwrap();
        let read = workspaces.get(&legacy.id).await.unwrap();
        assert_eq!(read.permission_mode, None, "pre-0015 semantics: NULL");
        assert!(read.notify_on_attention);

        let updated = workspaces
            .update(
                &legacy.id,
                WorkspaceUpdate {
                    permission_mode: Some(Some(PermissionMode::AskEdits)),
                    notify_on_attention: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.permission_mode, Some(PermissionMode::AskEdits));
        let reread = workspaces.get(&legacy.id).await.unwrap();
        assert_eq!(reread.permission_mode, Some(PermissionMode::AskEdits));
        assert!(!reread.notify_on_attention);

        // An unrelated update leaves them alone.
        workspaces
            .update(
                &legacy.id,
                WorkspaceUpdate {
                    name: Some("renamed".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let reread = workspaces.get(&legacy.id).await.unwrap();
        assert_eq!(reread.permission_mode, Some(PermissionMode::AskEdits));
    }

    #[tokio::test]
    async fn unknown_permission_mode_reads_as_none_instead_of_failing() {
        let (_r, workspaces, repo) = fresh().await;
        let ws = Workspace::new(repo.id.clone(), "w".into(), "c".into());
        workspaces.insert(&ws).await.unwrap();
        sqlx::query("UPDATE workspaces SET permission_mode = 'from-the-future' WHERE id = ?")
            .bind(&ws.id)
            .execute(&workspaces.db)
            .await
            .unwrap();
        let listed = workspaces.list_by_repository(&repo.id).await.unwrap();
        assert_eq!(listed[0].permission_mode, None);
    }

    #[tokio::test]
    async fn claim_local_for_task_only_touches_local_rows() {
        let (_r, workspaces, repo) = fresh().await;
        let agent_row = Workspace::new(repo.id.clone(), "task".into(), "c".into());
        workspaces.insert(&agent_row).await.unwrap();
        let claim = || LocalTaskClaim {
            agent: Agent::Codex,
            command: "codex".into(),
            prompt: Some("p".into()),
            permission_mode: PermissionMode::AskShell,
            notify_on_attention: false,
            started_at: Utc::now(),
        };
        assert!(matches!(
            workspaces.claim_local_for_task(&agent_row.id, claim()).await,
            Err(StoreError::NotFound)
        ));

        let mut local = Workspace::new(repo.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        local.status = WorkspaceStatus::Completed;
        local.exit_code = Some(0);
        workspaces.insert(&local).await.unwrap();
        let claimed = workspaces.claim_local_for_task(&local.id, claim()).await.unwrap();
        assert_eq!(claimed.status, WorkspaceStatus::Running);
        assert_eq!(claimed.exit_code, None);
        assert_eq!(claimed.agent, Some(Agent::Codex));
        assert_eq!(claimed.command, "codex");
        assert_eq!(claimed.permission_mode, Some(PermissionMode::AskShell));
        assert!(!claimed.notify_on_attention);
        assert_eq!(claimed.name, "local", "the slot keeps its identity");
    }
}
