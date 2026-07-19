//! Task-board command surface (multi-agent decomposition, P0 slice).
//!
//! Two thin `#[tauri::command]` handlers:
//!   - `start_decomposition` — the B2 approval gate. Atomically writes a
//!     `parent` + its `subtask` rows + the dependency edge(s) and returns the
//!     assembled `BoardState`. It does NOT spawn any agent: the gate only
//!     creates the DAG; the scheduler (Chunk 3) spawns ready subtasks later.
//!   - `get_board` — reads one parent's board back, owner-scoped.
//!
//! Both delegate straight down to `BoardRepo` + `WorkspaceRepo`; board/DAG
//! state stays OUT of `WorkspaceStatus` (spec claim #10) — "blocked" is derived
//! frontend-side from edges × contracts, never stored.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::{Agent, Workspace, WorkspaceContract, WorkspaceDependency, WorkspaceKind};
use crate::orchestrator::RepoLockRegistry;
use crate::store::{Board, BoardRepo, StoreError, WorkspaceRepo};
use crate::sync::CloudSyncState;

// ── request / response shapes (the frozen §C wire contract) ─────────────────

/// The approved decomposition plan. The draft lives entirely in the frontend
/// form until "Start N agents"; nothing is persisted before this call (B2).
/// Topology is supplied generically (N subtasks, M edges) — the store + gate
/// are written generically and only exercised on the fixed `backend → frontend`
/// PoC shape (spec §G). NOTE: no `parentId` field — the parent id is minted
/// server-side per call (see the dedup note on `start_decomposition`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompositionInput {
    pub repository_id: String,
    pub parent_prompt: String,
    pub subtasks: Vec<SubtaskInput>,
    pub edges: Vec<EdgeInput>,
}

/// One planned subtask: its DAG slot (`role`, also the dedup key with
/// `parent_id`), the agent to run, and its seed prompt.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskInput {
    pub role: String,
    pub agent: Agent,
    pub prompt: String,
}

/// One directed edge, addressed by role. Resolved to concrete subtask ids at
/// write time (`backend → frontend` for the PoC).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeInput {
    pub from_role: String,
    pub to_role: String,
}

/// Everything the board route renders. A command-layer DTO over `store::Board`;
/// its fields are domain types that already serialize camelCase. `contracts`
/// carries `publishedAt`, which drives the frontend "blocked" derivation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardState {
    pub parent: Workspace,
    pub subtasks: Vec<Workspace>,
    pub dependencies: Vec<WorkspaceDependency>,
    pub contracts: Vec<WorkspaceContract>,
}

impl From<Board> for BoardState {
    fn from(board: Board) -> Self {
        Self {
            parent: board.parent,
            subtasks: board.subtasks,
            dependencies: board.dependencies,
            contracts: board.contracts,
        }
    }
}

// ── error ───────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum BoardCmdError {
    Store(StoreError),
    Auth(AuthError),
    /// A malformed plan (empty, duplicate roles, an edge referencing an unknown
    /// role, or a self-edge). A clear error beats silently persisting a broken
    /// DAG the scheduler could deadlock on.
    InvalidDecomposition(String),
}

impl From<StoreError> for BoardCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for BoardCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for BoardCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::InvalidDecomposition(msg) => write!(f, "invalid decomposition: {msg}"),
        }
    }
}

