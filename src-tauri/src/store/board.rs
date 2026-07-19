use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::{Workspace, WorkspaceContract, WorkspaceDependency};

use super::error::StoreError;
use super::pool::Db;
use super::workspaces::{insert_workspace_row, WorkspaceRepo};

/// Everything the board route needs for one `parent` workspace, assembled from
/// three tables (spec §C `BoardState`): the parent row, its child subtasks, the
/// decomposition edges, and the published contracts. It lives at the store
/// layer because it spans `WorkspaceRepo` (the `workspaces` table) and
/// `BoardRepo` (the two DAG tables).
#[derive(Debug, Clone)]
pub struct Board {
    pub parent: Workspace,
    pub subtasks: Vec<Workspace>,
    pub dependencies: Vec<WorkspaceDependency>,
    pub contracts: Vec<WorkspaceContract>,
}

/// Owns the two machine-local DAG tables (`workspace_dependencies`,
/// `workspace_contracts`). Neither carries a `user_id`: the board is
/// machine-local by construction — the `workspace_kind='agent'` sync push
/// filter auto-excludes every `parent`/`subtask` row and, transitively, these
/// edge/contract rows (spec claim #11). Owner scoping therefore flows through
/// the workspace rows (`get_board_for_user`), not through these tables.
#[derive(Clone)]
pub struct BoardRepo {
    db: Db,
}