impl serde::Serialize for BoardCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// The B2 approval gate. Atomically persists a `parent` + its `subtask` rows +
/// the dependency edge(s) under the per-repo lock, then returns the board.
/// **Spawns nothing** — the scheduler (Chunk 3) mints worktrees/PTYs for ready
/// subtasks on its own tick, which is what decouples the gate from fan-out.
///
/// Dedup: `DecompositionInput` carries no `parentId`, so a re-submit mints a
/// FRESH independent parent (mirrors `start_task`'s "a deliberate re-run makes
/// fresh state"). There is no stable server-side key to dedup two submissions
/// against — `find_active_subtask(parent_id, role)` (Chunk 1) is the
/// scheduler's duplicate-tick guard where the parent id IS stable, not a gate
/// guard. The frontend's submit-button re-entrancy guard (the same D1 client
/// guard `start_task` relies on) is the accidental-double-click defense. What
/// the gate DOES enforce is well-formedness (`validate_decomposition`): a
/// malformed plan is a clear `InvalidDecomposition`, never a broken DAG.
#[tauri::command]
pub async fn start_decomposition(
    input: DecompositionInput,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<BoardState, BoardCmdError> {
    // Owner-scoped: parent + subtasks are stamped with this user so the board
    // can only ever be read back by the same account (`_for_user`).
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;

    // Serialize the atomic create against the shared per-repo lock, mirroring
    // start_task, so a concurrent create/start/delete on this repo can't
    // interleave with the parent+subtask+edge write. (The write is itself a
    // single DB transaction, so the lock is about ordering vs. OTHER repo
    // git/DB mutations, not intra-write atomicity.)
    let lock = repo_locks.for_repository(&input.repository_id);
    let guard = lock.lock().await;
    let assembled = create_decomposition_inner(&input, &current.user_id, &workspaces, &board).await;
    drop(guard);

    let assembled = assembled?;

    // The `workspaces` table is syncable, so honor the request-sync convention.
    // Parent/subtask rows are auto-excluded from the `workspace_kind = 'agent'`
    // push filter (spec claim #11), so this is a no-op for the board and keeps
    // it machine-local by construction — but we stay consistent with the sibling
    // workspace-mutating commands (create_workspace / start_task).
    sync_state.request_sync();

    Ok(assembled.into())
}

/// Read one parent's board back, owner-scoped. Thin wrapper over
/// `BoardRepo::get_board_for_user`.
#[tauri::command]
pub async fn get_board(
    parent_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<BoardState, BoardCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let assembled = board
        .get_board_for_user(&workspaces, &parent_id, &current.user_id)
        .await?;
    Ok(assembled.into())
}

// ── internals (testable without Tauri `State`) ──────────────────────────────

/// The gate's orchestration, minus session/lock/sync wiring, so it can be
/// exercised directly against real repos in tests. Validates, builds the rows,
/// writes them atomically, and reads the board back owner-scoped.
async fn create_decomposition_inner(
    input: &DecompositionInput,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
) -> Result<Board, BoardCmdError> {
    // Reject a malformed plan BEFORE any write, so nothing is persisted for a
    // bad input (the "no orphan rows" AC holds for invalid plans too).
    validate_decomposition(input)?;

    // 1. Parent = the integration container: kind=Parent, status=Pending
    //    (Workspace::new default), NO agent, NO branch/worktree, NO PTY. It
    //    gets a branch/worktree only at integration (Chunk 4, spec B1).
    let mut parent = Workspace::new(
        input.repository_id.clone(),
        parent_title(&input.parent_prompt),
        String::new(),
    );
    parent.workspace_kind = WorkspaceKind::Parent;
    parent.prompt = non_empty_prompt(&input.parent_prompt);

    // 2. Subtasks = real agents, but NOT spawned here (the scheduler does that
    //    in Chunk 3). kind=Subtask, status=Pending, parent_id + role + agent
    //    set. No branch/worktree yet — minting those is the scheduler's job.
    let mut subtasks = Vec::with_capacity(input.subtasks.len());
    let mut role_to_id: HashMap<&str, String> = HashMap::new();
    for planned in &input.subtasks {
        let mut subtask = Workspace::new(
            input.repository_id.clone(),
            planned.role.clone(),
            planned.agent.command().to_string(),
        );
        subtask.workspace_kind = WorkspaceKind::Subtask;
        subtask.parent_id = Some(parent.id.clone());
        subtask.role = Some(planned.role.clone());
        subtask.agent = Some(planned.agent);
        subtask.prompt = non_empty_prompt(&planned.prompt);
        role_to_id.insert(planned.role.as_str(), subtask.id.clone());
        subtasks.push(subtask);
    }

    // 3. Edges resolve role → freshly-minted subtask id (validated present
    //    above; the `ok_or_else` keeps this panic-free rather than `expect`).
    let mut dependencies = Vec::with_capacity(input.edges.len());
    for edge in &input.edges {
        let from = role_to_id
            .get(edge.from_role.as_str())
            .cloned()
            .ok_or_else(|| {
                BoardCmdError::InvalidDecomposition(format!(
                    "edge references unknown from-role `{}`",
                    edge.from_role
                ))
            })?;
        let to = role_to_id
            .get(edge.to_role.as_str())
            .cloned()
            .ok_or_else(|| {
                BoardCmdError::InvalidDecomposition(format!(
                    "edge references unknown to-role `{}`",
                    edge.to_role
                ))
            })?;
        dependencies.push(WorkspaceDependency::new(parent.id.clone(), from, to));
    }

    // 4. Atomic write — parent + subtasks + edges in one transaction. NO spawn.
    board
        .create_decomposition(&parent, &subtasks, &dependencies, Some(user_id))
        .await?;

    // Return the assembled board, owner-scoped, so the caller renders the same
    // shape `get_board` returns.
    Ok(board.get_board_for_user(workspaces, &parent.id, user_id).await?)
}

/// Well-formedness check for the decomposition DAG. Enforces role uniqueness
/// (the `(parent_id, role)` invariant, checked in-memory because the gate mints
/// a fresh parent id so a DB `find_active_subtask` lookup can't help), edge
/// referential integrity, and no self-edges. Kept generic (no hardcoded
/// backend/frontend topology) per spec §G — the fixed PoC shape is enforced by
/// the frontend form, not the command.
fn validate_decomposition(input: &DecompositionInput) -> Result<(), BoardCmdError> {
    if input.subtasks.is_empty() {
        return Err(BoardCmdError::InvalidDecomposition(
            "a decomposition needs at least one subtask".into(),
        ));
    }
    let mut roles = HashSet::new();
    for subtask in &input.subtasks {
        if subtask.role.trim().is_empty() {
            return Err(BoardCmdError::InvalidDecomposition(
                "every subtask needs a non-empty role".into(),
            ));
        }
        if !roles.insert(subtask.role.as_str()) {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "duplicate subtask role `{}`",
                subtask.role
            )));
        }
    }
    for edge in &input.edges {
        if edge.from_role == edge.to_role {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "self-edge on role `{}`",
                edge.from_role
            )));
        }
        if !roles.contains(edge.from_role.as_str()) {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "edge references unknown from-role `{}`",
                edge.from_role
            )));
        }
        if !roles.contains(edge.to_role.as_str()) {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "edge references unknown to-role `{}`",
                edge.to_role
            )));
        }
    }
    Ok(())
}