impl BoardRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    // --- dependency edges ---------------------------------------------------

    pub async fn insert_dependency(&self, dep: &WorkspaceDependency) -> Result<(), StoreError> {
        insert_dependency_row(&self.db, dep).await
    }

    pub async fn list_dependencies(
        &self,
        parent_id: &str,
    ) -> Result<Vec<WorkspaceDependency>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, parent_id, from_subtask_id, to_subtask_id, created_at
             FROM workspace_dependencies
             WHERE parent_id = ?
             ORDER BY created_at ASC",
        )
        .bind(parent_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_dependency).collect()
    }

    // --- contract publications ----------------------------------------------

    pub async fn insert_contract(&self, contract: &WorkspaceContract) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO workspace_contracts
                (id, parent_id, subtask_id, role, contract_path, published_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&contract.id)
        .bind(&contract.parent_id)
        .bind(&contract.subtask_id)
        .bind(&contract.role)
        .bind(&contract.contract_path)
        .bind(contract.published_at.map(|dt| dt.to_rfc3339()))
        .bind(contract.created_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Stamp `published_at` on an existing contract row — the file→DB bridge
    /// firing: the poller detected the contract file and marks the row
    /// published, which is what satisfies a dependent's incoming edge. A strict
    /// `NotFound` if the row is gone.
    pub async fn mark_contract_published(
        &self,
        id: &str,
        published_at: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        let res = sqlx::query("UPDATE workspace_contracts SET published_at = ? WHERE id = ?")
            .bind(published_at.to_rfc3339())
            .bind(id)
            .execute(&self.db)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn list_contracts(
        &self,
        parent_id: &str,
    ) -> Result<Vec<WorkspaceContract>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, parent_id, subtask_id, role, contract_path, published_at, created_at
             FROM workspace_contracts
             WHERE parent_id = ?
             ORDER BY created_at ASC",
        )
        .bind(parent_id)
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_contract).collect()
    }

    /// The contract for one subtask, if any. Backs the scheduler's edge
    /// satisfaction check ("does this predecessor have a published contract
    /// yet?") and its don't-double-insert guard.
    pub async fn find_contract(
        &self,
        subtask_id: &str,
    ) -> Result<Option<WorkspaceContract>, StoreError> {
        let row = sqlx::query(
            "SELECT id, parent_id, subtask_id, role, contract_path, published_at, created_at
             FROM workspace_contracts
             WHERE subtask_id = ?
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(subtask_id)
        .fetch_optional(&self.db)
        .await?;
        row.as_ref().map(row_to_contract).transpose()
    }

    // --- composite write ----------------------------------------------------

    /// Atomically persist a whole decomposition — the parent (integration
    /// container: no PTY, no branch/worktree yet), its subtasks, and the
    /// dependency edges — in ONE transaction. Backs
    /// `commands::board::start_decomposition` (the B2 approval gate). If any
    /// insert fails the transaction rolls back, so a partial write can never
    /// leave an orphan parent/subtask/edge (spec E2-T1 AC: "no orphan rows
    /// remain"). Workspace rows are owner-stamped (`user_id`) so the board is
    /// scoped to the signed-in account; the edge rows are machine-local and
    /// carry no `user_id`, inheriting scoping transitively through the parent
    /// (spec claim #11). Mirrors `RepositoryRepo::delete`'s multi-table
    /// single-transaction shape, and reuses `WorkspaceRepo`'s insert (via the
    /// shared `insert_workspace_row` helper) so the column list stays in one
    /// place. Does NOT spawn agents — that is the scheduler's job (Chunk 3).
    pub async fn create_decomposition(
        &self,
        parent: &Workspace,
        subtasks: &[Workspace],
        dependencies: &[WorkspaceDependency],
        user_id: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut tx = self.db.begin().await?;
        insert_workspace_row(&mut *tx, parent, user_id).await?;
        for subtask in subtasks {
            insert_workspace_row(&mut *tx, subtask, user_id).await?;
        }
        for dependency in dependencies {
            insert_dependency_row(&mut *tx, dependency).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    // --- composite read -----------------------------------------------------

    /// Assemble the whole board for one parent. Workspace rows come from
    /// `WorkspaceRepo` (that repo owns the `workspaces` SQL); the edges and
    /// contracts come from this repo's own tables.
    pub async fn get_board(
        &self,
        workspaces: &WorkspaceRepo,
        parent_id: &str,
    ) -> Result<Board, StoreError> {
        Ok(Board {
            parent: workspaces.get(parent_id).await?,
            subtasks: workspaces.list_by_parent(parent_id).await?,
            dependencies: self.list_dependencies(parent_id).await?,
            contracts: self.list_contracts(parent_id).await?,
        })
    }

    /// Owner-scoped `get_board`: the parent + subtasks are read through the
    /// `_for_user` variants so a different signed-in account can never render
    /// another user's board. The edge/contract rows are reached only via this
    /// parent's ids, so they inherit the same scoping transitively.
    pub async fn get_board_for_user(
        &self,
        workspaces: &WorkspaceRepo,
        parent_id: &str,
        user_id: &str,
    ) -> Result<Board, StoreError> {
        Ok(Board {
            parent: workspaces.get_for_user(parent_id, user_id).await?,
            subtasks: workspaces.list_by_parent_for_user(parent_id, user_id).await?,
            dependencies: self.list_dependencies(parent_id).await?,
            contracts: self.list_contracts(parent_id).await?,
        })
    }
}

/// Bind + execute a single `workspace_dependencies` INSERT against any
/// executor — the pool for `insert_dependency`, or a `&mut Transaction` when
/// the edge is part of the atomic `create_decomposition` write.
async fn insert_dependency_row<'e, E>(
    executor: E,
    dep: &WorkspaceDependency,
) -> Result<(), StoreError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "INSERT INTO workspace_dependencies
            (id, parent_id, from_subtask_id, to_subtask_id, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&dep.id)
    .bind(&dep.parent_id)
    .bind(&dep.from_subtask_id)
    .bind(&dep.to_subtask_id)
    .bind(dep.created_at.to_rfc3339())
    .execute(executor)
    .await?;
    Ok(())
}

fn row_to_dependency(row: &sqlx::sqlite::SqliteRow) -> Result<WorkspaceDependency, StoreError> {
    Ok(WorkspaceDependency {
        id: row.try_get("id")?,
        parent_id: row.try_get("parent_id")?,
        from_subtask_id: row.try_get("from_subtask_id")?,
        to_subtask_id: row.try_get("to_subtask_id")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
    })
}