/// A short, display-only title for the parent card, from the first non-empty
/// line of the approved prompt (truncated). The parent is an integration
/// container with no agent of its own, so its `name` is never a dedup key.
fn parent_title(parent_prompt: &str) -> String {
    let line = parent_prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Decomposition");
    let title: String = line.chars().take(80).collect();
    if title.is_empty() {
        "Decomposition".to_string()
    } else {
        title
    }
}

/// A blank prompt stores as NULL, matching how `create_workspace` treats "no
/// prompt" — an empty string and absence shouldn't differ on the wire.
fn non_empty_prompt(prompt: &str) -> Option<String> {
    if prompt.trim().is_empty() {
        None
    } else {
        Some(prompt.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, WorkspaceStatus};
    use crate::store::{init_pool, Db, RepositoryRepo};
    use std::path::PathBuf;

    async fn seed_user(pool: &Db, uid: &str) {
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .bind(uid)
        .bind(uid)
        .bind(format!("{uid}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn fresh() -> (WorkspaceRepo, BoardRepo, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let r = Repository::new("repo".into(), None, None);
        repos.insert(&r).await.unwrap();
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;
        (workspaces, board, r)
    }

    fn sample_input(repository_id: &str) -> DecompositionInput {
        DecompositionInput {
            repository_id: repository_id.to_string(),
            parent_prompt: "Build the widget\nwith tests".into(),
            subtasks: vec![
                SubtaskInput {
                    role: "backend".into(),
                    agent: Agent::Claude,
                    prompt: "do the backend".into(),
                },
                SubtaskInput {
                    role: "frontend".into(),
                    agent: Agent::Claude,
                    prompt: "do the frontend".into(),
                },
            ],
            edges: vec![EdgeInput {
                from_role: "backend".into(),
                to_role: "frontend".into(),
            }],
        }
    }

    // E2-T1: the gate creates exactly 1 parent + 2 subtasks + 1 edge and
    // SPAWNS NOTHING — every row is Pending with no branch/worktree (so no
    // PTY), and the parent has no agent.
    #[tokio::test]
    async fn start_decomposition_creates_dag_and_spawns_nothing() {
        let (workspaces, board, repo) = fresh().await;
        let b = create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
            .await
            .unwrap();

        // Parent: kind=Parent, Pending, no agent, no branch/worktree (no PTY).
        assert_eq!(b.parent.workspace_kind, WorkspaceKind::Parent);
        assert_eq!(b.parent.status, WorkspaceStatus::Pending);
        assert!(b.parent.agent.is_none());
        assert!(
            b.parent.branch.is_none() && b.parent.worktree_path.is_none(),
            "the gate must NOT create a worktree/branch for the parent"
        );

        // Subtasks: kind=Subtask, Pending, parent_id + role set, NOTHING spawned.
        assert_eq!(b.subtasks.len(), 2);
        for subtask in &b.subtasks {
            assert_eq!(subtask.workspace_kind, WorkspaceKind::Subtask);
            assert_eq!(subtask.status, WorkspaceStatus::Pending);
            assert_eq!(subtask.parent_id.as_deref(), Some(b.parent.id.as_str()));
            assert!(subtask.role.is_some());
            assert!(
                subtask.branch.is_none() && subtask.worktree_path.is_none(),
                "the gate must NOT spawn a subtask worktree/PTY"
            );
        }

        // Exactly one edge backend -> frontend, resolved to the real ids.
        let backend = b
            .subtasks
            .iter()
            .find(|s| s.role.as_deref() == Some("backend"))
            .unwrap();
        let frontend = b
            .subtasks
            .iter()
            .find(|s| s.role.as_deref() == Some("frontend"))
            .unwrap();
        assert_eq!(b.dependencies.len(), 1);
        assert_eq!(b.dependencies[0].from_subtask_id, backend.id);
        assert_eq!(b.dependencies[0].to_subtask_id, frontend.id);

        // Nothing published yet.
        assert!(b.contracts.is_empty());
    }

    // `get_board`'s read path returns the same board the gate just wrote.
    #[tokio::test]
    async fn get_board_reads_back_the_created_decomposition() {
        let (workspaces, board, repo) = fresh().await;
        let created =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        let read = board
            .get_board_for_user(&workspaces, &created.parent.id, "user-a")
            .await
            .unwrap();
        assert_eq!(read.parent.id, created.parent.id);
        assert_eq!(read.subtasks.len(), 2);
        assert_eq!(read.dependencies.len(), 1);
    }

    // Owner scoping: a different signed-in account can't read the board.
    #[tokio::test]
    async fn board_is_scoped_to_the_owner() {
        let (workspaces, board, repo) = fresh().await;
        let created =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        assert!(board
            .get_board_for_user(&workspaces, &created.parent.id, "user-a")
            .await
            .is_ok());
        assert!(
            matches!(
                board
                    .get_board_for_user(&workspaces, &created.parent.id, "user-b")
                    .await,
                Err(StoreError::NotFound)
            ),
            "a different account must get NotFound for another user's board"
        );
    }

    // Progressive disclosure (spec B6): subtasks never leak into the flat
    // top-level workspace list that backs the sidebar.
    #[tokio::test]
    async fn subtasks_do_not_leak_into_the_flat_workspace_list() {
        let (workspaces, board, repo) = fresh().await;
        let created =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        let top_ids: Vec<_> = workspaces
            .list_by_repository_for_user(&repo.id, "user-a")
            .await
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        for subtask in &created.subtasks {
            assert!(
                !top_ids.contains(&subtask.id),
                "a subtask must never appear in the flat top-level workspace list"
            );
        }
    }

    // Dedup decision: a re-submit is NOT deduped (no parent_id in the input to
    // key on) — each approval mints its own parent + its own subtasks, mirroring
    // start_task's deliberate-re-run-makes-fresh-state semantics.
    #[tokio::test]
    async fn re_decompose_mints_a_fresh_independent_parent() {
        let (workspaces, board, repo) = fresh().await;
        let first =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();
        let second =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        assert_ne!(first.parent.id, second.parent.id);
        let first_ids: Vec<_> = first.subtasks.iter().map(|s| s.id.clone()).collect();
        for subtask in &second.subtasks {
            assert!(
                !first_ids.contains(&subtask.id),
                "a re-decompose must not reuse the first submission's subtasks"
            );
        }
    }

    // A malformed plan is a clear error, and NOTHING is persisted for it.
    #[tokio::test]
    async fn malformed_decomposition_is_rejected_and_persists_nothing() {
        let (workspaces, board, repo) = fresh().await;

        // Duplicate role.
        let mut dup = sample_input(&repo.id);
        dup.subtasks[1].role = "backend".into();
        assert!(matches!(
            create_decomposition_inner(&dup, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // Self-edge.
        let mut self_edge = sample_input(&repo.id);
        self_edge.edges[0] = EdgeInput {
            from_role: "backend".into(),
            to_role: "backend".into(),
        };
        assert!(matches!(
            create_decomposition_inner(&self_edge, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // Edge referencing an unknown role.
        let mut dangling = sample_input(&repo.id);
        dangling.edges[0] = EdgeInput {
            from_role: "backend".into(),
            to_role: "nope".into(),
        };
        assert!(matches!(
            create_decomposition_inner(&dangling, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // Empty subtasks.
        let empty = DecompositionInput {
            repository_id: repo.id.clone(),
            parent_prompt: "x".into(),
            subtasks: vec![],
            edges: vec![],
        };
        assert!(matches!(
            create_decomposition_inner(&empty, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // None of the rejected attempts persisted a top-level row.
        assert!(workspaces
            .list_by_repository(&repo.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parent_title_uses_first_non_empty_line() {
        assert_eq!(parent_title("  \n  Build it\nmore"), "Build it");
        assert_eq!(parent_title("   "), "Decomposition");
        assert_eq!(parent_title(""), "Decomposition");
    }
}