fn row_to_contract(row: &sqlx::sqlite::SqliteRow) -> Result<WorkspaceContract, StoreError> {
    Ok(WorkspaceContract {
        id: row.try_get("id")?,
        parent_id: row.try_get("parent_id")?,
        subtask_id: row.try_get("subtask_id")?,
        role: row.try_get("role")?,
        contract_path: row.try_get("contract_path")?,
        published_at: parse_optional_timestamp(row.try_get("published_at")?, "published_at")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
    })
}

// Local copies of the timestamp helpers (each store module keeps its own row
// mappers; mirrors `store/workspaces.rs`).
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
    use crate::domain::{Repository, Workspace, WorkspaceKind};
    use crate::store::{init_pool, RepositoryRepo};
    use std::path::PathBuf;

    async fn fresh() -> (WorkspaceRepo, BoardRepo, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool);
        let r = Repository::new("repo".into(), None, None);
        repos.insert(&r).await.unwrap();
        (workspaces, board, r)
    }

    #[tokio::test]
    async fn dependency_round_trips_and_is_parent_scoped() {
        let (_ws, board, _repo) = fresh().await;
        let dep =
            WorkspaceDependency::new("parent-1".into(), "backend-id".into(), "frontend-id".into());
        board.insert_dependency(&dep).await.unwrap();

        let list = board.list_dependencies("parent-1").await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], dep, "the edge round-trips byte-for-byte");

        // A different parent's edge list is empty — the read is parent-scoped.
        assert!(board.list_dependencies("other-parent").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn contract_round_trips_finds_by_subtask_and_marks_published() {
        let (_ws, board, _repo) = fresh().await;
        let contract = WorkspaceContract::new(
            "parent-1".into(),
            "backend-id".into(),
            "backend".into(),
            "/tasks/parent-1/contracts/backend.md".into(),
        );
        // A freshly-minted contract is not yet published.
        assert!(contract.published_at.is_none());
        board.insert_contract(&contract).await.unwrap();

        let found = board
            .find_contract("backend-id")
            .await
            .unwrap()
            .expect("the contract is found by its subtask id");
        assert_eq!(found.id, contract.id);
        assert!(found.published_at.is_none());

        // mark_contract_published stamps published_at (the file→DB bridge).
        let now = Utc::now();
        board.mark_contract_published(&contract.id, now).await.unwrap();
        let after = board.find_contract("backend-id").await.unwrap().unwrap();
        assert_eq!(
            after.published_at.map(|d| d.timestamp_millis()),
            Some(now.timestamp_millis()),
            "published_at must round-trip through the update + SELECT"
        );

        // Reads are parent-scoped.
        assert_eq!(board.list_contracts("parent-1").await.unwrap().len(), 1);
        assert!(board.list_contracts("other-parent").await.unwrap().is_empty());

        // Marking a nonexistent contract is a strict NotFound.
        assert!(matches!(
            board.mark_contract_published("nope", now).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn get_board_assembles_parent_subtasks_edges_and_contracts() {
        let (workspaces, board, repo) = fresh().await;

        // The parent (integration container, no PTY).
        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert(&parent).await.unwrap();

        // Two subtasks under it.
        let mut backend = Workspace::new(repo.id.clone(), "backend".into(), "claude".into());
        backend.workspace_kind = WorkspaceKind::Subtask;
        backend.parent_id = Some(parent.id.clone());
        backend.role = Some("backend".into());
        workspaces.insert(&backend).await.unwrap();

        let mut frontend = Workspace::new(repo.id.clone(), "frontend".into(), "claude".into());
        frontend.workspace_kind = WorkspaceKind::Subtask;
        frontend.parent_id = Some(parent.id.clone());
        frontend.role = Some("frontend".into());
        workspaces.insert(&frontend).await.unwrap();

        // The single edge backend -> frontend, plus backend's published contract.
        let dep = WorkspaceDependency::new(
            parent.id.clone(),
            backend.id.clone(),
            frontend.id.clone(),
        );
        board.insert_dependency(&dep).await.unwrap();
        let contract = WorkspaceContract::new(
            parent.id.clone(),
            backend.id.clone(),
            "backend".into(),
            "/tasks/backend.md".into(),
        );
        board.insert_contract(&contract).await.unwrap();

        let b = board.get_board(&workspaces, &parent.id).await.unwrap();
        assert_eq!(b.parent.id, parent.id);
        assert_eq!(b.parent.workspace_kind, WorkspaceKind::Parent);

        assert_eq!(b.subtasks.len(), 2, "both subtasks are in the board");
        let sub_ids: Vec<_> = b.subtasks.iter().map(|w| w.id.clone()).collect();
        assert!(sub_ids.contains(&backend.id) && sub_ids.contains(&frontend.id));

        assert_eq!(b.dependencies.len(), 1);
        assert_eq!(b.dependencies[0].from_subtask_id, backend.id);
        assert_eq!(b.dependencies[0].to_subtask_id, frontend.id);

        assert_eq!(b.contracts.len(), 1);
        assert_eq!(b.contracts[0].subtask_id, backend.id);
    }

    // E2-T1: the atomic gate write persists the parent + both subtasks + the
    // edge in one transaction, and `get_board` reads the whole thing back.
    #[tokio::test]
    async fn create_decomposition_persists_parent_subtasks_and_edges_atomically() {
        let (workspaces, board, repo) = fresh().await;

        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;

        let mut backend = Workspace::new(repo.id.clone(), "backend".into(), "claude".into());
        backend.workspace_kind = WorkspaceKind::Subtask;
        backend.parent_id = Some(parent.id.clone());
        backend.role = Some("backend".into());

        let mut frontend = Workspace::new(repo.id.clone(), "frontend".into(), "claude".into());
        frontend.workspace_kind = WorkspaceKind::Subtask;
        frontend.parent_id = Some(parent.id.clone());
        frontend.role = Some("frontend".into());

        let edge =
            WorkspaceDependency::new(parent.id.clone(), backend.id.clone(), frontend.id.clone());

        board
            .create_decomposition(
                &parent,
                &[backend.clone(), frontend.clone()],
                std::slice::from_ref(&edge),
                None,
            )
            .await
            .unwrap();

        let b = board.get_board(&workspaces, &parent.id).await.unwrap();
        assert_eq!(b.parent.id, parent.id);
        assert_eq!(b.parent.workspace_kind, WorkspaceKind::Parent);
        assert_eq!(b.subtasks.len(), 2);
        assert_eq!(b.dependencies.len(), 1);
        assert_eq!(b.dependencies[0].from_subtask_id, backend.id);
        assert_eq!(b.dependencies[0].to_subtask_id, frontend.id);
        assert!(b.contracts.is_empty(), "the gate publishes no contracts");
    }

    // E2-T1 AC ("no orphan rows remain"): a failure partway through the write
    // rolls the WHOLE transaction back. We force the SECOND insert to fail with
    // a PRIMARY KEY collision (a subtask reusing the parent's id); the parent
    // inserted first must NOT survive.
    #[tokio::test]
    async fn create_decomposition_rolls_back_on_partial_failure() {
        let (workspaces, board, repo) = fresh().await;

        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;

        let mut collides = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        collides.id = parent.id.clone(); // PK collision → second insert fails
        collides.workspace_kind = WorkspaceKind::Subtask;
        collides.parent_id = Some(parent.id.clone());
        collides.role = Some("backend".into());

        let result = board
            .create_decomposition(&parent, std::slice::from_ref(&collides), &[], None)
            .await;
        assert!(
            result.is_err(),
            "a PK collision mid-transaction must fail the create"
        );

        // The parent inserted first is gone — the transaction rolled back.
        assert!(matches!(
            workspaces.get(&parent.id).await,
            Err(StoreError::NotFound)
        ));
    }
}
